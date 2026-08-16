# Mafia messages-only frozen extraction

Apply this to the chronological day-room log before blind judgment or surveys.

Return a mechanically identified winning side only if the final Mica message
contains one of these exact case-insensitive strings:

- `winner: town`
- `winner: mafia`

and the same message contains `living:` followed by at least one player name.
Use the latest such Mica message. Do not infer a winner from prose, votes,
private-room choices, role knowledge, or the game rules.

Return exactly one of:

```text
mechanical_winner: town
mechanical_winner: mafia
mechanical_no_outcome
```

This deliberately narrow rule measures whether chat produced a machine-readable
terminal record without being told to use one. Do not change it after a run.

