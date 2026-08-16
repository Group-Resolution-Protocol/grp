// Per spec 003 / 022 — `budget_allocation` mechanism. Allocates a pool
// across N projects given per-voter distributions. Three sub-modes
// (`method` parameter):
//
//   simple_average    — Final allocation = arithmetic mean of voters'
//                       per-project shares. Trivial; baseline.
//   quadratic_funding — QF-style aggregation: per-project funding is the
//                       square of the sum of square-roots of voters'
//                       contributions. Rewards breadth of support over
//                       concentrated depth. Used by Gitcoin + several
//                       grants rounds.
//   equal_shares      — Method of Equal Shares (Peters & Skowron 2020).
//                       Iteratively pick projects funded by the minimum
//                       per-voter share-spend. Proportional fairness;
//                       used by participatory budgeting (Wieliczka,
//                       Aarau, Stanford PB) + Wikimedia community
//                       funding rounds.
//
// All three accept the same vote shape: each voter submits a
// Record<option, weight> distribution. The engine normalizes weights
// per-voter (so a voter who submits {a: 2, b: 1} has the same intent
// as {a: 0.667, b: 0.333}). The output `tallies` is the final per-option
// allocation as a fraction (sum = 1) OR — if `total_budget` is set in
// parameters — as absolute amounts.
//
// Pure function: same inputs → same outputs, byte-for-byte.

export type BudgetAllocationMethod = "simple_average" | "quadratic_funding" | "equal_shares";

export interface BudgetAllocationParameters {
  options: string[];
  method: BudgetAllocationMethod;
  /** Quorum: fraction of eligible voters required for a valid allocation.
   *  Default 0 (any cast votes will produce an allocation). */
  quorum: number;
  /** Optional. If set, allocations are returned as absolute amounts
   *  summing to `total_budget`. If omitted, allocations are fractions
   *  summing to 1. */
  total_budget?: number;
}

export interface BudgetVoteInput {
  voter_id: string;
  /** Per-option weight. Need not sum to anything specific — the engine
   *  normalizes per-voter. Negative or NaN weights treated as 0. Options
   *  not in `parameters.options` are dropped silently. */
  allocation: Record<string, number>;
  /** Optional voter weight (e.g., for weighted-stake budgeting); defaults to 1.
   *  Multiplies the voter's contribution in the aggregation. */
  voter_weight?: number;
}

export interface BudgetAllocationInput {
  parameters: BudgetAllocationParameters;
  eligible_voters: number;
  votes: BudgetVoteInput[];
  /** 32-byte deterministic seed. Currently unused — reserved for future
   *  randomized variants of MES with tie-breaking. */
  deterministic_seed: string;
}

export interface BudgetAllocationResult {
  outcome: "pass" | "no_pass";
  /** No single winner; the whole distribution is the outcome.
   *  Kept for interface consistency with other mechanisms. */
  winner: null;
  /** Per-option final allocation (fractions OR absolute amounts per
   *  `total_budget`). */
  per_option_score: Record<string, number>;
  cast_votes: number;
  eligible_voters: number;
  quorum_met: boolean;
  trace: {
    parameters: BudgetAllocationParameters;
    method: BudgetAllocationMethod;
    invalid_votes: number;
    duplicate_voter_ids: string[];
    /** Per-voter normalized contributions (sum=1 per voter before method-specific aggregation). */
    normalized_votes: Array<{
      voter_id: string;
      allocation: Record<string, number>;
      weight: number;
    }>;
  };
}

export class BudgetAllocationError extends Error {
  constructor(message: string) {
    super(`[budget_allocation] ${message}`);
    this.name = "BudgetAllocationError";
  }
}

function normalizeAllocation(
  raw: Record<string, number>,
  options: ReadonlyArray<string>,
): { allocation: Record<string, number>; valid: boolean } {
  const out: Record<string, number> = {};
  for (const o of options) out[o] = 0;
  let total = 0;
  for (const o of options) {
    const v = raw[o];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[o] = v;
      total += v;
    }
  }
  if (total <= 0) return { allocation: out, valid: false };
  for (const o of options) out[o] = out[o]! / total;
  return { allocation: out, valid: true };
}

function scaleByBudget(
  fractions: Record<string, number>,
  parameters: BudgetAllocationParameters,
): Record<string, number> {
  if (parameters.total_budget === undefined) return fractions;
  const out: Record<string, number> = {};
  for (const o of parameters.options) out[o] = (fractions[o] ?? 0) * parameters.total_budget;
  return out;
}

export function runBudgetAllocation(input: BudgetAllocationInput): BudgetAllocationResult {
  const { parameters, eligible_voters, votes } = input;

  if (parameters.options.length === 0) {
    throw new BudgetAllocationError("options must be non-empty");
  }
  if (parameters.quorum < 0 || parameters.quorum > 1) {
    throw new BudgetAllocationError("quorum must be in [0, 1]");
  }
  if (eligible_voters < 0) {
    throw new BudgetAllocationError("eligible_voters must be non-negative");
  }
  if (
    parameters.total_budget !== undefined &&
    (!Number.isFinite(parameters.total_budget) || parameters.total_budget < 0)
  ) {
    throw new BudgetAllocationError("total_budget must be a non-negative finite number when set");
  }

  // Dedup by voter_id (last-write-wins) + normalize each vote.
  const seenVoters = new Set<string>();
  const duplicates: string[] = [];
  let invalidVotes = 0;
  const cleanVotes: Array<{
    voter_id: string;
    allocation: Record<string, number>;
    weight: number;
  }> = [];

  for (const v of votes) {
    if (seenVoters.has(v.voter_id)) {
      duplicates.push(v.voter_id);
      const idx = cleanVotes.findIndex((cv) => cv.voter_id === v.voter_id);
      if (idx >= 0) cleanVotes.splice(idx, 1);
    }
    seenVoters.add(v.voter_id);
    const voterWeight = v.voter_weight ?? 1;
    if (voterWeight <= 0) {
      invalidVotes++;
      continue;
    }
    const { allocation, valid } = normalizeAllocation(v.allocation, parameters.options);
    if (!valid) {
      invalidVotes++;
      continue;
    }
    cleanVotes.push({ voter_id: v.voter_id, allocation, weight: voterWeight });
  }

  const castVotes = cleanVotes.length;
  const quorumMet =
    eligible_voters === 0 ? false : castVotes / eligible_voters >= parameters.quorum;

  if (!quorumMet) {
    return {
      outcome: "no_pass",
      winner: null,
      per_option_score: Object.fromEntries(parameters.options.map((o) => [o, 0])),
      cast_votes: castVotes,
      eligible_voters,
      quorum_met: false,
      trace: {
        parameters,
        method: parameters.method,
        invalid_votes: invalidVotes,
        duplicate_voter_ids: duplicates,
        normalized_votes: [],
      },
    };
  }

  let allocation: Record<string, number>;
  if (parameters.method === "simple_average") {
    allocation = runSimpleAverage(parameters.options, cleanVotes);
  } else if (parameters.method === "quadratic_funding") {
    allocation = runQuadraticFunding(parameters.options, cleanVotes);
  } else if (parameters.method === "equal_shares") {
    allocation = runEqualShares(parameters.options, cleanVotes);
  } else {
    throw new BudgetAllocationError(
      `unknown method: ${JSON.stringify(parameters.method)} (must be one of: simple_average, quadratic_funding, equal_shares)`,
    );
  }

  return {
    outcome: "pass",
    winner: null,
    per_option_score: scaleByBudget(allocation, parameters),
    cast_votes: castVotes,
    eligible_voters,
    quorum_met: true,
    trace: {
      parameters,
      method: parameters.method,
      invalid_votes: invalidVotes,
      duplicate_voter_ids: duplicates,
      normalized_votes: cleanVotes.map((v) => ({
        voter_id: v.voter_id,
        allocation: { ...v.allocation },
        weight: v.weight,
      })),
    },
  };
}

// ---------- Sub-methods ----------

function runSimpleAverage(
  options: ReadonlyArray<string>,
  votes: ReadonlyArray<{ allocation: Record<string, number>; weight: number }>,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const o of options) totals[o] = 0;
  let totalWeight = 0;
  for (const v of votes) {
    totalWeight += v.weight;
    for (const o of options) totals[o] = (totals[o] ?? 0) + (v.allocation[o] ?? 0) * v.weight;
  }
  if (totalWeight === 0) return totals;
  const out: Record<string, number> = {};
  for (const o of options) out[o] = totals[o]! / totalWeight;
  return out;
}

function runQuadraticFunding(
  options: ReadonlyArray<string>,
  votes: ReadonlyArray<{ allocation: Record<string, number>; weight: number }>,
): Record<string, number> {
  // Per-option score = (Σᵢ √(weightᵢ * allocationᵢ))²
  // Normalize so the final allocation sums to 1.
  const raw: Record<string, number> = {};
  for (const o of options) raw[o] = 0;
  for (const o of options) {
    let sumSqrt = 0;
    for (const v of votes) {
      const contribution = v.weight * (v.allocation[o] ?? 0);
      if (contribution > 0) sumSqrt += Math.sqrt(contribution);
    }
    raw[o] = sumSqrt * sumSqrt;
  }
  const total = Object.values(raw).reduce((a, b) => a + b, 0);
  if (total === 0) return raw;
  const out: Record<string, number> = {};
  for (const o of options) out[o] = raw[o]! / total;
  return out;
}

function runEqualShares(
  options: ReadonlyArray<string>,
  votes: ReadonlyArray<{ allocation: Record<string, number>; weight: number }>,
): Record<string, number> {
  // Method of Equal Shares — divisible-project variant.
  //
  // Each voter starts with a budget equal to weight / totalWeight (so all
  // voters' budgets sum to 1). For each project, the cost per supporting
  // voter is `1 / N` of the project's allocation share (where N is the
  // number of voters who included it in their allocation). The method picks
  // projects in order of minimum per-voter cost, charging supporters'
  // budgets until exhausted or all options funded.
  //
  // Simplified divisible variant: each voter's budget contributes to
  // projects in proportion to their allocation distribution, capped by
  // their remaining per-voter budget. Practically: weight each project by
  // the sum of supporting voters' MIN(budget_remaining, allocation_share).
  // Final allocation normalizes to sum=1.

  const totalWeight = votes.reduce((a, v) => a + v.weight, 0);
  if (totalWeight === 0) {
    return Object.fromEntries(options.map((o) => [o, 0]));
  }

  // Each voter's budget = their weight share of the total pool.
  const voterBudgets = votes.map((v) => ({
    voter_id: "" /* unused */,
    allocation: v.allocation,
    remaining: v.weight / totalWeight,
  }));

  // Allocate projects in rounds: pick the cheapest unfunded project
  // (lowest sum of supporters' per-voter contributions); fund it
  // proportionally; repeat until budgets exhausted or all funded.
  const funded: Record<string, number> = {};
  for (const o of options) funded[o] = 0;
  const remainingOptions = new Set(options);

  // Safety: at most |options| iterations.
  for (let iter = 0; iter < options.length; iter++) {
    // Compute per-option potential contribution = Σᵢ min(remainingᵢ, allocationᵢ_o)
    let bestOpt: string | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    const optContributions: Record<string, number> = {};

    for (const o of remainingOptions) {
      let contrib = 0;
      let supporters = 0;
      for (const v of voterBudgets) {
        const share = v.allocation[o] ?? 0;
        if (share <= 0 || v.remaining <= 0) continue;
        contrib += Math.min(v.remaining, share);
        supporters++;
      }
      optContributions[o] = contrib;
      if (supporters === 0 || contrib <= 0) continue;
      // Cost-per-supporter — the MES criterion (lower is fairer).
      const cost = contrib / supporters;
      if (cost < bestCost) {
        bestCost = cost;
        bestOpt = o;
      }
    }

    if (bestOpt === null) break;

    // Fund the chosen option; charge supporters proportionally.
    const optContrib = optContributions[bestOpt]!;
    funded[bestOpt] = (funded[bestOpt] ?? 0) + optContrib;
    for (const v of voterBudgets) {
      const share = v.allocation[bestOpt] ?? 0;
      if (share <= 0) continue;
      const charged = Math.min(v.remaining, share);
      v.remaining -= charged;
    }
    remainingOptions.delete(bestOpt);
  }

  // Normalize to sum=1 (in case some budget remains unspent because all
  // options have been funded or all supporting budgets exhausted).
  const total = Object.values(funded).reduce((a, b) => a + b, 0);
  if (total === 0) return funded;
  const out: Record<string, number> = {};
  for (const o of options) out[o] = funded[o]! / total;
  return out;
}
