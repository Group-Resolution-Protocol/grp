# Morning Inbox — organization in a box

This manifest creates Mica and four counterparties, with one private room per
relationship. Silica and Cobalt open decisions, Argon asks a normal question,
and Neon keeps a room quiet. Mica must find and handle the work.

```bash
grp org validate examples/canonical-trials/morning-inbox/organization/organization.yaml
grp org create examples/canonical-trials/morning-inbox/organization/organization.yaml \
  --output=./morning-inbox-company
grp org launch ./morning-inbox-company
```

All five sessions use the local Claude account. They start together; Mica's
brief tells it to stay with the morning sweep while the counterparties place
their items in the rooms.

Record the run end after all five sessions are idle with no wait or background
task and the final room snapshots are quiescent.
