// Per spec 110 — generic_vote unit + property tests.
// Property tests cover the math correctness commitments from spec 110:
// monotonicity (more votes for winner can never make winner lose),
// permutation invariance (vote order doesn't matter),
// determinism (same input → same output).

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMETERS,
  GenericVoteError,
  type GenericVoteParameters,
  type VoteInput,
  isOutcomeLocked,
  runGenericVote,
} from "./generic-vote.js";

const SEED = "deadbeef".repeat(8);

const yesNo = (yes: number, no: number): VoteInput[] => {
  const out: VoteInput[] = [];
  for (let i = 0; i < yes; i++) out.push({ voter_id: `y${i}`, choice: "yes" });
  for (let i = 0; i < no; i++) out.push({ voter_id: `n${i}`, choice: "no" });
  return out;
};

describe("generic_vote — basic outcomes", () => {
  it("counts abstentions toward quorum without adding option support", () => {
    const r = runGenericVote({
      parameters: { ...DEFAULT_PARAMETERS, quorum: 1 },
      eligible_voters: 3,
      participating_voters: 3,
      votes: [{ voter_id: "v1", choice: "yes" }],
      deterministic_seed: SEED,
    });
    expect(r.quorum_met).toBe(true);
    expect(r.cast_votes).toBe(1);
    expect(r.per_option_score).toEqual({ yes: 1, no: 0 });
  });

  it("simple majority: 6 yes / 4 no with quorum 40% / threshold 50% → yes", () => {
    const r = runGenericVote({
      parameters: DEFAULT_PARAMETERS,
      eligible_voters: 10,
      votes: yesNo(6, 4),
      deterministic_seed: SEED,
    });
    expect(r.outcome).toBe("pass");
    expect(r.winner).toBe("yes");
    expect(r.per_option_score).toEqual({ yes: 6, no: 4 });
  });

  it("simple majority: a unique leader at exactly 50% does not pass", () => {
    const r = runGenericVote({
      parameters: { ...DEFAULT_PARAMETERS, options: ["a", "b", "c"] },
      eligible_voters: 4,
      votes: [
        { voter_id: "1", choice: "a" },
        { voter_id: "2", choice: "a" },
        { voter_id: "3", choice: "b" },
        { voter_id: "4", choice: "c" },
      ],
      deterministic_seed: SEED,
    });
    expect(r.outcome).toBe("no_pass");
    expect(r.winner).toBeNull();
    expect(r.threshold_met).toBe(false);
  });

  it("inclusive supermajority passes at exactly two thirds", () => {
    const r = runGenericVote({
      parameters: {
        ...DEFAULT_PARAMETERS,
        pass_threshold: 2 / 3,
        pass_threshold_comparison: "inclusive",
      },
      eligible_voters: 3,
      votes: yesNo(2, 1),
      deterministic_seed: SEED,
    });
    expect(r.outcome).toBe("pass");
    expect(r.winner).toBe("yes");
    expect(r.threshold_met).toBe(true);
  });

  it("supermajority via pass_threshold=2/3: 6 yes / 4 no fails", () => {
    const r = runGenericVote({
      parameters: { ...DEFAULT_PARAMETERS, pass_threshold: 2 / 3 },
      eligible_voters: 10,
      votes: yesNo(6, 4),
      deterministic_seed: SEED,
    });
    expect(r.outcome).toBe("no_pass");
    expect(r.winner).toBeNull();
    expect(r.threshold_met).toBe(false);
  });

  it("quorum failure: 2 yes / 1 no but quorum 0.4 of 10 → no_pass", () => {
    // 3 votes / 10 eligible = 30% < 40% quorum
    const r = runGenericVote({
      parameters: DEFAULT_PARAMETERS,
      eligible_voters: 10,
      votes: yesNo(2, 1),
      deterministic_seed: SEED,
    });
    expect(r.outcome).toBe("no_pass");
    expect(r.quorum_met).toBe(false);
  });

  it("quorum boundary: 4 votes / 10 eligible at quorum=0.4 meets quorum (>=)", () => {
    const r = runGenericVote({
      parameters: DEFAULT_PARAMETERS,
      eligible_voters: 10,
      votes: yesNo(3, 1),
      deterministic_seed: SEED,
    });
    expect(r.quorum_met).toBe(true);
    // 3/4 = 75% > 50% threshold → yes wins
    expect(r.outcome).toBe("pass");
    expect(r.winner).toBe("yes");
  });

  it("tie with no_pass tie-break → tied", () => {
    const r = runGenericVote({
      parameters: { ...DEFAULT_PARAMETERS, options: ["a", "b", "c"] },
      eligible_voters: 6,
      votes: [
        { voter_id: "1", choice: "a" },
        { voter_id: "2", choice: "a" },
        { voter_id: "3", choice: "b" },
        { voter_id: "4", choice: "b" },
        { voter_id: "5", choice: "c" },
        { voter_id: "6", choice: "c" },
      ],
      deterministic_seed: SEED,
    });
    // Each option gets 2/6 = 33% — below pass_threshold of 50%.
    expect(r.outcome).toBe("no_pass");
  });

  it("tie above threshold + first_listed → first option wins", () => {
    // 4-way tie at 25% each, threshold 25%. Should pick 'a' as listed first.
    const r = runGenericVote({
      parameters: {
        options: ["a", "b", "c", "d"],
        ballot_mode: "single_choice",
        quorum: 0.5,
        pass_threshold: 0.25,
        tie_break: "first_listed",
      },
      eligible_voters: 4,
      votes: [
        { voter_id: "1", choice: "a" },
        { voter_id: "2", choice: "b" },
        { voter_id: "3", choice: "c" },
        { voter_id: "4", choice: "d" },
      ],
      deterministic_seed: SEED,
    });
    expect(r.outcome).toBe("pass");
    expect(r.winner).toBe("a");
    expect(r.trace.tie_resolution_reason).toContain("first_listed");
  });

  it("approval ballot_mode: voter casts multi-choice", () => {
    const r = runGenericVote({
      parameters: {
        options: ["a", "b", "c"],
        ballot_mode: "approval",
        quorum: 0.5,
        pass_threshold: 0.5,
        tie_break: "no_pass",
      },
      eligible_voters: 4,
      votes: [
        { voter_id: "1", choice: ["a", "b"] },
        { voter_id: "2", choice: ["a"] },
        { voter_id: "3", choice: ["a", "c"] },
        { voter_id: "4", choice: ["b"] },
      ],
      deterministic_seed: SEED,
    });
    expect(r.per_option_score.a).toBe(3);
    expect(r.per_option_score.b).toBe(2);
    expect(r.per_option_score.c).toBe(1);
    // a hits 3/4 = 75% > 50% threshold → pass with winner=a
    expect(r.outcome).toBe("pass");
    expect(r.winner).toBe("a");
  });

  it("plurality fallthrough: 1-1-1 split at K=3 picks top via random_seeded", () => {
    // The exact K-sweep failure: K=3 with three different votes, no option
    // hits 50%. Without plurality, this is the no_pass abort the K-sweep saw
    // 10/10 times at K>1. With plurality_fallthrough + random_seeded tie_break,
    // a winner gets picked.
    const r = runGenericVote({
      parameters: {
        options: ["e2e4", "d2d4", "g1f3"],
        ballot_mode: "single_choice",
        quorum: 0.33, // 1 of 3 voters required
        pass_threshold: 0.5,
        tie_break: "random_seeded",
        plurality_fallthrough: true,
      },
      eligible_voters: 3,
      votes: [
        { voter_id: "1", choice: "e2e4" },
        { voter_id: "2", choice: "d2d4" },
        { voter_id: "3", choice: "g1f3" },
      ],
      deterministic_seed: SEED,
    });
    expect(r.outcome).toBe("plurality_pass");
    expect(r.winner).not.toBeNull();
    expect(["e2e4", "d2d4", "g1f3"]).toContain(r.winner);
    expect(r.threshold_met).toBe(false);
    expect(r.quorum_met).toBe(true);
    expect(r.trace.tie_resolution_reason).toContain("plurality_fallthrough");
  });

  it("plurality fallthrough: 2-1-1-1 picks the unambiguous leader", () => {
    // K=5 with the leader at 2/5 = 40% (below 50% threshold). No tiebreak
    // needed — plurality cleanly picks the leader.
    const r = runGenericVote({
      parameters: {
        options: ["a", "b", "c", "d"],
        ballot_mode: "single_choice",
        quorum: 0.2,
        pass_threshold: 0.5,
        tie_break: "no_pass",
        plurality_fallthrough: true,
      },
      eligible_voters: 5,
      votes: [
        { voter_id: "1", choice: "a" },
        { voter_id: "2", choice: "a" },
        { voter_id: "3", choice: "b" },
        { voter_id: "4", choice: "c" },
        { voter_id: "5", choice: "d" },
      ],
      deterministic_seed: SEED,
    });
    expect(r.outcome).toBe("plurality_pass");
    expect(r.winner).toBe("a");
    expect(r.threshold_met).toBe(false);
  });

  it("plurality fallthrough is deterministic: same input ⇒ same winner", () => {
    const input = {
      parameters: {
        options: ["x", "y", "z"],
        ballot_mode: "single_choice" as const,
        quorum: 0.33,
        pass_threshold: 0.5,
        tie_break: "random_seeded" as const,
        plurality_fallthrough: true,
      },
      eligible_voters: 3,
      votes: [
        { voter_id: "1", choice: "x" },
        { voter_id: "2", choice: "y" },
        { voter_id: "3", choice: "z" },
      ],
      deterministic_seed: SEED,
    };
    const r1 = runGenericVote(input);
    const r2 = runGenericVote(input);
    expect(r1.winner).toBe(r2.winner);
    expect(r1.outcome).toBe(r2.outcome);
  });

  it("plurality fallthrough OFF (default) preserves no_pass abort", () => {
    // Same input as the first plurality test but plurality_fallthrough left
    // unset — must reproduce the pre-spec-037 abort behavior exactly.
    const r = runGenericVote({
      parameters: {
        options: ["e2e4", "d2d4", "g1f3"],
        ballot_mode: "single_choice",
        quorum: 0.33,
        pass_threshold: 0.5,
        tie_break: "random_seeded",
      },
      eligible_voters: 3,
      votes: [
        { voter_id: "1", choice: "e2e4" },
        { voter_id: "2", choice: "d2d4" },
        { voter_id: "3", choice: "g1f3" },
      ],
      deterministic_seed: SEED,
    });
    expect(r.outcome).toBe("no_pass");
    expect(r.winner).toBeNull();
  });

  it("plurality fallthrough with tie_break=no_pass on multi-way tie still no_passes", () => {
    // Operator opted into "don't pick on ties." Plurality on a clean leader
    // would fire, but a 3-way tie at top respects the no_pass tie_break.
    const r = runGenericVote({
      parameters: {
        options: ["a", "b", "c"],
        ballot_mode: "single_choice",
        quorum: 0.33,
        pass_threshold: 0.5,
        tie_break: "no_pass",
        plurality_fallthrough: true,
      },
      eligible_voters: 3,
      votes: [
        { voter_id: "1", choice: "a" },
        { voter_id: "2", choice: "b" },
        { voter_id: "3", choice: "c" },
      ],
      deterministic_seed: SEED,
    });
    expect(r.outcome).toBe("no_pass");
    expect(r.winner).toBeNull();
  });

  it("plurality fallthrough is not invoked when threshold IS met", () => {
    // 2/3 for 'a' = 67% > 50% threshold → strict-majority pass, not plurality.
    const r = runGenericVote({
      parameters: {
        options: ["a", "b"],
        ballot_mode: "single_choice",
        quorum: 0.33,
        pass_threshold: 0.5,
        tie_break: "random_seeded",
        plurality_fallthrough: true,
      },
      eligible_voters: 3,
      votes: [
        { voter_id: "1", choice: "a" },
        { voter_id: "2", choice: "a" },
        { voter_id: "3", choice: "b" },
      ],
      deterministic_seed: SEED,
    });
    expect(r.outcome).toBe("pass");
    expect(r.winner).toBe("a");
    expect(r.threshold_met).toBe(true);
  });

  it("rejects votes for unknown options", () => {
    const r = runGenericVote({
      parameters: DEFAULT_PARAMETERS,
      eligible_voters: 4,
      votes: [
        { voter_id: "1", choice: "yes" },
        { voter_id: "2", choice: "yes" },
        { voter_id: "3", choice: "maybe" }, // invalid
        { voter_id: "4", choice: "no" },
      ],
      deterministic_seed: SEED,
    });
    expect(r.trace.invalid_votes).toBe(1);
    expect(r.cast_votes).toBe(3);
  });
});

describe("generic_vote — input validation", () => {
  it("rejects empty options", () => {
    expect(() =>
      runGenericVote({
        parameters: { ...DEFAULT_PARAMETERS, options: [] },
        eligible_voters: 0,
        votes: [],
        deterministic_seed: SEED,
      }),
    ).toThrow(GenericVoteError);
  });

  it("rejects out-of-range quorum", () => {
    expect(() =>
      runGenericVote({
        parameters: { ...DEFAULT_PARAMETERS, quorum: 1.5 },
        eligible_voters: 0,
        votes: [],
        deterministic_seed: SEED,
      }),
    ).toThrow(GenericVoteError);
  });

  it("rejects out-of-range pass_threshold", () => {
    expect(() =>
      runGenericVote({
        parameters: { ...DEFAULT_PARAMETERS, pass_threshold: 0 },
        eligible_voters: 0,
        votes: [],
        deterministic_seed: SEED,
      }),
    ).toThrow(GenericVoteError);
  });
});

describe("generic_vote — properties", () => {
  it("permutation invariance: vote order does not change the outcome", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            voter_id: fc.string({ minLength: 1, maxLength: 10 }),
            choice: fc.constantFrom("yes", "no"),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (votes) => {
          // Dedupe by voter_id so the engine's last-write-wins doesn't add noise.
          const seen = new Set<string>();
          const unique = votes.filter((v) => {
            if (seen.has(v.voter_id)) return false;
            seen.add(v.voter_id);
            return true;
          });
          if (unique.length === 0) return;
          const eligible = Math.max(unique.length, 5);

          const a = runGenericVote({
            parameters: DEFAULT_PARAMETERS,
            eligible_voters: eligible,
            votes: unique,
            deterministic_seed: SEED,
          });
          const b = runGenericVote({
            parameters: DEFAULT_PARAMETERS,
            eligible_voters: eligible,
            votes: [...unique].reverse(),
            deterministic_seed: SEED,
          });
          expect(a.outcome).toBe(b.outcome);
          expect(a.winner).toBe(b.winner);
          expect(a.per_option_score).toEqual(b.per_option_score);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("determinism: same inputs produce identical outputs", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            voter_id: fc.string({ minLength: 1, maxLength: 10 }),
            choice: fc.constantFrom("yes", "no"),
          }),
          { minLength: 0, maxLength: 30 },
        ),
        (votes) => {
          const params: GenericVoteParameters = DEFAULT_PARAMETERS;
          const eligible = 10;
          const a = runGenericVote({
            parameters: params,
            eligible_voters: eligible,
            votes,
            deterministic_seed: SEED,
          });
          const b = runGenericVote({
            parameters: params,
            eligible_voters: eligible,
            votes,
            deterministic_seed: SEED,
          });
          expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("isOutcomeLocked — spec 029 voting early-close", () => {
  it("subtracts formal abstentions from possible future ballots", () => {
    expect(
      isOutcomeLocked({
        parameters: {
          options: ["yes", "no"],
          ballot_mode: "single_choice",
          quorum: 1,
          pass_threshold: 0.5,
          tie_break: "no_pass",
        },
        eligible_voters: 3,
        participating_voters: 3,
        votes: [{ voter_id: "v1", choice: "yes" }],
        deterministic_seed: SEED,
      }),
    ).toBe(true);
  });

  // Chess-shaped params: single_choice, majority threshold, no_pass tie-break.
  const params = (options: string[], quorum: number): GenericVoteParameters => ({
    options,
    ballot_mode: "single_choice",
    quorum,
    pass_threshold: 0.5,
    tie_break: "no_pass",
  });
  const vote = (voter_id: string, choice: string): VoteInput => ({ voter_id, choice });

  it("K=1, quorum=1: locks on the lone vote", () => {
    expect(
      isOutcomeLocked({
        parameters: params(["a", "b"], 1.0),
        eligible_voters: 1,
        votes: [vote("v1", "a")],
        deterministic_seed: SEED,
      }),
    ).toBe(true);
  });

  it("K=1: NOT locked before any vote (quorum unmet, outcome could still become a pass)", () => {
    expect(
      isOutcomeLocked({
        parameters: params(["a", "b"], 1.0),
        eligible_voters: 1,
        votes: [],
        deterministic_seed: SEED,
      }),
    ).toBe(false);
  });

  it("K=3, quorum=2/3: locks as soon as the winner is unbeatable (before the 3rd vote)", () => {
    // 2 of 3 voted "a"; the lone remaining vote can't catch a 2-vote lead.
    expect(
      isOutcomeLocked({
        parameters: params(["a", "b"], 2 / 3),
        eligible_voters: 3,
        votes: [vote("v1", "a"), vote("v2", "a")],
        deterministic_seed: SEED,
      }),
    ).toBe(true);
  });

  it("K=3, quorum=2/3: NOT locked at one vote (quorum unmet)", () => {
    expect(
      isOutcomeLocked({
        parameters: params(["a", "b"], 2 / 3),
        eligible_voters: 3,
        votes: [vote("v1", "a")],
        deterministic_seed: SEED,
      }),
    ).toBe(false);
  });

  it("K=3, quorum=2/3: NOT locked on a 1-1 split (the 3rd vote can still decide)", () => {
    expect(
      isOutcomeLocked({
        parameters: params(["a", "b"], 2 / 3),
        eligible_voters: 3,
        votes: [vote("v1", "a"), vote("v2", "b")],
        deterministic_seed: SEED,
      }),
    ).toBe(false);
  });

  it("pass NOW but overtakable: NOT locked (3 remaining can pass a 2-vote lead)", () => {
    // eligible=5, quorum=0.4 → met at 2 votes; "a" leads 2-0 but b could reach 3.
    expect(
      isOutcomeLocked({
        parameters: params(["a", "b"], 0.4),
        eligible_voters: 5,
        votes: [vote("v1", "a"), vote("v2", "a")],
        deterministic_seed: SEED,
      }),
    ).toBe(false);
  });

  it("all eligible voted to a tie: locked (no_pass tie is final — no more votes possible)", () => {
    const r = isOutcomeLocked({
      parameters: params(["a", "b"], 1.0),
      eligible_voters: 2,
      votes: [vote("v1", "a"), vote("v2", "b")],
      deterministic_seed: SEED,
    });
    expect(r).toBe(true);
  });

  it("agent_proposed safety: a leading option with outstanding votes that a NEW option could match is NOT locked", () => {
    // Single listed option "a" with 1 of 3 voted; quorum met at 1/3, but two
    // remaining voters could propose+back a new move and tie/beat "a".
    expect(
      isOutcomeLocked({
        parameters: params(["a"], 1 / 3),
        eligible_voters: 3,
        votes: [vote("v1", "a")],
        deterministic_seed: SEED,
      }),
    ).toBe(false);
  });

  it("matches runGenericVote when it locks (early outcome == eventual outcome)", () => {
    const input = {
      parameters: params(["a", "b"], 2 / 3),
      eligible_voters: 3,
      votes: [vote("v1", "a"), vote("v2", "a")],
      deterministic_seed: SEED,
    };
    expect(isOutcomeLocked(input)).toBe(true);
    // Any completion of the 3rd vote yields the same (pass, "a").
    for (const third of ["a", "b"]) {
      const full = runGenericVote({
        ...input,
        votes: [...input.votes, vote("v3", third)],
      });
      expect(full.outcome).toBe("pass");
      expect(full.winner).toBe("a");
    }
  });
});

describe("generic_vote — plurality_fallthrough (spec 037)", () => {
  // Chess-K3-shaped: three distinct candidates, each with 1 vote → topScore=1/3
  // which is < 0.5 pass_threshold. Strict majority returns no_pass; plurality
  // returns the top option.
  const params = (overrides: Partial<GenericVoteParameters> = {}): GenericVoteParameters => ({
    options: ["a", "b", "c"],
    ballot_mode: "single_choice",
    quorum: 1.0,
    pass_threshold: 0.5,
    tie_break: "no_pass",
    ...overrides,
  });

  it("1-1-1 split with plurality+random_seeded picks one of the tied options", () => {
    const r = runGenericVote({
      parameters: params({ plurality_fallthrough: true, tie_break: "random_seeded" }),
      eligible_voters: 3,
      votes: [
        { voter_id: "v1", choice: "a" },
        { voter_id: "v2", choice: "b" },
        { voter_id: "v3", choice: "c" },
      ],
      deterministic_seed: SEED,
    });
    expect(r.outcome).toBe("plurality_pass");
    expect(["a", "b", "c"]).toContain(r.winner!);
    expect(r.threshold_met).toBe(false);
    expect(r.quorum_met).toBe(true);
    expect(r.trace.tie_resolution_reason).toMatch(/plurality_fallthrough/);
  });

  it("2-1-1-1 with plurality picks the unambiguous leader (no tiebreak needed)", () => {
    const r = runGenericVote({
      parameters: params({
        options: ["a", "b", "c", "d"],
        plurality_fallthrough: true,
        tie_break: "random_seeded",
      }),
      eligible_voters: 5,
      votes: [
        { voter_id: "v1", choice: "a" },
        { voter_id: "v2", choice: "a" },
        { voter_id: "v3", choice: "b" },
        { voter_id: "v4", choice: "c" },
        { voter_id: "v5", choice: "d" },
      ],
      deterministic_seed: SEED,
    });
    expect(r.outcome).toBe("plurality_pass");
    expect(r.winner).toBe("a");
  });

  it("deterministic: same input → same plurality winner across runs", () => {
    const input = {
      parameters: params({ plurality_fallthrough: true, tie_break: "random_seeded" }),
      eligible_voters: 3,
      votes: [
        { voter_id: "v1", choice: "a" },
        { voter_id: "v2", choice: "b" },
        { voter_id: "v3", choice: "c" },
      ],
      deterministic_seed: SEED,
    };
    const winners = new Set<string>();
    for (let i = 0; i < 20; i++) winners.add(runGenericVote(input).winner!);
    expect(winners.size).toBe(1);
  });

  it("plurality OFF (default) preserves no_pass on a vote split", () => {
    const r = runGenericVote({
      parameters: params(),
      eligible_voters: 3,
      votes: [
        { voter_id: "v1", choice: "a" },
        { voter_id: "v2", choice: "b" },
        { voter_id: "v3", choice: "c" },
      ],
      deterministic_seed: SEED,
    });
    expect(r.outcome).toBe("no_pass");
    expect(r.winner).toBeNull();
  });

  it("plurality + tie_break=no_pass on a multi-way tie still no_passes (operator honored)", () => {
    const r = runGenericVote({
      parameters: params({ plurality_fallthrough: true, tie_break: "no_pass" }),
      eligible_voters: 3,
      votes: [
        { voter_id: "v1", choice: "a" },
        { voter_id: "v2", choice: "b" },
        { voter_id: "v3", choice: "c" },
      ],
      deterministic_seed: SEED,
    });
    expect(r.outcome).toBe("no_pass");
    expect(r.winner).toBeNull();
  });

  it("plurality NOT invoked when threshold IS met (strict-majority precedence)", () => {
    const r = runGenericVote({
      parameters: params({ plurality_fallthrough: true, tie_break: "random_seeded" }),
      eligible_voters: 3,
      votes: [
        { voter_id: "v1", choice: "a" },
        { voter_id: "v2", choice: "a" },
        { voter_id: "v3", choice: "b" },
      ],
      deterministic_seed: SEED,
    });
    expect(r.outcome).toBe("pass");
    expect(r.winner).toBe("a");
    expect(r.threshold_met).toBe(true);
  });

  it("plurality + first_listed picks the earliest option in a multi-way tie", () => {
    const r = runGenericVote({
      parameters: params({
        options: ["hold", "buy", "sell"],
        plurality_fallthrough: true,
        tie_break: "first_listed",
      }),
      eligible_voters: 3,
      votes: [
        { voter_id: "v1", choice: "buy" },
        { voter_id: "v2", choice: "sell" },
        { voter_id: "v3", choice: "hold" },
      ],
      deterministic_seed: SEED,
    });
    expect(r.outcome).toBe("plurality_pass");
    expect(r.winner).toBe("hold");
  });
});
