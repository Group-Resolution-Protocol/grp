import { describe, expect, it } from "vitest";
import { runRankedPairwise } from "./ranked-pairwise.js";

describe("runRankedPairwise", () => {
  it("counts abstentions toward quorum without adding pairwise preferences", () => {
    const r = runRankedPairwise({
      parameters: { options: ["a", "b"], quorum: 1, tie_break: "first_listed" },
      eligible_voters: 3,
      participating_voters: 3,
      votes: [{ voter_id: "v1", ranking: ["a", "b"] }],
      deterministic_seed: "seed",
    });
    expect(r.quorum_met).toBe(true);
    expect(r.cast_votes).toBe(1);
    expect(r.winner).toBe("a");
  });

  it("selects the Condorcet winner when one exists", () => {
    const r = runRankedPairwise({
      parameters: { options: ["a", "b", "c"], quorum: 0, tie_break: "first_listed" },
      eligible_voters: 5,
      votes: [
        { voter_id: "v1", ranking: ["b", "a", "c"] },
        { voter_id: "v2", ranking: ["b", "c", "a"] },
        { voter_id: "v3", ranking: ["a", "b", "c"] },
        { voter_id: "v4", ranking: ["c", "b", "a"] },
        { voter_id: "v5", ranking: ["a", "b", "c"] },
      ],
      deterministic_seed: "seed",
    });
    expect(r.outcome).toBe("pass");
    expect(r.winner).toBe("b");
    expect(r.trace.pairwise_preferences.b?.a).toBeGreaterThan(
      r.trace.pairwise_preferences.a?.b ?? 0,
    );
    expect(r.trace.pairwise_preferences.b?.c).toBeGreaterThan(
      r.trace.pairwise_preferences.c?.b ?? 0,
    );
  });

  it("is deterministic under seeded top ties", () => {
    const input = {
      parameters: {
        options: ["a", "b"],
        quorum: 0,
        tie_break: "random_seeded" as const,
      },
      eligible_voters: 2,
      votes: [
        { voter_id: "v1", ranking: ["a", "b"] },
        { voter_id: "v2", ranking: ["b", "a"] },
      ],
      deterministic_seed: "seed",
    };
    const r1 = runRankedPairwise(input);
    const r2 = runRankedPairwise(input);
    expect(r1.outcome).toBe("pass");
    expect(r1.winner).toBe(r2.winner);
  });
});
