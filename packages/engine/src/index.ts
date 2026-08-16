// @grp-protocol/engine — pure-function mechanism implementations.
//
// v0.1 ships:
//   generic_vote       — flexible voting (single-choice / approval, with
//                         quorum + pass_threshold + tie_break)
//   ranked_choice      — Instant-Runoff Voting
//   ranked_pairwise    — Schulze-style Condorcet pairwise ranked voting
//   score_vote         — range/score voting
//   quadratic_vote     — credit-budgeted intensity voting
//   budget_allocation  — distributes a pool across N projects, with
//                         simple_average / quadratic_funding / equal_shares
//
// The registry stays open for v2+ mechanisms (recurring patronage,
// pairwise QF, milestone escrow, parliamentary procedure) added later.

export const ENGINE_VERSION = "0.2.0";

export type MechanismKind =
  | "generic_vote"
  | "ranked_choice"
  | "ranked_pairwise"
  | "score_vote"
  | "quadratic_vote"
  | "budget_allocation";

export {
  runGenericVote,
  isOutcomeLocked,
  GenericVoteError,
  DEFAULT_PARAMETERS,
} from "./generic-vote.js";
export type {
  GenericVoteInput,
  GenericVoteResult,
  GenericVoteParameters,
  BallotMode,
  TieBreak,
  VoteInput,
} from "./generic-vote.js";

export { runRankedChoice, RankedChoiceError } from "./ranked-choice.js";
export type {
  RankedChoiceInput,
  RankedChoiceResult,
  RankedChoiceParameters,
  RankedChoiceTieBreak,
  RankedChoiceRound,
  RankedVoteInput,
} from "./ranked-choice.js";

export { runRankedPairwise, RankedPairwiseError } from "./ranked-pairwise.js";
export type {
  RankedPairwiseInput,
  RankedPairwiseResult,
  RankedPairwiseParameters,
  RankedPairwiseTieBreak,
  RankedPairwiseVoteInput,
} from "./ranked-pairwise.js";

export {
  DEFAULT_SCORE_VOTE_PARAMETERS,
  ScoreVoteError,
  isScoreOutcomeLocked,
  runScoreVote,
} from "./score-vote.js";
export type {
  ScoreVoteInput,
  ScoreVoteInputVote,
  ScoreVoteParameters,
  ScoreVoteResult,
  ScoreVoteTieBreak,
} from "./score-vote.js";

export {
  DEFAULT_QUADRATIC_VOTE_PARAMETERS,
  QuadraticVoteError,
  isQuadraticOutcomeLocked,
  runQuadraticVote,
} from "./quadratic-vote.js";
export type {
  QuadraticVoteInput,
  QuadraticVoteInputVote,
  QuadraticVoteParameters,
  QuadraticVoteResult,
  QuadraticVoteTieBreak,
} from "./quadratic-vote.js";

export { runBudgetAllocation, BudgetAllocationError } from "./budget-allocation.js";
export type {
  BudgetAllocationInput,
  BudgetAllocationResult,
  BudgetAllocationParameters,
  BudgetAllocationMethod,
  BudgetVoteInput,
} from "./budget-allocation.js";

import {
  type BudgetAllocationInput,
  type BudgetAllocationResult,
  runBudgetAllocation,
} from "./budget-allocation.js";
import { type GenericVoteInput, type GenericVoteResult, runGenericVote } from "./generic-vote.js";
import {
  type QuadraticVoteInput,
  type QuadraticVoteResult,
  runQuadraticVote,
} from "./quadratic-vote.js";
import {
  type RankedChoiceInput,
  type RankedChoiceResult,
  runRankedChoice,
} from "./ranked-choice.js";
import {
  type RankedPairwiseInput,
  type RankedPairwiseResult,
  runRankedPairwise,
} from "./ranked-pairwise.js";
import { type ScoreVoteInput, type ScoreVoteResult, runScoreVote } from "./score-vote.js";

export interface Mechanism<TInput, TOutput> {
  readonly kind: MechanismKind;
  readonly version: string;
  run(input: TInput): TOutput;
}

export const registry: {
  generic_vote: Mechanism<GenericVoteInput, GenericVoteResult>;
  ranked_choice: Mechanism<RankedChoiceInput, RankedChoiceResult>;
  ranked_pairwise: Mechanism<RankedPairwiseInput, RankedPairwiseResult>;
  score_vote: Mechanism<ScoreVoteInput, ScoreVoteResult>;
  quadratic_vote: Mechanism<QuadraticVoteInput, QuadraticVoteResult>;
  budget_allocation: Mechanism<BudgetAllocationInput, BudgetAllocationResult>;
} = {
  generic_vote: {
    kind: "generic_vote",
    version: "1.0.0",
    run: (input) => runGenericVote(input),
  },
  ranked_choice: {
    kind: "ranked_choice",
    version: "1.0.0",
    run: (input) => runRankedChoice(input),
  },
  ranked_pairwise: {
    kind: "ranked_pairwise",
    version: "1.0.0",
    run: (input) => runRankedPairwise(input),
  },
  score_vote: {
    kind: "score_vote",
    version: "1.0.0",
    run: (input) => runScoreVote(input),
  },
  quadratic_vote: {
    kind: "quadratic_vote",
    version: "1.0.0",
    run: (input) => runQuadraticVote(input),
  },
  budget_allocation: {
    kind: "budget_allocation",
    version: "1.0.0",
    run: (input) => runBudgetAllocation(input),
  },
};
