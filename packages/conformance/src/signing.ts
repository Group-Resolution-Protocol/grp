import { createHash } from "node:crypto";
import {
  base64urlDecode,
  base64urlEncodeBytes,
  canonicalize,
  decodeCompactJwsUnverified,
  signCompactJws,
  verifyCompactJws,
} from "@grp-protocol/audit";
import * as ed25519 from "@noble/ed25519";
import type {
  ConformanceReport,
  ConformanceReportSignaturePayload,
  SignedConformanceReport,
} from "./types.js";

export interface SignConformanceReportOptions {
  report: ConformanceReport;
  privateKey: Uint8Array;
  kid: string;
  signedAt?: string;
}

export interface VerifySignedConformanceReportOptions {
  signedReport: SignedConformanceReport;
  publicKey?: Uint8Array;
}

export interface ConformanceReportVerification {
  ok: true;
  kid: string;
  signed_at: string;
  report_digest: string;
  trusted_public_key: boolean;
  report: ConformanceReport;
}

export async function signConformanceReport(
  opts: SignConformanceReportOptions,
): Promise<SignedConformanceReport> {
  if (!opts.kid) throw new Error("signing kid must be a non-empty string");
  if (opts.privateKey.length !== 32) {
    throw new Error(`expected 32-byte Ed25519 private key, got ${opts.privateKey.length}`);
  }

  const signedAt = opts.signedAt ?? new Date().toISOString();
  const reportDigest = digestJson(opts.report);
  const payload: ConformanceReportSignaturePayload = {
    schema_version: 1,
    kind: "grp.conformance.report_signature",
    signed_at: signedAt,
    report_digest: reportDigest,
    report: opts.report,
  };
  const publicKey = await ed25519.getPublicKeyAsync(opts.privateKey);
  const publicKeyJwk = {
    kty: "OKP" as const,
    crv: "Ed25519" as const,
    alg: "EdDSA" as const,
    kid: opts.kid,
    x: base64urlEncodeBytes(publicKey),
  };
  const jws = await signCompactJws({
    header: { alg: "EdDSA", typ: "grp-conformance-report+jws", kid: opts.kid },
    payload,
    privateKey: opts.privateKey,
  });

  return {
    schema_version: 1,
    kind: "grp.conformance.signed_report",
    report: opts.report,
    signature: {
      format: "compact-jws",
      alg: "EdDSA",
      kid: opts.kid,
      signed_at: signedAt,
      report_digest: reportDigest,
      public_key_jwk: publicKeyJwk,
      jws,
    },
  };
}

export async function verifySignedConformanceReport(
  opts: VerifySignedConformanceReportOptions,
): Promise<ConformanceReportVerification> {
  const envelope = opts.signedReport;
  assertSignedEnvelope(envelope);
  const embeddedPublicKey = base64urlDecode(envelope.signature.public_key_jwk.x);
  const publicKey = opts.publicKey ?? embeddedPublicKey;
  const trustedPublicKey = opts.publicKey ? bytesEqual(opts.publicKey, embeddedPublicKey) : false;

  const decoded = await verifyCompactJws<ConformanceReportSignaturePayload>({
    jws: envelope.signature.jws,
    publicKey,
  });
  if (decoded.header.kid !== envelope.signature.kid) {
    throw new Error("signature kid does not match JWS header kid");
  }
  if (decoded.header.typ !== "grp-conformance-report+jws") {
    throw new Error("JWS typ must be grp-conformance-report+jws");
  }
  assertSignaturePayload(decoded.payload);

  const envelopeDigest = digestJson(envelope.report);
  if (envelope.signature.report_digest !== envelopeDigest) {
    throw new Error("envelope report_digest does not match report body");
  }
  if (decoded.payload.report_digest !== envelopeDigest) {
    throw new Error("JWS payload report_digest does not match report body");
  }
  if (decoded.payload.report_digest !== envelope.signature.report_digest) {
    throw new Error("JWS payload report_digest does not match signature metadata");
  }
  if (decoded.payload.signed_at !== envelope.signature.signed_at) {
    throw new Error("JWS payload signed_at does not match signature metadata");
  }
  if (canonicalize(decoded.payload.report) !== canonicalize(envelope.report)) {
    throw new Error("JWS payload report does not match envelope report");
  }

  return {
    ok: true,
    kid: envelope.signature.kid,
    signed_at: envelope.signature.signed_at,
    report_digest: envelope.signature.report_digest,
    trusted_public_key: trustedPublicKey,
    report: envelope.report,
  };
}

export function decodeBase64Key(value: string, label: string): Uint8Array {
  const key = new Uint8Array(Buffer.from(value, "base64"));
  if (key.length !== 32) {
    throw new Error(`${label} must decode to 32 bytes; got ${key.length}`);
  }
  return key;
}

export function publicKeyFromJwks(jwks: unknown, kid: string): Uint8Array {
  if (!jwks || typeof jwks !== "object" || !Array.isArray((jwks as { keys?: unknown }).keys)) {
    throw new Error("JWKS must be an object with a keys array");
  }
  const key = (jwks as { keys: unknown[] }).keys.find(
    (candidate) => (candidate as { kid?: unknown })?.kid === kid,
  );
  if (!key || typeof key !== "object") {
    throw new Error(`JWKS does not contain kid '${kid}'`);
  }
  const jwk = key as Record<string, unknown>;
  if (
    jwk.kty !== "OKP" ||
    jwk.crv !== "Ed25519" ||
    jwk.alg !== "EdDSA" ||
    typeof jwk.x !== "string"
  ) {
    throw new Error(`JWKS kid '${kid}' must be an Ed25519 OKP key`);
  }
  const publicKey = base64urlDecode(jwk.x);
  if (publicKey.length !== 32) {
    throw new Error(`JWKS kid '${kid}' x value must decode to 32 bytes; got ${publicKey.length}`);
  }
  return publicKey;
}

export function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function assertSignedEnvelope(value: unknown): asserts value is SignedConformanceReport {
  if (!value || typeof value !== "object") throw new Error("signed report must be an object");
  const envelope = value as SignedConformanceReport;
  if (envelope.schema_version !== 1) throw new Error("signed report schema_version must be 1");
  if (envelope.kind !== "grp.conformance.signed_report") {
    throw new Error("signed report kind must be grp.conformance.signed_report");
  }
  if (!envelope.report || typeof envelope.report !== "object") {
    throw new Error("signed report must include report object");
  }
  const signature = envelope.signature;
  if (!signature || typeof signature !== "object") {
    throw new Error("signed report must include signature object");
  }
  if (signature.format !== "compact-jws") throw new Error("signature format must be compact-jws");
  if (signature.alg !== "EdDSA") throw new Error("signature alg must be EdDSA");
  if (typeof signature.kid !== "string" || signature.kid.length === 0) {
    throw new Error("signature kid must be non-empty string");
  }
  if (typeof signature.signed_at !== "string" || signature.signed_at.length === 0) {
    throw new Error("signature signed_at must be non-empty string");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(signature.report_digest)) {
    throw new Error("signature report_digest must be sha256:<hex>");
  }
  if (typeof signature.jws !== "string" || signature.jws.length === 0) {
    throw new Error("signature jws must be non-empty string");
  }
  const decoded = decodeCompactJwsUnverified(signature.jws);
  if (decoded.header.alg !== "EdDSA") throw new Error("JWS header alg must be EdDSA");
}

function assertSignaturePayload(
  value: unknown,
): asserts value is ConformanceReportSignaturePayload {
  if (!value || typeof value !== "object") throw new Error("JWS payload must be an object");
  const payload = value as ConformanceReportSignaturePayload;
  if (payload.schema_version !== 1) throw new Error("JWS payload schema_version must be 1");
  if (payload.kind !== "grp.conformance.report_signature") {
    throw new Error("JWS payload kind must be grp.conformance.report_signature");
  }
  if (typeof payload.signed_at !== "string" || payload.signed_at.length === 0) {
    throw new Error("JWS payload signed_at must be non-empty string");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(payload.report_digest)) {
    throw new Error("JWS payload report_digest must be sha256:<hex>");
  }
  if (!payload.report || typeof payload.report !== "object") {
    throw new Error("JWS payload must include report object");
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
