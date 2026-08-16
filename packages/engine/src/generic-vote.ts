// Per spec 110 — `generic_vote` mechanism. Five configurable knobs:
//
//   options       — list of choice strings (the ballot)
//   ballot_mode   — 'single_choice' | 'approval'
//   quorum        — fraction of eligible voters that must vote (0..1)
//   pass_threshold — fraction of cast votes a winner needs (0..1)
//   tie_break     — 'no_pass' | 'first_listed' | 'random_seeded'
//
// Subsumes simple-majority, supermajority, and approval-voting variants.
// Pure function: same inputs → same outputs, byte-for-byte.

import { createHash } from "node:crypto";
import { canonicalize } from "@grp-protocol/audit";

export type BallotMode = "single_choice" | "approval";
export type TieBreak = "no_pass" | "first_listed" | "random_seeded";
export type PassThresholdComparison = "inclusive" | "strict";

export interface GenericVoteParameters {
  options: string[];
  ballot_mode: BallotMode;
  quorum: number;
  pass_threshold: number;
  /**
   * Whether support must meet (`inclusive`) or exceed (`strict`) the pass
   * threshold. Defaults to inclusive for generic/custom mechanisms. The
   * simple-majority preset is strict because exactly half is not a majority.
   */
  pass_threshold_comparison?: PassThresholdComparison;
  tie_break: TieBreak;
  /**
   * Spec 037 — when true, if quorum is met but no option reaches
   * `pass_threshold`, fall through to plurality: the top-scored option wins.
   * Multi-way ties at the top are then resolved by `tie_break`. The fall-
   * through NEVER invents an option — it picks from the cast-vote leaders
   * only. Default false preserves the strict-majority semantics of v1.
   */
  plurality_fallthrough?: boolean;
}

export interface VoteInput {
  voter_id: string;
  /** For single_choice mode: a single option string. For approval: an array. */
  choice: string | string[];
  /** Optional weight for weighted voting; defaults to 1. */
  weight?: number;
}

export interface GenericVoteInput {
  parameters: GenericVoteParameters;
  eligible_voters: number;
  votes: VoteInput[];
  /** Cast ballots plus formal abstentions. Defaults to the valid ballot count. */
  participating_voters?: number;
  /** 32-byte deterministic seed for random tie-break. */
  deterministic_seed: string;
}

export interface GenericVoteResult {
  outcome: "pass" | "no_pass" | "tied" | "plurality_pass";
  winner: string | null;
  per_option_score: Record<string, number>;
  cast_votes: number;
  eligible_voters: number;
  quorum_met: boolean;
  threshold_met: boolean;
  trace: {
    parameters: GenericVoteParameters;
    invalid_votes: number;
    duplicate_voter_ids: string[];
    tie_resolution_reason?: string;
  };
}

export class GenericVoteError extends Error {
  constructor(message: string) {
    super(`[generic_vote] ${message}`);
    this.name = "GenericVoteError";
  }
}

export function runGenericVote(input: GenericVoteInput): GenericVoteResult {
  const { parameters, eligible_voters, votes, deterministic_seed } = input;

  if (parameters.options.length === 0) {
    throw new GenericVoteError("options must be non-empty");
  }
  if (parameters.quorum < 0 || parameters.quorum > 1) {
    throw new GenericVoteError("quorum must be in [0, 1]");
  }
  if (parameters.pass_threshold <= 0 || parameters.pass_threshold > 1) {
    throw new GenericVoteError("pass_threshold must be in (0, 1]");
  }
  if (
    parameters.pass_threshold_comparison !== undefined &&
    parameters.pass_threshold_comparison !== "inclusive" &&
    parameters.pass_threshold_comparison !== "strict"
  ) {
    throw new GenericVoteError("pass_threshold_comparison must be inclusive or strict");
  }
  if (eligible_voters < 0) {
    throw new GenericVoteError("eligible_voters must be non-negative");
  }

  // Sanitize: drop votes whose choice is invalid; deduplicate by voter_id
  // (last-write-wins inside this run, but the writer in spec 111 prevents
  // duplicates upstream).
  const seenVoters = new Set<string>();
  const duplicates: string[] = [];
  let invalidVotes = 0;
  const cleanVotes: VoteInput[] = [];

  for (const v of votes) {
    if (seenVoters.has(v.voter_id)) {
      duplicates.push(v.voter_id);
      // keep the last vote per voter (replace previous in cleanVotes)
      const idx = cleanVotes.findIndex((cv) => cv.voter_id === v.voter_id);
      if (idx >= 0) cleanVotes.splice(idx, 1);
    }
    seenVoters.add(v.voter_id);

    const choices = Array.isArray(v.choice) ? v.choice : [v.choice];
    if (parameters.ballot_mode === "single_choice" && choices.length !== 1) {
      invalidVotes++;
      continue;
    }
    const everyOptionValid = choices.every((c) => parameters.options.includes(c));
    if (!everyOptionValid) {
      invalidVotes++;
      continue;
    }
    cleanVotes.push(v);
  }

  // Tally.
  const score: Record<string, number> = Object.fromEntries(parameters.options.map((o) => [o, 0]));

  for (const v of cleanVotes) {
    const w = v.weight ?? 1;
    if (w <= 0) {
      // negative or zero weights are invalid input but not catastrophic — drop.
      continue;
    }
    const choices = Array.isArray(v.choice) ? v.choice : [v.choice];
    for (const c of choices) {
      // Already verified c ∈ options.
      score[c] = (score[c] ?? 0) + w;
    }
  }

  const castVotes = cleanVotes.length;
  const participatingVoters = input.participating_voters ?? castVotes;
  if (
    !Number.isInteger(participatingVoters) ||
    participatingVoters < castVotes ||
    participatingVoters > eligible_voters
  ) {
    throw new GenericVoteError(
      "participating_voters must be an integer between cast votes and eligible_voters",
    );
  }
  const quorumMet =
    eligible_voters === 0 ? false : participatingVoters / eligible_voters >= parameters.quorum;

  if (!quorumMet) {
    return {
      outcome: "no_pass",
      winner: null,
      per_option_score: score,
      cast_votes: castVotes,
      eligible_voters,
      quorum_met: false,
      threshold_met: false,
      trace: {
        parameters,
        invalid_votes: invalidVotes,
        duplicate_voter_ids: duplicates,
      },
    };
  }

  // Find the leading score.
  const totalCast =
    parameters.ballot_mode === "approval"
      ? castVotes // approval: threshold computed against voter count
      : castVotes;
  const sorted = Object.entries(score).sort(([, a], [, b]) => b - a);
  const topScore = sorted[0]?.[1] ?? 0;
  const ties = sorted.filter(([, s]) => s === topScore).map(([o]) => o);
  const thresholdMet = meetsPassThreshold(topScore, totalCast, parameters);

  if (!thresholdMet) {
    // Spec 037 — plurality fallthrough. If quorum is met but no option clears
    // pass_threshold, pick the top-scored option (multi-way ties broken via
    // tie_break, same rules as a strict-majority tie). Only fires when topScore
    // > 0 so a no-vote situation still no_passes honestly. `outcome` stays
    // distinguishable as `"plurality_pass"` so receipts make the fall-through
    // visible in the audit trail.
    if (parameters.plurality_fallthrough && topScore > 0) {
      const pluralityWinner =
        ties.length === 1
          ? ties[0]!
          : parameters.tie_break === "first_listed"
            ? parameters.options.find((o) => ties.includes(o))!
            : parameters.tie_break === "random_seeded"
              ? (() => {
                  const idxBytes = createHash("sha256")
                    .update(deterministic_seed, "utf8")
                    .update(canonicalize({ options: parameters.options, ties }))
                    .digest();
                  return ties[idxBytes.readUInt32BE(0) % ties.length]!;
                })()
              : null;
      if (pluralityWinner !== null) {
        return {
          outcome: "plurality_pass",
          winner: pluralityWinner,
          per_option_score: score,
          cast_votes: castVotes,
          eligible_voters,
          quorum_met: true,
          threshold_met: false,
          trace: {
            parameters,
            invalid_votes: invalidVotes,
            duplicate_voter_ids: duplicates,
            tie_resolution_reason:
              ties.length === 1
                ? `plurality_fallthrough: '${pluralityWinner}' led with ${topScore}/${castVotes} (threshold ${parameters.pass_threshold} not met)`
                : `plurality_fallthrough + ${parameters.tie_break}: '${pluralityWinner}' picked from ${ties.length}-way tie at ${topScore}/${castVotes}`,
          },
        };
      }
      // tie_break === "no_pass" with a multi-way plurality tie falls through
      // to the no_pass return below — the operator opted into "don't pick on
      // ties," which we honor even with plurality on.
    }
    return {
      outcome: "no_pass",
      winner: null,
      per_option_score: score,
      cast_votes: castVotes,
      eligible_voters,
      quorum_met: true,
      threshold_met: false,
      trace: {
        parameters,
        invalid_votes: invalidVotes,
        duplicate_voter_ids: duplicates,
      },
    };
  }

  if (ties.length === 1) {
    const winner = ties[0]!;
    return {
      outcome: "pass",
      winner,
      per_option_score: score,
      cast_votes: castVotes,
      eligible_voters,
      quorum_met: true,
      threshold_met: true,
      trace: {
        parameters,
        invalid_votes: invalidVotes,
        duplicate_voter_ids: duplicates,
      },
    };
  }

  // Multi-way tie at the top — apply tie_break.
  if (parameters.tie_break === "no_pass") {
    return {
      outcome: "tied",
      winner: null,
      per_option_score: score,
      cast_votes: castVotes,
      eligible_voters,
      quorum_met: true,
      threshold_met: true,
      trace: {
        parameters,
        invalid_votes: invalidVotes,
        duplicate_voter_ids: duplicates,
        tie_resolution_reason: "no_pass tie-break: tie not resolved",
      },
    };
  }

  if (parameters.tie_break === "first_listed") {
    // Pick whichever tied option appears earliest in the original options list.
    const winner = parameters.options.find((o) => ties.includes(o))!;
    return {
      outcome: "pass",
      winner,
      per_option_score: score,
      cast_votes: castVotes,
      eligible_voters,
      quorum_met: true,
      threshold_met: true,
      trace: {
        parameters,
        invalid_votes: invalidVotes,
        duplicate_voter_ids: duplicates,
        tie_resolution_reason: `first_listed: chose '${winner}' as earliest tied option`,
      },
    };
  }

  // random_seeded: deterministic by seed.
  const idxBytes = createHash("sha256")
    .update(deterministic_seed, "utf8")
    .update(canonicalize({ options: parameters.options, ties }))
    .digest();
  // First 4 bytes as uint32 → modulo ties.length
  const idx = idxBytes.readUInt32BE(0) % ties.length;
  const winner = ties[idx]!;
  return {
    outcome: "pass",
    winner,
    per_option_score: score,
    cast_votes: castVotes,
    eligible_voters,
    quorum_met: true,
    threshold_met: true,
    trace: {
      parameters,
      invalid_votes: invalidVotes,
      duplicate_voter_ids: duplicates,
      tie_resolution_reason: `random_seeded: chose '${winner}' from ${ties.length}-way tie via seed`,
    },
  };
}

/**
 * Spec 029 — is the decision's `(outcome, winner)` already locked, i.e.
 * invariant under every possible completion of the remaining un-cast votes?
 * Pure function over the SAME inputs `runGenericVote` consumes, so an
 * early-resolved outcome is byte-identical to what window-expiry would produce.
 *
 * Soundness assumes the vote-set is immutable from the instant this returns
 * true: the caller forbids revision once the lock condition holds against the
 * current votes and resolves the decision at that instant (spec 029 §1;
 * revision-until-locked per spec 052 F12). Before the lock, revision is safe —
 * this check always runs against the current vote-set. Only the `remaining`
 * un-cast votes are treated as uncertain.
 *
 * Conservative: returns `true` only when invariance is proven. A genuinely
 * locked `no_pass`/`tied` (with votes still outstanding) returns `false` and is
 * left for the window timeout — a latency cost, never a wrong outcome.
 */
export function isOutcomeLocked(input: GenericVoteInput): boolean {
  const current = runGenericVote(input);
  const C = current.cast_votes;
  const participatingVoters = input.participating_voters ?? C;
  const remaining = input.eligible_voters - participatingVoters;

  // No further vote is possible — whatever the current result is, it is final.
  if (remaining <= 0) return true;

  // Only a decisive winner can be locked early; a no_pass / tied result with
  // outstanding votes could still flip to a pass, so wait for the window.
  // `plurality_pass` is decisive too — and its dominance check below is even
  // tighter than the strict-majority one because plurality skips the
  // pass_threshold floor (it's the whole point of the fall-through).
  if (
    (current.outcome !== "pass" && current.outcome !== "plurality_pass") ||
    current.winner === null
  )
    return false;

  const winner = current.winner;
  const sW = current.per_option_score[winner] ?? 0;

  // Threshold floor only applies to strict-majority pass. Plurality skips it
  // by design.
  if (current.outcome === "pass" && !meetsPassThreshold(sW, C + remaining, input.parameters)) {
    return false;
  }

  // Dominance: no existing option can catch the winner even if every remaining
  // vote piles onto it. Strict `>` so a tie is impossible (the no_pass
  // tie-break can't fire) and the winner stays the unique top.
  for (const [option, score] of Object.entries(current.per_option_score)) {
    if (option === winner) continue;
    if (sW - score <= remaining) return false;
  }
  // A not-yet-proposed option (agent_proposed mode) starts at 0 and could
  // absorb all remaining votes — the winner must out-poll that hypothetical too.
  if (sW <= remaining) return false;

  return true;
}

/** v1 default parameters per spec 110. */
export const DEFAULT_PARAMETERS: GenericVoteParameters = {
  options: ["yes", "no"],
  ballot_mode: "single_choice",
  quorum: 0.4,
  pass_threshold: 0.5,
  pass_threshold_comparison: "strict",
  tie_break: "no_pass",
};

function meetsPassThreshold(
  score: number,
  total: number,
  parameters: Pick<GenericVoteParameters, "pass_threshold" | "pass_threshold_comparison">,
): boolean {
  if (total <= 0) return false;
  const fraction = score / total;
  return parameters.pass_threshold_comparison === "strict"
    ? fraction > parameters.pass_threshold
    : fraction >= parameters.pass_threshold;
}
