// Per spec 104 — hash-chain construction.
//
// hash = sha256(prev_hash_hex || canonical_jcs(body) || ts_iso8601)
//
// Concurrent writes by different actors don't contend (each actor has its own
// chain via prev_hash); concurrent writes by the same actor serialize via
// a Postgres advisory lock keyed on (actor_kind, actor_id) — handled at the
// writer layer (audit/middleware.ts), not in this pure module.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalize } from "./canonical.js";

export type Hex = string;

export interface ChainInput {
  /** The previous event's hash for this actor; null on first event. */
  prevHash: Hex | null;
  /** The canonicalized event body — the JSON the hash signs. */
  body: unknown;
  /** Event timestamp in ISO 8601 / RFC 3339. */
  ts: string;
}

/**
 * Compute the next hash in a chain. Pure function; no I/O.
 */
export function nextHash({ prevHash, body, ts }: ChainInput): Hex {
  const h = sha256.create();
  if (prevHash) h.update(hexToBytes(prevHash));
  // The canonical body is signed verbatim — the body bytes ARE the input
  // to the hash, not their re-stringification by JS.
  h.update(utf8ToBytes(canonicalize(body)));
  h.update(utf8ToBytes(ts));
  return bytesToHex(h.digest());
}

/**
 * Verify a chain segment. Returns true iff every step matches.
 */
export function verifyChain(events: ChainInput[], hashes: Hex[]): boolean {
  if (events.length !== hashes.length) return false;
  let prev: Hex | null = null;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const expected = hashes[i];
    if (!ev || !expected) return false;
    const computed = nextHash({ ...ev, prevHash: prev });
    if (computed !== expected) return false;
    prev = computed;
  }
  return true;
}
