import { createHash } from "node:crypto";
import { canonicalize } from "@grp-protocol/audit";

export type ScoreVoteTieBreak = "no_pass" | "first_listed" | "random_seeded";

export interface ScoreVoteParameters {
  options: string[];
  quorum: number;
  min_score: number;
  max_score: number;
  tie_break: ScoreVoteTieBreak;
}

export interface ScoreVoteInputVote {
  voter_id: string;
  scores: Record<string, number>;
  weight?: number;
}

export interface ScoreVoteInput {
  parameters: ScoreVoteParameters;
  eligible_voters: number;
  votes: ScoreVoteInputVote[];
  /** Cast ballots plus formal abstentions. Defaults to the valid ballot count. */
  participating_voters?: number;
  deterministic_seed: string;
}

export interface ScoreVoteResult {
  outcome: "pass" | "no_pass" | "tied";
  winner: string | null;
  per_option_score: Record<string, number>;
  cast_votes: number;
  eligible_voters: number;
  quorum_met: boolean;
  trace: {
    parameters: ScoreVoteParameters;
    invalid_votes: number;
    duplicate_voter_ids: string[];
    total_weight: number;
    tie_resolution_reason?: string;
  };
}

export class ScoreVoteError extends Error {
  constructor(message: string) {
    super(`[score_vote] ${message}`);
    this.name = "ScoreVoteError";
  }
}

export const DEFAULT_SCORE_VOTE_PARAMETERS: Omit<ScoreVoteParameters, "options" | "quorum"> = {
  min_score: 0,
  max_score: 5,
  tie_break: "random_seeded",
};

export function runScoreVote(input: ScoreVoteInput): ScoreVoteResult {
  const { parameters, eligible_voters, votes, deterministic_seed } = input;
  validateParameters(parameters, eligible_voters);

  const seenVoters = new Set<string>();
  const duplicates: string[] = [];
  let invalidVotes = 0;
  const cleanVotes: Array<{ voter_id: string; scores: Record<string, number>; weight: number }> =
    [];

  for (const v of votes) {
    if (seenVoters.has(v.voter_id)) {
      duplicates.push(v.voter_id);
      const idx = cleanVotes.findIndex((cv) => cv.voter_id === v.voter_id);
      if (idx >= 0) cleanVotes.splice(idx, 1);
    }
    seenVoters.add(v.voter_id);

    const weight = v.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      invalidVotes++;
      continue;
    }

    const normalized: Record<string, number> = {};
    let hasAnyScore = false;
    let valid = true;
    for (const option of parameters.options) {
      const raw = v.scores[option] ?? parameters.min_score;
      if (
        typeof raw !== "number" ||
        !Number.isFinite(raw) ||
        raw < parameters.min_score ||
        raw > parameters.max_score
      ) {
        valid = false;
        break;
      }
      normalized[option] = raw;
      if (raw > parameters.min_score) hasAnyScore = true;
    }

    if (!valid || !hasAnyScore) {
      invalidVotes++;
      continue;
    }
    cleanVotes.push({ voter_id: v.voter_id, scores: normalized, weight });
  }

  const castVotes = cleanVotes.length;
  const participatingVoters = input.participating_voters ?? castVotes;
  validateParticipatingVoters(participatingVoters, castVotes, eligible_voters);
  const quorumMet =
    eligible_voters === 0 ? false : participatingVoters / eligible_voters >= parameters.quorum;
  const score = Object.fromEntries(parameters.options.map((o) => [o, 0])) as Record<string, number>;
  let totalWeight = 0;

  if (!quorumMet) {
    return result("no_pass", null, score, castVotes, eligible_voters, false, parameters, {
      invalidVotes,
      duplicates,
      totalWeight,
    });
  }

  for (const v of cleanVotes) {
    totalWeight += v.weight;
    for (const option of parameters.options) {
      score[option] = (score[option] ?? 0) + (v.scores[option] ?? parameters.min_score) * v.weight;
    }
  }

  const sorted = Object.entries(score).sort(([, a], [, b]) => b - a);
  const topScore = sorted[0]?.[1] ?? 0;
  const ties = sorted.filter(([, s]) => s === topScore).map(([o]) => o);
  if (topScore <= parameters.min_score * totalWeight) {
    return result("no_pass", null, score, castVotes, eligible_voters, true, parameters, {
      invalidVotes,
      duplicates,
      totalWeight,
    });
  }
  const winner = resolveTie(parameters.options, ties, parameters.tie_break, deterministic_seed);
  if (winner === null) {
    return result("tied", null, score, castVotes, eligible_voters, true, parameters, {
      invalidVotes,
      duplicates,
      totalWeight,
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
    totalWeight,
    ...(tieResolutionReason ? { tieResolutionReason } : {}),
  });
}

/**
 * Spec 152 W1 — is a score decision's `(outcome, winner)` locked, i.e.
 * invariant under every possible completion of the remaining un-cast ballots?
 * Same contract as the generic `isOutcomeLocked` (spec 029): pure over the
 * inputs `runScoreVote` consumes; the caller owns the no-revision-after-lock
 * guarantee (or routes determination into the spec-115 settle window, where
 * revisions are deliberately permitted and re-checked).
 *
 * Bound: each remaining ballot contributes at least `min_score` and at most
 * `max_score` to every option (unscored options default to `min_score` in
 * `runScoreVote`), so a rival can close the gap by at most
 * `(max_score - min_score)` per remaining ballot. Locked ⟺ the current
 * outcome is a decisive pass, quorum is already met, and every rival trails
 * by strictly more than `remaining × (max_score - min_score)`. Remaining
 * ballots are assumed weight 1, exactly as the generic lock assumes.
 *
 * Conservative: a genuinely settled no_pass/tied with ballots outstanding
 * returns false and waits for the window — a latency cost, never a wrong
 * outcome.
 */
export function isScoreOutcomeLocked(input: ScoreVoteInput): boolean {
  const current = runScoreVote(input);
  const remaining = input.eligible_voters - (input.participating_voters ?? current.cast_votes);
  if (remaining <= 0) return true;
  if (current.outcome !== "pass" || current.winner === null) return false;
  if (!current.quorum_met) return false;
  const spread = input.parameters.max_score - input.parameters.min_score;
  const sW = current.per_option_score[current.winner] ?? 0;
  for (const [option, score] of Object.entries(current.per_option_score)) {
    if (option === current.winner) continue;
    if (sW - score <= remaining * spread) return false;
  }
  return true;
}

function validateParameters(parameters: ScoreVoteParameters, eligibleVoters: number): void {
  if (parameters.options.length === 0) throw new ScoreVoteError("options must be non-empty");
  if (parameters.quorum < 0 || parameters.quorum > 1) {
    throw new ScoreVoteError("quorum must be in [0, 1]");
  }
  if (!Number.isFinite(parameters.min_score) || !Number.isFinite(parameters.max_score)) {
    throw new ScoreVoteError("min_score and max_score must be finite numbers");
  }
  if (parameters.min_score < 0 || parameters.max_score <= parameters.min_score) {
    throw new ScoreVoteError("score range must satisfy 0 <= min_score < max_score");
  }
  if (eligibleVoters < 0) throw new ScoreVoteError("eligible_voters must be non-negative");
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
    throw new ScoreVoteError(
      "participating_voters must be an integer between cast votes and eligible_voters",
    );
  }
}

function resolveTie(
  options: string[],
  ties: string[],
  tieBreak: ScoreVoteTieBreak,
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
  outcome: ScoreVoteResult["outcome"],
  winner: string | null,
  score: Record<string, number>,
  castVotes: number,
  eligibleVoters: number,
  quorumMet: boolean,
  parameters: ScoreVoteParameters,
  trace: {
    invalidVotes: number;
    duplicates: string[];
    totalWeight: number;
    tieResolutionReason?: string;
  },
): ScoreVoteResult {
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
      total_weight: trace.totalWeight,
      ...(trace.tieResolutionReason ? { tie_resolution_reason: trace.tieResolutionReason } : {}),
    },
  };
}
