import {
  type GenericVoteInput,
  type QuadraticVoteInput,
  type RankedChoiceInput,
  type RankedPairwiseInput,
  type ScoreVoteInput,
  runGenericVote,
  runQuadraticVote,
  runRankedChoice,
  runRankedPairwise,
  runScoreVote,
} from "@grp-protocol/engine";
import type { ConformanceCase } from "../types.js";

export const mechanismVectors = [
  {
    id: "core.mechanism.generic_vote.simple_majority",
    title: "generic_vote passes a simple-majority decision",
    mechanism: "generic_vote",
    input: {
      parameters: {
        options: ["yes", "no"],
        ballot_mode: "single_choice",
        quorum: 0.5,
        pass_threshold: 0.5,
        pass_threshold_comparison: "strict",
        tie_break: "no_pass",
      },
      eligible_voters: 4,
      votes: [
        { voter_id: "a", choice: "yes" },
        { voter_id: "b", choice: "yes" },
        { voter_id: "c", choice: "yes" },
        { voter_id: "d", choice: "no" },
      ],
      deterministic_seed: "grp-v0.1-vector-simple-majority",
    },
    expected: {
      outcome: "pass",
      winner: "yes",
      per_option_score: { yes: 3, no: 1 },
      cast_votes: 4,
      quorum_met: true,
      threshold_met: true,
    },
  },
  {
    id: "core.mechanism.generic_vote.supermajority_no_pass",
    title: "generic_vote rejects when supermajority threshold is not met",
    mechanism: "generic_vote",
    input: {
      parameters: {
        options: ["approve", "reject"],
        ballot_mode: "single_choice",
        quorum: 0.5,
        pass_threshold: 0.75,
        tie_break: "no_pass",
      },
      eligible_voters: 4,
      votes: [
        { voter_id: "a", choice: "approve" },
        { voter_id: "b", choice: "approve" },
        { voter_id: "c", choice: "reject" },
        { voter_id: "d", choice: "reject" },
      ],
      deterministic_seed: "grp-v0.1-vector-supermajority",
    },
    expected: {
      outcome: "no_pass",
      winner: null,
      per_option_score: { approve: 2, reject: 2 },
      cast_votes: 4,
      quorum_met: true,
      threshold_met: false,
    },
  },
  {
    id: "core.mechanism.generic_vote.approval",
    title: "generic_vote tallies approval ballots",
    mechanism: "generic_vote",
    input: {
      parameters: {
        options: ["park", "library", "pool"],
        ballot_mode: "approval",
        quorum: 0.5,
        pass_threshold: 0.5,
        tie_break: "first_listed",
      },
      eligible_voters: 3,
      votes: [
        { voter_id: "a", choice: ["park", "library"] },
        { voter_id: "b", choice: ["library"] },
        { voter_id: "c", choice: ["pool", "library"] },
      ],
      deterministic_seed: "grp-v0.1-vector-approval",
    },
    expected: {
      outcome: "pass",
      winner: "library",
      per_option_score: { park: 1, library: 3, pool: 1 },
      cast_votes: 3,
      quorum_met: true,
      threshold_met: true,
    },
  },
  {
    id: "core.mechanism.generic_vote.quorum_unmet",
    title: "generic_vote no-passes when quorum is unmet",
    mechanism: "generic_vote",
    input: {
      parameters: {
        options: ["yes", "no"],
        ballot_mode: "single_choice",
        quorum: 0.75,
        pass_threshold: 0.5,
        tie_break: "no_pass",
      },
      eligible_voters: 4,
      votes: [{ voter_id: "a", choice: "yes" }],
      deterministic_seed: "grp-v0.1-vector-quorum",
    },
    expected: {
      outcome: "no_pass",
      winner: null,
      per_option_score: { yes: 1, no: 0 },
      cast_votes: 1,
      quorum_met: false,
      threshold_met: false,
    },
  },
  {
    id: "core.mechanism.generic_vote.tie_first_listed",
    title: "generic_vote resolves ties with first_listed",
    mechanism: "generic_vote",
    input: {
      parameters: {
        options: ["alpha", "beta"],
        ballot_mode: "single_choice",
        quorum: 0.5,
        pass_threshold: 0.5,
        tie_break: "first_listed",
      },
      eligible_voters: 2,
      votes: [
        { voter_id: "a", choice: "beta" },
        { voter_id: "b", choice: "alpha" },
      ],
      deterministic_seed: "grp-v0.1-vector-first-listed",
    },
    expected: {
      outcome: "pass",
      winner: "alpha",
      per_option_score: { alpha: 1, beta: 1 },
      cast_votes: 2,
      quorum_met: true,
      threshold_met: true,
    },
  },
  {
    id: "core.mechanism.ranked_choice.transfer",
    title: "ranked_choice transfers an eliminated option to a majority winner",
    mechanism: "ranked_choice",
    input: {
      parameters: {
        options: ["alpha", "beta", "gamma"],
        quorum: 1,
        tie_break: "first_listed",
      },
      eligible_voters: 5,
      votes: [
        { voter_id: "a", ranking: ["alpha", "beta", "gamma"] },
        { voter_id: "b", ranking: ["alpha", "beta", "gamma"] },
        { voter_id: "c", ranking: ["beta", "gamma", "alpha"] },
        { voter_id: "d", ranking: ["gamma", "beta", "alpha"] },
        { voter_id: "e", ranking: ["gamma", "beta", "alpha"] },
      ],
      deterministic_seed: "grp-v0.1-vector-ranked-choice-transfer",
    },
    expected: {
      outcome: "pass",
      winner: "gamma",
      per_option_score: { alpha: 2, gamma: 3 },
      cast_votes: 5,
      quorum_met: true,
      "trace.invalid_votes": 0,
    },
  },
  {
    id: "core.mechanism.ranked_pairwise.condorcet_compromise",
    title: "ranked_pairwise selects the option that beats both polar alternatives",
    mechanism: "ranked_pairwise",
    input: {
      parameters: {
        options: ["HOLD", "UNWIND", "TRIM-BOTH"],
        quorum: 1,
        tie_break: "no_pass",
      },
      eligible_voters: 5,
      votes: [
        { voter_id: "a", ranking: ["HOLD", "TRIM-BOTH", "UNWIND"] },
        { voter_id: "b", ranking: ["HOLD", "TRIM-BOTH", "UNWIND"] },
        { voter_id: "c", ranking: ["UNWIND", "TRIM-BOTH", "HOLD"] },
        { voter_id: "d", ranking: ["UNWIND", "TRIM-BOTH", "HOLD"] },
        { voter_id: "e", ranking: ["TRIM-BOTH", "HOLD", "UNWIND"] },
      ],
      deterministic_seed: "grp-v0.1-vector-pairwise-compromise",
    },
    expected: {
      outcome: "pass",
      winner: "TRIM-BOTH",
      per_option_score: { HOLD: 0, UNWIND: -2, "TRIM-BOTH": 2 },
      cast_votes: 5,
      quorum_met: true,
      "trace.tied_options": ["TRIM-BOTH"],
    },
  },
  {
    id: "core.mechanism.ranked_pairwise.condorcet_cycle",
    title: "ranked_pairwise preserves an unresolved three-option cycle",
    mechanism: "ranked_pairwise",
    input: {
      parameters: {
        options: ["alpha", "beta", "gamma"],
        quorum: 1,
        tie_break: "no_pass",
      },
      eligible_voters: 3,
      votes: [
        { voter_id: "a", ranking: ["alpha", "beta", "gamma"] },
        { voter_id: "b", ranking: ["beta", "gamma", "alpha"] },
        { voter_id: "c", ranking: ["gamma", "alpha", "beta"] },
      ],
      deterministic_seed: "grp-v0.1-vector-pairwise-cycle",
    },
    expected: {
      outcome: "tied",
      winner: null,
      per_option_score: { alpha: 0, beta: 0, gamma: 0 },
      cast_votes: 3,
      quorum_met: true,
      "trace.tied_options": ["alpha", "beta", "gamma"],
    },
  },
  {
    id: "core.mechanism.score_vote.cardinal_compromise",
    title: "score_vote aggregates intensity across a polar preference profile",
    mechanism: "score_vote",
    input: {
      parameters: {
        options: ["HOLD", "UNWIND", "SHORT-CASH", "TRIM-BOTH", "POWER-ROTATE"],
        quorum: 1,
        min_score: 0,
        max_score: 5,
        tie_break: "no_pass",
      },
      eligible_voters: 5,
      votes: [
        {
          voter_id: "a",
          scores: { HOLD: 5, "POWER-ROTATE": 4.5, "TRIM-BOTH": 1.5, "SHORT-CASH": 1 },
        },
        {
          voter_id: "b",
          scores: { HOLD: 5, "TRIM-BOTH": 4.5, "POWER-ROTATE": 4, "SHORT-CASH": 1 },
        },
        {
          voter_id: "c",
          scores: { UNWIND: 5, "POWER-ROTATE": 4.5, "TRIM-BOTH": 1.5, "SHORT-CASH": 1 },
        },
        {
          voter_id: "d",
          scores: { UNWIND: 5, "TRIM-BOTH": 4.5, "POWER-ROTATE": 4, "SHORT-CASH": 1 },
        },
        {
          voter_id: "e",
          scores: {
            "TRIM-BOTH": 5,
            "POWER-ROTATE": 4.5,
            "SHORT-CASH": 3,
            HOLD: 1.5,
            UNWIND: 1.5,
          },
        },
      ],
      deterministic_seed: "grp-v0.1-vector-score-compromise",
    },
    expected: {
      outcome: "pass",
      winner: "POWER-ROTATE",
      per_option_score: {
        HOLD: 11.5,
        UNWIND: 11.5,
        "SHORT-CASH": 7,
        "TRIM-BOTH": 17,
        "POWER-ROTATE": 21.5,
      },
      cast_votes: 5,
      quorum_met: true,
      "trace.invalid_votes": 0,
    },
  },
  {
    id: "core.mechanism.quadratic_vote.credit_budget",
    title: "quadratic_vote applies square-root credits and rejects an over-budget ballot",
    mechanism: "quadratic_vote",
    input: {
      parameters: {
        options: ["alpha", "beta", "gamma"],
        quorum: 1,
        credits_per_voter: 9,
        tie_break: "no_pass",
      },
      eligible_voters: 4,
      participating_voters: 4,
      votes: [
        { voter_id: "a", allocation: { alpha: 9 } },
        { voter_id: "b", allocation: { beta: 4, gamma: 5 } },
        { voter_id: "c", allocation: { beta: 9 } },
        { voter_id: "d", allocation: { alpha: 10 } },
      ],
      deterministic_seed: "grp-v0.1-vector-quadratic-budget",
    },
    expected: {
      outcome: "pass",
      winner: "beta",
      per_option_score: { alpha: 3, beta: 5, gamma: 2.23606797749979 },
      cast_votes: 3,
      quorum_met: true,
      "trace.invalid_votes": 1,
      "trace.spent_credits_by_voter": { a: 9, b: 9, c: 9 },
    },
  },
] as const;

export const mechanismCases: ConformanceCase[] = mechanismVectors.map((vector) => ({
  id: vector.id,
  title: vector.title,
  profile: "core",
  run: () => {
    const result = runMechanismVector(vector);
    for (const [field, expected] of Object.entries(vector.expected)) {
      assertJsonEqual(readPath(result, field), expected, field);
    }
  },
}));

function runMechanismVector(vector: (typeof mechanismVectors)[number]): unknown {
  switch (vector.mechanism) {
    case "generic_vote":
      return runGenericVote(vector.input as unknown as GenericVoteInput);
    case "ranked_choice":
      return runRankedChoice(vector.input as unknown as RankedChoiceInput);
    case "ranked_pairwise":
      return runRankedPairwise(vector.input as unknown as RankedPairwiseInput);
    case "score_vote":
      return runScoreVote(vector.input as unknown as ScoreVoteInput);
    case "quadratic_vote":
      return runQuadraticVote(vector.input as unknown as QuadraticVoteInput);
  }
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || !(segment in current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function assertJsonEqual(actual: unknown, expected: unknown, field: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${field}: expected ${e}, got ${a}`);
  }
}
