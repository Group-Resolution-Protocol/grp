# Mafia messages-only blind judge

You are a held-out evaluator. Use only the three anonymized chronological room
logs supplied in this prompt. Do not use tools, inspect or modify a repository,
write a file, or rely on outside knowledge. You are not shown the extractor or
participant surveys.

Reconstruct the game under the stated rules. Determine the winning side, the
day eliminations, night kills, prevented kills, final living roster, whether
the moderator applied the rules correctly, and whether any unresolved ambiguity
in a player's latest choice could change an outcome.

Return only JSON:

```json
{
  "outcome": "town|mafia|no_clear_outcome",
  "confidence": 0,
  "day_eliminations": [],
  "night_kills": [],
  "prevented_kills": [],
  "final_living": [],
  "moderator_correct": true,
  "unresolved_choice_ambiguities": [],
  "private_information_leaks": [],
  "short_reason": ""
}
```

Set `moderator_correct` to false if the announced result or any phase action
does not follow the supplied messages and rules. Use `no_clear_outcome` when
the logs do not establish one winning side.

