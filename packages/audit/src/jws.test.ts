import * as ed25519 from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import {
  JwsVerificationError,
  base64urlDecode,
  base64urlEncodeBytes,
  decodeCompactJwsUnverified,
  signCompactJws,
  verifyCompactJws,
} from "./jws.js";

const PRIV = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff);

async function pubFor(priv: Uint8Array): Promise<Uint8Array> {
  return ed25519.getPublicKeyAsync(priv);
}

describe("jws sign/verify", () => {
  it("signs and verifies a compact JWS round-trip", async () => {
    const pub = await pubFor(PRIV);
    const jws = await signCompactJws({
      header: { alg: "EdDSA", typ: "grp-mandate+jwt", kid: "k1" },
      payload: { iss: "https://example.test", sub: "agent:x", grp: { actions: ["vote"] } },
      privateKey: PRIV,
    });
    expect(jws.split(".")).toHaveLength(3);
    const decoded = await verifyCompactJws<{ iss: string; sub: string }>({
      jws,
      publicKey: pub,
    });
    expect(decoded.header.kid).toBe("k1");
    expect(decoded.payload.iss).toBe("https://example.test");
    expect(decoded.payload.sub).toBe("agent:x");
  });

  it("rejects a tampered payload", async () => {
    const pub = await pubFor(PRIV);
    const jws = await signCompactJws({
      header: { alg: "EdDSA", typ: "grp-mandate+jwt" },
      payload: { a: 1 },
      privateKey: PRIV,
    });
    const parts = jws.split(".");
    const tamperedPayload = base64urlEncodeBytes(new TextEncoder().encode('{"a":2}'));
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    await expect(verifyCompactJws({ jws: tampered, publicKey: pub })).rejects.toThrow(
      JwsVerificationError,
    );
  });

  it("rejects a tampered signature", async () => {
    const pub = await pubFor(PRIV);
    const jws = await signCompactJws({
      header: { alg: "EdDSA" },
      payload: { a: 1 },
      privateKey: PRIV,
    });
    const parts = jws.split(".");
    const sigBytes = base64urlDecode(parts[2]!);
    sigBytes[0] = (sigBytes[0]! ^ 0x01) & 0xff;
    const tampered = `${parts[0]}.${parts[1]}.${base64urlEncodeBytes(sigBytes)}`;
    await expect(verifyCompactJws({ jws: tampered, publicKey: pub })).rejects.toThrow(
      JwsVerificationError,
    );
  });

  it("rejects a non-EdDSA alg", async () => {
    const pub = await pubFor(PRIV);
    const headerB64 = base64urlEncodeBytes(
      new TextEncoder().encode('{"alg":"HS256","typ":"junk"}'),
    );
    const fake = `${headerB64}.eyJhIjoxfQ.AAAA`;
    await expect(verifyCompactJws({ jws: fake, publicKey: pub })).rejects.toMatchObject({
      code: "alg_unsupported",
    });
  });

  it("rejects a malformed JWS shape", () => {
    expect(() => decodeCompactJwsUnverified("only.two")).toThrow(JwsVerificationError);
    expect(() => decodeCompactJwsUnverified("one.two.three.four")).toThrow(JwsVerificationError);
  });

  it("rejects padded or otherwise noncanonical base64url segments", async () => {
    const pub = await pubFor(PRIV);
    const jws = await signCompactJws({
      header: { alg: "EdDSA" },
      payload: { a: 1 },
      privateKey: PRIV,
    });
    const parts = jws.split(".");
    const paddedSignature = `${parts[0]}.${parts[1]}.${parts[2]}=`;
    await expect(verifyCompactJws({ jws: paddedSignature, publicKey: pub })).rejects.toMatchObject({
      code: "shape",
    });
  });

  it("rejects critical header parameters it does not understand", async () => {
    const pub = await pubFor(PRIV);
    const jws = await signCompactJws({
      header: { alg: "EdDSA", crit: ["future"] },
      payload: { a: 1 },
      privateKey: PRIV,
    });
    await expect(verifyCompactJws({ jws, publicKey: pub })).rejects.toMatchObject({
      code: "header",
    });
  });

  it("decodes header and payload without verifying signature", () => {
    const headerB64 = base64urlEncodeBytes(
      new TextEncoder().encode('{"alg":"EdDSA","kid":"deadbeef"}'),
    );
    const payloadB64 = base64urlEncodeBytes(new TextEncoder().encode('{"x":42}'));
    const fake = `${headerB64}.${payloadB64}.AAAA`;
    const decoded = decodeCompactJwsUnverified<{ x: number }>(fake);
    expect(decoded.header.kid).toBe("deadbeef");
    expect(decoded.payload.x).toBe(42);
  });

  it("is deterministic across logically-equal payloads (JCS canonicalization)", async () => {
    const a = await signCompactJws({
      header: { alg: "EdDSA", typ: "grp-mandate+jwt" },
      payload: { b: 2, a: 1 },
      privateKey: PRIV,
    });
    const b = await signCompactJws({
      header: { alg: "EdDSA", typ: "grp-mandate+jwt" },
      payload: { a: 1, b: 2 },
      privateKey: PRIV,
    });
    expect(a).toBe(b);
  });
});
