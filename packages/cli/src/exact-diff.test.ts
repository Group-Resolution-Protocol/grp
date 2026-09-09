import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { exactLineChanges, renderExactDiff, verifiedNativeContent } from "./exact-diff.js";

describe("exact native diff", () => {
  it("handles large adversarial replacements without recursive or spread-argument failure", () => {
    const before = "a\n".repeat(150000);
    const after = "b\n".repeat(150000);
    const { changes, fallback } = exactLineChanges(before, after);
    expect(fallback).toBe(true);
    const rendered = renderExactDiff(before, after, "r1", "r2");
    expect(rendered).toContain("Diff rendering work limit reached");
    expect(rendered).toContain(JSON.stringify(before));
    expect(rendered).toContain(JSON.stringify(after));
    expect(
      changes
        .filter((c) => c.kind !== "add")
        .map((c) => c.text)
        .join(""),
    ).toBe(before);
    expect(
      changes
        .filter((c) => c.kind !== "remove")
        .map((c) => c.text)
        .join(""),
    ).toBe(after);
  });
  const pairs: [string, string][] = [
    ["Alpha\n\nBeta\n", "Alpha\n\n\nBeta\n"],
    ["\nAlpha\n", "Alpha\n"],
    ["a\r\nb\r\n", "a\nb\n"],
    ["a\n", "a"],
    ["a ", "a\t"],
    ["", "\n"],
    ["one\ntwo\nthree\n", "three\none\ntwo\n"],
    ["a\na\nb\n", "a\nb\na\n"],
  ];
  it.each(pairs)("preserves exact before and after bytes (%#)", (before, after) => {
    for (const budget of [1, 1_000_000]) {
      const { changes } = exactLineChanges(before, after, budget);
      expect(
        changes
          .filter((c) => c.kind !== "add")
          .map((c) => c.text)
          .join(""),
      ).toBe(before);
      expect(
        changes
          .filter((c) => c.kind !== "remove")
          .map((c) => c.text)
          .join(""),
      ).toBe(after);
    }
    expect(renderExactDiff(before, after, "r1", "r2")).not.toContain("no content changes");
  });
  it("exposes separator bytes and hides only unchanged context", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join("");
    const out = renderExactDiff(before, before.replace("line 20\n", "line 20\n\n"), "r1", "r2");
    expect(out).toContain("Exact add line bytes (JSON)");
    expect(out).not.toContain("line 0\n");
    expect(out).toContain("line 19");
  });
  it("rejects mismatched hashes and does not infer native bytes from blocks", () => {
    expect(() => verifiedNativeContent({ content: "different", sha256: "0".repeat(64) })).toThrow(
      "integrity mismatch",
    );
    expect(verifiedNativeContent({ blocks: [] })).toBeNull();
    expect(
      verifiedNativeContent({ content: "", sha256: createHash("sha256").update("").digest("hex") }),
    ).toBe("");
  });
  it("reconstructs generated repeated and whitespace-heavy documents", () => {
    let seed = 17;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const pieces = ["a\n", "b\r\n", "\n", "\t\n", "🦋 ", "last"];
    for (let test = 0; test < 150; test++) {
      const make = () =>
        Array.from({ length: random() % 30 }, () => pieces[random() % pieces.length]).join("");
      const before = make();
      const after = make();
      for (const cells of [1, 1_000_000]) {
        const { changes } = exactLineChanges(before, after, cells);
        expect(
          changes
            .filter((c) => c.kind !== "add")
            .map((c) => c.text)
            .join(""),
        ).toBe(before);
        expect(
          changes
            .filter((c) => c.kind !== "remove")
            .map((c) => c.text)
            .join(""),
        ).toBe(after);
      }
    }
  });
});
