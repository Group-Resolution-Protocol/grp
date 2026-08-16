// Spec 041 §4.2/§4.3 — the vector builders themselves: deterministic output,
// expected verdicts, and chain math an external implementer can replicate.

import { computeJwsReceiptHash } from "@grp-protocol/audit";
import { describe, expect, it } from "vitest";
import {
  buildMandateVerificationVectors,
  mandateVectorPublicKey,
  referenceVerifyMandate,
} from "./mandates.js";
import { buildReceiptChainVectors } from "./receipts.js";

describe("mandate verification vectors", () => {
  it("are deterministic across builds", async () => {
    const a = await buildMandateVerificationVectors();
    const b = await buildMandateVerificationVectors();
    expect(a.map((v) => v.jws)).toEqual(b.map((v) => v.jws));
  });

  it("cover the spec-002 rejection reasons", async () => {
    const vectors = await buildMandateVerificationVectors();
    const reasons = vectors.map((v) => (v.expect.valid ? "valid" : v.expect.reason)).sort();
    expect(reasons).toEqual(
      [
        "action_not_in_scope",
        "expired",
        "not_yet_valid",
        "revoked",
        "room_not_in_scope",
        "signature_invalid",
        "valid",
      ].sort(),
    );
  });

  it("every vector reaches its expected verdict under the reference verifier", async () => {
    const publicKey = await mandateVectorPublicKey();
    for (const vector of await buildMandateVerificationVectors()) {
      const got = await referenceVerifyMandate(vector, publicKey);
      expect({ id: vector.id, ...got }).toEqual({ id: vector.id, ...vector.expect });
    }
  });
});

describe("receipt chain vectors", () => {
  it("chain links via sha256 over the prior JWS bytes", async () => {
    const { chain, hashes } = await buildReceiptChainVectors();
    expect(chain).toHaveLength(3);
    for (let i = 0; i < chain.length; i++) {
      expect(computeJwsReceiptHash(chain[i] as string)).toBe(hashes[i]);
    }
  });

  it("is deterministic across builds", async () => {
    const a = await buildReceiptChainVectors();
    const b = await buildReceiptChainVectors();
    expect(a.chain).toEqual(b.chain);
    expect(a.hashes).toEqual(b.hashes);
  });
});
