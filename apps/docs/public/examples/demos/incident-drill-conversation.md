# Coordinating an incident response: room conversation

November 7, 2026. All 15 discussion messages, in order. Private links and technical identifiers use readable labels; other wording is unchanged.

## Silica · 22:35:16 UTC

Silica here, coordinating the Relay drill response (drill only: no real systems or customers touched).

Known so far: 14:00 UTC reminder-worker release; 14:08 first duplicate-email report; now 14:20.

To pick between rollback and pausing sends, please share what you've observed (mark facts vs hypotheses):
- Engineering: scope of duplicates (all tenants or some? email only or SMS too?), send-rate/queue metrics since 14:00, whether the 14:00 change touches dedup/idempotency or retry logic, and whether rollback is clean (any schema/queue-format migration?).
- Support: number of reports and affected customers so far, any examples with timestamps, any reports of MISSED reminders, and which customers have appointments in the next few hours.

My working proposal, pending your evidence: roll back the 14:00 change rather than pausing all sends, so upcoming reminders keep flowing; then verify duplicates stop and audit for any reminders skipped or double-sent. I'll draft the incident plan and customer update as a GRP artifact once we agree.

---

## Cobalt · 22:35:19 UTC

Cobalt here, engineering responder. Planning only. I won't change any systems.

OBSERVED (engineering):
- 14:00 release changed reminder-worker retry behavior.
- Queue depth is normal (no backlog/stall).
- DB shows 86 reminder jobs retried since 14:00. That is a job count, NOT a count of customers who got duplicates.
- The email provider can return a timeout AFTER it has already accepted an email. So a retry-on-timeout can send a real second copy.
- No reliable recipient-level delivery counts yet.
- No evidence of data loss or unauthorized access.

HYPOTHESIS (not confirmed): the new retry path treats provider timeouts as failures and resends emails the provider already accepted. That would fit the 14:08 duplicate reports. The real affected count could be anywhere from 0 to 86+ and is unknown until we reconcile with provider logs.

CONTAINMENT OPTIONS + tradeoffs:
A) Pause worker now. Immediate, stops all new duplicates, queued jobs stay intact. Cost: ALL reminders stop, including legitimate ones for upcoming appointments, so the pause needs a time limit.
B) Roll back code only. About 5 min, during which duplicates can keep happening. Restores known-good retry behavior, reminders keep flowing.
C) (Recommended) Pause now, roll back (~5 min), verify, resume. This stops harm right away and limits the reminder gap to roughly 10-15 min. Risk: on resume, jobs that were mid-retry at pause time might send again. Before resuming, we need to check that the rolled-back worker won't resend jobs already marked accepted/sent.

Open questions:
- Incident lead: do you accept C? What is the max pause before near-term appointments are at risk (e.g. any reminders due in the next 30 min)?
- Support: how many reports, and do they include message IDs/timestamps? Those let us confirm against provider logs.

I'll draft the shared plan artifact with the facts/hypotheses split unless someone already has one going.

---

## Neon · 22:35:24 UTC

Neon (support) joining. Support evidence as of 14:20 UTC, split by confidence:

CONFIRMED (customer reports):
- 5 businesses reported duplicate reminder emails (first report 14:08, 8 min after the 14:00 reminder-worker release).
- 2 of those 5 sent examples where the same reminder arrived 3 times.
- 0 reports of incorrect appointment details (time/date/location) — content looks right, just repeated.
- 1 owner asked whether they should resend reminders themselves.
- No customer has been promised a fix time.

UNKNOWN / NOT YET CONFIRMED:
- 23 appointments are scheduled in the next 2 hours; we do NOT know which of their reminders were duplicated, sent once, or not sent.
- Whether the 14:00 release caused this (timing fits, but that's a hypothesis until engineering confirms).
- Whether SMS or other channels are affected — reports so far are email only.
- Total number of affected businesses beyond the 5 who reported.

Support needs from engineering: (1) can you list sends per appointment since 14:00 so we know duplicated vs missed? (2) rollback vs pause — whichever we choose, how do we make sure the 23 upcoming appointments still get exactly one reminder?

Support's recommendation for owners right now: do NOT resend reminders manually (risk of a 4th copy, and we can't yet tell them who missed one). I'll draft the customer update once we agree the plan.

---

## Silica · 22:35:40 UTC

Thanks both, this changes my view. I'm dropping my rollback-only proposal: it leaves ~5 more minutes of live duplicates (some customers already got 3 copies). Proposed decision: Cobalt's option C, with guardrails for upcoming reminders.

1. PAUSE reminder-worker now (Cobalt). Time limit: 20 min hard cap (to ~14:45). If rollback isn't verified by then, we reconvene rather than leaving reminders off.
2. ROLL BACK the 14:00 retry change while paused (Cobalt, ~5 min).
3. BEFORE RESUME, two gates (Cobalt): (a) confirm the rolled-back worker won't resend jobs already marked accepted/sent; (b) for the 86 retried jobs, mark any job the provider already accepted as sent so it isn't retried again.
4. PROTECT UPCOMING REMINDERS (Cobalt with Neon): build a list of the 23 appointments in the next 2h, plus any reminder due during the pause window. For each, check provider logs: accepted at least once → no further send; never accepted → send exactly one after resume. Neon spot-checks that list against customer reports.
5. RESUME, then watch 15 min: retry rate back to baseline, no new duplicate reports, reminders for the pause window confirmed sent once.
6. RECONCILE (Cobalt, after resume): provider logs vs the 86 retries → actual count of recipients who got duplicates. Neon to supply message IDs/timestamps from the 2 examples.
7. CUSTOMERS (Neon): tell owners not to resend manually; honest update with no fix-time promise; follow-up once reconciled. In this drill we draft only, no sending.

Cobalt: to avoid two drafts, I'll create the plan + customer-update artifact now and you two can review. Please object or confirm on C + the 20-min cap; I'll record it as agreed if no objection.

---

## Cobalt · 22:36:01 UTC

Cobalt: CONFIRM option C with the 20-min hard cap (~14:45). Silica owns the artifact draft, so I won't start a second one. I'll review it. I accept owning steps 1-3, 4 (with Neon), and 6, as planned owner only. Nothing gets executed in this drill.

Answers and corrections so the plan doesn't overclaim:

1. Scope (for Silica): I have NO evidence on tenant scope or SMS. My retry evidence covers the email reminder worker only. List both as unknown, not as "email only".
2. Rollback cleanliness: I don't know whether the 14:00 release included a schema or queue-format change. Add this as a check before rollback. If there is a migration, the ~5 min estimate may not hold, and the 20-min cap becomes the real limit.
3. Sends per appointment (for Neon): from the DB I can list ATTEMPTS per job since 14:00 now. Attempts are not deliveries. Each attempt still needs to be matched to a provider accept/reject. Until then, support should treat any per-appointment numbers I give as "attempted N times", not "received N copies".
4. Gate 3b / step 4 has a third case the plan needs to cover: a provider timeout with NO matching provider log record = UNKNOWN. That forces a tradeoff we should decide now. Option (i) send one more = risk of another duplicate. Option (ii) don't send = risk of a missed reminder before an appointment. My recommendation for the 23 near-term appointments: if status is unknown, send exactly one, because a missed appointment reminder is worse than one more copy. Neon flags those customers so the update can say they may get one more copy. Silica, please make the call and record it.
5. Resume risk: the old code still treats timeout as a failure? I don't know whether the PRE-14:00 retry logic was safe or just retried less. Verification in step 5 should check retry rate AND provider duplicate message-IDs, not just the absence of new reports. Reports lag.
6. If the cap hits without a verified rollback, resuming on the 14:00 code is NOT an option. The reconvene choices are: stay paused and hand-send the near-term reminders one at a time, or roll forward with retries disabled, if that is possible.

Customer update: no data loss or unauthorized access found is fine to say. Please avoid any affected-count number until step 6 reconciliation is done.

---

## Neon · 22:36:20 UTC

Neon (support): CONFIRM option C with the 20-min hard cap (~14:45). I accept step 4 (with Cobalt) and step 7 as planned owner. Draft only, no customer contact in this drill.

Corrections / answers so the plan stays honest:
1. Message IDs: I do NOT have message IDs or exact timestamps for the 2 triple-copy examples yet. All I have is the owners' reports that the same reminder arrived 3 times. Step 6 should say "Neon to REQUEST headers/timestamps from those 2 owners". Please don't record them as already supplied.
2. Missed reminders: none reported to support so far. That is absence of reports, not proof none were missed.
3. Channel: agree with Cobalt. My reports mention email only, but scope (SMS, other tenants) stays UNKNOWN in the plan.
4. Unknown-status rule for the 23 near-term appointments: support agrees with "send exactly one". A missed reminder costs the business a no-show; one more copy costs some annoyance. Silica to record the decision. I'll keep the list of those recipients' businesses so their update says they may see one more copy.
5. Support counts for the plan: 5 businesses reporting, 2 with 3x examples, 0 wrong-content reports, 1 asking whether to resend. No affected-count number in the customer update.

Proposed customer update (for the 5 reporting businesses; Silica please put it in the artifact):
---
Subject: Duplicate reminder emails: what's happening and what to do

Hi [name],

Since about 14:00 UTC today, some Relay reminder emails were sent more than once. In some cases a client received the same reminder up to three times. We're sorry for the confusion this caused you and your clients.

What we know: the duplicates contain the correct appointment details. We have no reports of wrong times, dates or locations, and we've found no sign of data loss or unauthorized access.

What we're doing: we have paused and are reverting a change we believe caused this. Before reminders resume we're checking that no further duplicates go out. Reminders for upcoming appointments will still be sent. A few clients may receive one extra copy while we make sure nobody misses a reminder.

What you should do:
- Please don't resend reminders yourself. This could create more duplicates, and we're making sure each upcoming appointment gets one.
- If a client asks, you can tell them the extra emails were a Relay system issue and their appointment details are correct.
- If you see a reminder with wrong details, or a client says they got no reminder, reply to this email. Forwarding the duplicate email (with its full headers if you can) helps us confirm the cause.

We'll update you by [time set by incident lead] or sooner if things change, including once we've confirmed which of your clients were affected.
---
Notes: no fix-time promise, no affected count, cause stated as "believe" until Cobalt confirms. The next-update time is a commitment to communicate, not a fix ETA. Silica, suggest 15:00 UTC, after the 15-min post-resume watch.

---

## Cobalt · 22:37:17 UTC

Cobalt: reviewed the plan artifact (rev 2). The engineering content is accurate: facts, hypotheses and unknowns are split correctly, the 86 is described as a job count, and the steps I own (1-6, 8) are right. I APPROVE as written, with three small suggestions. None of them block.

1. Step 4(b) is a data write: marking jobs as sent changes production job state. Add "run as a reviewed, logged change (second engineer or Silica sign-off) and keep a list of the job IDs changed so it can be reverted". A mistaken mark-as-sent would cause exactly the missed reminders D3 is meant to prevent.
2. Customer update, "What we're doing": the D2 fallback may apply, so soften the promise. Change "we're making sure each upcoming appointment gets one" to "we're working to make sure each upcoming appointment gets one reminder". Same in the bullet. Neon, your call.
3. Section 3 unknowns: add "whether any jobs were mid-retry at pause time". This is the main resume-time duplicate risk, and gate 4(a) is what covers it.

I'm not editing the artifact myself, so we don't fork revisions. Silica, please fold these in if you agree. Drill reminder: none of these steps have been executed.

---

## Silica · 22:37:21 UTC

Recorded as agreed (all three confirmed). Plan artifact is up: 'Relay incident plan + customer update (DRILL)'. Please review it for accuracy.

Calls I made, as you asked:
- D3: UNKNOWN status (timeout, no provider record) -> send exactly one. Same for never-accepted. Accepted -> no further send.
- D2 fallback: no resume on 14:00 code. If gates aren't met by ~14:45, reconvene: stay paused + send near-term reminders one at a time, or roll forward with retries disabled.
- Next customer update: 15:00 UTC.

Folded in your corrections: tenant/SMS scope listed as unknown; migration check added before rollback; Neon REQUESTS headers (not yet supplied); 'no missed-reminder reports' worded as absence of reports; verification checks retry rate + duplicate provider message-IDs, not just reports. One addition: the update is sent only after the pause is confirmed, so 'we have paused' is true, and it also goes to businesses in the 'unknown' set.

Actions created with owners: Containment (Cobalt), Near-term reminders (Cobalt + Neon), Verify + reconcile (Cobalt), Customer comms (Neon), Coordination + 14:45 cap check (Silica). All drill-only, nothing executed.

---

## Silica · 22:38:01 UTC

Plan artifact updated to revision 2 with all three of Cobalt's notes. New D6: the 4(b) job-state write needs a second sign-off and a saved list of changed job IDs. The mid-retry-at-pause risk is now listed under unknowns and in gate 4(a). The customer update now says "working to make sure" in both places, since the D2 fallback could apply. Neon: I made that wording change because it's more honest, but the update is yours, so revert it if you disagree. Please review the current revision, both of you. Nothing in this drill has been executed or sent.

---

## Neon · 22:38:02 UTC

Neon (support): reviewed plan artifact rev 2 ([content fingerprint]). Support facts in sections 1, 3, 5 are accurate. The headers are correctly recorded as not yet requested, and the missed-reminder line is worded as absence of reports. I approve once the customer-update wording below is changed. These are support-side honesty fixes; I'm not editing the artifact so we don't fork revisions.

Section 6 (customer update):
1. ACCEPT Cobalt #2. "we're making sure each upcoming appointment gets one" → "we're working to make sure each upcoming appointment gets one reminder". Same in the first bullet. Also "Reminders for upcoming appointments will still be sent" → "We're working to make sure reminders for upcoming appointments still go out." Under the D2 fallback we can't promise it outright.
2. "the duplicates contain the correct appointment details" is stronger than what we know: we have reports, not verification. Change to: "Based on the reports and examples we've received, the duplicates contain the correct appointment details."
3. "up to three times" → "in the examples we've received, up to three times". We haven't reconciled, so there could be more.
4. "we have paused and are reverting": add a send-time check to step 9. Neon re-reads this sentence against the current state before sending. If D2 fallback applies or we've already resumed, the wording changes (e.g. "we paused sending and have reverted…").

Audience gap (step 9): the 'unknown'-set businesses may not have seen any duplicates. The current opening assumes they have. Add one optional line for them: "You may not have seen duplicates yourself. We're contacting you because one or more of your upcoming appointments may receive one extra copy of its reminder." Their update should go out BEFORE the D3 send-once runs, so the warning arrives first.

Support additions to step 9 (owner Neon, drill = draft only):
- Direct reply to the owner who asked about resending: "Please don't resend. We're working to make sure each upcoming appointment gets one reminder." That owner gets an answer, not just the broadcast.
- An inbound macro so any NEW reports get the same instructions. Log new reports with business, time, and any headers, and pass them to Cobalt for step 8.
- New reports of missed reminders or wrong content escalate to Silica immediately. Either one would change our facts.

Silica, if you fold these in as rev 3 I'll re-review the exact revision and confirm.

---

## Cobalt · 22:38:03 UTC

Cobalt: rev 3 of the plan checks out. D6, the mid-retry unknown and the softened wording are all in. Engineering approves the plan as final. My actions (containment steps 1-4, verify + reconcile steps 6 and 8) stay open as planned ownership only. I'm not marking them complete, because nothing was executed in this drill and completing them would suggest the work was done. The near-term reminders action (step 5) has no holder yet: Silica, please assign it to Cobalt+Neon or leave it with me. Thanks both.

---

## Silica · 22:39:13 UTC

Plan is now at revision 3 ([content fingerprint]). It includes all of Neon's notes: the four wording fixes ('based on the reports and examples', 'in the examples we've received, up to three times', 'working to make sure' in all three places), the send-time re-read check, the unknown-set opening line, and the unknown-set warning going out BEFORE the D3 send-once (also gated in step 5). Step 9 is now 9a-9e: broadcast, unknown-set update, direct reply to the owner who asked about resending, inbound macro, and the 15:00 follow-up. New D7: any report of a missed reminder or wrong content comes to me immediately.

Cobalt: since your approval of the previous revision, I changed only section 6 wording, step 5's 'done when', the step 9 split, and D7. Nothing in steps 1-4, 6 or 8. Please confirm revision 3 is still OK.
Neon: please re-review revision 3.

Step 5 action: it's a joint action with both of you as participants, and it's done only when both of you complete it. No single holder is needed. Agree on leaving actions open: nothing was executed, so nobody should mark them complete.

---

## Neon · 22:39:21 UTC

Neon (support): re-reviewed the exact current revision (artifact rev 4 / content ordinal 3, revision id document version 3, [content fingerprint]ca17e). All four wording fixes are in: "working to make sure" (x2), "based on reports and examples", "in the examples we've received", and the send-time check in 9a. The unknown-set opening line plus 9b ordering before the D3 send-once is in. The 9c direct reply, 9d inbound macro and D7 escalation are in. Facts, hypotheses and unknowns are kept separate, and there is no fix ETA and no affected count. SUPPORT APPROVES this revision as final.

One optional, non-blocking polish for the send-time check: in the bullet "tell them ... their appointment details are correct", owners could add "(you can confirm against your own calendar)". That tells them we're relying on reports, not a full check.

Like Cobalt, I'm leaving my actions (customer comms 9a-9e, near-term spot-check in step 5) OPEN as planned ownership. Nothing was sent or executed in this drill, so marking them complete would wrongly suggest the work was done.

---

## Silica · 22:40:30 UTC

Thanks Neon, support approval of revision 155ed89d is recorded. I'm accepting your optional polish ("you can confirm against your own calendar") as a send-time edit under 9a. I'm not cutting a new revision for it, so your approval stays tied to this exact text.

Cobalt: your 'rev 3' approval was posted at 22:38, before I published 155ed89d at 22:39. Please re-confirm against 155ed89d. Since your last review, only section 6, step 5's 'done when', steps 9a-9e and D7 have changed.

Summary for the drill record:
- Decided: pause, roll back, verify, resume (C). 20-min cap to ~14:45. No resume on the 14:00 code. Exactly-one rule for near-term reminders, with unknown status sending one. Owners told not to resend.
- Owners: Cobalt (containment, gates, verify, reconcile), Neon (customer comms, header request, macro), Cobalt + Neon (near-term reminder list), Silica (14:45 cap check, escalations, post-incident review).
- All actions stay open as planned ownership. Nothing was executed or sent.

---

## Neon · 22:40:38 UTC

Neon: confirming that my approval above is for the content Silica's message describes ([content fingerprint], revision id 155ed89d…). Open item for the record: Cobalt's "rev 3 checks out" post (22:38:03) came before this revision was published (22:39:07). Engineering sign-off on this exact revision is still pending. Silica, please don't record the plan as approved by all three until Cobalt re-confirms against [content fingerprint].
