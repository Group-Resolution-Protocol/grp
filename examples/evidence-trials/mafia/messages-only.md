# Mafia messages-only chat arm

This is an independent fourth surface. It does not reopen or replace Mafia's
GRP-chat, natural-GRP, or structured-GRP rooms.

## Treatment boundary

The four players and neutral moderator share attributed chronological messages
with exact quiet send and one-line arrival notification. The ordinary GRP read
projection, decisions, choices, tallies, outcomes, conclusions, and receipts
are unavailable.

Mica remains the game moderator because Mafia cannot preserve secret night
actions without a neutral seat that can see both private rooms. Mica is part of
the task in every Mafia surface, not a chair supplied to solve ordinary group
coordination. This scenario therefore does not test whether agents invent a
leader. It tests whether messages alone let them preserve roles, express and
revise votes, move between public and private phases, adjudicate the rules, and
know when the game has ended.

## Named connection blocks

Create named invites for Mica and every player. Replace the placeholders and
give each seat only its own block. A seat with more than one room uses the
explicit room argument shown below; joining a later room does not select it as
current.

Mica:

```text
Install the transport client if needed:
  curl -fsSL https://grp.app/grp/install.sh | sh

Join the messages-only rooms as Mica:
  grp join https://api.grp.app/r/DAY_ROOM --invite=MICA_DAY_INVITE --json
  grp join https://api.grp.app/r/MAFIA_ROOM --invite=MICA_MAFIA_INVITE --json
  grp join https://api.grp.app/r/DOCTOR_ROOM --invite=MICA_DOCTOR_INVITE --json

For shared communication in this trial, use only:
  grp timeline ROOM
  grp discuss --file=PATH --quiet ROOM
  grp watch --timeout=0 ROOM | head -n 1

DAY_ROOM, MAFIA_ROOM, and DOCTOR_ROOM above mean the corresponding room IDs.
The timeline is that room's chronological chat. Write exact messages to a
temporary file outside the repository before sending them. The one-line wait
only notifies you that one event occurred; reread the timeline for its content.
Do not use other grp commands or the execution repository for this task.
```

Silica receives the same block with the day and Mafia join commands and those
two explicit room IDs. Cobalt receives it with the day and Doctor join commands
and those two room IDs. Argon and Neon receive it with only the day join and
day-room commands.

The block defines the available communication surface. It does not prescribe
when to read, write, wait, vote, revise, tally, change phase, or stop.

## Execution-context neutrality

Before a future evidence room is created, all six Claude Code sessions must be
on a clean private execution repository and branch whose names are neutral.
Neither name may mention GRP, chat, decisions, voting, mechanisms, agents, the
scenario, a prior trial, or another evidence arm. The checked-out tree must
contain only a neutral `README.md`; it must not contain `CLAUDE.md`,
`AGENTS.md`, task facts, trial artifacts, or prior work. The operator reads the
active repository and branch selectors directly in all six windows during the
batch preflight.

This is a hard treatment gate, not cosmetic tidying. Repository and branch
names can enter provider context even when participants are told not to use the
repository. A run in a semantically loaded execution context remains counted,
but it cannot be the clean post-revision observation.

## Room configuration

The operator creates three fresh private, persistent, room-scoped speech rooms.
All decision, proposal, and conclusion authority is disabled.

```bash
grp create --about="Mafia messages-only day room" --mechanism=plurality --quorum=4 --max-participants=6 --voting-window=2700 --settle-window=45 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=none --decision-opening-authority=none --conclusion-authority=none --max-open-decisions=1
grp invite --name Mica DAY_ROOM
grp invite --name Silica DAY_ROOM
grp invite --name Cobalt DAY_ROOM
grp invite --name Argon DAY_ROOM
grp invite --name Neon DAY_ROOM

grp create --about="Mafia messages-only Mafia room" --mechanism=plurality --quorum=1 --max-participants=3 --voting-window=2700 --settle-window=45 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=none --decision-opening-authority=none --conclusion-authority=none --max-open-decisions=1
grp invite --name Mica MAFIA_ROOM
grp invite --name Silica MAFIA_ROOM

grp create --about="Mafia messages-only Doctor room" --mechanism=plurality --quorum=1 --max-participants=3 --voting-window=2700 --settle-window=45 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=none --decision-opening-authority=none --conclusion-authority=none --max-open-decisions=1
grp invite --name Mica DOCTOR_ROOM
grp invite --name Cobalt DOCTOR_ROOM
```

The mechanism fields are inert because no decision can be opened. They keep
the ordinary room schema valid and are not exposed to participants.

## Completion and evidence

The 45-minute hard safety cap starts with the final confirmed initial send.
End earlier at the first observation where all five participant turns are idle,
no foreground wait or background process remains, no room transition remains,
and two read-only snapshots of all three rooms are quiescent. Send no live task
message after kickoff.

Apply the frozen Mafia extraction rule before Quartz receives anonymized logs
from all three rooms. Then send the frozen memory-only survey to Mica, Silica,
Cobalt, Argon, and Neon. Send only the fenced participant block in
`instruments/survey.md`, never its heading or operator directions. Preserve
every setup, provider, browser, transport, capture, gameplay, and survey
failure.
