// Per spec 020 — Compact JWS (RFC 7515) over JCS-canonicalized JSON, Ed25519
// (alg=EdDSA). The shared envelope for mandates and receipts.
//
// Wire format: <base64url(header)>.<base64url(payload)>.<base64url(signature)>
//
// Header and payload are both serialized via JCS (RFC 8785) before
// base64url-encoding so two implementations producing the same logical object
// produce identical bytes. The signing input is the exact UTF-8 bytes of
// "<b64h>.<b64p>" — what JWS verifiers compute from the encoded segments,
// without re-serializing the parsed objects.
//
// We hand-roll base64url so this module stays portable across Node and edge
// runtimes; @noble/ed25519 already runs in both.

import * as ed25519 from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { canonicalize } from "./canonical.js";

export type JwsAlg = "EdDSA";

export interface JwsHeader {
  alg: JwsAlg;
  typ?: string;
  kid?: string;
  [k: string]: unknown;
}

export interface DecodedJws<P = Record<string, unknown>> {
  header: JwsHeader;
  payload: P;
  /** The encoded segments — `${b64h}.${b64p}.${b64sig}`. */
  raw: string;
}

export class JwsVerificationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "shape"
      | "header"
      | "alg_unsupported"
      | "signature_invalid"
      | "payload_decode",
  ) {
    super(`[jws] ${code}: ${message}`);
    this.name = "JwsVerificationError";
  }
}

export interface SignJwsOptions<P> {
  header: JwsHeader;
  payload: P;
  /** 32-byte Ed25519 private (seed) key. */
  privateKey: Uint8Array;
}

export async function signCompactJws<P>(opts: SignJwsOptions<P>): Promise<string> {
  if (opts.privateKey.length !== 32) {
    throw new Error(`[jws] expected 32-byte Ed25519 private key, got ${opts.privateKey.length}`);
  }
  if (opts.header.alg !== "EdDSA") {
    throw new Error(`[jws] only alg=EdDSA is supported; got '${opts.header.alg}'`);
  }
  const b64h = base64urlEncodeString(canonicalize(opts.header));
  const b64p = base64urlEncodeString(canonicalize(opts.payload));
  const signingInput = `${b64h}.${b64p}`;
  const sig = await ed25519.signAsync(new TextEncoder().encode(signingInput), opts.privateKey);
  const b64sig = base64urlEncodeBytes(sig);
  return `${signingInput}.${b64sig}`;
}

export interface VerifyJwsOptions {
  jws: string;
  /** 32-byte Ed25519 public key. */
  publicKey: Uint8Array;
}

export async function verifyCompactJws<P = Record<string, unknown>>(
  opts: VerifyJwsOptions,
): Promise<DecodedJws<P>> {
  const decoded = decodeCompactJwsUnverified<P>(opts.jws);
  if (decoded.header.alg !== "EdDSA") {
    throw new JwsVerificationError(`unsupported alg '${decoded.header.alg}'`, "alg_unsupported");
  }
  const dotIx = opts.jws.lastIndexOf(".");
  if (dotIx < 0) {
    throw new JwsVerificationError("missing signature segment", "shape");
  }
  const signingInput = new TextEncoder().encode(opts.jws.slice(0, dotIx));
  let sig: Uint8Array;
  try {
    sig = base64urlDecode(opts.jws.slice(dotIx + 1));
  } catch (err) {
    throw new JwsVerificationError(
      `signature is not canonical base64url: ${(err as Error).message}`,
      "shape",
    );
  }
  const ok = await ed25519.verifyAsync(sig, signingInput, opts.publicKey);
  if (!ok) {
    throw new JwsVerificationError("signature did not verify", "signature_invalid");
  }
  return decoded;
}

/**
 * Decode a compact JWS without verifying the signature. Used to inspect the
 * `kid` header before resolving the issuer's key.
 */
export function decodeCompactJwsUnverified<P = Record<string, unknown>>(
  jws: string,
): DecodedJws<P> {
  const parts = jws.split(".");
  if (parts.length !== 3) {
    throw new JwsVerificationError(
      `compact JWS must have 3 segments separated by '.'; got ${parts.length}`,
      "shape",
    );
  }
  const [b64h, b64p] = parts as [string, string, string];
  let header: JwsHeader;
  let payload: P;
  try {
    header = JSON.parse(base64urlDecodeToString(b64h)) as JwsHeader;
  } catch (e) {
    throw new JwsVerificationError(`header is not valid JSON: ${(e as Error).message}`, "header");
  }
  if (typeof header !== "object" || header === null || typeof header.alg !== "string") {
    throw new JwsVerificationError("header must be an object with `alg` string", "header");
  }
  if (Object.hasOwn(header, "crit")) {
    throw new JwsVerificationError(
      "critical header parameters are not supported by this verifier",
      "header",
    );
  }
  try {
    payload = JSON.parse(base64urlDecodeToString(b64p)) as P;
  } catch (e) {
    throw new JwsVerificationError(
      `payload is not valid JSON: ${(e as Error).message}`,
      "payload_decode",
    );
  }
  return { header, payload, raw: jws };
}

/**
 * Per spec 005 — a receipt's chain-link hash: `sha256:<hex>` over the exact
 * compact-JWS bytes. Lives here (portable) so browser verifiers, the API,
 * and third-party tooling all share one definition.
 */
export function computeJwsReceiptHash(compactJws: string): string {
  const digest = sha256(new TextEncoder().encode(compactJws));
  return `sha256:${bytesToHex(digest)}`;
}

// --- base64url helpers (RFC 7515 §2: base64url with no padding) ---
//
// Pure JS over btoa/atob (global in Node ≥16, browsers, and edge runtimes) so
// receipt/mandate verification runs anywhere, including browser-based receipt
// verifiers. No Buffer, no node:crypto.

export function base64urlEncodeString(s: string): string {
  return base64urlEncodeBytes(new TextEncoder().encode(s));
}

export function base64urlEncodeBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new Error("only the unpadded base64url alphabet is allowed");
  }
  if (s.length % 4 === 1) {
    throw new Error("invalid base64url length");
  }
  const padded = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (base64urlEncodeBytes(out) !== s) {
    throw new Error("non-canonical base64url encoding");
  }
  return out;
}

export function base64urlDecodeToString(s: string): string {
  return new TextDecoder().decode(base64urlDecode(s));
}
