import { signCompactJws } from "@grp-protocol/audit";
import * as ed25519 from "@noble/ed25519";
import { fetchWithRateLimitRetry, isReachableHttpStatus } from "../http.js";
import type { ConformanceCase } from "../types.js";
import { KNOWN_MECHANISMS, validateDiscoveryDocument } from "./discovery.js";

const grpA2aExtensionUri = "https://groupresolutionprotocol.org/ext/grp/v1";
const grpVoteMime = "application/vnd.grp.vote+json";
const grpReceiptMime = "application/grp-receipt+jwt";

interface DiscoveryDoc {
  transports?: { rest?: string; mcp?: string; a2a?: string };
  auth?: { oauth_resource_metadata?: unknown };
  mechanisms_supported?: unknown;
  mechanisms?: unknown;
  keys?: unknown;
  conformance?: {
    self_attested?: unknown;
    validated?: unknown;
  };
  long_running_pattern?: unknown;
  supports_long_poll?: unknown;
  long_poll_max_wait_seconds?: unknown;
  supports_sse_upgrade?: unknown;
}

interface AgentCard {
  url?: unknown;
  capabilities?: {
    streaming?: unknown;
    pushNotifications?: unknown;
    extensions?: Array<{
      uri?: unknown;
      required?: unknown;
      params?: Record<string, unknown>;
    }>;
  };
  skills?: Array<{ id?: unknown }>;
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

interface A2aTask {
  id: string;
  status: { state: string };
  artifacts?: Array<{ mimeType?: string; parts?: unknown[] }>;
  metadata?: Record<string, unknown>;
}

export const operatorCases: ConformanceCase[] = [
  {
    id: "operator.discovery.claims_are_backed",
    title: "operator discovery claims are internally consistent and backed by live endpoints",
    profile: "operator",
    run: async ({ target }) => {
      if (!target) throw new Error("operator profile requires --target=<base-url>");
      await validateOperatorDiscovery(target);
    },
  },
  {
    id: "operator.rest.negative_contracts",
    title:
      "operator REST surface rejects invalid rooms, tokens, choices, and closed option proposals",
    profile: "operator",
    run: async ({ target }) => {
      if (!target) throw new Error("operator profile requires --target=<base-url>");
      await validateRestNegativeContracts(target);
    },
  },
  {
    id: "operator.rest.advertised_mechanisms",
    title: "every mechanism advertised by discovery resolves a live REST decision",
    profile: "operator",
    run: async ({ target }) => {
      if (!target) throw new Error("operator profile requires --target=<base-url>");
      await validateAdvertisedMechanisms(target);
    },
  },
  {
    id: "operator.auth.mandate_required",
    title: "a trusted mandate joins and acts in a mandate-required room",
    profile: "operator",
    run: async ({ target, mandate }) => {
      if (!target) throw new Error("operator profile requires --target=<base-url>");
      await validateMandateRequiredRoom(target, mandate);
    },
  },
  {
    id: "operator.a2a.binding_if_advertised",
    title: "operator A2A Agent Card and GRP extension binding work when A2A is advertised",
    profile: "operator",
    run: async ({ target }) => {
      if (!target) throw new Error("operator profile requires --target=<base-url>");
      await validateA2aBindingIfAdvertised(target);
    },
  },
];

async function validateOperatorDiscovery(target: string): Promise<void> {
  const discovery = await fetchJson<DiscoveryDoc>(new URL("/.well-known/grp.json", target));
  validateDiscoveryDocument(discovery);

  const mechanisms = discovery.mechanisms_supported ?? discovery.mechanisms;
  if (!Array.isArray(mechanisms) || !mechanisms.every((m) => typeof m === "string")) {
    throw new Error("operator discovery mechanisms must be a string array");
  }
  const known = new Set<string>(KNOWN_MECHANISMS);
  const unsupported = mechanisms.filter((m) => !known.has(m));
  if (unsupported.length > 0) {
    throw new Error(`operator advertises unsupported mechanisms: ${unsupported.join(", ")}`);
  }

  if (!Array.isArray(discovery.keys)) {
    throw new Error("operator discovery keys must be a JWKS keys array");
  }
  for (const key of discovery.keys) {
    if (!key || typeof key !== "object") throw new Error("operator discovery key must be object");
    const k = key as Record<string, unknown>;
    if (
      typeof k.kid !== "string" ||
      k.kty !== "OKP" ||
      k.crv !== "Ed25519" ||
      k.alg !== "EdDSA" ||
      typeof k.x !== "string"
    ) {
      throw new Error("operator discovery key must be Ed25519 JWKS shape");
    }
  }

  if (
    typeof discovery.conformance?.self_attested !== "boolean" ||
    typeof discovery.conformance?.validated !== "boolean"
  ) {
    throw new Error(
      "operator discovery conformance metadata must include boolean attestation flags",
    );
  }

  await expectReachable(new URL("/healthz", target), "health endpoint");
  const oauthMetadata = discovery.auth?.oauth_resource_metadata;
  if (oauthMetadata !== undefined && typeof oauthMetadata !== "string") {
    throw new Error("advertised OAuth metadata URL must be a string");
  }
  if (typeof oauthMetadata === "string") {
    await expectReachable(new URL(oauthMetadata, target), "OAuth metadata");
  }
  await expectReachable(new URL("/mcp", target), "MCP endpoint", { method: "POST" });

  if (discovery.supports_long_poll === true) {
    // The universal floor — if advertised, /next-action must be reachable.
    await expectNotMissing(
      new URL("/api/rooms/operator-conformance/next-action", target),
      "long-poll next-action endpoint",
    );
    if (
      typeof discovery.long_poll_max_wait_seconds !== "number" ||
      !Number.isFinite(discovery.long_poll_max_wait_seconds) ||
      discovery.long_poll_max_wait_seconds <= 0 ||
      discovery.long_poll_max_wait_seconds > 50
    ) {
      throw new Error("long_poll_max_wait_seconds must be a number in (0, 50]");
    }
  }
  if (discovery.long_running_pattern === "webhook") {
    await expectNotMissing(
      new URL("/api/rooms/operator-conformance/webhooks", target),
      "webhook registration endpoint",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
  }
  if (discovery.supports_sse_upgrade === true) {
    await expectNotMissing(
      new URL("/api/rooms/operator-conformance/events/stream", target),
      "SSE event stream endpoint",
    );
  }
}

async function validateRestNegativeContracts(target: string): Promise<void> {
  const missing = await fetchWithRateLimitRetry(
    new URL("/api/rooms/definitely-not-a-real-room", target),
  );
  if (missing.status !== 404) {
    throw new Error(`missing room should return 404; got ${missing.status}`);
  }
  const missingBody = (await missing.json().catch(() => null)) as Record<string, unknown> | null;
  if (!isErrorEnvelope(missingBody)) {
    throw new Error("missing room response must include the {error:{code,message}} envelope");
  }

  const room = await postJson<{ slug: string; creator_token: string }>(target, "/api/rooms", {
    question: `GRP operator negative contracts ${new Date().toISOString()}`,
    options: ["yes", "no"],
    config: {
      visibility: "unlisted",
      mechanism: "simple_majority",
      option_proposal_authority: { kind: "none" },
      auth: "token_only",
      quorum: 1,
      voting_window: 60,
      settle_window: 0,
      early_close: true,
      creator_votes: false,
    },
  });

  try {
    const joined = await postJson<{ participant_token: string }>(
      target,
      `/api/rooms/${room.slug}/join`,
      { display_name: "grp-operator-negative-agent" },
    );

    await expectClientError(
      target,
      `/api/rooms/${room.slug}/choose`,
      { choice: "not-an-option" },
      "invalid choice",
      joined.participant_token,
    );

    await expectClientError(
      target,
      `/api/rooms/${room.slug}/choose`,
      { choice: "yes" },
      "invalid token",
      "not-a-real-token",
    );

    await expectClientError(
      target,
      `/api/rooms/${room.slug}/options`,
      { option: "maybe" },
      "closed option proposal",
      room.creator_token,
    );
  } finally {
    await deleteRoom(target, room.slug, room.creator_token);
  }
}

async function validateA2aBindingIfAdvertised(target: string): Promise<void> {
  const discovery = await fetchJson<DiscoveryDoc>(new URL("/.well-known/grp.json", target));
  if (!discovery.transports?.a2a) return;

  const card = await fetchJson<AgentCard>(new URL("/.well-known/agent-card.json", target));
  const extensions = card.capabilities?.extensions ?? [];
  const grpExtension = extensions.find((ext) => ext.uri === grpA2aExtensionUri);
  if (!grpExtension) {
    throw new Error("A2A Agent Card must declare the GRP extension URI");
  }
  if (grpExtension.required !== false) {
    throw new Error("GRP A2A extension must be optional at v0.1");
  }
  if (grpExtension.params?.mandate_header !== undefined) {
    throw new Error(
      "GRP A2A extension must not advertise mandate auth until the binding enforces it",
    );
  }
  const skillIds = new Set((card.skills ?? []).map((skill) => skill.id));
  for (const skill of ["grp-participate", "grp-create", "grp-subscribe"]) {
    if (!skillIds.has(skill)) throw new Error(`A2A Agent Card missing skill ${skill}`);
  }

  const created = await a2aRpc<A2aTask>(target, 1, "tasks/send", {
    extensions: [grpA2aExtensionUri],
    metadata: {
      "grp:role": "creator",
      "grp:decision_config": {
        question: `GRP operator A2A binding ${new Date().toISOString()}`,
        options: ["approve", "reject"],
        config: {
          visibility: "unlisted",
          mechanism: "simple_majority",
          auth: "token_only",
          quorum: 1,
          voting_window: 60,
          settle_window: 0,
          early_close: true,
          creator_votes: false,
        },
      },
    },
    message: { role: "user", parts: [{ type: "text", text: "open decision" }] },
  });
  assertString(created.id, "A2A created task id");
  const slug = created.id;
  const creatorToken = created.metadata?.["grp:creator_token"];
  assertString(creatorToken, "A2A created task creator token");

  try {
    const voted = await a2aRpc<A2aTask>(target, 2, "tasks/send", {
      id: `grp-conformance-a2a-${slug}`,
      extensions: [grpA2aExtensionUri],
      metadata: {
        "grp:role": "participant",
        "grp:decision_id": slug,
        "grp:display_name": "grp-conformance-a2a-agent",
      },
      message: {
        role: "user",
        parts: [
          {
            type: "data",
            mimeType: grpVoteMime,
            data: { decision_id: slug, choice: "approve", weight: 1 },
          },
        ],
      },
    });
    if (voted.status.state !== "completed") {
      throw new Error(`A2A vote should complete early-close task; got ${voted.status.state}`);
    }
    if (!voted.artifacts?.some((artifact) => artifact.mimeType === grpReceiptMime)) {
      throw new Error("A2A completed task must include receipt artifact");
    }

    const participantToken = voted.metadata?.["grp:join_token"];
    assertString(participantToken, "A2A participant join token");

    const got = await a2aRpc<A2aTask>(target, 3, "tasks/get", {
      id: slug,
      metadata: {
        "grp:decision_id": slug,
        "grp:join_token": participantToken,
      },
    });
    if (got.status.state !== "completed") {
      throw new Error(`A2A tasks/get should return completed task; got ${got.status.state}`);
    }

    const outcome = await fetchJson<{
      status: string;
      resolved_winner: string | null;
      decisions: unknown[];
    }>(new URL(`/api/rooms/${slug}/outcome`, target), {
      authorization: `Bearer ${creatorToken}`,
    });
    if (outcome.status !== "resolved" || outcome.resolved_winner !== "approve") {
      throw new Error("A2A-backed decision did not match REST outcome");
    }
  } finally {
    await deleteRoom(target, slug, creatorToken);
  }
}

async function validateAdvertisedMechanisms(target: string): Promise<void> {
  const discovery = await fetchJson<DiscoveryDoc>(new URL("/.well-known/grp.json", target));
  const mechanisms = discovery.mechanisms_supported ?? discovery.mechanisms;
  if (!Array.isArray(mechanisms) || !mechanisms.every((value) => typeof value === "string")) {
    throw new Error("operator discovery mechanisms must be a string array");
  }

  for (const mechanism of mechanisms) {
    const room = await postJson<{ slug: string; creator_token: string }>(target, "/api/rooms", {
      question: `GRP conformance ${mechanism} ${new Date().toISOString()}`,
      options: ["alpha", "beta", "gamma"],
      config: {
        visibility: "unlisted",
        mechanism,
        auth: "token_only",
        quorum: 1,
        voting_window: 60,
        settle_window: 0,
        early_close: true,
        creator_votes: true,
      },
    });
    try {
      await postJson<{ ok: true }>(
        target,
        `/api/rooms/${room.slug}/choose`,
        { choice: choiceForMechanism(mechanism) },
        room.creator_token,
      );
      const outcome = await fetchJson<{ status: string; resolved_winner: string | null }>(
        new URL(`/api/rooms/${room.slug}/outcome`, target),
        { authorization: `Bearer ${room.creator_token}` },
      );
      if (outcome.status !== "resolved" || outcome.resolved_winner !== "alpha") {
        throw new Error(
          `${mechanism} did not resolve alpha; got ${outcome.status}/${String(outcome.resolved_winner)}`,
        );
      }
    } finally {
      await deleteRoom(target, room.slug, room.creator_token);
    }
  }
}

function choiceForMechanism(mechanism: string): string | string[] | Record<string, number> {
  if (mechanism === "approval") return ["alpha"];
  if (mechanism === "ranked_choice" || mechanism === "ranked_pairwise") {
    return ["alpha", "beta", "gamma"];
  }
  if (mechanism === "score_vote") return { alpha: 5, beta: 1, gamma: 0 };
  if (mechanism === "quadratic_vote") return { alpha: 4 };
  return "alpha";
}

async function validateMandateRequiredRoom(
  target: string,
  suppliedMandate?: string,
): Promise<void> {
  const room = await postJson<{ slug: string; creator_token: string }>(target, "/api/rooms", {
    question: `GRP conformance mandate ${new Date().toISOString()}`,
    options: ["approve", "reject"],
    config: {
      visibility: "unlisted",
      mechanism: "simple_majority",
      auth: "mandate_required",
      quorum: 1,
      voting_window: 60,
      settle_window: 0,
      early_close: true,
      creator_votes: false,
    },
  });
  try {
    const rawMandate = suppliedMandate ?? (await makeEphemeralMandate());
    const mandateHeaders = { "x-mandate": rawMandate };
    let joined: { participant_id: string };
    try {
      joined = await postJson<{ participant_id: string }>(
        target,
        `/api/rooms/${room.slug}/join`,
        { display_name: "grp-conformance-mandate-agent" },
        undefined,
        mandateHeaders,
      );
    } catch (error) {
      if (!suppliedMandate) {
        const diagnostic = error instanceof Error ? error.message : String(error);
        throw new Error(
          `the target rejected the development-only ephemeral did:key mandate; hosted operators should rerun with --mandate-file containing a short-lived mandate from an issuer trusted by the target (${diagnostic})`,
        );
      }
      throw error;
    }
    assertString(joined.participant_id, "mandate join participant id");
    await postJson<{ ok: true }>(
      target,
      `/api/rooms/${room.slug}/discuss`,
      { body: "Ephemeral did:key mandate authorized this discussion." },
      undefined,
      mandateHeaders,
    );
    await postJson<{ ok: true }>(
      target,
      `/api/rooms/${room.slug}/choose`,
      { choice: "approve" },
      undefined,
      mandateHeaders,
    );
    const outcome = await fetchJson<{ status: string; resolved_winner: string | null }>(
      new URL(`/api/rooms/${room.slug}/outcome`, target),
      mandateHeaders,
    );
    if (outcome.status !== "resolved" || outcome.resolved_winner !== "approve") {
      throw new Error("mandate-backed decision did not resolve through the live host");
    }
  } finally {
    await deleteRoom(target, room.slug, room.creator_token);
  }
}

async function makeEphemeralMandate(): Promise<string> {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = await ed25519.getPublicKeyAsync(privateKey);
  const issuer = didKeyForPublicKey(publicKey);
  const now = Math.floor(Date.now() / 1000);
  return signCompactJws({
    header: { alg: "EdDSA", typ: "grp-mandate+jwt", kid: issuer },
    payload: {
      iss: issuer,
      sub: `urn:grp:agent:conformance-${crypto.randomUUID()}`,
      jti: `urn:uuid:${crypto.randomUUID()}`,
      nbf: now - 60,
      exp: now + 600,
      grp: {
        actions: ["choose", "discuss", "propose", "react", "member_join_request"],
        rooms: ["*"],
        weight_cap: 1,
        trust_stage: 2,
      },
    },
    privateKey,
  });
}

function didKeyForPublicKey(publicKey: Uint8Array): string {
  const multicodecKey = new Uint8Array(34);
  multicodecKey.set([0xed, 0x01], 0);
  multicodecKey.set(publicKey, 2);
  return `did:key:z${base58btc(multicodecKey)}`;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btc(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  return encoded;
}

async function a2aRpc<T>(
  target: string,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const response = await fetchWithRateLimitRetry(new URL("/a2a", target), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const payload = (await response.json().catch(() => null)) as JsonRpcResponse<T> | null;
  if (!response.ok) {
    throw new Error(`A2A ${method} returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  if (!payload || payload.error) {
    throw new Error(
      `A2A ${method} returned RPC error: ${JSON.stringify(payload?.error ?? payload)}`,
    );
  }
  return payload.result as T;
}

async function fetchJson<T>(url: URL, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetchWithRateLimitRetry(url, {
    headers,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${url.toString()} returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload as T;
}

async function postJson<T>(
  target: string,
  path: string,
  body: unknown,
  token?: string,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const response = await fetchWithRateLimitRetry(new URL(path, target), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`POST ${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload as T;
}

async function expectClientError(
  target: string,
  path: string,
  body: unknown,
  label: string,
  token?: string,
): Promise<void> {
  const response = await fetchWithRateLimitRetry(new URL(path, target), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.status < 400 || response.status >= 500) {
    throw new Error(
      `${label} should return 4xx; got ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  if (!isErrorEnvelope(payload)) {
    throw new Error(`${label} response must include the {error:{code,message}} envelope`);
  }
}

async function deleteRoom(target: string, slug: string, creatorToken: string): Promise<void> {
  const response = await fetchWithRateLimitRetry(new URL(`/api/rooms/${slug}`, target), {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${creatorToken}`,
      "x-confirm-delete": slug,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(
      `failed to delete operator conformance room ${slug}: HTTP ${response.status} ${JSON.stringify(payload)}`,
    );
  }
}

function isErrorEnvelope(payload: Record<string, unknown> | null): boolean {
  if (!payload || typeof payload.error !== "object" || payload.error === null) return false;
  const err = payload.error as Record<string, unknown>;
  return typeof err.code === "string" && typeof err.message === "string";
}

async function expectReachable(url: URL, label: string, init: RequestInit = {}): Promise<void> {
  const response = await fetchWithRateLimitRetry(url, init);
  if (!isReachableHttpStatus(response.status)) {
    throw new Error(`${label} is not reachable; got ${response.status}`);
  }
}

async function expectNotMissing(url: URL, label: string, init: RequestInit = {}): Promise<void> {
  const response = await fetchWithRateLimitRetry(url, init);
  if (response.status >= 500) {
    throw new Error(`${label} is advertised but failed with ${response.status}`);
  }
  if (response.status === 405) {
    throw new Error(`${label} is advertised but missing; got ${response.status}`);
  }
  if (response.status === 404) {
    // The probes use a fabricated room slug, so a ROUTE that exists answers
    // 404 with the API's JSON error envelope ("room not found"). Only a
    // non-JSON 404 (the framework's route-miss default) means the endpoint
    // itself is missing.
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (body && typeof body.error !== "undefined") return;
    throw new Error(`${label} is advertised but missing; got ${response.status}`);
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}
