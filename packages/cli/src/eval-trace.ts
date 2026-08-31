import { createHmac, randomBytes } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";

const TRACE_PATH_ENV = "GRP_EVAL_TRACE";
const TRACE_KEY_ENV = "GRP_EVAL_TRACE_KEY";
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_.-]{0,79}$/;
let nextAttempt = 1;
const PROCESS_NONCE = randomBytes(32).toString("hex");

interface TraceConfig {
  path: string;
  key: string;
}

export interface EvalTraceRequest {
  method: string;
  path: string;
  serializedBody?: string;
  expectedRoomRevision?: string;
  postAnyway?: boolean;
}

export interface EvalTraceAttempt {
  config: TraceConfig;
  attempt: number;
  startedAtMs: number;
}

function traceConfig(env: Record<string, string | undefined>): TraceConfig | null {
  const path = env[TRACE_PATH_ENV];
  const key = env[TRACE_KEY_ENV];
  if (path === undefined && key === undefined) return null;
  if (!path || !key) {
    throw new Error(`${TRACE_PATH_ENV} and ${TRACE_KEY_ENV} must be set together`);
  }
  if (!isAbsolute(path)) throw new Error(`${TRACE_PATH_ENV} must be an absolute path`);
  if (Buffer.byteLength(key, "utf8") < 32) {
    throw new Error(`${TRACE_KEY_ENV} must contain at least 32 bytes of per-run secret material`);
  }
  return { path, key };
}

function openPrivateTrace(config: TraceConfig): number {
  try {
    const existing = lstatSync(config.path);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`${TRACE_PATH_ENV} must name a regular, non-symlink file`);
    }
    if ((existing.mode & 0o077) !== 0) {
      throw new Error(`${TRACE_PATH_ENV} must not be readable or writable by group or others`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(
    config.path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || (opened.mode & 0o077) !== 0) {
      throw new Error(`${TRACE_PATH_ENV} must be a private regular file with mode 0600`);
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function appendTrace(config: TraceConfig, value: Record<string, unknown>): void {
  const descriptor = openPrivateTrace(config);
  try {
    writeSync(descriptor, `${JSON.stringify(value)}\n`, undefined, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function token(config: TraceConfig, value: string): string {
  return `hmac:${createHmac("sha256", config.key).update(value, "utf8").digest("hex")}`;
}

function operationFor(method: string, path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments[0] !== "api" || segments[1] !== "rooms") return "api.request";
  if (segments.length === 2) return method === "POST" ? "room.create" : "room.list";
  if (segments.length === 3) return method === "GET" ? "room.read" : "room.update";
  const resource = segments[3];
  if (resource === "working-signals") {
    if (segments.length === 4) return method === "POST" ? "working.start" : "working.list";
    return method === "PUT"
      ? "working.renew"
      : method === "DELETE"
        ? "working.stop"
        : "working.read";
  }
  if (resource === "actions") {
    if (segments.length === 4) return method === "POST" ? "action.create" : "action.list";
    if (segments.length === 5) return "action.read";
    const transition = segments[5];
    if (transition === "claim") return method === "POST" ? "action.claim" : "action.claim_update";
    if (transition === "complete" || transition === "fail" || transition === "cancel") {
      return `action.${transition}`;
    }
    return "action.update";
  }
  if (resource === "artifacts") {
    if (segments.length === 4) return method === "POST" ? "artifact.create" : "artifact.list";
    if (segments.length === 5) return "artifact.read";
    const transition = segments[5];
    if (transition === "claim")
      return method === "POST" ? "artifact.claim" : "artifact.claim_update";
    if (transition === "revisions") {
      if (segments.length === 6) return "artifact.publish";
      return segments[7] === "review" ? "artifact.review" : "artifact.revision_read";
    }
    return "artifact.update";
  }
  if (resource === "discussion") return method === "POST" ? "room.discuss" : "room.discussion_read";
  if (resource === "decisions") return method === "GET" ? "decision.read" : "decision.update";
  if (resource === "events") return "room.events";
  return "room.request";
}

function requestTokens(config: TraceConfig, request: EvalTraceRequest): Record<string, unknown> {
  const segments = request.path.split("/").filter(Boolean);
  const body = request.serializedBody ? (JSON.parse(request.serializedBody) as unknown) : null;
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const room = segments[0] === "api" && segments[1] === "rooms" ? segments[2] : undefined;
  const resourceKind = segments[3];
  const resource =
    resourceKind === "actions" || resourceKind === "artifacts" ? segments[4] : undefined;
  const pathRevision =
    resourceKind === "artifacts" && segments[5] === "revisions" ? segments[6] : undefined;
  return {
    ...(room ? { room_token: token(config, room) } : {}),
    ...(resource ? { resource_token: token(config, resource) } : {}),
    ...(pathRevision ? { revision_token: token(config, pathRevision) } : {}),
    ...(typeof record.expected_revision === "string"
      ? { expected_resource_revision_token: token(config, record.expected_revision) }
      : {}),
    ...(typeof record.base_revision_id === "string"
      ? { base_revision_token: token(config, record.base_revision_id) }
      : {}),
    ...(request.expectedRoomRevision
      ? { expected_room_revision_token: token(config, request.expectedRoomRevision) }
      : {}),
    ...(request.serializedBody !== undefined
      ? {
          request_body_bytes: Buffer.byteLength(request.serializedBody, "utf8"),
          request_body_token: token(config, request.serializedBody),
        }
      : { request_body_bytes: 0 }),
  };
}

/** Validate an explicitly enabled trace before any network mutation occurs. */
export function preflightEvalTrace(env: Record<string, string | undefined>): void {
  const config = traceConfig(env);
  if (!config) return;
  const descriptor = openPrivateTrace(config);
  closeSync(descriptor);
}

/** Append a content-free request-start record before the request is sent. */
export function startEvalTraceRequest(
  env: Record<string, string | undefined>,
  request: EvalTraceRequest,
): EvalTraceAttempt | null {
  const config = traceConfig(env);
  if (!config) return null;
  const attempt = nextAttempt++;
  const startedAtMs = Date.now();
  appendTrace(config, {
    schema: "grp.eval_trace.v1",
    event: "request_started",
    at: new Date(startedAtMs).toISOString(),
    process_token: token(config, PROCESS_NONCE),
    attempt,
    operation: operationFor(request.method, request.path),
    method: request.method,
    post_anyway: request.postAnyway === true,
    room_state_guard: request.expectedRoomRevision !== undefined,
    ...requestTokens(config, request),
  });
  return { config, attempt, startedAtMs };
}

/** Append the bounded outcome. Error messages and response bodies are never retained. */
export function finishEvalTraceRequest(
  trace: EvalTraceAttempt | null,
  outcome: { status?: number; errorCode?: string },
): void {
  if (!trace) return;
  const finishedAtMs = Date.now();
  const errorCode =
    outcome.errorCode && SAFE_ERROR_CODE.test(outcome.errorCode)
      ? outcome.errorCode
      : outcome.errorCode
        ? "client.error"
        : undefined;
  appendTrace(trace.config, {
    schema: "grp.eval_trace.v1",
    event: "request_finished",
    at: new Date(finishedAtMs).toISOString(),
    process_token: token(trace.config, PROCESS_NONCE),
    attempt: trace.attempt,
    duration_ms: Math.max(0, finishedAtMs - trace.startedAtMs),
    ...(outcome.status === undefined ? {} : { status: outcome.status }),
    ...(errorCode ? { error_code: errorCode } : {}),
    ok:
      errorCode === undefined &&
      outcome.status !== undefined &&
      outcome.status >= 200 &&
      outcome.status < 300,
  });
}
