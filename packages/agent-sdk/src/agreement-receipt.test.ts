import { describe, expect, it } from "vitest";
import { verifyAgreementReceiptSemantics } from "./agreement-receipt.js";

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    grp: {
      mechanism: {
        kind: "simple_majority",
        parameters: {
          agreement: true,
          options: ["yes", "no"],
          ballot_mode: "single_choice",
          quorum: 1,
          pass_threshold: 1,
          tie_break: "no_pass",
          plurality_fallthrough: false,
        },
      },
      votes: [
        { agent_id: "did:one", choice: "yes", weight: 1 },
        { agent_id: "did:two", choice: "yes", weight: 1 },
      ],
      outcome: {
        status: "completed",
        winning_option: "yes",
        tallies: { yes: 2, no: 0 },
        diagnostics: { cast_votes: 2, eligible_voters: 2 },
      },
      ...overrides,
    },
  };
}

describe("verifyAgreementReceiptSemantics", () => {
  it("verifies a unanimous agreement from signed parameters and votes", () => {
    expect(verifyAgreementReceiptSemantics(receipt())).toEqual({ status: "verified" });
  });

  it("verifies a full-electorate split as rejected with no winner", () => {
    expect(
      verifyAgreementReceiptSemantics(
        receipt({
          votes: [
            { agent_id: "did:one", choice: "yes", weight: 1 },
            { agent_id: "did:two", choice: "no", weight: 1 },
          ],
          outcome: {
            status: "rejected",
            winning_option: null,
            tallies: { yes: 1, no: 1 },
            diagnostics: { cast_votes: 2, eligible_voters: 2 },
          },
        }),
      ),
    ).toEqual({ status: "verified" });
  });

  it("verifies an attributed cancellation while preserving signed participation", () => {
    expect(
      verifyAgreementReceiptSemantics(
        receipt({
          votes: [{ agent_id: "did:one", choice: "yes", weight: 1 }],
          overrides: [
            {
              by: "participant:operator",
              reason: "The premise changed.",
              fired_at: "2026-08-21T12:34:56.000Z",
              authority_source: "conclusion_authority:operator",
            },
          ],
          outcome: {
            status: "canceled",
            winning_option: null,
            tallies: {},
            diagnostics: { cast_votes: 1, eligible_voters: 2 },
          },
        }),
      ),
    ).toEqual({ status: "verified" });
  });

  it("verifies a submitted-action holder withdrawing their exact approval round", () => {
    expect(
      verifyAgreementReceiptSemantics(
        receipt({
          votes: [{ agent_id: "did:holder", choice: "yes", weight: 1 }],
          overrides: [
            {
              by: "participant:holder",
              reason: "A reviewer found one correction.",
              fired_at: "2026-08-22T18:34:13.035Z",
              authority_source: "action_submission:holder",
            },
          ],
          outcome: {
            status: "canceled",
            winning_option: null,
            tallies: {},
            diagnostics: { cast_votes: 1, eligible_voters: 2 },
          },
        }),
      ),
    ).toEqual({ status: "verified" });
  });

  it("rejects a cancellation without one valid authority-attributed override", () => {
    const outcome = {
      status: "canceled",
      winning_option: null,
      tallies: {},
      diagnostics: { cast_votes: 2, eligible_voters: 2 },
    };
    expect(verifyAgreementReceiptSemantics(receipt({ overrides: [], outcome }))).toEqual({
      status: "failed",
      reason: "canceled agreement receipt must have one attributed cancellation override",
    });
    expect(
      verifyAgreementReceiptSemantics(
        receipt({
          overrides: [
            {
              by: "participant:operator",
              reason: "The premise changed.",
              fired_at: "2026-08-21T12:34:56.000Z",
              authority_source: "decision_opening_authority:any_participant",
            },
          ],
          outcome,
        }),
      ),
    ).toEqual({
      status: "failed",
      reason: "canceled agreement receipt has invalid actor, reason, time, or authority",
    });
    expect(
      verifyAgreementReceiptSemantics(
        receipt({
          overrides: [
            {
              by: "participant:reviewer",
              reason: "The premise changed.",
              fired_at: "2026-08-21T12:34:56.000Z",
              authority_source: "action_submission:reviewer",
            },
          ],
          outcome,
        }),
      ),
    ).toEqual({
      status: "failed",
      reason: "canceled agreement receipt has invalid actor, reason, time, or authority",
    });
  });

  it("rejects a signed outcome that contradicts the signed acceptances", () => {
    expect(
      verifyAgreementReceiptSemantics(
        receipt({
          outcome: {
            status: "rejected",
            winning_option: null,
            tallies: { yes: 2, no: 0 },
            diagnostics: { cast_votes: 2, eligible_voters: 2 },
          },
        }),
      ),
    ).toEqual({
      status: "failed",
      reason: "agreement receipt outcome does not match its signed votes",
    });
  });

  it("rejects agreement markers without the effective unanimity parameters", () => {
    const payload = receipt();
    const grp = payload.grp as Record<string, unknown>;
    const mechanism = grp.mechanism as Record<string, unknown>;
    (mechanism.parameters as Record<string, unknown>).quorum = 0.5;
    expect(verifyAgreementReceiptSemantics(payload)).toEqual({
      status: "failed",
      reason: "agreement receipt does not sign the required unanimity parameters",
    });
  });

  it("reports aggregate-only receipts honestly when votes were deliberately omitted", () => {
    expect(
      verifyAgreementReceiptSemantics(
        receipt({
          votes: [],
          outcome: {
            status: "completed",
            winning_option: "yes",
            tallies: { yes: 2, no: 0 },
            diagnostics: { cast_votes: 2, eligible_voters: 2 },
          },
        }),
      ),
    ).toEqual({
      status: "unavailable",
      reason: "aggregate-only agreement receipt omits the votes needed for semantic replay",
    });
  });

  it("does not impose agreement semantics on legacy and plain receipts", () => {
    expect(verifyAgreementReceiptSemantics({ grp: { mechanism: { parameters: {} } } })).toEqual({
      status: "not_applicable",
    });
  });
});
