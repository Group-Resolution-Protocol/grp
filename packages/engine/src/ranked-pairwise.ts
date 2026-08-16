import { createHash } from "node:crypto";
import { canonicalize } from "@grp-protocol/audit";

export type RankedPairwiseTieBreak = "no_pass" | "first_listed" | "random_seeded";

export interface RankedPairwiseParameters {
  options: string[];
  quorum: number;
  tie_break: RankedPairwiseTieBreak;
}

export interface RankedPairwiseVoteInput {
  voter_id: string;
  ranking: string[];
  weight?: number;
}

export interface RankedPairwiseInput {
  parameters: RankedPairwiseParameters;
  eligible_voters: number;
  votes: RankedPairwiseVoteInput[];
  /** Cast ballots plus formal abstentions. Defaults to the valid ballot count. */
  participating_voters?: number;
  deterministic_seed: string;
}

export interface RankedPairwiseResult {
  outcome: "pass" | "no_pass" | "tied";
  winner: string | null;
  /** Copeland-style wins minus losses for compact UI sorting. */
  per_option_score: Record<string, number>;
  cast_votes: number;
  eligible_voters: number;
  quorum_met: boolean;
  trace: {
    parameters: RankedPairwiseParameters;
    invalid_votes: number;
    duplicate_voter_ids: string[];
    pairwise_preferences: Record<string, Record<string, number>>;
    strongest_paths: Record<string, Record<string, number>>;
    tied_options: string[];
    tie_resolution_reason?: string;
  };
}

export class RankedPairwiseError extends Error {
  constructor(message: string) {
    super(`[ranked_pairwise] ${message}`);
    this.name = "RankedPairwiseError";
  }
}

export function runRankedPairwise(input: RankedPairwiseInput): RankedPairwiseResult {
  const { parameters, eligible_voters, votes, deterministic_seed } = input;
  validateParameters(parameters, eligible_voters);

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
    if (!Number.isFinite(weight) || weight <= 0) {
      invalidVotes++;
      continue;
    }

    const ranking: string[] = [];
    const seenInRank = new Set<string>();
    for (const option of v.ranking) {
      if (!validOptions.has(option) || seenInRank.has(option)) continue;
      seenInRank.add(option);
      ranking.push(option);
    }
    if (ranking.length === 0) {
      invalidVotes++;
      continue;
    }
    cleanVotes.push({ voter_id: v.voter_id, ranking, weight });
  }

  const castVotes = cleanVotes.length;
  const participatingVoters = input.participating_voters ?? castVotes;
  if (
    !Number.isInteger(participatingVoters) ||
    participatingVoters < castVotes ||
    participatingVoters > eligible_voters
  ) {
    throw new RankedPairwiseError(
      "participating_voters must be an integer between cast votes and eligible_voters",
    );
  }
  const quorumMet =
    eligible_voters === 0 ? false : participatingVoters / eligible_voters >= parameters.quorum;
  const preferences = emptyMatrix(parameters.options);
  const paths = emptyMatrix(parameters.options);
  const scores = Object.fromEntries(parameters.options.map((o) => [o, 0])) as Record<
    string,
    number
  >;

  if (!quorumMet) {
    return buildResult("no_pass", null, scores, castVotes, eligible_voters, false, parameters, {
      invalidVotes,
      duplicates,
      preferences,
      paths,
      tiedOptions: [],
    });
  }

  for (const vote of cleanVotes) {
    const rankIndex = new Map<string, number>();
    vote.ranking.forEach((option, index) => rankIndex.set(option, index));

    for (const a of parameters.options) {
      for (const b of parameters.options) {
        if (a === b) continue;
        const aRank = rankIndex.get(a);
        const bRank = rankIndex.get(b);
        if (aRank === undefined && bRank === undefined) continue;
        if (aRank !== undefined && (bRank === undefined || aRank < bRank)) {
          preferences[a]![b] = (preferences[a]?.[b] ?? 0) + vote.weight;
        }
      }
    }
  }

  for (const i of parameters.options) {
    for (const j of parameters.options) {
      if (i === j) continue;
      paths[i]![j] =
        (preferences[i]?.[j] ?? 0) > (preferences[j]?.[i] ?? 0) ? preferences[i]?.[j]! : 0;
    }
  }

  for (const i of parameters.options) {
    for (const j of parameters.options) {
      if (i === j) continue;
      for (const k of parameters.options) {
        if (i === k || j === k) continue;
        paths[j]![k] = Math.max(
          paths[j]?.[k] ?? 0,
          Math.min(paths[j]?.[i] ?? 0, paths[i]?.[k] ?? 0),
        );
      }
    }
  }

  for (const a of parameters.options) {
    for (const b of parameters.options) {
      if (a === b) continue;
      if ((paths[a]?.[b] ?? 0) > (paths[b]?.[a] ?? 0)) scores[a] = (scores[a] ?? 0) + 1;
      else if ((paths[a]?.[b] ?? 0) < (paths[b]?.[a] ?? 0)) scores[a] = (scores[a] ?? 0) - 1;
    }
  }

  const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
  const topScore = sorted[0]?.[1] ?? 0;
  const tiedOptions = sorted.filter(([, s]) => s === topScore).map(([o]) => o);
  const winner = resolveTie(
    parameters.options,
    tiedOptions,
    parameters.tie_break,
    deterministic_seed,
  );
  if (winner === null) {
    return buildResult("tied", null, scores, castVotes, eligible_voters, true, parameters, {
      invalidVotes,
      duplicates,
      preferences,
      paths,
      tiedOptions,
      tieResolutionReason: "no_pass tie-break: tie not resolved",
    });
  }
  const tieResolutionReason =
    tiedOptions.length > 1
      ? `${parameters.tie_break}: chose '${winner}' from ${tiedOptions.length}-way top tie`
      : undefined;
  return buildResult("pass", winner, scores, castVotes, eligible_voters, true, parameters, {
    invalidVotes,
    duplicates,
    preferences,
    paths,
    tiedOptions,
    ...(tieResolutionReason ? { tieResolutionReason } : {}),
  });
}

function validateParameters(parameters: RankedPairwiseParameters, eligibleVoters: number): void {
  if (parameters.options.length === 0) throw new RankedPairwiseError("options must be non-empty");
  if (parameters.quorum < 0 || parameters.quorum > 1) {
    throw new RankedPairwiseError("quorum must be in [0, 1]");
  }
  if (eligibleVoters < 0) throw new RankedPairwiseError("eligible_voters must be non-negative");
}

function emptyMatrix(options: string[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const a of options) {
    out[a] = {};
    for (const b of options) out[a]![b] = a === b ? 0 : 0;
  }
  return out;
}

function resolveTie(
  options: string[],
  ties: string[],
  tieBreak: RankedPairwiseTieBreak,
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

function buildResult(
  outcome: RankedPairwiseResult["outcome"],
  winner: string | null,
  scores: Record<string, number>,
  castVotes: number,
  eligibleVoters: number,
  quorumMet: boolean,
  parameters: RankedPairwiseParameters,
  trace: {
    invalidVotes: number;
    duplicates: string[];
    preferences: Record<string, Record<string, number>>;
    paths: Record<string, Record<string, number>>;
    tiedOptions: string[];
    tieResolutionReason?: string;
  },
): RankedPairwiseResult {
  return {
    outcome,
    winner,
    per_option_score: scores,
    cast_votes: castVotes,
    eligible_voters: eligibleVoters,
    quorum_met: quorumMet,
    trace: {
      parameters,
      invalid_votes: trace.invalidVotes,
      duplicate_voter_ids: trace.duplicates,
      pairwise_preferences: trace.preferences,
      strongest_paths: trace.paths,
      tied_options: trace.tiedOptions,
      ...(trace.tieResolutionReason ? { tie_resolution_reason: trace.tieResolutionReason } : {}),
    },
  };
}
