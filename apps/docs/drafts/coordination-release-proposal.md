# Release-scope review: optional coordination capabilities for GRP

Local release-scope decision, not a published specification, release announcement
or declaration of availability. The maintained scope and compatibility decision
is in `apps/docs/content/specification/coordination-release-scope.mdx`.

## Problem and proposed scope

A decision records a choice. It does not by itself record who will do the work,
whether the work is still open, which output was reviewed, or whether an
amendment supersedes a previous result. Add Actions and optional versioned
Artifacts, while keeping ordinary discussion and decisions available.

The proposed capability covers action ownership, handoff and cancellation;
holder or group completion; immutable artifact revisions; exact-version review
and non-dispositive follow-up notes; and successor lineage. Optional speaking
turns serialize conversational contributions with bounded, renewable grants.
They do not serialize votes or reviews, pause decision deadlines, or guarantee
that an absent reviewer returns. Open foreground remains the recommended model.

The candidate client also improves bounded read delivery, change-oriented
review views, state observations and recovery. These are not claims that agents
understand every delivered byte, that agreement proves correctness, or that GRP
executes or authorizes external tool actions.

## Explicit compatibility and transport decision

Keep the published base specification and receipt-verification commitments
unchanged during review. The implementation currently supplies the new resource
mutations through participant-token REST and the CLI, not equivalent MCP tools
or mandate-scoped mutations. Selected SDK types/methods are not full parity.
The base transport requirement must not be silently weakened to fit that gap.

**Decision:** target protocol `0.2`, retaining the existing REST/MCP decision
surface and explicitly defining optional REST/token coordination. Requiring
turns changes discussion eligibility; open successors can prevent conclusion.
Those existing-operation behavior changes fall under Versioning §2.2, not just
§3.1's additive-field exception. The frozen `0.1` contract stays unchanged.

Discovery must identify the supported operations/authentication and protocol
version honestly; coordination needs its own conformance coverage. Base-profile
success is not extension certification. The current experimental `0.1`
advertisement is not the final version contract. Implement and test the version
transition before promotion, including older-client refusal/upgrade behavior.
Do not claim that ordinary-room success against today's experimental declaration
proves older clients accept the final declaration. Existing receipts must continue
to verify. CLI-only output/acknowledgment changes belong in its package migration.

Retained phased foreground and generic working signals are experimental, not
part of the recommended release workflow. No new voting mechanism, mandatory
turn policy, automatic approval, or forced stopping heuristic is proposed.

## Reviewable artifacts and acceptance

- The candidate guides, lifecycle draft and separate candidate OpenAPI document
  define the currently implemented subset; the frozen base contract is separate.
- Synthetic schema and projection tests validate shapes, not live conformance.
  Acceptance needs lifecycle, role/authentication denials, atomicity, stale
  observations, fencing/expiry, exact review and compatibility evidence.
- Receipts continue to prove a signed decision record, not independent truth,
  complete runtime transcripts, action execution or the agent's outside authority.
- Upgrade documentation must distinguish protocol/capability versions, npm
  versions and host availability. These are different version domains.
- Maintainer acceptance, provider safeguards and explicit publication/deployment
  approvals remain necessary; no trial result substitutes for them.

Review the scope, implementation and conformance locally, obtain maintainer
approval, then record the accepted specification change. No public proposal or
waiting period is required. Local acceptance does not authorize publication or
deployment. The scope decision above does not imply its version transition or
remaining validation work is already implemented.

## Selected tooling release targets

Subject to a final registry/byte check:

| Package | Target version | Reason |
| --- | --- | --- |
| CLI | 0.2.0 | New workflows and intentionally changed read/acknowledgment and recovery behavior |
| SDK | 0.1.1 | Additive selected types/method and cancellation verification support |
| Engine | 0.1.1 | Reviewed invariant-handling cleanup; no intended mechanism behavior change |
| Conformance | 0.1.1 | Additional offline projection validation; not full extension certification |
| Audit | No release planned | No intended runtime change requiring a release |

These are npm targets, not published or reserved versions or frozen
artifacts. Do not overwrite existing versions. Mechanism identifiers, engine
identity and package versions must not be bumped together merely for symmetry.

## Communications and limits

Lead with “From agreement to action.” Keep small reliability improvements in
the release notes and upgrade guide. A separate observations article can discuss
verbosity, repeated work, context loss and correlated errors. Individual model
pairs are descriptive, not a leaderboard or causal result. A reproducible
collaboration benchmark is a future direction, not a feature of this release.

The safety page remains the durable home for risks. Authenticated participants
can still amplify untrusted instructions or incorrect premises. Room credentials,
votes and signed outcomes do not grant filesystem, network, publication or other
external authority. Independent tool permissions and review remain necessary.
