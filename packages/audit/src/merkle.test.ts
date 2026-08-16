import { describe, expect, it } from "vitest";
import { buildMerkleRoot } from "./merkle.js";

describe("merkle root", () => {
  it("single leaf is its own root", () => {
    const leaf = "a".repeat(64);
    const result = buildMerkleRoot([leaf]);
    expect(result.root).toBe(leaf);
    expect(result.leafCount).toBe(1);
  });

  it("two leaves hash together", () => {
    const a = "0".repeat(64);
    const b = "1".repeat(64);
    const result = buildMerkleRoot([a, b]);
    expect(result.root).not.toBe(a);
    expect(result.root).not.toBe(b);
    expect(result.root).toMatch(/^[0-9a-f]{64}$/);
  });

  it("three leaves: odd level duplicates last", () => {
    const a = "00".repeat(32);
    const b = "11".repeat(32);
    const c = "22".repeat(32);
    const r = buildMerkleRoot([a, b, c]);
    expect(r.leafCount).toBe(3);
    expect(r.root).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const leaves = Array.from({ length: 7 }, (_, i) => i.toString(16).padStart(64, "0"));
    expect(buildMerkleRoot(leaves).root).toBe(buildMerkleRoot(leaves).root);
  });

  it("rejects zero leaves", () => {
    expect(() => buildMerkleRoot([])).toThrow();
  });
});
