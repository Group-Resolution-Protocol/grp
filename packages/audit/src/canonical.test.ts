// Per spec 104 — canonical JSON tests. These are property-level guarantees
// the hash chain depends on; if any of them regress, the audit chain
// becomes invalid retroactively.

import { describe, expect, it } from "vitest";
import { CanonicalizationError, canonicalize } from "./canonical.js";

describe("canonicalize (RFC 8785)", () => {
  it("primitives", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
    expect(canonicalize(0)).toBe("0");
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize(-42)).toBe("-42");
    expect(canonicalize("hello")).toBe(`"hello"`);
  });

  it("sorts object keys lexicographically", () => {
    expect(canonicalize({ b: 1, a: 2, c: 3 })).toBe(`{"a":2,"b":1,"c":3}`);
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("nested objects sort recursively", () => {
    const v = { z: { y: 1, x: 2 }, a: [{ d: 1, c: 2 }] };
    expect(canonicalize(v)).toBe(`{"a":[{"c":2,"d":1}],"z":{"x":2,"y":1}}`);
  });

  it("rejects undefined", () => {
    expect(() => canonicalize(undefined)).toThrow(CanonicalizationError);
  });

  it("rejects bigint", () => {
    expect(() => canonicalize({ x: 1n })).toThrow(CanonicalizationError);
  });

  it("rejects NaN / Infinity", () => {
    expect(() => canonicalize(Number.NaN)).toThrow(CanonicalizationError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(CanonicalizationError);
  });

  it("is idempotent", () => {
    const v = { c: 1, a: { y: [3, 2, 1], x: "x" }, b: null };
    const once = canonicalize(v);
    const twice = canonicalize(JSON.parse(once));
    expect(twice).toBe(once);
  });

  it("preserves Unicode strings exactly without NFC normalization", () => {
    // 'é' as composed (U+00E9) vs decomposed (U+0065 U+0301)
    const composed = "café";
    const decomposed = "café";
    expect(canonicalize(composed)).not.toBe(canonicalize(decomposed));
    expect(canonicalize(composed)).toBe(JSON.stringify(composed));
    expect(canonicalize(decomposed)).toBe(JSON.stringify(decomposed));
  });

  it("preserves property names exactly without normalization", () => {
    const composed = "é";
    const decomposed = "é";
    expect(canonicalize({ [composed]: 1, [decomposed]: 2 })).toBe(
      `{${JSON.stringify(decomposed)}:2,${JSON.stringify(composed)}:1}`,
    );
  });

  it("rejects lone UTF-16 surrogates in values and property names", () => {
    expect(() => canonicalize("\ud800")).toThrow(CanonicalizationError);
    expect(() => canonicalize("\udead")).toThrow(CanonicalizationError);
    expect(() => canonicalize(Object.fromEntries([["\ud800", true]]))).toThrow(
      CanonicalizationError,
    );
    expect(canonicalize("😀")).toBe('"😀"');
  });

  it("matches RFC 8785 Appendix B number samples", () => {
    const fromBits = (hex: string): number => {
      const bytes = new Uint8Array(8);
      const bits = BigInt(`0x${hex}`);
      for (let i = 7; i >= 0; i--) {
        bytes[i] = Number((bits >> BigInt((7 - i) * 8)) & 0xffn);
      }
      return new DataView(bytes.buffer).getFloat64(0, false);
    };
    const samples = [
      ["0000000000000000", "0"],
      ["8000000000000000", "0"],
      ["0000000000000001", "5e-324"],
      ["8000000000000001", "-5e-324"],
      ["7fefffffffffffff", "1.7976931348623157e+308"],
      ["4340000000000000", "9007199254740992"],
      ["4430000000000000", "295147905179352830000"],
      ["44b52d02c7e14af6", "1e+23"],
      ["444b1ae4d6e2ef50", "1e+21"],
      ["3eb0c6f7a0b5ed8d", "0.000001"],
      ["becbf647612f3696", "-0.0000033333333333333333"],
      ["43143ff3c1cb0959", "1424953923781206.2"],
    ] as const;
    for (const [bits, expected] of samples) {
      expect(canonicalize(fromBits(bits))).toBe(expected);
    }
  });

  it("matches a known fixture", () => {
    const fixture = {
      principal: { handle: "alice", privacy_mode: "pseudonymous" },
      ts: "2026-05-05T12:00:00Z",
      action: "constitution.signed",
      version: 1,
    };
    expect(canonicalize(fixture)).toBe(
      `{"action":"constitution.signed","principal":{"handle":"alice","privacy_mode":"pseudonymous"},"ts":"2026-05-05T12:00:00Z","version":1}`,
    );
  });
});
