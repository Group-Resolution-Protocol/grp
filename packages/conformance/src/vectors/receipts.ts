// Spec 041 §4.3 — receipt chain vectors.
//
// A three-receipt hash chain over compact JWS bytes (spec 005): each link's
// `grp.prev_hash` is `sha256:<hex>` of the prior link's exact JWS string.
// External implementations replay their own receipt verifier and must accept
// the chain, reject the tampered/wrong-key variants, and reproduce the hash.

import { computeJwsReceiptHash, signCompactJws, verifyCompactJws } from "@grp-protocol/audit";
import * as ed25519 from "@noble/ed25519";
import type { ConformanceCase } from "../types.js";

const ROOM_PRIVATE_KEY = new Uint8Array(32).map((_, i) => (i * 17 + 7) & 0xff);
const OTHER_PRIVATE_KEY = new Uint8Array(32).map((_, i) => (i * 19 + 9) & 0xff);
const ROOM_KID = "room-key-1";
const ROOM = "https://room.example/r/board";

function receiptPayload(sequence: number, prevHash: string | null) {
  return {
    iss: ROOM,
    aud: ROOM,
    jti: `urn:uuid:66666666-6666-4666-8666-66666666666${sequence}`,
    iat: 1_777_723_200 + sequence * 3_600,
    grp: {
      decision_id: `urn:uuid:77777777-7777-4777-8777-77777777777${sequence}`,
      decision_kind: "standing",
      room_id: ROOM,
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
      prev_hash: prevHash,
      sequence,
    },
  };
}

export interface ReceiptChainVectors {
  /** Three compact-JWS receipts; link N+1's prev_hash = sha256 of link N. */
  chain: string[];
  /** The expected `sha256:<hex>` hash of each link. */
  hashes: string[];
  /** Link 2 with one payload character flipped — signature must fail. */
  tamperedSecondLink: string;
  /** The full chain re-signed under a key the room never published. */
  wrongKeyReceipt: string;
}

async function signWith(privateKey: Uint8Array, kid: string, payload: unknown): Promise<string> {
  return signCompactJws({
    header: { alg: "EdDSA", typ: "grp-receipt+jwt", kid },
    payload,
    privateKey,
  });
}

/** Deterministic (RFC 8032): the same vectors on every run, any machine. */
export async function buildReceiptChainVectors(): Promise<ReceiptChainVectors> {
  const chain: string[] = [];
  const hashes: string[] = [];
  let prev: string | null = null;
  for (let seq = 1; seq <= 3; seq++) {
    const jws = await signWith(ROOM_PRIVATE_KEY, ROOM_KID, receiptPayload(seq, prev));
    chain.push(jws);
    prev = computeJwsReceiptHash(jws);
    hashes.push(prev);
  }

  const second = chain[1] as string;
  const [h, p, sig] = second.split(".") as [string, string, string];
  const tamperedSecondLink = `${h}.${p.slice(0, -1)}${p.endsWith("A") ? "B" : "A"}.${sig}`;

  const wrongKeyReceipt = await signWith(OTHER_PRIVATE_KEY, ROOM_KID, receiptPayload(1, null));

  return { chain, hashes, tamperedSecondLink, wrongKeyReceipt };
}

export async function receiptVectorPublicKey(): Promise<Uint8Array> {
  return ed25519.getPublicKeyAsync(ROOM_PRIVATE_KEY);
}

interface ReceiptClaims {
  iss: string;
  aud: string;
  grp: { prev_hash: string | null; sequence: number };
}

export const receiptChainCases: ConformanceCase[] = [
  {
    id: "core.receipt.chain_of_three_verifies",
    title: "three-receipt hash chain verifies link by link",
    profile: "core",
    run: async () => {
      const publicKey = await receiptVectorPublicKey();
      const { chain, hashes } = await buildReceiptChainVectors();
      let prev: string | null = null;
      for (let i = 0; i < chain.length; i++) {
        const jws = chain[i] as string;
        const decoded = await verifyCompactJws<ReceiptClaims>({ jws, publicKey });
        if (decoded.payload.grp.prev_hash !== prev) {
          throw new Error(
            `link ${i + 1}: prev_hash ${decoded.payload.grp.prev_hash} != expected ${prev}`,
          );
        }
        const hash = computeJwsReceiptHash(jws);
        if (hash !== hashes[i]) {
          throw new Error(`link ${i + 1}: hash ${hash} != expected vector hash ${hashes[i]}`);
        }
        prev = hash;
      }
    },
  },
  {
    id: "core.receipt.tampered_link_breaks_chain",
    title: "tampering one link fails signature verification",
    profile: "core",
    run: async () => {
      const publicKey = await receiptVectorPublicKey();
      const { tamperedSecondLink } = await buildReceiptChainVectors();
      let failed = false;
      try {
        await verifyCompactJws({ jws: tamperedSecondLink, publicKey });
      } catch {
        failed = true;
      }
      if (!failed) throw new Error("tampered receipt verified — chain integrity is broken");
    },
  },
  {
    id: "core.receipt.wrong_key_rejected",
    title: "receipt signed by an unpublished key is rejected even with a matching kid",
    profile: "core",
    run: async () => {
      const publicKey = await receiptVectorPublicKey();
      const { wrongKeyReceipt } = await buildReceiptChainVectors();
      let failed = false;
      try {
        await verifyCompactJws({ jws: wrongKeyReceipt, publicKey });
      } catch {
        failed = true;
      }
      if (!failed) throw new Error("receipt signed by the wrong key verified");
    },
  },
  {
    id: "core.receipt.deterministic_hash",
    title: "re-signing the identical payload reproduces the identical receipt hash",
    profile: "core",
    run: async () => {
      // Ed25519 (RFC 8032) is deterministic and JCS canonicalization is
      // byte-stable, so two independent signings of the same logical payload
      // MUST yield the same JWS bytes and therefore the same receipt hash.
      const a = await signWith(ROOM_PRIVATE_KEY, ROOM_KID, receiptPayload(1, null));
      const b = await signWith(ROOM_PRIVATE_KEY, ROOM_KID, receiptPayload(1, null));
      if (a !== b) throw new Error("signing the same payload twice produced different JWS bytes");
      if (computeJwsReceiptHash(a) !== computeJwsReceiptHash(b)) {
        throw new Error("deterministic payloads produced different receipt hashes");
      }
    },
  },
];
