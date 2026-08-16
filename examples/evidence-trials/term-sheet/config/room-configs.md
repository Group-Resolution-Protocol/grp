# Frozen Term Sheet room configurations and order

## Common shape

All rooms are Unlisted and operator-created. The creator is a non-voting host
and occupies one roster slot. Silica and Cobalt are the only negotiating
participants. Argon joins as an observer. Capacity is therefore four.

The chat and structured rooms use these controlled settings:

```yaml
visibility: unlisted
creator_votes: false
mechanism: simple_majority
max_participants: 4
quorum: 2
voting_window: 1800
settle_window: 45
early_close: true
choice_visibility: after_decided
option_proposal_authority: any_participant
decision_opening_authority: any_participant
conclusion_authority: none
max_open_decisions: 1
```

The chat room overrides option proposal and decision opening authority to
`none`. It opens with no question and can never open one.

The natural-GRP room uses ordinary `grp create` defaults. The operator sets
only its purpose, four-slot capacity, and `creator_votes: false`. It begins
with no question or options.

The structured room opens this agreement question in collect-options phase:

`Which complete term-sheet package should Kestrel and Northline jointly recommend?`

An agreement decision resolves only when every eligible voter accepts the
same option. Argon is an observer, so the eligible voters are Silica and
Cobalt. Packages are proposed during the run; no package is prewritten by the
operator.

## Surface sentences

Replace `{{SURFACE_SENTENCE}}` with exactly one line:

- Chat: `Use the shared conversation room to negotiate with the other party and complete the assignment.`
- Natural GRP: `Use GRP to negotiate with the other party and complete the assignment.`
- Structured GRP: `Use the GRP room and its open agreement decision to negotiate with the other party and complete the assignment.`

No arm is called a control or treatment in participant text.

## Order and fixed assignments

Run chat first, natural GRP second, and structured GRP third. Use fresh sessions
in the existing browser tabs. Silica always receives `silica.md`, Cobalt always
receives `cobalt.md`, and Argon always receives `argon.md`. Quartz judges chat
and never joins a live room. Neon and Mica are unused.

Before each arm, follow the shared six-window grid preflight in
[`../../README.md`](../../README.md). Confirm the private execution repository,
registered source branch, Opus 5, high effort, and blank composer. Never enter
`/transcript` in a participant composer.

## Completion and safety cap

The 60-minute safety cap begins with the final confirmed initial send. Send no
participant message during the live task. End earlier at the first observation
where Silica, Cobalt, and Argon are all idle; no foreground wait, tool call, or
background process remains; no room transition is pending; and a final
read-only room snapshot is quiescent. Otherwise stop any unfinished session at
the cap without sending it a message.

The chat-control and structured-room commands use a two-hour protocol voting
window. That window is deliberately longer than the external safety cap, so a
pre-opened decision cannot expire while a live negotiation is still making
progress. It does not extend the live task beyond the 60-minute cap.

## Ordinary setup

Run these operator commands one at a time. Keep invitation tokens out of the
public record.

Chat room:

```bash
grp create --about="Term Sheet chat-control trial" --mechanism=simple_majority --quorum=2 --max-participants=4 --voting-window=7200 --settle-window=45 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=none --decision-opening-authority=none --conclusion-authority=none --max-open-decisions=1
grp invite ROOM --name Silica
grp invite ROOM --name Cobalt
grp invite ROOM --name Argon --role observer
grp settings ROOM
```

Natural-GRP room:

```bash
grp create --about="Term Sheet natural-GRP trial" --max-participants=4 --creator-votes=false
grp invite ROOM --name Silica
grp invite ROOM --name Cobalt
grp invite ROOM --name Argon --role observer
grp settings ROOM
```

Structured-GRP room:

```bash
grp create --about="Term Sheet agreement-decision trial" --mechanism=simple_majority --quorum=2 --max-participants=4 --voting-window=7200 --settle-window=45 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=any_participant --decision-opening-authority=any_participant --conclusion-authority=none --max-open-decisions=1
grp invite ROOM --name Silica
grp invite ROOM --name Cobalt
grp invite ROOM --name Argon --role observer
grp ask "Which complete term-sheet package should Kestrel and Northline jointly recommend?" ROOM --agreement --collect-options
grp settings ROOM
grp options ROOM
```

The structured decision is opened only after all three named invitations
exist, so its electorate is derived from the two expected voting seats while
the observer remains ineligible.
