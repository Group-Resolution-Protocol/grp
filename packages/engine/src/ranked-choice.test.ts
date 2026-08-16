import { describe, expect, it } from "vitest";
import { runRankedChoice } from "./ranked-choice.js";

const opts = ["a", "b", "c", "d"];

describe("runRankedChoice (IRV)", () => {
  it("counts abstentions toward quorum without adding a ranking", () => {
    const r = runRankedChoice({
      parameters: { options: ["a", "b"], quorum: 1, tie_break: "first_listed" },
      eligible_voters: 3,
      participating_voters: 3,
      votes: [{ voter_id: "v1", ranking: ["a"] }],
      deterministic_seed: "seed",
    });
    expect(r.quorum_met).toBe(true);
    expect(r.cast_votes).toBe(1);
    expect(r.winner).toBe("a");
  });

  it("first-round majority wins immediately", () => {
    const result = runRankedChoice({
      parameters: { options: opts, quorum: 0.0, tie_break: "first_listed" },
      eligible_voters: 5,
      votes: [
        { voter_id: "v1", ranking: ["a", "b"] },
        { voter_id: "v2", ranking: ["a", "c"] },
        { voter_id: "v3", ranking: ["a", "d"] },
        { voter_id: "v4", ranking: ["b", "a"] },
        { voter_id: "v5", ranking: ["c", "a"] },
      ],
      deterministic_seed: "test",
    });
    expect(result.outcome).toBe("pass");
    expect(result.winner).toBe("a");
    expect(result.trace.rounds.length).toBe(1);
  });

  it("eliminates lowest + redistributes through to a majority", () => {
    // Round 1: a=2, b=2, c=1 → eliminate c
    // c's voter ranked c, a → goes to a
    // Round 2: a=3, b=2 → a wins (majority of 5 active)
    const result = runRankedChoice({
      parameters: { options: ["a", "b", "c"], quorum: 0.0, tie_break: "first_listed" },
      eligible_voters: 5,
      votes: [
        { voter_id: "v1", ranking: ["a", "b"] },
        { voter_id: "v2", ranking: ["a", "b"] },
        { voter_id: "v3", ranking: ["b", "a"] },
        { voter_id: "v4", ranking: ["b", "a"] },
        { voter_id: "v5", ranking: ["c", "a"] },
      ],
      deterministic_seed: "test",
    });
    expect(result.outcome).toBe("pass");
    expect(result.winner).toBe("a");
    expect(result.trace.rounds.length).toBe(2);
    expect(result.trace.rounds[0]?.eliminated).toEqual(["c"]);
  });

  it("fails quorum cleanly", () => {
    const result = runRankedChoice({
      parameters: { options: opts, quorum: 0.8, tie_break: "first_listed" },
      eligible_voters: 10,
      votes: [
        { voter_id: "v1", ranking: ["a", "b"] },
        { voter_id: "v2", ranking: ["a", "b"] },
      ],
      deterministic_seed: "test",
    });
    expect(result.outcome).toBe("no_pass");
    expect(result.quorum_met).toBe(false);
  });

  it("exhausted ballots count toward elimination math but not toward winning majority", () => {
    // Round 1: a=2, b=1, c=1 → eliminate b and c tied at bottom → first_listed
    // eliminates `c` (last in ballot among the tied set).
    // After round 1 elim of c, c's voter (ranking [c]) exhausts.
    // Round 2: a=2, b=1, with 1 exhausted → a is the most but only 2/3 active = >50% → wins.
    const result = runRankedChoice({
      parameters: { options: ["a", "b", "c"], quorum: 0.0, tie_break: "first_listed" },
      eligible_voters: 4,
      votes: [
        { voter_id: "v1", ranking: ["a"] },
        { voter_id: "v2", ranking: ["a"] },
        { voter_id: "v3", ranking: ["b"] },
        { voter_id: "v4", ranking: ["c"] }, // exhausts after c eliminated
      ],
      deterministic_seed: "test",
    });
    expect(result.outcome).toBe("pass");
    expect(result.winner).toBe("a");
  });

  it("first_listed tie-break at the bottom: eliminates the option appearing LAST in the options list", () => {
    // Round 1: a=1, b=1 tied at top AND bottom (2-way race, both options at 1).
    // first_listed keeps `a` (earliest in options) and eliminates `b`.
    // Round 2: only `a` remains → a wins as sole survivor.
    const result = runRankedChoice({
      parameters: { options: ["a", "b"], quorum: 0.0, tie_break: "first_listed" },
      eligible_voters: 2,
      votes: [
        { voter_id: "v1", ranking: ["a"] },
        { voter_id: "v2", ranking: ["b"] },
      ],
      deterministic_seed: "test",
    });
    expect(result.outcome).toBe("pass");
    expect(result.winner).toBe("a");
    expect(result.trace.rounds[0]?.eliminated).toEqual(["b"]);
  });

  it("no_pass tie-break surrenders on bottom-tie", () => {
    const result = runRankedChoice({
      parameters: { options: ["a", "b"], quorum: 0.0, tie_break: "no_pass" },
      eligible_voters: 2,
      votes: [
        { voter_id: "v1", ranking: ["a"] },
        { voter_id: "v2", ranking: ["b"] },
      ],
      deterministic_seed: "test",
    });
    expect(result.outcome).toBe("tied");
    expect(result.winner).toBeNull();
    expect(result.trace.tie_resolution_reason).toMatch(/no_pass tie-break/);
  });

  it("random_seeded tie-break is deterministic across runs with the same seed", () => {
    const input = {
      parameters: { options: ["a", "b"], quorum: 0.0, tie_break: "random_seeded" as const },
      eligible_voters: 2,
      votes: [
        { voter_id: "v1", ranking: ["a"] },
        { voter_id: "v2", ranking: ["b"] },
      ],
      deterministic_seed: "fixed-seed-42",
    };
    const r1 = runRankedChoice(input);
    const r2 = runRankedChoice(input);
    expect(r1.outcome).toBe("pass");
    expect(r1.winner).toBe(r2.winner);
  });

  it("strips invalid options + dedupes within a single ranking", () => {
    const result = runRankedChoice({
      parameters: { options: ["a", "b"], quorum: 0.0, tie_break: "first_listed" },
      eligible_voters: 2,
      votes: [
        { voter_id: "v1", ranking: ["a", "nonsense", "a", "b"] }, // → ["a", "b"]
        { voter_id: "v2", ranking: ["b"] },
      ],
      deterministic_seed: "test",
    });
    expect(result.outcome).toBe("pass");
    // Tied a=1, b=1; first_listed survives a, eliminates b. → a wins.
    expect(result.winner).toBe("a");
  });

  it("rejects empty rankings as invalid", () => {
    const result = runRankedChoice({
      parameters: { options: ["a", "b"], quorum: 0.0, tie_break: "first_listed" },
      eligible_voters: 3,
      votes: [
        { voter_id: "v1", ranking: ["a"] },
        { voter_id: "v2", ranking: [] }, // invalid
        { voter_id: "v3", ranking: ["nonsense"] }, // invalid (filtered to empty)
      ],
      deterministic_seed: "test",
    });
    expect(result.trace.invalid_votes).toBe(2);
    expect(result.cast_votes).toBe(1);
  });

  it("dedupes voter_id last-write-wins", () => {
    const result = runRankedChoice({
      parameters: { options: ["a", "b"], quorum: 0.0, tie_break: "first_listed" },
      eligible_voters: 1,
      votes: [
        { voter_id: "v1", ranking: ["a"] },
        { voter_id: "v1", ranking: ["b"] }, // overrides
      ],
      deterministic_seed: "test",
    });
    expect(result.cast_votes).toBe(1);
    expect(result.trace.duplicate_voter_ids).toContain("v1");
    expect(result.winner).toBe("b");
  });
});
