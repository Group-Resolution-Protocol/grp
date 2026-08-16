# Term Sheet — organization in a box

This manifest creates Silica, Cobalt, and Argon as local personas in one
private room. Silica represents Kestrel, Cobalt represents Northline, and they
receive different private mandates. Argon joins as the board observer.

```bash
grp org validate examples/canonical-trials/term-sheet/organization/organization.yaml
grp org create examples/canonical-trials/term-sheet/organization/organization.yaml \
  --output=./term-sheet-company
grp org launch ./term-sheet-company
```

The runtime sessions share one local Claude account, but each starts in its own
persona workspace with only its own mandate. The run ends when all three
sessions are idle with no wait or background task and a final room snapshot
shows a mutually accepted complete package or a clearly recorded no-deal
result.
