# Dinner messages-only chat arm

This is an independent fourth surface. It does not reopen or replace Dinner's
completed GRP-chat, natural-GRP, or structured-GRP arms.

## Frozen surface sentence

Replace `{{SURFACE_SENTENCE}}` in `prompts/common.md` with exactly:

`Use the shared messages-only chat to work with the other diners and complete the assignment.`

## Named connection block

Create one named invite per agent. Replace the placeholders and give each seat
only its own block:

```text
Install the transport client if needed:
  curl -fsSL https://grp.app/grp/install.sh | sh

Join this messages-only room as AGENT_NAME:
  grp join https://api.grp.app/r/ROOM --invite=INVITE --json

For shared communication in this trial, use only:
  grp timeline
  grp discuss --file=PATH --quiet
  grp watch --timeout=0 | head -n 1

The timeline is the chronological shared chat. Write exact messages to a
temporary file outside the repository before sending them. The one-line wait only
notifies you that one event occurred; reread the timeline for its content.
Do not use other grp commands in this trial.
```

This block defines the available communication surface. It does not prescribe
when to read, write, wait, agree, or stop.

## Room configuration

The operator creates a fresh private, persistent, room-scoped speech room with
a non-voting host and three participant slots. No decision, proposal,
conclusion, or receipt can exist.

```bash
grp create --about="Dinner messages-only trial" --mechanism=simple_majority --quorum=3 --max-participants=4 --voting-window=1200 --settle-window=45 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=none --decision-opening-authority=none --conclusion-authority=none --max-open-decisions=1
grp invite --name Silica ROOM
grp invite --name Cobalt ROOM
grp invite --name Argon ROOM
grp settings ROOM
```

Run Silica, Cobalt, and Argon in their existing fixed browser tabs with their
unchanged private preference files. Quartz is held out for blind adjudication.
Neon and Mica are unused.

## Completion and evidence

The 20-minute hard safety cap starts with the final confirmed initial send.
End earlier at the first observation where all three provider turns are idle,
no foreground wait or background process remains, no room transition is
pending, and two read-only room snapshots show quiescent state. Send no live
task message after kickoff.

Apply the existing frozen Dinner mechanical extractor before Quartz receives
an anonymized transcript. Then send the existing frozen memory-only survey to
Silica, Cobalt, and Argon. Preserve every setup, provider, browser, transport,
capture, and survey failure.
