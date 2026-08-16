# Investment Committee messages-only chat arm

This is an independent fourth surface. It does not reopen or replace the
committee's GRP-chat, natural-GRP, or structured-GRP observations.

## Frozen surface sentence

Replace `{{SURFACE_SENTENCE}}` in `prompts/common.md` with exactly:

`Use the shared messages-only chat to work with the other committee members and complete the assignment.`

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
temporary file outside the repository before sending them. The one-line wait
only notifies you that one event occurred; reread the timeline for its content.
Do not use other grp commands or the execution repository for this task.
```

This block defines the available communication surface. It does not prescribe
when to read, write, wait, agree, decide, or stop.

## Room configuration

The operator creates a fresh private, persistent, room-scoped speech room with
a non-voting host and five committee seats. No decision, proposal, conclusion,
or receipt can exist.

```bash
grp create --about="Morrow Vale investment-committee messages-only trial" --mechanism=ranked_pairwise --quorum=5 --max-participants=6 --voting-window=2700 --settle-window=60 --creator-votes=false --choice-visibility=after_decided --option-proposal-authority=none --decision-opening-authority=none --conclusion-authority=none --max-open-decisions=1
grp invite --name Silica ROOM
grp invite --name Cobalt ROOM
grp invite --name Argon ROOM
grp invite --name Neon ROOM
grp invite --name Mica ROOM
grp settings ROOM
```

Run Silica, Cobalt, Argon, Neon, and Mica in their fixed browser tabs with the
same private mandates used in the three GRP surfaces. Quartz remains held out
for blind adjudication.

## Neutral execution context

Before the room exists, all six browser selectors must use the registered
private neutral repository and neutral orphan branch. The branch has no parent,
its tree contains only the registered neutral `README.md`, and neither the
repository nor branch name may mention GRP, chat, agents, decisions, voting,
mechanisms, the scenario, a prior trial, or another evidence arm.

## Completion and evidence

The 45-minute hard safety cap starts with the final confirmed initial send.
End earlier at the first observation where all five provider turns are idle,
no foreground wait or background process remains, no room transition is
pending, and two read-only room snapshots show quiescent state. Send no live
task message after kickoff.

Apply the frozen committee mechanical extractor before Quartz receives the
anonymized chronological transcript. Then send the frozen memory-only survey
to all five participants. Preserve every setup, provider, browser, transport,
capture, and survey failure.
