// Per spec 003 / 022 — `ranked_choice` mechanism. Instant-Runoff Voting (IRV).
//
// Voters submit an ordered preference list of options. The engine repeatedly
// eliminates the option with the fewest first-place votes and redistributes
// those voters' next-ranked preferences. Iteration ends when one option has
// a majority of remaining non-exhausted ballots, or when all remaining
// options are tied and the tie_break parameter resolves.
//
// Parameters:
//
//   options         — full ballot of valid choice strings
//   quorum          — fraction of eligible voters who must cast a ballot
//   tie_break       — 'no_pass' | 'first_listed' | 'random_seeded'
//                     (applied both to ties at the bottom during elimination
//                      and to ties at the top of the final round)
//
// IRV does NOT take a `pass_threshold` — majority-of-final-round is the
// definitional outcome. A `quorum` parameter is honored on initial ballots
// cast (an exhausted ballot still counted toward quorum since it was cast).
//
// Pure function: same inputs → same outputs.

import { createHash } from "node:crypto";
import { canonicalize } from "@grp-protocol/audit";

export type RankedChoiceTieBreak = "no_pass" | "first_listed" | "random_seeded";

export interface RankedChoiceParameters {
  options: string[];
  quorum: number;
  tie_break: RankedChoiceTieBreak;
}

export interface RankedVoteInput {
  voter_id: string;
  /** Ordered preference list. Must contain only strings from `parameters.options`.
   *  Truncated lists are valid (voters need not rank everything). */
  ranking: string[];
  /** Optional weight; defaults to 1. */
  weight?: number;
}

export interface RankedChoiceInput {
  parameters: RankedChoiceParameters;
  eligible_voters: number;
  votes: RankedVoteInput[];
  /** Cast ballots plus formal abstentions. Defaults to the valid ballot count. */
  participating_voters?: number;
  /** 32-byte deterministic seed for random tie-break. */
  deterministic_seed: string;
}

export interface RankedChoiceRound {
  /** Per-option tally at the START of this round. */
  tally: Record<string, number>;
  /** Options still in contention at the start of this round. */
  remaining: string[];
  /** Options eliminated AT THE END of this round (may be >1 in a bottom-tie). */
  eliminated: string[];
  /** Number of ballots fully exhausted (no remaining ranked option) by the end. */
  exhausted_ballots: number;
}

export interface RankedChoiceResult {
  outcome: "pass" | "no_pass" | "tied";
  winner: string | null;
  /** Tally of the FINAL round (the one that produced a winner or terminated). */
  per_option_score: Record<string, number>;
  cast_votes: number;
  eligible_voters: number;
  quorum_met: boolean;
  trace: {
    parameters: RankedChoiceParameters;
    rounds: RankedChoiceRound[];
    invalid_votes: number;
    duplicate_voter_ids: string[];
    tie_resolution_reason?: string;
  };
}

export class RankedChoiceError extends Error {
  constructor(message: string) {
    super(`[ranked_choice] ${message}`);
    this.name = "RankedChoiceError";
  }
}

function tallyFirstPlace(
  cleanVotes: ReadonlyArray<{ voter_id: string; ranking: string[]; weight: number }>,
  remaining: ReadonlyArray<string>,
): { tally: Record<string, number>; exhaustedThisRound: number } {
  const tally: Record<string, number> = {};
  for (const o of remaining) tally[o] = 0;
  let exhaustedThisRound = 0;
  const remainingSet = new Set(remaining);
  for (const v of cleanVotes) {
    const next = v.ranking.find((c) => remainingSet.has(c));
    if (next === undefined) {
      exhaustedThisRound++;
      continue;
    }
    tally[next] = (tally[next] ?? 0) + v.weight;
  }
  return { tally, exhaustedThisRound };
}

export function runRankedChoice(input: RankedChoiceInput): RankedChoiceResult {
  const { parameters, eligible_voters, votes, deterministic_seed } = input;

  if (parameters.options.length === 0) {
    throw new RankedChoiceError("options must be non-empty");
  }
  if (parameters.quorum < 0 || parameters.quorum > 1) {
    throw new RankedChoiceError("quorum must be in [0, 1]");
  }
  if (eligible_voters < 0) {
    throw new RankedChoiceError("eligible_voters must be non-negative");
  }

  // Sanitize: dedupe by voter_id (last-write-wins); strip rankings of any
  // option not in `parameters.options`; reject empty rankings.
  const seenVoters = new Set<string>();
  const duplicates: string[] = [];
  let invalidVotes = 0;
  const validOptions = new Set(parameters.options);
  const cleanVotes: Array<{ voter_id: string; ranking: string[]; weight: number }> = [];

  for (const v of votes) {
    if (seenVoters.has(v.voter_id)) {
      duplicates.push(v.voter_id);
      const idx = cleanVotes.findIndex((cv) => cv.voter_id === v.voter_id);
      if (idx >= 0) cleanVotes.splice(idx, 1);
    }
    seenVoters.add(v.voter_id);
    const weight = v.weight ?? 1;
    if (weight <= 0) {
      invalidVotes++;
      continue;
    }
    // Strip unknown options and de-dupe consecutive repeats in the ranking.
    const filtered: string[] = [];
    const seenInRank = new Set<string>();
    for (const c of v.ranking) {
      if (!validOptions.has(c)) continue;
      if (seenInRank.has(c)) continue;
      seenInRank.add(c);
      filtered.push(c);
    }
    if (filtered.length === 0) {
      invalidVotes++;
      continue;
    }
    cleanVotes.push({ voter_id: v.voter_id, ranking: filtered, weight });
  }

  const castVotes = cleanVotes.length;
  const participatingVoters = input.participating_voters ?? castVotes;
  if (
    !Number.isInteger(participatingVoters) ||
    participatingVoters < castVotes ||
    participatingVoters > eligible_voters
  ) {
    throw new RankedChoiceError(
      "participating_voters must be an integer between cast votes and eligible_voters",
    );
  }
  const quorumMet =
    eligible_voters === 0 ? false : participatingVoters / eligible_voters >= parameters.quorum;

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
        rounds: [],
        invalid_votes: invalidVotes,
        duplicate_voter_ids: duplicates,
      },
    };
  }

  // IRV rounds.
  let remaining = [...parameters.options];
  const rounds: RankedChoiceRound[] = [];
  let tieResolutionReason: string | undefined;
  const SAFETY_MAX_ROUNDS = parameters.options.length + 1; // can't have more rounds than options

  for (let roundIdx = 0; roundIdx < SAFETY_MAX_ROUNDS; roundIdx++) {
    const { tally, exhaustedThisRound } = tallyFirstPlace(cleanVotes, remaining);
    const totalActive = Object.values(tally).reduce((a, b) => a + b, 0);

    // No active ballots — every voter is exhausted. Apply tie-break to remaining options.
    if (totalActive === 0) {
      rounds.push({
        tally: { ...tally },
        remaining: [...remaining],
        eliminated: [],
        exhausted_ballots: exhaustedThisRound,
      });
      return resolveExhausted(
        parameters,
        tally,
        rounds,
        castVotes,
        eligible_voters,
        deterministic_seed,
        invalidVotes,
        duplicates,
      );
    }

    // Check for majority winner.
    const sorted = Object.entries(tally).sort(([, a], [, b]) => b - a);
    const topScore = sorted[0]?.[1] ?? 0;
    const topOptions = sorted.filter(([, s]) => s === topScore).map(([o]) => o);

    if (topOptions.length === 1 && topScore > totalActive / 2) {
      // Majority winner.
      rounds.push({
        tally: { ...tally },
        remaining: [...remaining],
        eliminated: [],
        exhausted_ballots: exhaustedThisRound,
      });
      const winner = topOptions[0]!;
      return {
        outcome: "pass",
        winner,
        per_option_score: tally,
        cast_votes: castVotes,
        eligible_voters,
        quorum_met: true,
        trace: {
          parameters,
          rounds,
          invalid_votes: invalidVotes,
          duplicate_voter_ids: duplicates,
        },
      };
    }

    // Last round and no majority winner — only one option remains.
    if (remaining.length === 1) {
      rounds.push({
        tally: { ...tally },
        remaining: [...remaining],
        eliminated: [],
        exhausted_ballots: exhaustedThisRound,
      });
      const winner = remaining[0]!;
      // It "wins" since it's the only option left, but with majority-of-cast-ballots
      // (not majority of active) being arguably below 50%. Still report as pass —
      // IRV is about preference aggregation, not absolute majority of original cast.
      return {
        outcome: "pass",
        winner,
        per_option_score: tally,
        cast_votes: castVotes,
        eligible_voters,
        quorum_met: true,
        trace: {
          parameters,
          rounds,
          invalid_votes: invalidVotes,
          duplicate_voter_ids: duplicates,
        },
      };
    }

    // No majority — eliminate the bottom.
    const bottomScore = sorted[sorted.length - 1]?.[1] ?? 0;
    const bottomOptions = sorted.filter(([, s]) => s === bottomScore).map(([o]) => o);

    let toEliminate: string[];
    if (bottomOptions.length === 1) {
      toEliminate = bottomOptions;
    } else {
      // Bottom-tie — apply tie_break.
      toEliminate = breakBottomTie(
        parameters,
        bottomOptions,
        remaining,
        deterministic_seed,
        roundIdx,
      );
      if (toEliminate.length === bottomOptions.length) {
        // tie_break='no_pass' surrenders — bail out as tied.
        if (parameters.tie_break === "no_pass") {
          rounds.push({
            tally: { ...tally },
            remaining: [...remaining],
            eliminated: [],
            exhausted_ballots: exhaustedThisRound,
          });
          return {
            outcome: "tied",
            winner: null,
            per_option_score: tally,
            cast_votes: castVotes,
            eligible_voters,
            quorum_met: true,
            trace: {
              parameters,
              rounds,
              invalid_votes: invalidVotes,
              duplicate_voter_ids: duplicates,
              tie_resolution_reason: `no_pass tie-break: ${bottomOptions.length}-way bottom tie at round ${roundIdx + 1}`,
            },
          };
        }
      }
      tieResolutionReason = `bottom-tie at round ${roundIdx + 1}: ${parameters.tie_break} eliminated ${toEliminate.join(", ")}`;
    }

    rounds.push({
      tally: { ...tally },
      remaining: [...remaining],
      eliminated: [...toEliminate],
      exhausted_ballots: exhaustedThisRound,
    });

    remaining = remaining.filter((o) => !toEliminate.includes(o));

    if (remaining.length === 0) {
      // Should never happen given guards above, but guard regardless.
      return {
        outcome: "tied",
        winner: null,
        per_option_score: tally,
        cast_votes: castVotes,
        eligible_voters,
        quorum_met: true,
        trace: {
          parameters,
          rounds,
          invalid_votes: invalidVotes,
          duplicate_voter_ids: duplicates,
          ...(tieResolutionReason !== undefined
            ? { tie_resolution_reason: `${tieResolutionReason}; eliminated all remaining` }
            : { tie_resolution_reason: "eliminated all remaining" }),
        },
      };
    }
  }

  throw new RankedChoiceError(
    `exceeded SAFETY_MAX_ROUNDS=${SAFETY_MAX_ROUNDS} — invariant violation`,
  );
}

function breakBottomTie(
  parameters: RankedChoiceParameters,
  tiedOptions: string[],
  remaining: string[],
  deterministicSeed: string,
  roundIdx: number,
): string[] {
  if (parameters.tie_break === "no_pass") return tiedOptions;
  if (parameters.tie_break === "first_listed") {
    // Eliminate whichever tied option appears LAST in the original ballot order
    // (the LEAST preferred at top of ballot). The "first listed" canonical
    // wins ties at the top; symmetrically, it survives ties at the bottom.
    const ordered = parameters.options.filter((o) => tiedOptions.includes(o));
    return [ordered[ordered.length - 1]!];
  }
  // random_seeded — deterministic from seed
  const idxBytes = createHash("sha256")
    .update(deterministicSeed, "utf8")
    .update(canonicalize({ round: roundIdx, remaining, tied: tiedOptions }))
    .digest();
  const idx = idxBytes.readUInt32BE(0) % tiedOptions.length;
  return [tiedOptions[idx]!];
}

function resolveExhausted(
  parameters: RankedChoiceParameters,
  tally: Record<string, number>,
  rounds: RankedChoiceRound[],
  castVotes: number,
  eligibleVoters: number,
  deterministicSeed: string,
  invalidVotes: number,
  duplicates: string[],
): RankedChoiceResult {
  // All ballots exhausted — no preference signal left. Apply tie_break
  // across the still-remaining options.
  const remaining = Object.keys(tally);
  if (parameters.tie_break === "no_pass" || remaining.length === 0) {
    return {
      outcome: "tied",
      winner: null,
      per_option_score: tally,
      cast_votes: castVotes,
      eligible_voters: eligibleVoters,
      quorum_met: true,
      trace: {
        parameters,
        rounds,
        invalid_votes: invalidVotes,
        duplicate_voter_ids: duplicates,
        tie_resolution_reason: "all ballots exhausted; no_pass tie-break or no remaining options",
      },
    };
  }
  let winner: string;
  if (parameters.tie_break === "first_listed") {
    winner = parameters.options.find((o) => remaining.includes(o))!;
  } else {
    const idxBytes = createHash("sha256")
      .update(deterministicSeed, "utf8")
      .update(canonicalize({ exhausted: true, remaining }))
      .digest();
    const idx = idxBytes.readUInt32BE(0) % remaining.length;
    winner = remaining[idx]!;
  }
  return {
    outcome: "pass",
    winner,
    per_option_score: tally,
    cast_votes: castVotes,
    eligible_voters: eligibleVoters,
    quorum_met: true,
    trace: {
      parameters,
      rounds,
      invalid_votes: invalidVotes,
      duplicate_voter_ids: duplicates,
      tie_resolution_reason: `all ballots exhausted; ${parameters.tie_break} resolved to ${winner}`,
    },
  };
}
