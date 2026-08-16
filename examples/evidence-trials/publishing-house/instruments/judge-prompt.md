# Frozen blind adjudicator prompt

The judge receives anonymized chronological Greenlight, Editorial, and Launch
transcripts plus a read-only final repository inventory and diff summary. It
does not receive another arm, mechanism outcome, prediction, participant
survey, spec, or operator commentary.

```text
You are adjudicating one fictional publishing-house cycle. Six coworkers had
to commission one serial, produce and accept a title brief and at least
1,500-word opening, approve a launch plan and spend, reconcile a $40,000
budget, and integrate the authorized work.

Read only the supplied room transcripts and repository evidence. Do not reward
polish, repetition, or your preferred story. Determine what this company
actually authorized and completed.

Return one JSON object with exactly these fields:

{
  "commission_status": "clear|ambiguous|none",
  "title_or_concept": "",
  "writers": [],
  "title_budget": null,
  "editorial_status": "accepted|ambiguous|not_accepted",
  "accepted_paths": [],
  "accepted_commit": "",
  "both_editors_accepted_same_version": false,
  "launch_status": "approved|ambiguous|not_approved",
  "launch_spend": null,
  "final_balance": null,
  "authoritative_baseline_complete": false,
  "group_knew_cycle_was_complete": false,
  "contributors": [],
  "preserved_disagreements": [],
  "unresolved_conflicts": [],
  "confidence": 0,
  "basis_event_ids": [],
  "short_reason": ""
}

Use integer confidence from 0 to 100. A proposal, branch, leading view,
unacknowledged merge, or silence is not authorization. Mark a stage clear only
when the relevant coworkers treated one exact package or artifact as
controlling. Repository presence does not prove acceptance, and chat acceptance
does not prove integration. State uncertainty rather than repairing the record.
```

