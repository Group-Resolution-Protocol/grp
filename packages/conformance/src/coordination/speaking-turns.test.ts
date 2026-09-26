import { describe, expect, it } from "vitest";
import { validateSpeakingTurnProjection } from "./speaking-turns.js";

const expires = "2026-01-01T00:05:00.000Z";
function held(): Record<string, unknown> {
  return {
    policy: "speaking_turns",
    revision: "9007199254740993",
    concluded: false,
    holder: {
      participant_id: "alice",
      request_id: "request-a",
      epoch: "9007199254740993",
      expires_at: expires,
      max_until: "2026-01-01T00:10:00.000Z",
    },
    own: { request_id: "request-a", status: "held", queue_position: null, expires_at: expires },
    next_deadline_at: expires,
  };
}
const check = (v: unknown) => validateSpeakingTurnProjection(v, { surface: "read" });

describe("candidate speaking-turn wire validation (offline, not host certification)", () => {
  it("accepts decimal strings above the JS safe integer range without coercion", () => {
    expect(() =>
      check({ ...held(), observation: "opaque-proof", future_field: true }),
    ).not.toThrow();
  });
  it("accepts a queued participant looking at another holder", () => {
    expect(() =>
      check({
        ...held(),
        own: {
          request_id: "request-b",
          status: "queued",
          queue_position: 1,
          expires_at: "2026-01-01T00:20:00.000Z",
        },
        observation: null,
      }),
    ).not.toThrow();
  });
  it("accepts an idle or concluded room and a terminal target", () => {
    for (const concluded of [false, true]) {
      expect(() =>
        validateSpeakingTurnProjection(
          {
            policy: "speaking_turns",
            revision: "0",
            concluded,
            holder: null,
            own: null,
            next_deadline_at: null,
            target: { request_id: "old-request", status: concluded ? "concluded" : "completed" },
          },
          { surface: "wait" },
        ),
      ).not.toThrow();
    }
  });
  it("accepts a terminal old target while a different request is held", () => {
    expect(() =>
      validateSpeakingTurnProjection(
        {
          ...held(),
          target: {
            request_id: "old-request",
            status: "expired",
          },
        },
        { surface: "wait" },
      ),
    ).not.toThrow();
  });
  it.each(["operation", "wait"] as const)(
    "rejects observations from %s, including null",
    (surface) => {
      for (const observation of [null, "opaque-proof"]) {
        expect(() =>
          validateSpeakingTurnProjection({ ...held(), observation }, { surface }),
        ).toThrow(/non-read/);
      }
    },
  );
  it.each([null, [], "state", {}])("rejects a missing or malformed root %j", (value) => {
    expect(() => check(value)).toThrow();
  });
  it.each(["policy", "revision", "concluded", "holder", "own", "next_deadline_at"])(
    "requires %s",
    (field) => {
      const v = held();
      delete v[field];
      expect(() => check(v)).toThrow();
    },
  );
  it("rejects numeric epochs and revisions", () => {
    expect(() => check({ ...held(), revision: 2 })).toThrow();
    const v = held();
    (v.holder as Record<string, unknown>).epoch = 2;
    expect(() => check(v)).toThrow();
  });
  it("rejects a held request with no matching holder", () => {
    expect(() => check({ ...held(), holder: null })).toThrow(/matching holder/);
  });
  it("rejects lease/maximum and own/holder expiry inconsistencies", () => {
    const v = held();
    (v.holder as Record<string, unknown>).max_until = "2026-01-01T00:04:00.000Z";
    expect(() => check(v)).toThrow(/maximum tenure/);
    const w = held();
    (w.own as Record<string, unknown>).expires_at = "2026-01-01T00:04:00.000Z";
    expect(() => check(w)).toThrow(/lease mismatch/);
  });
  it("rejects invalid dates, queue positions, statuses and concluded live work", () => {
    expect(() => check({ ...held(), next_deadline_at: "not-a-date" })).toThrow();
    expect(() => check({ ...held(), concluded: true })).toThrow(/live work/);
    for (const queue_position of [0, -1, 1.5, null, "1"]) {
      expect(() =>
        check({
          ...held(),
          own: { request_id: "b", status: "queued", queue_position, expires_at: expires },
        }),
      ).toThrow();
    }
    expect(() =>
      check({ ...held(), own: { request_id: "b", status: "completed", expires_at: expires } }),
    ).toThrow();
  });
  it("rejects a missing or late deadline for live work", () => {
    expect(() => check({ ...held(), next_deadline_at: null })).toThrow();
    expect(() => check({ ...held(), next_deadline_at: "2026-01-01T00:06:00.000Z" })).toThrow();
  });
  it("rejects a queued observation or mismatched granted/waiting target", () => {
    expect(() => check({ ...held(), own: null, observation: "proof" })).toThrow();
    for (const status of ["granted", "waiting", "unknown"]) {
      expect(() => check({ ...held(), target: { request_id: "other", status } })).toThrow();
    }
  });
});
