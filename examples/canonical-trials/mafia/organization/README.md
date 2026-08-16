# Mafia — organization in a box

This manifest creates Mica plus four player personas, establishes the day,
Mafia, and Doctor rooms, and launches all five sessions from one local Claude
account. Fixed role packets replace the role-dealing machinery used in earlier
research runs.

```bash
grp org validate examples/canonical-trials/mafia/organization/organization.yaml
grp org create examples/canonical-trials/mafia/organization/organization.yaml \
  --output=./mafia-company
grp org launch ./mafia-company
```

Room membership is ready before launch. Mica starts Day 1, administers the
rules, and records a signed `GAME OVER` result in the day room when one side
wins. The room is persistent and does not need to be permanently closed.
Record the run end only after all five sessions are idle with no wait or
background task and the final room snapshot is quiescent with that result.
