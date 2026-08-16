import {
  base64urlDecode,
  base64urlEncodeBytes,
  decodeCompactJwsUnverified,
  signCompactJws,
  verifyCompactJws,
} from "@grp-protocol/audit";
import * as ed25519 from "@noble/ed25519";
import type { ConformanceCase } from "../types.js";

const MANDATE_PRIVATE_KEY = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff);
const RECEIPT_PRIVATE_KEY = new Uint8Array(32).map((_, i) => (i * 11 + 3) & 0xff);

export const mandatePayloadVector = {
  iss: "https://principal.example/.well-known/grp.json",
  sub: "urn:grp:agent:alice-assistant",
  jti: "urn:uuid:11111111-1111-4111-8111-111111111111",
  nbf: 1_777_677_600,
  exp: 1_780_356_800,
  grp: {
    actions: ["choose", "discuss"],
    rooms: ["https://room.example/r/board"],
    weight_cap: 1,
    trust_stage: 2,
  },
} as const;

export const receiptPayloadVector = {
  iss: "https://room.example/r/board",
  aud: "https://room.example/r/board",
  jti: "urn:uuid:22222222-2222-4222-8222-222222222222",
  iat: 1_777_723_200,
  grp: {
    decision_id: "urn:uuid:33333333-3333-4333-8333-333333333333",
    decision_kind: "standing",
    room_id: "urn:grp:room:board",
    mechanism: {
      kind: "generic_vote",
      parameters: {
        options: ["approve", "reject"],
        ballot_mode: "single_choice",
        quorum: 0.5,
        pass_threshold: 0.5,
        tie_break: "no_pass",
      },
    },
    windows: {
      deliberation_started_at: "2026-05-01T10:00:00Z",
      voting_started_at: "2026-05-01T11:00:00Z",
      voting_ended_at: "2026-05-01T12:00:00Z",
      cooldown_ended_at: "2026-05-01T13:00:00Z",
    },
    deliberation_message_count: 0,
    votes: [],
    overrides: [],
    outcome: {
      status: "completed",
      winning_option: "approve",
      tallies: { approve: 2, reject: 1 },
      diagnostics: {},
    },
    prev_hash: null,
    sequence: 1,
  },
} as const;

export const jwsCases: ConformanceCase[] = [
  {
    id: "core.jws.mandate.valid_signature",
    title: "compact-JWS mandate vector verifies with Ed25519",
    profile: "core",
    run: async () => {
      const publicKey = await ed25519.getPublicKeyAsync(MANDATE_PRIVATE_KEY);
      const jws = await signCompactJws({
        header: { alg: "EdDSA", typ: "grp-mandate+jwt", kid: "principal-key-1" },
        payload: mandatePayloadVector,
        privateKey: MANDATE_PRIVATE_KEY,
      });
      const decoded = await verifyCompactJws({ jws, publicKey });
      if (decoded.header.typ !== "grp-mandate+jwt") {
        throw new Error(`unexpected typ ${String(decoded.header.typ)}`);
      }
      if (decoded.payload.jti !== mandatePayloadVector.jti) {
        throw new Error("mandate payload jti mismatch");
      }
    },
  },
  {
    id: "core.jws.mandate.tampered_payload_rejected",
    title: "compact-JWS mandate vector rejects tampered payload",
    profile: "core",
    run: async () => {
      const publicKey = await ed25519.getPublicKeyAsync(MANDATE_PRIVATE_KEY);
      const jws = await signCompactJws({
        header: { alg: "EdDSA", typ: "grp-mandate+jwt", kid: "principal-key-1" },
        payload: mandatePayloadVector,
        privateKey: MANDATE_PRIVATE_KEY,
      });
      const [header, _payload, signature] = jws.split(".");
      const tamperedPayload = base64urlEncodeBytes(
        new TextEncoder().encode(JSON.stringify({ ...mandatePayloadVector, sub: "urn:evil" })),
      );
      await assertRejects(
        () => verifyCompactJws({ jws: `${header}.${tamperedPayload}.${signature}`, publicKey }),
        "tampered mandate unexpectedly verified",
      );
    },
  },
  {
    id: "core.jws.receipt.valid_signature",
    title: "compact-JWS receipt vector verifies with Ed25519",
    profile: "core",
    run: async () => {
      const publicKey = await ed25519.getPublicKeyAsync(RECEIPT_PRIVATE_KEY);
      const jws = await signCompactJws({
        header: { alg: "EdDSA", typ: "grp-receipt+jwt", kid: "room-key-1" },
        payload: receiptPayloadVector,
        privateKey: RECEIPT_PRIVATE_KEY,
      });
      const decoded = await verifyCompactJws({ jws, publicKey });
      if (decoded.header.typ !== "grp-receipt+jwt") {
        throw new Error(`unexpected typ ${String(decoded.header.typ)}`);
      }
      if (decoded.payload.jti !== receiptPayloadVector.jti) {
        throw new Error("receipt payload jti mismatch");
      }
    },
  },
  {
    id: "core.jws.receipt.tampered_signature_rejected",
    title: "compact-JWS receipt vector rejects tampered signature",
    profile: "core",
    run: async () => {
      const publicKey = await ed25519.getPublicKeyAsync(RECEIPT_PRIVATE_KEY);
      const jws = await signCompactJws({
        header: { alg: "EdDSA", typ: "grp-receipt+jwt", kid: "room-key-1" },
        payload: receiptPayloadVector,
        privateKey: RECEIPT_PRIVATE_KEY,
      });
      const [header, payload, signature] = jws.split(".");
      const sig = base64urlDecode(signature ?? "");
      sig[0] = (sig[0] ?? 0) ^ 1;
      await assertRejects(
        () =>
          verifyCompactJws({
            jws: `${header}.${payload}.${base64urlEncodeBytes(sig)}`,
            publicKey,
          }),
        "tampered receipt unexpectedly verified",
      );
    },
  },
  {
    id: "core.jws.canonicalization.deterministic",
    title: "compact-JWS signing is deterministic over JCS-canonicalized JSON",
    profile: "core",
    run: async () => {
      const a = await signCompactJws({
        header: { alg: "EdDSA", typ: "grp-mandate+jwt", kid: "principal-key-1" },
        payload: { b: 2, a: 1 },
        privateKey: MANDATE_PRIVATE_KEY,
      });
      const b = await signCompactJws({
        header: { kid: "principal-key-1", typ: "grp-mandate+jwt", alg: "EdDSA" },
        payload: { a: 1, b: 2 },
        privateKey: MANDATE_PRIVATE_KEY,
      });
      if (a !== b) {
        throw new Error("logically equal objects produced different compact JWS values");
      }
      const decoded = decodeCompactJwsUnverified(a);
      if (decoded.header.kid !== "principal-key-1") {
        throw new Error("decoded canonical JWS header mismatch");
      }
    },
  },
];

async function assertRejects(fn: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(message);
}
