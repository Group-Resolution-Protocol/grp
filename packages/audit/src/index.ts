// @grp-protocol/audit — audit-log writer + Merkle root publisher (spec 104).

export const AUDIT_VERSION = "0.1.0";

// Naming convention: <entity>.<action>, lowercase, underscore-separated.
export const AUDIT_ACTIONS = [
  // identity (spec 102)
  "auth.passkey_register",
  "auth.passkey_login",
  "auth.passkey_revoke",
  "auth.magic_link_request",
  "auth.magic_link_consume",
  "auth.session_refresh",
  "auth.session_replay_detected",
  "auth.logout",
  "api_key.create",
  "api_key.revoke",
  "restricted_key.create",
  "restricted_key.revoke",
  "privacy_mode.change",
  "verified_attribute.create",
  "verified_attribute.expire",
  "principal.signed_up",
  "principal.delete_requested",
  "principal.delete_executed",
  // constitution / mandate (105/106)
  "constitution.created",
  "constitution.signed",
  "constitution.superseded",
  "mandate.created",
  "mandate.revoked",
  // room (108)
  "room.created",
  "room.member_joined",
  "room.member_left",
  // decision/vote (111)
  "decision.opened",
  "decision.closed",
  "decision.voting_started",
  "vote.cast",
  "vote.changed",
  "vote.revoked",
  // delegation (115)
  "delegation.granted",
  "delegation.revoked",
  // receipt (113)
  "receipt.emitted",
  "receipt.overridden",
  "receipt.reversed_in_window",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export { canonicalize, CanonicalizationError } from "./canonical.js";
export { nextHash, verifyChain } from "./hash-chain.js";
export { buildMerkleRoot } from "./merkle.js";
export type { ChainInput, Hex } from "./hash-chain.js";
export type { MerkleResult } from "./merkle.js";
export {
  signCompactJws,
  verifyCompactJws,
  decodeCompactJwsUnverified,
  computeJwsReceiptHash,
  base64urlDecode,
  base64urlDecodeToString,
  base64urlEncodeBytes,
  base64urlEncodeString,
  JwsVerificationError,
} from "./jws.js";
export type { JwsAlg, JwsHeader, DecodedJws, SignJwsOptions, VerifyJwsOptions } from "./jws.js";
