import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { finishEvalTraceRequest, preflightEvalTrace, startEvalTraceRequest } from "./eval-trace.js";

const TRACE_KEY = "a-private-per-run-eval-key-with-more-than-32-bytes";

function traceEnv(path: string): Record<string, string> {
  return { GRP_EVAL_TRACE: path, GRP_EVAL_TRACE_KEY: TRACE_KEY };
}

describe("opt-in eval trace", () => {
  it("is inert unless both explicit environment variables are present", () => {
    expect(() => preflightEvalTrace({})).not.toThrow();
    expect(startEvalTraceRequest({}, { method: "GET", path: "/api/rooms/secret" })).toBeNull();
    expect(() => preflightEvalTrace({ GRP_EVAL_TRACE: "/tmp/trace.jsonl" })).toThrow(
      /must be set together/,
    );
    expect(() => preflightEvalTrace({ GRP_EVAL_TRACE_KEY: TRACE_KEY })).toThrow(
      /must be set together/,
    );
    expect(() =>
      preflightEvalTrace({ GRP_EVAL_TRACE: "relative.jsonl", GRP_EVAL_TRACE_KEY: TRACE_KEY }),
    ).toThrow(/absolute path/);
  });

  it("creates a private file and never records content, raw identifiers, URLs, or the key", () => {
    const directory = mkdtempSync(join(tmpdir(), "grp-eval-trace-"));
    const path = join(directory, "agent.jsonl");
    const env = traceEnv(path);
    const sensitiveBody = JSON.stringify({
      expected_revision: "resource-revision-secret",
      base_revision_id: "base-revision-secret",
      sync_content: "Highly sensitive draft paragraph and private customer name",
    });
    preflightEvalTrace(env);
    const attempt = startEvalTraceRequest(env, {
      method: "POST",
      path: "/api/rooms/private-room-slug/artifacts/private-artifact-id/revisions",
      serializedBody: sensitiveBody,
      expectedRoomRevision: "room-revision-secret",
    });
    finishEvalTraceRequest(attempt, { status: 412, errorCode: "state.precondition_failed" });

    const raw = readFileSync(path, "utf8");
    for (const forbidden of [
      "Highly sensitive",
      "private customer",
      "private-room-slug",
      "private-artifact-id",
      "resource-revision-secret",
      "base-revision-secret",
      "room-revision-secret",
      TRACE_KEY,
      "/api/rooms/",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    const records = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      schema: "grp.eval_trace.v1",
      event: "request_started",
      operation: "artifact.publish",
      method: "POST",
      post_anyway: false,
      request_body_bytes: Buffer.byteLength(sensitiveBody, "utf8"),
    });
    expect(records[0]?.room_token).toMatch(/^hmac:[0-9a-f]{64}$/);
    expect(records[0]?.resource_token).toMatch(/^hmac:[0-9a-f]{64}$/);
    expect(records[0]?.request_body_token).toMatch(/^hmac:[0-9a-f]{64}$/);
    expect(records[1]).toMatchObject({
      schema: "grp.eval_trace.v1",
      event: "request_finished",
      status: 412,
      error_code: "state.precondition_failed",
    });
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it("rejects a symlink or non-private existing trace before a request can start", () => {
    const directory = mkdtempSync(join(tmpdir(), "grp-eval-trace-safety-"));
    const target = join(directory, "target.jsonl");
    const link = join(directory, "link.jsonl");
    writeFileSync(target, "", { mode: 0o600 });
    symlinkSync(target, link);
    expect(() => preflightEvalTrace(traceEnv(link))).toThrow(/non-symlink/);

    chmodSync(target, 0o644);
    expect(() => preflightEvalTrace(traceEnv(target))).toThrow(/group or others/);
  });

  it("records explicit guard bypass without inferring it from an absent header", () => {
    const directory = mkdtempSync(join(tmpdir(), "grp-eval-trace-override-"));
    const path = join(directory, "agent.jsonl");
    const attempt = startEvalTraceRequest(traceEnv(path), {
      method: "POST",
      path: "/api/rooms/room-a/discussion",
      serializedBody: JSON.stringify({ body: "not retained" }),
      postAnyway: true,
    });
    finishEvalTraceRequest(attempt, { status: 200 });
    const started = JSON.parse(readFileSync(path, "utf8").split("\n")[0] ?? "null") as Record<
      string,
      unknown
    >;
    expect(started).toMatchObject({ operation: "room.discuss", post_anyway: true });
  });
});
