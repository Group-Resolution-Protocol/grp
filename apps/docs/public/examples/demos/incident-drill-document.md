# Relay duplicate-reminder incident: plan and customer update

DRILL ONLY. Planning record. No real systems were changed and no customers were contacted.
Incident lead: Silica | Engineering: Cobalt | Support: Neon
Status as of 14:20 UTC: plan agreed by all three responders (Option C, 20-min pause cap). Rev 3 folds in Cobalt's and Neon's review notes.

## 1. Observed facts
- 14:00 UTC: reminder-worker release changed retry behavior. (Cobalt)
- 14:08: first duplicate-email report. (Neon)
- 5 businesses reported duplicate reminder emails; 2 sent examples of the same reminder arriving 3 times. (Neon)
- 0 reports of wrong appointment content; 1 owner asked whether to resend manually. (Neon)
- 0 reports of missed reminders. This is absence of reports, not proof none were missed. (Neon)
- 86 reminder jobs retried since 14:00. This is a job count, NOT a count of recipients with duplicates. (Cobalt)
- Queue depth normal; no backlog. (Cobalt)
- The email provider can return a timeout after already accepting an email. (Cobalt)
- No evidence of data loss or unauthorized access. (Cobalt)
- No customer has been promised a fix time. (Neon)
- 23 appointments are scheduled in the next 2 hours. (Neon)

## 2. Hypotheses (not confirmed)
- Cause: the new retry path treats provider timeouts as failures and resends emails the provider already accepted. Timing fits; not yet confirmed.
- Whether the PRE-14:00 retry logic is safe or just retried less is unknown, so rollback alone may not fully stop duplicates.

## 3. Unknowns
- Tenant scope and channel scope (SMS / other channels). Evidence so far covers the email reminder worker only.
- Number of recipients who actually received duplicates (anywhere from 0 to 86+ until reconciled), and the maximum copies any one recipient got (3 is the most in examples received so far).
- Per-appointment delivery status for the 23 near-term appointments.
- Whether the 14:00 release included a schema or queue-format change (affects rollback time).
- Whether any jobs were mid-retry at pause time. This is the main resume-time duplicate risk; gate 4(a) covers it.
- Message IDs / timestamps for the 2 triple-copy examples (not yet requested from owners).
- Duplicate content correctness is based on reports and examples, not verified across all sends.

## 4. Decisions (recorded by Silica, agreed by Cobalt and Neon)
- D1. Containment: Option C. Pause reminder-worker now, roll back the 14:00 change, verify, then resume. Chosen over rollback-only because rollback-only allows ~5+ more minutes of live duplicates.
- D2. Pause hard cap: 20 minutes (until ~14:45 UTC). If rollback is not verified by then, the team reconvenes. Resuming on the 14:00 code is NOT an option. Fallbacks: stay paused and send near-term reminders one at a time, or roll forward with retries disabled if possible.
- D3. Exactly-one rule for near-term reminders: provider accepted at least once -> no further send; never accepted -> send exactly one after resume; UNKNOWN (timeout with no matching provider record) -> send exactly one. Reason: a missed reminder risks a no-show, which is worse than one extra copy. Neon flags those businesses and warns them BEFORE the send-once runs.
- D4. Owners are told NOT to resend reminders manually.
- D5. Customer update: no fix-time promise, no affected count until reconciliation, cause stated as "we believe", content correctness stated as based on reports. Next update committed for 15:00 UTC.
- D6. Any production job-state write (gate 4b) is a reviewed, logged change with second sign-off (second engineer or Silica), and the list of changed job IDs is kept so it can be reverted. A wrong mark-as-sent would cause the missed reminders D3 exists to prevent.
- D7. Escalation: any new report of a MISSED reminder or WRONG content goes to Silica immediately; either changes our facts and may change the plan.

## 5. Action plan with owners
| # | Step | Owner | Done when |
|---|------|-------|-----------|
| 1 | Pause reminder-worker (starts 20-min cap) | Cobalt | Worker paused; send rate drops to zero; pause time logged |
| 2 | Pre-rollback check: does the 14:00 release include a schema/queue-format migration? | Cobalt | Answer recorded; if yes, revised rollback estimate posted to room |
| 3 | Roll back the 14:00 retry change while paused | Cobalt | Previous worker version deployed (still paused) |
| 4 | Resume gates: (a) rolled-back worker will not resend jobs marked accepted/sent, including jobs mid-retry at pause time; (b) any of the 86 retried jobs the provider already accepted is marked sent, run per D6 | Cobalt (4b sign-off: second engineer or Silica) | Both gates confirmed in room before resume; changed job-ID list saved |
| 5 | Near-term reminder list: 23 appointments in next 2h + any reminder due during the pause; classify each accepted / never accepted / unknown per D3 | Cobalt (data) + Neon (spot-check vs reports, flag businesses with "unknown") | List classified; send-once set agreed; send-once does not run until step 9b warning is out |
| 6 | Resume, then watch 15 min | Cobalt | Retry rate at baseline; NO duplicate provider message-IDs for the same reminder (reports lag, so don't rely on absence of reports); pause-window reminders confirmed sent once |
| 7 | Request headers/timestamps from the 2 triple-copy owners | Neon | Request drafted (drill: not sent) |
| 8 | Reconcile provider logs vs the 86 retries -> actual affected recipients and businesses; confirm or reject cause hypothesis | Cobalt | Counts and cause posted to room |
| 9a | Customer update (section 6) to the 5 reporting businesses | Neon | Drafted and reviewed (drill: not sent). Send only after step 1 is confirmed. Send-time check: Neon re-reads "What we're doing" against current state; if D2 fallback applies or we've resumed, adjust wording (e.g. "we paused sending and have reverted...") |
| 9b | Same update + 'unknown-set' opening line to businesses in the unknown set | Neon | Sent BEFORE the D3 send-once runs (drill: not sent) |
| 9c | Direct reply to the owner who asked about resending | Neon | Reply drafted: "Please don't resend. We're working to make sure each upcoming appointment gets one reminder." (drill: not sent) |
| 9d | Inbound macro for new reports: same instructions; log business, time, headers; pass to Cobalt for step 8; escalate missed/wrong-content per D7 | Neon | Macro drafted |
| 9e | 15:00 UTC follow-up | Neon | Drafted after step 6/8 results; affected count only if step 8 is done |
| 10 | Coordinate: track cap, decisions, timeline; call reconvene at 14:45 if gates not met; schedule post-incident review | Silica | Plan kept current; review scheduled |

## 6. Customer update (draft by Neon, reviewed by Silica and Cobalt)
Subject: Duplicate reminder emails: what's happening and what to do

Hi [name],

[Unknown-set businesses only: You may not have seen duplicates yourself. We're contacting you because one or more of your upcoming appointments may receive one extra copy of its reminder.]

Since about 14:00 UTC today, some Relay reminder emails were sent more than once. In the examples we've received, a client got the same reminder up to three times. We're sorry for the confusion this caused you and your clients.

What we know: based on the reports and examples we've received, the duplicates contain the correct appointment details. We have no reports of wrong times, dates or locations, and we've found no sign of data loss or unauthorized access.

What we're doing: we have paused and are reverting a change we believe caused this. Before reminders resume we're checking that no further duplicates go out. We're working to make sure reminders for upcoming appointments still go out. A few clients may receive one extra copy while we make sure nobody misses a reminder.

What you should do:
- Please don't resend reminders yourself. This could create more duplicates, and we're working to make sure each upcoming appointment gets one reminder.
- If a client asks, you can tell them the extra emails were a Relay system issue and their appointment details are correct.
- If you see a reminder with wrong details, or a client says they got no reminder, reply to this email. Forwarding the duplicate email (with its full headers if you can) helps us confirm the cause.

We'll update you by 15:00 UTC, or sooner if things change, including once we've confirmed which of your clients were affected.

## 7. Timeline
- 14:00 Reminder-worker retry change released
- 14:08 First duplicate report
- 14:20 Responders convene; Option C agreed; 20-min pause cap set (to ~14:45)
- ~14:45 Cap: resume only if gates in step 4 pass; otherwise reconvene (D2)
- 15:00 Next customer update due

## 8. Follow-ups (post-incident)
- Make reminder sends idempotent (provider idempotency key / dedup on accepted message) so timeouts can't produce duplicates.
- Confirm whether SMS and other tenants were affected.
- Release checks for retry-behavior changes (canary + duplicate message-ID alert).
