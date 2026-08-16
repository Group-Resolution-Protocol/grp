# Frozen Dinner room configurations and order

## Common settings

All three rooms are Unlisted and operator-created. The operator is a non-voting
host. The host still occupies a participant-roster slot, so the room capacity
is four: one host plus the three eligible diners. The chat and preconfigured
simple-majority rooms share the controlled settings below; their quorum is
three. The natural room's smaller setup is specified separately.

```yaml
visibility: unlisted
creator_votes: false
mechanism: simple_majority
max_participants: 4
quorum: 3
voting_window: 1200
settle_window: 45
early_close: true
choice_visibility: after_decided
option_proposal_authority: none
decision_opening_authority: any_participant
conclusion_authority: none
max_open_decisions: 1
```

The treatment room opens with this question:

`Which dinner plan should Silica, Cobalt, and Argon use?`

Its exact options, in order, are:

1. `Tamarind Table at 7:30 PM`
2. `Tamarind Table at 8:00 PM`
3. `Sol y Nopal at 7:00 PM`
4. `Sol y Nopal at 7:30 PM`
5. `Olive Yard at 8:00 PM`
6. `Lantern Sushi at 8:00 PM`
7. `Piazza Nook at 7:30 PM`

The chat room opens with no decision and overrides:

```yaml
decision_opening_authority: none
conclusion_authority: none
```

The natural-GRP room also opens with no decision. It uses an ordinary `grp
create` with no mechanism, quorum, voting-window, choice-visibility, or
authority flags. The operator sets only the task description, four-slot
capacity, and `creator_votes: false` for the non-voting host plus three diners.
No decision or options are preloaded.

## Surface sentences

Replace `{{SURFACE_SENTENCE}}` with exactly one line:

- Chat: `Use the shared conversation room to work with the other diners and complete the assignment.`
- Natural GRP: `Use GRP to work with the other diners and complete the assignment.`
- Treatment: `Use the GRP room and its open decision to work with the other diners and complete the assignment.`

## Order and fixed assignments

Quartz is the post-run judge and never joins a live room.

Silica, Cobalt, and Argon are both the account names and the agent names in
every arm. Their private preferences are fixed across chat, natural GRP, and
simple majority: Silica receives `silica.md`, Cobalt receives `cobalt.md`, and
Argon receives `argon.md`. There is no persona alias or arm-to-arm rotation.

Run chat first, natural GRP second, and simple majority third. All use fresh
sessions. Before every paste, confirm Claude Opus 5 and high effort. Record
transcript-display availability during preflight. The current Claude Code web
surface has no verified display-only control, so never enter `/transcript` in
a participant composer.

## Completion and safety cap

The 20-minute safety cap begins when the third participant receives the
initial prompt. Do not message a participant during the live task. End sooner
once all three model turns are idle, no foreground wait or background process
remains, no room transition is pending, and a final read-only room snapshot is
quiescent. Record that observation as the task end. Otherwise stop any
still-running session at the safety cap without sending it a message.

## Ordinary setup

These are operator commands, not a trial runner. Run them one at a time and
retain the returned room slug without publishing invitation tokens.

Chat room:

```bash
grp create --about="Dinner chat-control trial" --mechanism=simple_majority --quorum=3 --max-participants=4 --voting-window=1200 --settle-window=45 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=none --decision-opening-authority=none --conclusion-authority=none --max-open-decisions=1
grp invite --name Silica ROOM
grp invite --name Cobalt ROOM
grp invite --name Argon ROOM
grp settings ROOM
```

Natural-GRP room:

```bash
grp create --about="Dinner natural-GRP trial" --max-participants=4 --creator-votes=false
grp invite --name Silica ROOM
grp invite --name Cobalt ROOM
grp invite --name Argon ROOM
grp settings ROOM
```

Treatment room:

```bash
grp create --about="Dinner decision-surface trial" --ask="Which dinner plan should Silica, Cobalt, and Argon use?" --option="Tamarind Table at 7:30 PM" --option="Tamarind Table at 8:00 PM" --option="Sol y Nopal at 7:00 PM" --option="Sol y Nopal at 7:30 PM" --option="Olive Yard at 8:00 PM" --option="Lantern Sushi at 8:00 PM" --option="Piazza Nook at 7:30 PM" --mechanism=simple_majority --quorum=3 --max-participants=4 --voting-window=1200 --settle-window=45 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=none --decision-opening-authority=any_participant --conclusion-authority=none --max-open-decisions=1
grp invite --name Silica ROOM
grp invite --name Cobalt ROOM
grp invite --name Argon ROOM
grp settings ROOM
grp options ROOM
```

## 2026-08-03 development-rehearsal amendment

Before the next Dinner room existed, the common prompt's explicit reference to
an outside chair was removed and the invite names were changed from rotating
Dinner roles to the three standing account identities. This removes a prompt
cue for a coordination convention measured by the study and follows the common
browser checklist. It did not change the assignment, preferences, option
slate, room surfaces, mechanism, order, cutoff, predictions, or instruments.

## 2026-08-03 release-candidate amendment

The development rehearsal showed two unnecessary sources of confusion. The
private Alex/Blair/Casey aliases and arm-to-arm preference rotation are removed
prospectively; Silica, Cobalt, and Argon now keep one fixed preference packet
through all three surfaces. The fixed 20-minute observation window is also
replaced by the deterministic all-idle completion rule above, with 20 minutes
retained only as a safety cap. Historical rooms and reports keep the names and
timing rule actually used. No outcome from the rehearsal is relabeled.

## 2026-08-04 post-paper-attempt amendment

Paper-set attempt 1 showed that a zero-second settlement can seal a hidden-
choice result as soon as the third diner arrives, before earlier diners can
respond to information posted with that last choice. Prospectively, the chat
control and structured rooms use the reference implementation's ordinary
45-second settlement window. The chat room cannot open a decision, so this
setting is inert there; keeping it equal isolates the available decision
surface. Completed rooms retain the settings they actually used.
