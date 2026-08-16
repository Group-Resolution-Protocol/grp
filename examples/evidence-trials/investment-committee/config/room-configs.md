# Frozen room configurations and order

## Common settings

All rooms are Unlisted and operator-created. The operator is a non-voting host.
The host still occupies a participant-roster slot, so room capacity is six:
one host plus the five eligible committee seats. The chat and preconfigured
ranked-pairwise room share the controlled settings below; their quorum is
five. The natural room's smaller setup is specified separately.

```yaml
visibility: unlisted
creator_votes: false
max_participants: 6
quorum: 5
voting_window: 2700
settle_window: 60
early_close: true
choice_visibility: after_decided
option_proposal_authority: none
decision_opening_authority: any_participant
conclusion_authority: none
max_open_decisions: 1
```

The structured room opens with the question and five exact options from
`evidence-packet.md`. The chat room opens with no decision and overrides:

```yaml
decision_opening_authority: none
conclusion_authority: none
```

The configured mechanism field in the chat room is `ranked_pairwise`, although
no decision can open. This keeps every non-ablated room setting aligned with
the spec-053 treatment.

The natural-GRP room also opens with no decision. It uses an ordinary `grp
create` with no mechanism, quorum, voting-window, choice-visibility, or
authority flags. The reference CLI/server therefore supplies its normal room
defaults. The operator sets only the task description, a six-slot capacity,
and `creator_votes: false`, which are required for the non-voting host plus
five committee seats. The operator does not open a decision or preload the
five packages as room options.

## Surface sentences

Replace `{{SURFACE_SENTENCE}}` in each seat prompt with exactly one line:

- Chat: `Use the shared conversation room to work with the other committee members and complete the assignment.`
- Natural GRP: `Use GRP to work with the other committee members and complete the assignment.`
- Mechanism: `Use the GRP room and its open decision to work with the other committee members and complete the assignment.`

## Arm order

1. Chat control
2. Natural GRP
3. Ranked pairwise

The registered ablation is chat versus ranked pairwise; natural GRP is analyzed
separately. The earlier simple-majority, plurality, ranked-pairwise, and score-
vote sweep remains development evidence. All three paper arms use fresh agent
sessions.

## Fixed agent assignments

Quartz is the post-run judge in every arm and never joins a live committee
room.

The standing account name is inserted into `{{ACCOUNT_NAME}}` and used for its
named invitation. The same agent receives the same private file in chat,
natural GRP, and ranked pairwise:

| Agent | Private file |
|---|---|
| Silica | `silica.md` |
| Cobalt | `cobalt.md` |
| Argon | `argon.md` |
| Neon | `neon.md` |
| Mica | `mica.md` |

Before every paste, confirm all five participant sessions show Claude Opus 5
and high effort. Record transcript-display availability during preflight. The
current Claude Code web surface has no verified display-only control, so never
enter `/transcript` in a participant composer. Record any setting that cannot
be made identical.

## Completion and safety cap

The 45-minute safety cap begins when the fifth seat receives its initial
prompt. Record every launch timestamp. No participant gets a second operator
message during the live task. End sooner once all five model turns are idle,
no foreground wait or background process remains, no room transition is
pending, and a final read-only room snapshot is quiescent. Otherwise stop
still-running sessions at the safety cap without a message and code them as
budget exits.

## Ordinary setup

These are operator commands, not a trial runner. Run them one at a time. The
five option strings below are the exact room slate; do not shorten or reorder
them. Retain room slugs for the record, but never publish invitation tokens.

For the chat arm:

```bash
grp create --about="Morrow Vale investment-committee chat-control trial" --mechanism=ranked_pairwise --quorum=5 --max-participants=6 --voting-window=2700 --settle-window=60 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=none --decision-opening-authority=none --conclusion-authority=none --max-open-decisions=1
```

For the natural-GRP arm:

```bash
grp create --about="Morrow Vale investment-committee natural-GRP trial" --max-participants=6 --creator-votes=false
```

For the ranked-pairwise structured arm:

```bash
grp create --about="Morrow Vale investment-committee ranked-pairwise trial" --ask="Which FY2027 target-exposure package should Morrow Vale Capital authorize?" --option="HOLD — CRM -30%, WDAY -30%, NOW -30%, NVDA +25%, TSM +25%, AVGO +20%, VRT +20%, CEG 0%, cash +100%, gross 180%" --option="UNWIND — CRM 0%, WDAY 0%, NOW 0%, NVDA +10%, TSM +10%, AVGO +8%, VRT +7%, CEG 0%, cash +65%, gross 35%" --option="SHORT-CASH — CRM -25%, WDAY -25%, NOW -25%, NVDA +12%, TSM +12%, AVGO +10%, VRT +6%, CEG 0%, cash +135%, gross 115%" --option="TRIM-BOTH — CRM -15%, WDAY -15%, NOW -15%, NVDA +15%, TSM +15%, AVGO +12%, VRT +10%, CEG 0%, cash +93%, gross 97%" --option="POWER-ROTATE — CRM -15%, WDAY -15%, NOW -15%, NVDA +10%, TSM +10%, AVGO +10%, VRT +14%, CEG +15%, cash +86%, gross 104%" --mechanism=ranked_pairwise --quorum=5 --max-participants=6 --voting-window=2700 --settle-window=60 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=none --decision-opening-authority=any_participant --conclusion-authority=none --max-open-decisions=1
```

Create and preserve one named invitation per standing account:

```bash
grp invite --name Silica ROOM
grp invite --name Cobalt ROOM
grp invite --name Argon ROOM
grp invite --name Neon ROOM
grp invite --name Mica ROOM
grp settings ROOM
```

For a preconfigured decision arm, also run `grp options ROOM` before any
prompt is pasted. For chat and natural GRP, confirm that the room has no open
decision. Do not inspect or alter the natural room again after kickoff unless
the run record clearly logs the read-only observation.
