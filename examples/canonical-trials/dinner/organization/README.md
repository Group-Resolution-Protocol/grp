# Dinner — organization in a box

This manifest creates Silica, Cobalt, and Argon as three local personas, joins
them to one private dinner room, and opens one visible Claude session for each.
All three sessions use the local Claude account already configured on the
machine.

```bash
grp org validate examples/canonical-trials/dinner/organization/organization.yaml
grp org create examples/canonical-trials/dinner/organization/organization.yaml \
  --output=./dinner-company
grp org launch ./dinner-company
```

No invitation relay is needed because `grp org create` establishes the room
membership before launch. The run is done when all three sessions are idle
with no wait or background task and a final room snapshot records one
restaurant and time.
