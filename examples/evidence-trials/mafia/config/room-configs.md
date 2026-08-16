# Frozen Mafia GRP room configurations and order

## Common topology

Each surface uses three fresh Unlisted rooms:

- the day room includes Mica, Silica, Cobalt, Argon, and Neon;
- the Mafia room includes Mica and Silica; and
- the Doctor room includes Mica and Cobalt.

The operator is a non-voting host and occupies one roster slot in every room.
Mica joins the day room as a participant so the moderator can speak publicly.
Mica joins the two role-specific rooms as an observer: the moderator must read
and watch those rooms to adjudicate the night, but must not appear in either
room's electorate. Quartz is held out and never joins a live room.

Mica is required by the game so hidden night choices can be adjudicated. The
operator does not send room messages, advance phases, tally prose votes, open
runoffs, open night actions, tell agents when to read or wait, or decide when
the game is over.

## Surface boundaries

### Chat with decisions disabled

All three rooms expose ordinary GRP conversation, read, and wake affordances.
Opening decisions, proposing options, and concluding rooms are disabled. The
plurality fields are inert and keep the controlled room schema equal to the
structured arm where possible.

```yaml
visibility: unlisted
creator_votes: false
mechanism: plurality
voting_window: 7200
settle_window: 45
early_close: true
choice_visibility: after_decided
option_proposal_authority: none
decision_opening_authority: none
conclusion_authority: none
max_open_decisions: 1
```

The day room has capacity six and quorum four. Each role-specific room has capacity
three and quorum one.

### Natural GRP

All three rooms use ordinary `grp create` defaults. The operator sets only the
room description, roster capacity, and `creator_votes: false`. No mechanism,
quorum, voting window, visibility rule, authority, question, or option is
specified. Participants may use normal GRP capabilities or remain entirely in
conversation.

### Structured GRP

The three rooms share the controlled settings below. The day room begins with
one fixed-slate plurality decision:

`Day 1: who should be eliminated?`

The exact options and eligible voters, in order, are Silica, Cobalt, Argon,
and Neon. Mica can discuss and moderate in the day room but is explicitly
outside the electorate. The role-specific rooms begin with no question. Any voting
participant may open a later decision or propose options after the first
decision closes. Mica can read and watch those rooms as an observer without
becoming a second possible chooser whose unused ballot blocks early closure.

```yaml
visibility: unlisted
creator_votes: false
mechanism: plurality
voting_window: 7200
settle_window: 45
early_close: true
choice_visibility: after_decided
option_proposal_authority: any_participant
decision_opening_authority: any_participant
conclusion_authority: none
max_open_decisions: 1
```

The two-hour protocol window is longer than the external 45-minute safety cap,
so an unfinished game cannot be ended by decision expiry. Only the Day 1
decision is pre-opened. Ties, runoffs, night actions, later days, and final
closure are left to Mica and the players under the ordinary room capabilities.

## Surface sentences

Replace `{{SURFACE_SENTENCE}}` in each player packet with exactly one line:

- Chat: `Use the shared conversation rooms to play the game.`
- Natural GRP: `Use GRP to play the game.`
- Structured GRP: `Use the GRP rooms and the open Day 1 elimination decision to play the game.`

Use the corresponding Mica line:

- Chat: `Use the shared conversation rooms to administer the game with the players.`
- Natural GRP: `Use GRP to administer the game with the players.`
- Structured GRP: `Use the GRP rooms and the open Day 1 elimination decision to administer the game with the players.`

No participant text calls a surface a control or treatment. It does not teach
a command loop, voting syntax, choice-revision rule, phase marker, correction
window, terminal marker, or stopping procedure.

## Order and fixed assignments

Run chat first, natural GRP second, and structured GRP third. Every room and
provider session is fresh. Silica is always Mafia, Cobalt is always Doctor,
Argon and Neon are always Villagers, Mica is always moderator, and Quartz is
always held out.

Before each surface, follow the shared six-window preflight in
[`../../README.md`](../../README.md). Audit the six existing tabs as one
batch. Confirm the expected account, private repository, registered branch,
Opus 5, high effort, and blank composer. Reuse each tab through sidebar **New**
only. Never open a replacement tab, enter `/transcript`, or move, resize,
maximize, tile, close, or otherwise change a browser window.

## Completion and safety cap

The 45-minute hard safety cap begins with the final confirmed initial send.
Send no participant message during the live task. End earlier at the first
observation where all five participant turns are idle, no foreground wait or
background process remains, no room transition is pending, and two read-only
snapshots of all three rooms are quiescent. Otherwise stop unfinished sessions
at the cap without sending text.

Run the frozen extraction and evidence review before Quartz receives the
anonymized chat transcript. Send the fenced memory-only survey once to all
five participants only after the task has ended.

## Ordinary setup

Run these as operator commands, not as a trial runner. Keep invitation tokens
out of the public record.

### Chat

```bash
grp create --about="Mafia chat-control day room" --mechanism=plurality --quorum=4 --max-participants=6 --voting-window=7200 --settle-window=45 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=none --decision-opening-authority=none --conclusion-authority=none --max-open-decisions=1
grp invite DAY_ROOM --name Mica
grp invite DAY_ROOM --name Silica
grp invite DAY_ROOM --name Cobalt
grp invite DAY_ROOM --name Argon
grp invite DAY_ROOM --name Neon

grp create --about="Mafia chat-control Mafia room" --mechanism=plurality --quorum=1 --max-participants=3 --voting-window=7200 --settle-window=45 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=none --decision-opening-authority=none --conclusion-authority=none --max-open-decisions=1
grp invite MAFIA_ROOM --name Mica --role observer
grp invite MAFIA_ROOM --name Silica

grp create --about="Mafia chat-control Doctor room" --mechanism=plurality --quorum=1 --max-participants=3 --voting-window=7200 --settle-window=45 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=none --decision-opening-authority=none --conclusion-authority=none --max-open-decisions=1
grp invite DOCTOR_ROOM --name Mica --role observer
grp invite DOCTOR_ROOM --name Cobalt
```

### Natural GRP

```bash
grp create --about="Mafia natural-GRP day room" --max-participants=6 --creator-votes=false
grp invite DAY_ROOM --name Mica
grp invite DAY_ROOM --name Silica
grp invite DAY_ROOM --name Cobalt
grp invite DAY_ROOM --name Argon
grp invite DAY_ROOM --name Neon

grp create --about="Mafia natural-GRP Mafia room" --max-participants=3 --creator-votes=false
grp invite MAFIA_ROOM --name Mica --role observer
grp invite MAFIA_ROOM --name Silica

grp create --about="Mafia natural-GRP Doctor room" --max-participants=3 --creator-votes=false
grp invite DOCTOR_ROOM --name Mica --role observer
grp invite DOCTOR_ROOM --name Cobalt
```

### Structured GRP

```bash
grp create --about="Mafia structured day room" --mechanism=plurality --quorum=4 --max-participants=6 --voting-window=7200 --settle-window=45 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=any_participant --decision-opening-authority=any_participant --conclusion-authority=none --max-open-decisions=1
grp invite DAY_ROOM --name Mica
grp invite DAY_ROOM --name Silica
grp invite DAY_ROOM --name Cobalt
grp invite DAY_ROOM --name Argon
grp invite DAY_ROOM --name Neon

grp create --about="Mafia structured Mafia room" --mechanism=plurality --quorum=1 --max-participants=3 --voting-window=7200 --settle-window=45 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=any_participant --decision-opening-authority=any_participant --conclusion-authority=none --max-open-decisions=1
grp invite MAFIA_ROOM --name Mica --role observer
grp invite MAFIA_ROOM --name Silica

grp create --about="Mafia structured Doctor room" --mechanism=plurality --quorum=1 --max-participants=3 --voting-window=7200 --settle-window=45 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=any_participant --decision-opening-authority=any_participant --conclusion-authority=none --max-open-decisions=1
grp invite DOCTOR_ROOM --name Mica --role observer
grp invite DOCTOR_ROOM --name Cobalt
```

The structured surface has one setup-only join gate. After all three rooms and
named invitations exist, have the five trial sessions run only their named
join commands and confirm that the intended seats are present. Precede the
first join command in every fresh cloud session with the official CLI installer
from the shared preflight; do not assume `grp` is already on `PATH`. Do not send
the game rules or surface sentence yet. An explicit electorate can resolve
only joined participants, not pending named invitations. Once Mica, Silica,
Cobalt, Argon, and Neon are present in the day room, open the frozen question:

```bash
grp ask "Day 1: who should be eliminated?" DAY_ROOM --options=Silica,Cobalt,Argon,Neon --eligible=Silica,Cobalt,Argon,Neon
```

Then read back the exact electorate and send the unchanged task packets in one
tight pass. The join gate is transport setup, not gameplay guidance, and no
agent reads, speaks, opens a decision, or takes a game action during it.

After each setup, read `grp settings` for all three rooms. For the structured
day room, also read `grp options` and confirm the open question, exact ordered
slate, and four-player electorate before any initial prompt is sent.
