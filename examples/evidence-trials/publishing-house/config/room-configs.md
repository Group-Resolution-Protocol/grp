# Frozen Publishing House room configurations

## Common topology and timing

All rooms are Unlisted and persistent. The operator is a non-voting host and
occupies one roster slot. The Greenlight room therefore has capacity seven,
Editorial capacity five, and Launch capacity four. All configured rooms use a
4,500-second choice window, a 60-second settlement window, early close, hidden
choices until resolution, participant-authored options where decisions are
enabled, no participant conclusion authority, and enough open-decision slots
for the department's work.

The task safety cap is 75 minutes after the sixth confirmed kickoff. It does
not keep a completed company running.

## Surface sentences

Replace `{{SURFACE_SENTENCE}}` in every assembled packet with exactly one:

- Messages only: `Use the three shared messages-only rooms to work with your coworkers and complete the publishing cycle.`
- Decisions disabled: `Use the shared conversation rooms to work with your coworkers and complete the publishing cycle.`
- Natural GRP: `Use GRP to work with your coworkers and complete the publishing cycle.`
- Structured GRP: `Use the GRP rooms and their configured decision surfaces to work with your coworkers and complete the publishing cycle.`

No arm is named as a control or treatment. No sentence specifies a chair,
ballot format, turn order, final marker, Git workflow, or recovery procedure.

## Arm order

1. Messages only
2. Decisions-disabled GRP conversation
3. Natural GRP
4. Structured GRP

Each arm uses a fresh repository baseline branch, three fresh rooms, six fresh
provider sessions, and fresh named invitations. A clean first attempt is final.

## Decisions-disabled and messages-only rooms

Create the rooms with the structured mechanism for that department but disable
both option proposals and decision opening:

```bash
grp create --about="Lantern Press Greenlight" --mechanism=score_vote --quorum=6 --max-participants=7 --voting-window=4500 --settle-window=60 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=none --decision-opening-authority=none --conclusion-authority=none --max-open-decisions=3
grp create --about="Lantern Press Editorial" --mechanism=simple_majority --quorum=2 --max-participants=5 --voting-window=4500 --settle-window=60 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=none --decision-opening-authority=none --conclusion-authority=none --max-open-decisions=2
grp create --about="Lantern Press Launch" --mechanism=simple_majority --quorum=3 --max-participants=4 --voting-window=4500 --settle-window=60 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=none --decision-opening-authority=none --conclusion-authority=none --max-open-decisions=2
```

No decision is preopened.

## Natural-GRP rooms

Use ordinary create defaults. Set only the task description, capacity needed
for the non-voting host plus department members, and `creator_votes: false`:

```bash
grp create --about="Lantern Press Greenlight" --max-participants=7 --creator-votes=false
grp create --about="Lantern Press Editorial" --max-participants=5 --creator-votes=false
grp create --about="Lantern Press Launch" --max-participants=4 --creator-votes=false
```

No decision, mechanism, option, or procedure is supplied in the participant
prompt. The server's ordinary defaults remain observable.

## Structured-GRP rooms

The work products do not exist at kickoff, so no question or option is
preopened. The prospectively chosen department mechanisms and electorate floors
are configured before kickoff:

```bash
grp create --about="Lantern Press Greenlight" --mechanism=score_vote --quorum=6 --max-participants=7 --voting-window=4500 --settle-window=60 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=any_participant --decision-opening-authority=any_participant --conclusion-authority=none --max-open-decisions=3
grp create --about="Lantern Press Editorial" --mechanism=simple_majority --quorum=2 --max-participants=5 --voting-window=4500 --settle-window=60 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=any_participant --decision-opening-authority=any_participant --conclusion-authority=none --max-open-decisions=2
grp create --about="Lantern Press Launch" --mechanism=simple_majority --quorum=3 --max-participants=4 --voting-window=4500 --settle-window=60 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=any_participant --decision-opening-authority=any_participant --conclusion-authority=none --max-open-decisions=2
```

Greenlight is configured for score voting across all six employees. Editorial
requires at least the two editors to act and the task itself requires Silica
and Mica to approve the same exact version; agents choose how to represent any
additional eligible readers. Launch requires all three department members to
participate. Agreement questions remain available through the ordinary CLI,
but the operator does not prescribe when or how to use one.

## Named memberships

Create these participant invitations in every arm:

| Room | Named participants |
|---|---|
| Greenlight | Silica, Cobalt, Argon, Mica, Neon, Quartz |
| Editorial | Silica, Mica, Neon, Quartz |
| Launch | Silica, Cobalt, Argon |

Before kickoff, read back every room's settings and members. For decisions-
disabled and natural arms, verify no decision is open. Never expose invitation
tokens in a report.

## Repository baseline

Every arm begins from the exact three files in `../seed/` on a fresh private
baseline branch. Neither the repository nor baseline branch may name GRP,
chat, agents, decisions, voting, a mechanism, the scenario, an arm, an outcome,
or a previous trial. Record repository, branch, commit, tree, and seed-file
hashes before room creation. All six active selectors must show that same
baseline before kickoff.
