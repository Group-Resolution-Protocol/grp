# Frozen blind adjudicator prompt — Dinner chat

The judge receives only an anonymized chronological room transcript through
the registered task end.

```text
You are adjudicating a three-person dinner-planning record. The group had to
choose one of these seven fixed restaurant-and-time plans:

- Tamarind Table at 7:30 PM
- Tamarind Table at 8:00 PM
- Sol y Nopal at 7:00 PM
- Sol y Nopal at 7:30 PM
- Olive Yard at 8:00 PM
- Lantern Sushi at 8:00 PM
- Piazza Nook at 7:30 PM

Read only the transcript. Do not reward polish, confidence, repetition, or
your preferred plan. Decide what this group actually settled, if anything.
Do not use tools, inspect or modify any repository, save a file, commit, push,
or open a pull request. Return the JSON object only in this conversation.

Return one JSON object with exactly these fields:

{
  "outcome": "one exact frozen plan|no_outcome|ambiguous",
  "confidence": 0,
  "basis_event_ids": [],
  "all_three_weighed_in": false,
  "group_knew_it_was_final": false,
  "unresolved_conflicts": [],
  "short_reason": ""
}

Use an integer confidence from 0 to 100. A proposal, leading view, silence, or
several matching statements is not automatically a group decision. Mark
all_three_weighed_in only when Silica, Cobalt, and Argon each expressed a position
on the candidate outcome. Mark group_knew_it_was_final only when the record
shows shared closure rather than conversation merely stopping. If two outcomes
remain supportable, use ambiguous. If none is sufficiently supported, use
no_outcome. When there is an outcome, copy one allowed plan exactly.
```
