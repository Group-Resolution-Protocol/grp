// Spec 041 §4.2 — mandate verification vectors.
//
// Each vector is a (mandate JWS, action context, expected verdict) triple. An
// external implementation replays its own mandate verifier over the vector
// set and must reach the same verdicts. The reference verifier below is
// deliberately self-contained — the spec-002 checks expressed in ~40 lines,
// with no dependency on any operator's server code.

import { signCompactJws, verifyCompactJws } from "@grp-protocol/audit";
import * as ed25519 from "@noble/ed25519";
import type { ConformanceCase } from "../types.js";

const PRINCIPAL_PRIVATE_KEY = new Uint8Array(32).map((_, i) => (i * 13 + 5) & 0xff);
const PRINCIPAL_KID = "principal-key-1";

/** Fixed evaluation clock so vectors are stable: 2026-05-01T12:00:00Z. */
export const MANDATE_VECTOR_NOW = 1_777_723_200;

const ROOM = "https://room.example/r/board";

interface MandateGrpClaims {
  actions: string[];
  rooms: string[];
  weight_cap: number;
  trust_stage: number;
}

interface MandateClaims {
  iss: string;
  sub: string;
  jti: string;
  nbf: number;
  exp: number;
  grp: MandateGrpClaims;
}

function baseMandate(overrides: Partial<MandateClaims> = {}): MandateClaims {
  return {
    iss: "https://principal.example/.well-known/grp.json",
    sub: "urn:grp:agent:alice-assistant",
    jti: "urn:uuid:44444444-4444-4444-8444-444444444444",
    nbf: MANDATE_VECTOR_NOW - 3_600,
    exp: MANDATE_VECTOR_NOW + 86_400,
    grp: {
      actions: ["choose", "discuss"],
      rooms: [ROOM],
      weight_cap: 1,
      trust_stage: 2,
    },
    ...overrides,
  };
}

export type MandateRejection =
  | "signature_invalid"
  | "expired"
  | "not_yet_valid"
  | "room_not_in_scope"
  | "action_not_in_scope"
  | "revoked";

export interface MandateVerificationVector {
  id: string;
  description: string;
  /** Compact-JWS mandate to evaluate. */
  jws: string;
  /** The action the agent attempts under this mandate. */
  context: { action: string; room: string; now: number };
  /** Revoked jti list the room has cached from the issuer (spec 002). */
  revocations: string[];
  expect: { valid: true } | { valid: false; reason: MandateRejection };
}

async function sign(payload: MandateClaims): Promise<string> {
  return signCompactJws({
    header: { alg: "EdDSA", typ: "grp-mandate+jwt", kid: PRINCIPAL_KID },
    payload,
    privateKey: PRINCIPAL_PRIVATE_KEY,
  });
}

const defaultContext = { action: "choose", room: ROOM, now: MANDATE_VECTOR_NOW };

/** Build the full vector set. Deterministic: Ed25519 signing is RFC 8032 deterministic. */
export async function buildMandateVerificationVectors(): Promise<MandateVerificationVector[]> {
  const valid = await sign(baseMandate());
  const expired = await sign(
    baseMandate({ exp: MANDATE_VECTOR_NOW - 60, nbf: MANDATE_VECTOR_NOW - 7_200 }),
  );
  const notYetValid = await sign(baseMandate({ nbf: MANDATE_VECTOR_NOW + 3_600 }));
  const otherRoom = await sign(
    baseMandate({
      grp: {
        actions: ["choose"],
        rooms: ["https://room.example/r/other"],
        weight_cap: 1,
        trust_stage: 2,
      },
    }),
  );
  const readOnly = await sign(
    baseMandate({
      grp: { actions: ["discuss"], rooms: [ROOM], weight_cap: 1, trust_stage: 2 },
    }),
  );
  const revokedJti = "urn:uuid:55555555-5555-4555-8555-555555555555";
  const revoked = await sign(baseMandate({ jti: revokedJti }));
  // Malformed signature: flip the FIRST character of the signature segment.
  // (The last base64url char only carries discarded padding bits — flipping
  // it can decode to identical signature bytes.)
  const sigStart = valid.lastIndexOf(".") + 1;
  const tampered =
    valid.slice(0, sigStart) + (valid[sigStart] === "A" ? "B" : "A") + valid.slice(sigStart + 1);

  return [
    {
      id: "mandate.valid",
      description: "in-window mandate scoped to the action and room verifies",
      jws: valid,
      context: defaultContext,
      revocations: [],
      expect: { valid: true },
    },
    {
      id: "mandate.expired",
      description: "mandate past `exp` is rejected",
      jws: expired,
      context: defaultContext,
      revocations: [],
      expect: { valid: false, reason: "expired" },
    },
    {
      id: "mandate.not_yet_valid",
      description: "mandate before `nbf` is rejected",
      jws: notYetValid,
      context: defaultContext,
      revocations: [],
      expect: { valid: false, reason: "not_yet_valid" },
    },
    {
      id: "mandate.room_not_in_scope",
      description: "mandate scoped to a different room is rejected",
      jws: otherRoom,
      context: defaultContext,
      revocations: [],
      expect: { valid: false, reason: "room_not_in_scope" },
    },
    {
      id: "mandate.action_not_in_scope",
      description: "mandate without the attempted action is rejected",
      jws: readOnly,
      context: defaultContext,
      revocations: [],
      expect: { valid: false, reason: "action_not_in_scope" },
    },
    {
      id: "mandate.revoked",
      description: "mandate whose jti appears in the issuer's revocations is rejected",
      jws: revoked,
      context: defaultContext,
      revocations: [revokedJti],
      expect: { valid: false, reason: "revoked" },
    },
    {
      id: "mandate.malformed_signature",
      description: "mandate with a corrupted signature segment is rejected",
      jws: tampered,
      context: defaultContext,
      revocations: [],
      expect: { valid: false, reason: "signature_invalid" },
    },
  ];
}

/**
 * Reference verifier — the spec-002 checks in evaluation order: signature,
 * revocation, validity window, room scope, action scope. Returns the first
 * failure, mirroring how a conforming room must short-circuit.
 */
export async function referenceVerifyMandate(
  vector: MandateVerificationVector,
  publicKey: Uint8Array,
): Promise<{ valid: true } | { valid: false; reason: MandateRejection }> {
  let payload: MandateClaims;
  try {
    const decoded = await verifyCompactJws<MandateClaims>({ jws: vector.jws, publicKey });
    payload = decoded.payload;
  } catch {
    return { valid: false, reason: "signature_invalid" };
  }
  if (vector.revocations.includes(payload.jti)) return { valid: false, reason: "revoked" };
  if (vector.context.now >= payload.exp) return { valid: false, reason: "expired" };
  if (vector.context.now < payload.nbf) return { valid: false, reason: "not_yet_valid" };
  if (!payload.grp.rooms.includes(vector.context.room)) {
    return { valid: false, reason: "room_not_in_scope" };
  }
  if (!payload.grp.actions.includes(vector.context.action)) {
    return { valid: false, reason: "action_not_in_scope" };
  }
  return { valid: true };
}

export async function mandateVectorPublicKey(): Promise<Uint8Array> {
  return ed25519.getPublicKeyAsync(PRINCIPAL_PRIVATE_KEY);
}

export const mandateCases: ConformanceCase[] = [
  {
    id: "core.mandate.verification_vectors",
    title: "spec-002 mandate verification vectors reach the expected verdicts",
    profile: "core",
    run: async () => {
      const publicKey = await mandateVectorPublicKey();
      const vectors = await buildMandateVerificationVectors();
      for (const vector of vectors) {
        const got = await referenceVerifyMandate(vector, publicKey);
        const want = vector.expect;
        const match =
          got.valid === want.valid &&
          (got.valid || !("reason" in want) || got.reason === want.reason);
        if (!match) {
          throw new Error(
            `${vector.id}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
          );
        }
      }
    },
  },
];
