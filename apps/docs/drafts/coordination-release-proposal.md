# Release-scope review: optional coordination capabilities for GRP

Unpublished draft for local maintainer review. This is not an
accepted specification, release announcement, or declaration of availability.

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

**Recommendation for review:** define a separately versioned, explicitly
optional REST coordination extension, with discovery that identifies supported
operations and authentication, and a separate conformance verdict. Base-profile
conformance alone must never imply extension support. Clients must fail clearly
when a host or transport lacks a required capability. Older clients remain
usable for ordinary rooms, but cannot contribute in enforced-turn rooms.

This requires an explicit maintainer decision about the scope of transport
parity and versioning. Versioning §2.2 requires a new protocol version for
behavior changes, while §3.1 permits additive optional fields/capabilities.
The proposal must resolve that distinction, including changed guard/recovery
behavior, before any normative promotion. Do not assume a capability flag alone
exempts a behavior change. If the accepted interpretation requires a new base
protocol version or full transport parity, revise implementation and validation
accordingly before releasing the affected capability.

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
deployment, and this draft does not settle the technical scope decision above.

## Proposed tooling release selection

Subject to the accepted scope and a final registry/byte check:

| Package | Proposed next version | Reason |
| --- | --- | --- |
| CLI | 0.2.0 | New workflows and intentionally changed read/acknowledgment and recovery behavior |
| SDK | 0.1.1 | Additive selected types/method and cancellation verification support |
| Engine | 0.1.1 | Reviewed invariant-handling cleanup; no intended mechanism behavior change |
| Conformance | 0.1.1 | Additional offline projection validation; not full extension certification |
| Audit | No release planned | No intended runtime change requiring a release |

These are proposed npm versions, not a protocol-version ruling or frozen
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
