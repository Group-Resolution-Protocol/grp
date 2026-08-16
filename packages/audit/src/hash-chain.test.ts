import { describe, expect, it } from "vitest";
import { nextHash, verifyChain } from "./hash-chain.js";

describe("hash chain", () => {
  it("first hash uses null prev", () => {
    const h = nextHash({
      prevHash: null,
      body: { action: "principal.signed_up", principal_id: "x" },
      ts: "2026-05-05T12:00:00Z",
    });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("subsequent hash includes prev", () => {
    const h1 = nextHash({
      prevHash: null,
      body: { x: 1 },
      ts: "2026-05-05T12:00:00Z",
    });
    const h2 = nextHash({
      prevHash: h1,
      body: { x: 2 },
      ts: "2026-05-05T12:00:01Z",
    });
    expect(h2).not.toBe(h1);
  });

  it("verifyChain accepts a valid chain", () => {
    const events = [
      { prevHash: null, body: { x: 1 }, ts: "2026-05-05T12:00:00Z" },
      { prevHash: null, body: { x: 2 }, ts: "2026-05-05T12:00:01Z" }, // prev inferred
      { prevHash: null, body: { x: 3 }, ts: "2026-05-05T12:00:02Z" },
    ];
    let prev: string | null = null;
    const hashes: string[] = [];
    for (const ev of events) {
      const h = nextHash({ ...ev, prevHash: prev });
      hashes.push(h);
      prev = h;
    }
    expect(verifyChain(events, hashes)).toBe(true);
  });

  it("verifyChain rejects a tampered body", () => {
    const events = [
      { prevHash: null, body: { x: 1 }, ts: "2026-05-05T12:00:00Z" },
      { prevHash: null, body: { x: 2 }, ts: "2026-05-05T12:00:01Z" },
    ];
    let prev: string | null = null;
    const hashes: string[] = [];
    for (const ev of events) {
      const h = nextHash({ ...ev, prevHash: prev });
      hashes.push(h);
      prev = h;
    }
    // Tamper: change the second event's body.
    const tampered = [...events];
    tampered[1] = { ...events[1]!, body: { x: 999 } };
    expect(verifyChain(tampered, hashes)).toBe(false);
  });

  it("verifyChain rejects a tampered hash", () => {
    const events = [
      { prevHash: null, body: { x: 1 }, ts: "2026-05-05T12:00:00Z" },
      { prevHash: null, body: { x: 2 }, ts: "2026-05-05T12:00:01Z" },
    ];
    let prev: string | null = null;
    const hashes: string[] = [];
    for (const ev of events) {
      const h = nextHash({ ...ev, prevHash: prev });
      hashes.push(h);
      prev = h;
    }
    hashes[1] = "0".repeat(64);
    expect(verifyChain(events, hashes)).toBe(false);
  });
});
