/**
 * Independently replay the deliberately small agreement-decision contract from
 * a decoded receipt payload. This stays browser-portable and does not import
 * the Node-only mechanism engine, so auditors can use it anywhere the SDK runs.
 */

export type AgreementReceiptVerification =
  | { status: "verified" }
  | { status: "not_applicable" }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sameTallies(actual: Record<string, unknown>, expected: Record<string, number>): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return false;
  }
  return expectedKeys.every((key) => finiteNumber(actual[key]) === expected[key]);
}

/**
 * Verify agreement semantics after the compact JWS signature has been checked.
 * Non-agreement receipts are intentionally left alone for backward
 * compatibility. A choice-visibility `never` receipt can prove its aggregate
 * result was signed, but cannot replay attribution that was deliberately
 * omitted, so that case is reported as unavailable rather than verified.
 */
export function verifyAgreementReceiptSemantics(payload: unknown): AgreementReceiptVerification {
  if (!isRecord(payload) || !isRecord(payload.grp)) {
    return { status: "not_applicable" };
  }
  const grp = payload.grp;
  if (!isRecord(grp.mechanism) || !isRecord(grp.mechanism.parameters)) {
    return { status: "not_applicable" };
  }
  const parameters = grp.mechanism.parameters;
  if (parameters.agreement !== true) return { status: "not_applicable" };

  const mechanism = grp.mechanism.kind;
  if (mechanism !== "simple_majority" && mechanism !== "supermajority") {
    return { status: "failed", reason: "agreement receipt uses a non-majority mechanism" };
  }
  if (
    parameters.ballot_mode !== "single_choice" ||
    parameters.quorum !== 1 ||
    parameters.pass_threshold !== 1 ||
    parameters.tie_break !== "no_pass" ||
    parameters.plurality_fallthrough !== false
  ) {
    return {
      status: "failed",
      reason: "agreement receipt does not sign the required unanimity parameters",
    };
  }

  if (
    !Array.isArray(parameters.options) ||
    parameters.options.length === 0 ||
    !parameters.options.every((option) => typeof option === "string")
  ) {
    return { status: "failed", reason: "agreement receipt has invalid signed options" };
  }
  const options = parameters.options as string[];
  if (new Set(options).size !== options.length) {
    return { status: "failed", reason: "agreement receipt has duplicate signed options" };
  }
  if (!Array.isArray(grp.votes) || !isRecord(grp.outcome)) {
    return { status: "failed", reason: "agreement receipt is missing votes or outcome" };
  }
  const diagnostics = isRecord(grp.outcome.diagnostics) ? grp.outcome.diagnostics : null;
  const eligibleVoters = diagnostics ? finiteNumber(diagnostics.eligible_voters) : null;
  const claimedCastVotes = diagnostics ? finiteNumber(diagnostics.cast_votes) : null;
  if (
    eligibleVoters === null ||
    claimedCastVotes === null ||
    !Number.isInteger(eligibleVoters) ||
    !Number.isInteger(claimedCastVotes) ||
    eligibleVoters < 0 ||
    claimedCastVotes < 0
  ) {
    return { status: "failed", reason: "agreement receipt has invalid voter diagnostics" };
  }
  if (grp.votes.length === 0 && claimedCastVotes > 0) {
    return {
      status: "unavailable",
      reason: "aggregate-only agreement receipt omits the votes needed for semantic replay",
    };
  }

  const tallies: Record<string, number> = Object.fromEntries(options.map((option) => [option, 0]));
  const voterIds = new Set<string>();
  for (const rawVote of grp.votes) {
    if (!isRecord(rawVote)) {
      return { status: "failed", reason: "agreement receipt contains a malformed vote" };
    }
    const voterId = rawVote.agent_id;
    const choice = rawVote.choice;
    const weight = rawVote.weight ?? 1;
    if (typeof voterId !== "string" || voterId.length === 0 || voterIds.has(voterId)) {
      return {
        status: "failed",
        reason: "agreement receipt contains an invalid or duplicate voter",
      };
    }
    if (typeof choice !== "string" || !options.includes(choice) || weight !== 1) {
      return { status: "failed", reason: "agreement receipt contains an invalid acceptance" };
    }
    voterIds.add(voterId);
    tallies[choice] = (tallies[choice] ?? 0) + 1;
  }

  const castVotes = grp.votes.length;
  if (castVotes !== claimedCastVotes || castVotes > eligibleVoters) {
    return {
      status: "failed",
      reason: "agreement receipt vote diagnostics do not match signed votes",
    };
  }
  const quorumMet = eligibleVoters > 0 && castVotes === eligibleVoters;
  const unanimousChoice =
    castVotes > 0 ? (options.find((option) => tallies[option] === castVotes) ?? null) : null;
  const winner = quorumMet ? unanimousChoice : null;
  const status = winner !== null ? "completed" : quorumMet ? "rejected" : "no_quorum";

  if (grp.outcome.status !== status || (grp.outcome.winning_option ?? null) !== winner) {
    return {
      status: "failed",
      reason: "agreement receipt outcome does not match its signed votes",
    };
  }
  if (!isRecord(grp.outcome.tallies) || !sameTallies(grp.outcome.tallies, tallies)) {
    return { status: "failed", reason: "agreement receipt tallies do not match its signed votes" };
  }
  return { status: "verified" };
}
