import { createHash } from "node:crypto";
import { canonicalize } from "@grp-protocol/audit";

export type QuadraticVoteTieBreak = "no_pass" | "first_listed" | "random_seeded";

export interface QuadraticVoteParameters {
  options: string[];
  quorum: number;
  credits_per_voter: number;
  tie_break: QuadraticVoteTieBreak;
}

export interface QuadraticVoteInputVote {
  voter_id: string;
  allocation: Record<string, number>;
  weight?: number;
}

export interface QuadraticVoteInput {
  parameters: QuadraticVoteParameters;
  eligible_voters: number;
  votes: QuadraticVoteInputVote[];
  /** Cast ballots plus formal abstentions. Defaults to the valid ballot count. */
  participating_voters?: number;
  deterministic_seed: string;
}

export interface QuadraticVoteResult {
  outcome: "pass" | "no_pass" | "tied";
  winner: string | null;
  per_option_score: Record<string, number>;
  cast_votes: number;
  eligible_voters: number;
  quorum_met: boolean;
  trace: {
    parameters: QuadraticVoteParameters;
    invalid_votes: number;
    duplicate_voter_ids: string[];
    spent_credits_by_voter: Record<string, number>;
    tie_resolution_reason?: string;
  };
}

export class QuadraticVoteError extends Error {
  constructor(message: string) {
    super(`[quadratic_vote] ${message}`);
    this.name = "QuadraticVoteError";
  }
}

export const DEFAULT_QUADRATIC_VOTE_PARAMETERS: Omit<
  QuadraticVoteParameters,
  "options" | "quorum"
> = {
  credits_per_voter: 9,
  tie_break: "random_seeded",
};

export function runQuadraticVote(input: QuadraticVoteInput): QuadraticVoteResult {
  const { parameters, eligible_voters, votes, deterministic_seed } = input;
  validateParameters(parameters, eligible_voters);

  const seenVoters = new Set<string>();
  const duplicates: string[] = [];
  let invalidVotes = 0;
  const score = Object.fromEntries(parameters.options.map((o) => [o, 0])) as Record<string, number>;
  const spentCreditsByVoter: Record<string, number> = {};
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
      delete spentCreditsByVoter[v.voter_id];
    }
    seenVoters.add(v.voter_id);

    const weight = v.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      invalidVotes++;
      continue;
    }

    const allocation: Record<string, number> = {};
    let spent = 0;
    let hasAnyAllocation = false;
    let valid = true;
    for (const option of parameters.options) {
      const raw = v.allocation[option] ?? 0;
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
        valid = false;
        break;
      }
      const credits = Math.floor(raw);
      allocation[option] = credits;
      spent += credits;
      if (credits > 0) hasAnyAllocation = true;
    }

    if (!valid || !hasAnyAllocation || spent > parameters.credits_per_voter) {
      invalidVotes++;
      continue;
    }
    spentCreditsByVoter[v.voter_id] = spent;
    cleanVotes.push({ voter_id: v.voter_id, allocation, weight });
  }

  const castVotes = cleanVotes.length;
  const participatingVoters = input.participating_voters ?? castVotes;
  validateParticipatingVoters(participatingVoters, castVotes, eligible_voters);
  const quorumMet =
    eligible_voters === 0 ? false : participatingVoters / eligible_voters >= parameters.quorum;
  if (!quorumMet) {
    return result("no_pass", null, score, castVotes, eligible_voters, false, parameters, {
      invalidVotes,
      duplicates,
      spentCreditsByVoter,
    });
  }

  for (const v of cleanVotes) {
    for (const option of parameters.options) {
      const credits = v.allocation[option] ?? 0;
      score[option] = (score[option] ?? 0) + Math.sqrt(credits) * v.weight;
    }
  }

  const sorted = Object.entries(score).sort(([, a], [, b]) => b - a);
  const topScore = sorted[0]?.[1] ?? 0;
  const ties = sorted.filter(([, s]) => s === topScore).map(([o]) => o);
  if (topScore <= 0) {
    return result("no_pass", null, score, castVotes, eligible_voters, true, parameters, {
      invalidVotes,
      duplicates,
      spentCreditsByVoter,
    });
  }

  const winner = resolveTie(parameters.options, ties, parameters.tie_break, deterministic_seed);
  if (winner === null) {
    return result("tied", null, score, castVotes, eligible_voters, true, parameters, {
      invalidVotes,
      duplicates,
      spentCreditsByVoter,
      tieResolutionReason: "no_pass tie-break: tie not resolved",
    });
  }
  const tieResolutionReason =
    ties.length > 1
      ? `${parameters.tie_break}: chose '${winner}' from ${ties.length}-way tie`
      : undefined;
  return result("pass", winner, score, castVotes, eligible_voters, true, parameters, {
    invalidVotes,
    duplicates,
    spentCreditsByVoter,
    ...(tieResolutionReason ? { tieResolutionReason } : {}),
  });
}

/**
 * Spec 152 W1 — is a quadratic decision's `(outcome, winner)` locked under
 * every completion of the remaining un-cast ballots? Same contract as the
 * generic `isOutcomeLocked` (spec 029) and the score lock: pure over the
 * inputs `runQuadraticVote` consumes; revision handling is the caller's
 * (settle window per spec 115).
 *
 * Bound: a remaining ballot adds at most `sqrt(credits_per_voter)` effective
 * votes to any single option and at least 0 to the winner, so locked ⟺ the
 * current outcome is a decisive pass, quorum is already met, and every rival
 * trails by strictly more than `remaining × sqrt(credits_per_voter)`.
 * Remaining ballots are assumed weight 1, exactly as the generic lock
 * assumes. Conservative on no_pass/tied with ballots outstanding.
 */
export function isQuadraticOutcomeLocked(input: QuadraticVoteInput): boolean {
  const current = runQuadraticVote(input);
  const remaining = input.eligible_voters - (input.participating_voters ?? current.cast_votes);
  if (remaining <= 0) return true;
  if (current.outcome !== "pass" || current.winner === null) return false;
  if (!current.quorum_met) return false;
  const maxGain = Math.sqrt(input.parameters.credits_per_voter);
  const sW = current.per_option_score[current.winner] ?? 0;
  for (const [option, score] of Object.entries(current.per_option_score)) {
    if (option === current.winner) continue;
    if (sW - score <= remaining * maxGain) return false;
  }
  return true;
}

function validateParameters(parameters: QuadraticVoteParameters, eligibleVoters: number): void {
  if (parameters.options.length === 0) throw new QuadraticVoteError("options must be non-empty");
  if (parameters.quorum < 0 || parameters.quorum > 1) {
    throw new QuadraticVoteError("quorum must be in [0, 1]");
  }
  if (
    !Number.isInteger(parameters.credits_per_voter) ||
    parameters.credits_per_voter < 1 ||
    parameters.credits_per_voter > 1000
  ) {
    throw new QuadraticVoteError("credits_per_voter must be an integer in [1, 1000]");
  }
  if (eligibleVoters < 0) throw new QuadraticVoteError("eligible_voters must be non-negative");
}

function validateParticipatingVoters(
  participatingVoters: number,
  castVotes: number,
  eligibleVoters: number,
): void {
  if (
    !Number.isInteger(participatingVoters) ||
    participatingVoters < castVotes ||
    participatingVoters > eligibleVoters
  ) {
    throw new QuadraticVoteError(
      "participating_voters must be an integer between cast votes and eligible_voters",
    );
  }
}

function resolveTie(
  options: string[],
  ties: string[],
  tieBreak: QuadraticVoteTieBreak,
  seed: string,
): string | null {
  if (ties.length === 1) return ties[0]!;
  if (tieBreak === "no_pass") return null;
  if (tieBreak === "first_listed") return options.find((o) => ties.includes(o)) ?? null;
  const idxBytes = createHash("sha256")
    .update(seed, "utf8")
    .update(canonicalize({ options, ties }))
    .digest();
  return ties[idxBytes.readUInt32BE(0) % ties.length] ?? null;
}

function result(
  outcome: QuadraticVoteResult["outcome"],
  winner: string | null,
  score: Record<string, number>,
  castVotes: number,
  eligibleVoters: number,
  quorumMet: boolean,
  parameters: QuadraticVoteParameters,
  trace: {
    invalidVotes: number;
    duplicates: string[];
    spentCreditsByVoter: Record<string, number>;
    tieResolutionReason?: string;
  },
): QuadraticVoteResult {
  return {
    outcome,
    winner,
    per_option_score: score,
    cast_votes: castVotes,
    eligible_voters: eligibleVoters,
    quorum_met: quorumMet,
    trace: {
      parameters,
      invalid_votes: trace.invalidVotes,
      duplicate_voter_ids: trace.duplicates,
      spent_credits_by_voter: trace.spentCreditsByVoter,
      ...(trace.tieResolutionReason ? { tie_resolution_reason: trace.tieResolutionReason } : {}),
    },
  };
}
