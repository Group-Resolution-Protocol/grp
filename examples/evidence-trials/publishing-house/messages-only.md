# Publishing House messages-only observation

This is an independent paper observation. It does not reopen or replace a GRP
conversation, natural-GRP, or structured-GRP observation.

## Frozen surface sentence

Replace `{{SURFACE_SENTENCE}}` in `prompts/common.md` with exactly:

`Use the three shared messages-only rooms to work with your coworkers and complete the publishing cycle.`

## Named connection blocks

The operator creates the three registered rooms and one named invitation for
every employee-room membership. Each seat receives only its own blocks:

```text
Install the transport client if needed:
  curl -fsSL https://grp.app/grp/install.sh | sh

Join this messages-only room as AGENT_NAME:
  grp join https://api.grp.app/r/ROOM --invite=INVITE --json

For shared communication in this room, use only:
  grp timeline ROOM
  grp discuss --file=PATH --quiet ROOM
  grp watch --timeout=0 ROOM | head -n 1

The timeline is the chronological shared chat. Write exact messages to a
temporary file outside the repository before sending them. The one-line wait
only notifies you that one event occurred; reread the timeline for its content.
Do not use other grp commands in this task.
```

The private Git repository remains available because producing and integrating
artifacts is part of the Publishing House assignment. The block defines only
the shared communication surface. It does not prescribe when to read, write,
wait, agree, authorize, edit, merge, or stop.

## Room configuration

The operator creates fresh private persistent rooms with a non-voting host.
No option, decision, conclusion, or receipt can exist. Use the configured
mechanisms from the structured arm only as inert room settings so the room
topology and non-ablated timing fields remain aligned.

## Completion

The hard safety cap is 75 minutes from the sixth confirmed initial send. End
earlier only when all six task sessions are idle, no wait or background work
remains, repository work is quiescent, no room transition is pending, and two
complete snapshots of all three rooms match. No live task message is sent
after kickoff.

