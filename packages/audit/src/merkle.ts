// Per spec 104 — Merkle tree builder for daily root publication.
// Binary tree, SHA-256, leaves are event hashes (hex strings, lowercase),
// deterministic ordering by (ts, id). Odd-leaf level: duplicate the last leaf.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export interface MerkleResult {
  root: string;
  leafCount: number;
}

export function buildMerkleRoot(leaves: string[]): MerkleResult {
  if (leaves.length === 0) {
    throw new Error("buildMerkleRoot: cannot build a tree with zero leaves");
  }
  let level = leaves.map((l) => l.toLowerCase());
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      if (!a) throw new Error("buildMerkleRoot: undefined leaf");
      const b = level[i + 1] ?? a; // duplicate last leaf at odd levels
      next.push(hashPair(a, b));
    }
    level = next;
  }
  const root = level[0];
  if (!root) throw new Error("buildMerkleRoot: empty result");
  return { root, leafCount: leaves.length };
}

function hashPair(a: string, b: string): string {
  return bytesToHex(sha256.create().update(hexToBytes(a)).update(hexToBytes(b)).digest());
}
