import { describe, expect, it } from "vitest";
import { type ScoreVoteInput, isScoreOutcomeLocked, runScoreVote } from "./score-vote.js";

describe("runScoreVote", () => {
  it("counts abstentions toward quorum without adding scores", () => {
    const r = runScoreVote({
      parameters: {
        options: ["a", "b"],
        quorum: 1,
        min_score: 0,
        max_score: 5,
        tie_break: "first_listed",
      },
      eligible_voters: 3,
      participating_voters: 3,
      votes: [{ voter_id: "v1", scores: { a: 5 } }],
      deterministic_seed: "seed",
    });
    expect(r.quorum_met).toBe(true);
    expect(r.per_option_score).toEqual({ a: 5, b: 0 });
  });

  it("selects the highest aggregate score", () => {
    const r = runScoreVote({
      parameters: {
        options: ["a", "b", "c"],
        quorum: 0,
        min_score: 0,
        max_score: 5,
        tie_break: "first_listed",
      },
      eligible_voters: 3,
      votes: [
        { voter_id: "v1", scores: { a: 5, b: 3 } },
        { voter_id: "v2", scores: { b: 5, a: 1 } },
        { voter_id: "v3", scores: { a: 4, c: 5 } },
      ],
      deterministic_seed: "seed",
    });
    expect(r.outcome).toBe("pass");
    expect(r.winner).toBe("a");
    expect(r.per_option_score).toEqual({ a: 10, b: 8, c: 5 });
  });

  it("rejects scores outside the configured range", () => {
    const r = runScoreVote({
      parameters: {
        options: ["a", "b"],
        quorum: 0,
        min_score: 0,
        max_score: 5,
        tie_break: "first_listed",
      },
      eligible_voters: 2,
      votes: [
        { voter_id: "v1", scores: { a: 10 } },
        { voter_id: "v2", scores: { b: 4 } },
      ],
      deterministic_seed: "seed",
    });
    expect(r.trace.invalid_votes).toBe(1);
    expect(r.winner).toBe("b");
  });
});

describe("isScoreOutcomeLocked (spec 152 W1)", () => {
  it("subtracts formal abstentions from the remaining-ballot bound", () => {
    const r: ScoreVoteInput = {
      parameters: {
        options: ["a", "b"],
        quorum: 1,
        min_score: 0,
        max_score: 5,
        tie_break: "first_listed",
      },
      eligible_voters: 3,
      participating_voters: 3,
      votes: [{ voter_id: "v1", scores: { a: 5 } }],
      deterministic_seed: "seed",
    };
    expect(isScoreOutcomeLocked(r)).toBe(true);
  });

  const params = {
    options: ["a", "b"],
    quorum: 0.5,
    min_score: 0,
    max_score: 5,
    tie_break: "first_listed" as const,
  };
  const input = (votes: ScoreVoteInput["votes"], eligible = 5): ScoreVoteInput => ({
    parameters: params,
    eligible_voters: eligible,
    votes,
    deterministic_seed: "seed",
  });

  it("locks when every rival trails by more than remaining × spread", () => {
    // Stage A budget shape: 3/5 cast, all 5s on one option of two. 15 vs 0,
    // 2 remaining × spread 5 = 10 < 15 — locked.
    const r = input([
      { voter_id: "v1", scores: { a: 5 } },
      { voter_id: "v2", scores: { a: 5 } },
      { voter_id: "v3", scores: { a: 5 } },
    ]);
    expect(runScoreVote(r).winner).toBe("a");
    expect(isScoreOutcomeLocked(r)).toBe(true);
  });

  it("does not lock when a remaining ballot could still flip the winner", () => {
    // 10 vs 0 with 2 remaining × spread 5 = 10: not strictly greater — a
    // max-score sweep for b plus min for a ends tied. Not locked.
    const r = input([
      { voter_id: "v1", scores: { a: 5 } },
      { voter_id: "v2", scores: { a: 5 } },
    ]);
    expect(isScoreOutcomeLocked(r)).toBe(false);
  });

  it("boundary: lead of exactly remaining×spread+1 locks", () => {
    const r: ScoreVoteInput = {
      parameters: { ...params, max_score: 10 },
      eligible_voters: 3,
      votes: [
        { voter_id: "v1", scores: { a: 10, b: 4 } },
        { voter_id: "v2", scores: { a: 10, b: 5 } },
      ],
      deterministic_seed: "seed",
    };
    // a=20, b=9, remaining 1 × spread 10 = 10 < 11 — locked.
    expect(isScoreOutcomeLocked(r)).toBe(true);
  });

  it("never locks before quorum is met", () => {
    const r = input([{ voter_id: "v1", scores: { a: 5 } }], 5);
    // 1/5 cast against quorum 0.5 — outcome is no_pass; not locked.
    expect(isScoreOutcomeLocked(r)).toBe(false);
  });

  it("locks any outcome once every eligible ballot is cast", () => {
    const r = input(
      [
        { voter_id: "v1", scores: { a: 5, b: 5 } },
        { voter_id: "v2", scores: { a: 5, b: 5 } },
      ],
      2,
    );
    expect(isScoreOutcomeLocked(r)).toBe(true);
  });

  it("respects a nonzero min_score floor in the spread", () => {
    const r: ScoreVoteInput = {
      parameters: { ...params, min_score: 3, max_score: 5 },
      eligible_voters: 3,
      votes: [
        { voter_id: "v1", scores: { a: 5, b: 3 } },
        { voter_id: "v2", scores: { a: 5, b: 3 } },
      ],
      deterministic_seed: "seed",
    };
    // a=10, b=6; remaining 1 × spread 2 = 2 < 4 — locked despite the floor.
    expect(isScoreOutcomeLocked(r)).toBe(true);
  });
});
