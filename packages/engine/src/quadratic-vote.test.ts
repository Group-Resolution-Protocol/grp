import { describe, expect, it } from "vitest";
import {
  type QuadraticVoteInput,
  isQuadraticOutcomeLocked,
  runQuadraticVote,
} from "./quadratic-vote.js";

describe("runQuadraticVote", () => {
  it("counts abstentions toward quorum without adding credits", () => {
    const r = runQuadraticVote({
      parameters: {
        options: ["a", "b"],
        quorum: 1,
        credits_per_voter: 9,
        tie_break: "first_listed",
      },
      eligible_voters: 3,
      participating_voters: 3,
      votes: [{ voter_id: "v1", allocation: { a: 4 } }],
      deterministic_seed: "seed",
    });
    expect(r.quorum_met).toBe(true);
    expect(r.per_option_score.b).toBe(0);
  });

  it("turns credit allocations into square-root vote strength", () => {
    const r = runQuadraticVote({
      parameters: {
        options: ["a", "b"],
        quorum: 0,
        credits_per_voter: 9,
        tie_break: "first_listed",
      },
      eligible_voters: 3,
      votes: [
        { voter_id: "v1", allocation: { a: 9 } },
        { voter_id: "v2", allocation: { b: 4 } },
        { voter_id: "v3", allocation: { b: 4 } },
      ],
      deterministic_seed: "seed",
    });
    expect(r.outcome).toBe("pass");
    expect(r.winner).toBe("b");
    expect(r.per_option_score.a).toBe(3);
    expect(r.per_option_score.b).toBe(4);
  });

  it("rejects ballots that overspend the credit budget", () => {
    const r = runQuadraticVote({
      parameters: {
        options: ["a", "b"],
        quorum: 0,
        credits_per_voter: 9,
        tie_break: "first_listed",
      },
      eligible_voters: 2,
      votes: [
        { voter_id: "v1", allocation: { a: 10 } },
        { voter_id: "v2", allocation: { b: 1 } },
      ],
      deterministic_seed: "seed",
    });
    expect(r.trace.invalid_votes).toBe(1);
    expect(r.winner).toBe("b");
  });
});

describe("isQuadraticOutcomeLocked (spec 152 W1)", () => {
  const params = {
    options: ["a", "b"],
    quorum: 0.5,
    credits_per_voter: 9,
    tie_break: "first_listed" as const,
  };

  it("locks when rivals trail by more than remaining × sqrt(credits)", () => {
    const r: QuadraticVoteInput = {
      parameters: params,
      eligible_voters: 3,
      votes: [
        { voter_id: "v1", allocation: { a: 9 } },
        { voter_id: "v2", allocation: { a: 9 } },
      ],
      deterministic_seed: "seed",
    };
    // a=6, b=0; remaining 1 × sqrt(9)=3 < 6 — locked.
    expect(isQuadraticOutcomeLocked(r)).toBe(true);
  });

  it("does not lock when a remaining allocation could catch the winner", () => {
    const r: QuadraticVoteInput = {
      parameters: params,
      eligible_voters: 3,
      votes: [
        { voter_id: "v1", allocation: { a: 4, b: 1 } },
        { voter_id: "v2", allocation: { a: 1, b: 4 } },
      ],
      deterministic_seed: "seed",
    };
    // a=3, b=3 → tie is not even a pass; and margins are within reach.
    expect(isQuadraticOutcomeLocked(r)).toBe(false);
  });

  it("locks any outcome once every eligible ballot is cast", () => {
    const r: QuadraticVoteInput = {
      parameters: params,
      eligible_voters: 2,
      votes: [
        { voter_id: "v1", allocation: { a: 4 } },
        { voter_id: "v2", allocation: { b: 4 } },
      ],
      deterministic_seed: "seed",
    };
    expect(isQuadraticOutcomeLocked(r)).toBe(true);
  });

  it("never locks before quorum is met", () => {
    const r: QuadraticVoteInput = {
      parameters: params,
      eligible_voters: 5,
      votes: [{ voter_id: "v1", allocation: { a: 9 } }],
      deterministic_seed: "seed",
    };
    expect(isQuadraticOutcomeLocked(r)).toBe(false);
  });
});
