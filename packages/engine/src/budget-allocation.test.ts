import { describe, expect, it } from "vitest";
import { runBudgetAllocation } from "./budget-allocation.js";

const opts = ["env", "edu", "health"];

describe("runBudgetAllocation — simple_average", () => {
  it("averages distributions across voters", () => {
    const result = runBudgetAllocation({
      parameters: { options: opts, method: "simple_average", quorum: 0 },
      eligible_voters: 3,
      votes: [
        { voter_id: "v1", allocation: { env: 1, edu: 0, health: 0 } },
        { voter_id: "v2", allocation: { env: 0, edu: 1, health: 0 } },
        { voter_id: "v3", allocation: { env: 0, edu: 0, health: 1 } },
      ],
      deterministic_seed: "test",
    });
    expect(result.outcome).toBe("pass");
    expect(result.per_option_score.env).toBeCloseTo(1 / 3);
    expect(result.per_option_score.edu).toBeCloseTo(1 / 3);
    expect(result.per_option_score.health).toBeCloseTo(1 / 3);
  });

  it("normalizes per-voter (raw weights need not sum to 1)", () => {
    const result = runBudgetAllocation({
      parameters: { options: ["a", "b"], method: "simple_average", quorum: 0 },
      eligible_voters: 1,
      votes: [{ voter_id: "v1", allocation: { a: 100, b: 50 } }],
      deterministic_seed: "test",
    });
    // 100/150 ≈ 0.667 to a; 50/150 ≈ 0.333 to b.
    expect(result.per_option_score.a).toBeCloseTo(2 / 3);
    expect(result.per_option_score.b).toBeCloseTo(1 / 3);
  });

  it("scales to total_budget when set", () => {
    const result = runBudgetAllocation({
      parameters: { options: ["a", "b"], method: "simple_average", quorum: 0, total_budget: 1000 },
      eligible_voters: 1,
      votes: [{ voter_id: "v1", allocation: { a: 1, b: 1 } }],
      deterministic_seed: "test",
    });
    expect(result.per_option_score.a).toBeCloseTo(500);
    expect(result.per_option_score.b).toBeCloseTo(500);
  });
});

describe("runBudgetAllocation — quadratic_funding", () => {
  it("rewards breadth: many small supporters > one big supporter", () => {
    // 10 voters each give all their share to env; 1 voter gives all to edu.
    // QF: env = (10*sqrt(0.1))² = 10² * 0.1 = 10; edu = sqrt(1)² = 1.
    // env should dominate vastly.
    const tenSmall: Array<{ voter_id: string; allocation: { env: number; edu: number } }> = [];
    for (let i = 0; i < 10; i++) {
      tenSmall.push({ voter_id: `s${i}`, allocation: { env: 1, edu: 0 } });
    }
    const result = runBudgetAllocation({
      parameters: { options: ["env", "edu"], method: "quadratic_funding", quorum: 0 },
      eligible_voters: 11,
      votes: [...tenSmall, { voter_id: "big", allocation: { env: 0, edu: 1 } }],
      deterministic_seed: "test",
    });
    expect(result.per_option_score.env).toBeGreaterThan(result.per_option_score.edu! * 5);
  });

  it("matches arithmetic average when all voters allocate uniformly", () => {
    // Edge: every voter gives 50/50 to two options → QF should split 50/50 too.
    const result = runBudgetAllocation({
      parameters: { options: ["a", "b"], method: "quadratic_funding", quorum: 0 },
      eligible_voters: 4,
      votes: [
        { voter_id: "v1", allocation: { a: 1, b: 1 } },
        { voter_id: "v2", allocation: { a: 1, b: 1 } },
        { voter_id: "v3", allocation: { a: 1, b: 1 } },
        { voter_id: "v4", allocation: { a: 1, b: 1 } },
      ],
      deterministic_seed: "test",
    });
    expect(result.per_option_score.a).toBeCloseTo(0.5);
    expect(result.per_option_score.b).toBeCloseTo(0.5);
  });
});

describe("runBudgetAllocation — equal_shares", () => {
  it("produces a valid allocation summing to 1 across all options", () => {
    const result = runBudgetAllocation({
      parameters: { options: opts, method: "equal_shares", quorum: 0 },
      eligible_voters: 4,
      votes: [
        { voter_id: "v1", allocation: { env: 1, edu: 0, health: 0 } },
        { voter_id: "v2", allocation: { env: 1, edu: 0, health: 0 } },
        { voter_id: "v3", allocation: { env: 0, edu: 1, health: 0 } },
        { voter_id: "v4", allocation: { env: 0, edu: 0, health: 1 } },
      ],
      deterministic_seed: "test",
    });
    expect(result.outcome).toBe("pass");
    const sum = Object.values(result.per_option_score).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
    // Every option that had at least one supporter should get nonzero.
    expect(result.per_option_score.env!).toBeGreaterThan(0);
    expect(result.per_option_score.edu!).toBeGreaterThan(0);
    expect(result.per_option_score.health!).toBeGreaterThan(0);
  });

  it("respects proportional fairness — 3-to-1 supporter ratio yields ~3x allocation", () => {
    const result = runBudgetAllocation({
      parameters: { options: ["popular", "niche"], method: "equal_shares", quorum: 0 },
      eligible_voters: 4,
      votes: [
        { voter_id: "v1", allocation: { popular: 1, niche: 0 } },
        { voter_id: "v2", allocation: { popular: 1, niche: 0 } },
        { voter_id: "v3", allocation: { popular: 1, niche: 0 } },
        { voter_id: "v4", allocation: { popular: 0, niche: 1 } },
      ],
      deterministic_seed: "test",
    });
    // 3 voters x 0.25 budget each = 0.75 for popular; 1 voter x 0.25 = 0.25 for niche.
    // Ratio = 3:1.
    expect(result.per_option_score.popular!).toBeCloseTo(0.75, 2);
    expect(result.per_option_score.niche!).toBeCloseTo(0.25, 2);
  });
});

describe("runBudgetAllocation — common behavior", () => {
  it("fails quorum cleanly", () => {
    const result = runBudgetAllocation({
      parameters: { options: opts, method: "simple_average", quorum: 0.8 },
      eligible_voters: 10,
      votes: [{ voter_id: "v1", allocation: { env: 1, edu: 0, health: 0 } }],
      deterministic_seed: "test",
    });
    expect(result.outcome).toBe("no_pass");
    expect(result.quorum_met).toBe(false);
  });

  it("treats negative/NaN/zero weights as 0 (and an all-zero vote as invalid)", () => {
    const result = runBudgetAllocation({
      parameters: { options: ["a", "b"], method: "simple_average", quorum: 0 },
      eligible_voters: 3,
      votes: [
        { voter_id: "v1", allocation: { a: 1, b: 0 } },
        { voter_id: "v2", allocation: { a: -5, b: Number.NaN } }, // all-zero after sanitize → invalid
        { voter_id: "v3", allocation: { a: 0, b: 1 } },
      ],
      deterministic_seed: "test",
    });
    expect(result.trace.invalid_votes).toBe(1);
    expect(result.cast_votes).toBe(2);
  });

  it("dedupes voter_id (last-write-wins)", () => {
    const result = runBudgetAllocation({
      parameters: { options: ["a", "b"], method: "simple_average", quorum: 0 },
      eligible_voters: 1,
      votes: [
        { voter_id: "v1", allocation: { a: 1, b: 0 } },
        { voter_id: "v1", allocation: { a: 0, b: 1 } }, // overrides
      ],
      deterministic_seed: "test",
    });
    expect(result.cast_votes).toBe(1);
    expect(result.trace.duplicate_voter_ids).toContain("v1");
    expect(result.per_option_score.b).toBeCloseTo(1);
  });

  it("rejects unknown method with a clear error", () => {
    expect(() =>
      runBudgetAllocation({
        // @ts-expect-error — testing rejection of bad method
        parameters: { options: ["a"], method: "made_up", quorum: 0 },
        eligible_voters: 1,
        votes: [{ voter_id: "v1", allocation: { a: 1 } }],
        deterministic_seed: "test",
      }),
    ).toThrowError(/unknown method/);
  });
});
