# Shaping a first release: room conversation

November 7, 2026. All 22 discussion messages, in order. Private links and technical identifiers use readable labels; other wording is unchanged.

## Cobalt · 22:12:07 UTC

Cobalt here (design). Opening positions for the first release, so product/eng can react:

1. Reminder visibility for owners: every appointment shows a plain "Messages" timeline: Confirmation (sent/scheduled + time), Reminder (scheduled for <exact local time>, or 'won't send' + reason, e.g. booked <24h out). Business-level settings page states the rule in one sentence: "Customers get a confirmation when you book, and one reminder 24 hours before." No configurable cadences in v1 — keeps it explainable.

2. Changes & cancellations shouldn't surprise customers: every customer-visible edit (time/date/location) shows a preview before saving: "Save & notify customer" is the default, with the exact email shown. Reschedule = send an 'updated' email, cancel the old reminder, schedule a new one. Cancellation = confirm dialog saying the customer gets a cancellation email and no reminder. Non-customer-visible edits (internal notes) never notify. No silent sends; no silent suppression.

3. Assistants not stepping on each other: (a) every appointment shows 'Last changed by <name>, <time>'; (b) stale-edit protection — if someone else saved since you opened it, block save and show what changed rather than overwriting; (c) an activity log per appointment. I'd skip real-time locking/presence for v1.

4. CSV import: preview step with row-level errors and a clear count of how many confirmations WILL be sent on import, with an option to import without sending confirmations (for appointments customers already know about). This is the biggest surprise risk.

5. Out of scope I'd support: SMS, calendar sync, payments, custom templates, multiple reminders.

Open questions for eng: timezone source (business vs customer?), what happens to a reminder if an edit lands inside the 24h window, and email bounce visibility to the owner.

---

## Silica · 22:12:16 UTC

Hi — Silica here, representing Product. Opening position so we have something concrete to push on.

**Goal for Release 1:** fewer no-shows and less admin for the 12 pilot businesses, via one dependable loop: appointment in → customer reminded → customer responds → owner sees who's coming. Not a scheduling platform.

**Proposed IN:**
1. Customer can **Confirm** or **Cancel** from the reminder email (one click, no login). Cancel notifies the owner and frees the slot. This is the single biggest no-show lever we can add without new channels.
2. **Second reminder (optional, per business)** — e.g. 2h before, alongside the existing 24h. Per-business setting, not per-appointment.
3. **"Today / This week" view** for owner + assistants showing each appointment's status: Unconfirmed / Confirmed / Cancelled, plus a delivery problem flag (bounced / failed).
4. **Changes behave correctly**: edit or cancel by staff → customer gets an update email, pending reminders reschedule or stop. No stale reminders, ever.
5. **CSV import hardening**: preview, row-level errors, duplicate detection before commit.

**Proposed OUT (explicitly):** SMS, payments, calendar sync, customer self-serve rescheduling (reminder says "reply / contact us to reschedule"), public booking pages, recurring appointments, custom template editor, analytics beyond a simple no-show count.

**Open questions for you:**
- Design: is Confirm/Cancel without login acceptable UX-wise, and what does the customer see after clicking?
- Engineering: what does it take to make reminder delivery dependable (scheduling, retries, timezone/DST, edits racing with sends)? I'd trade feature #2 or #5 for reliability if needed.
- SMS: I know it's the obvious ask for no-shows. My lean is defer to R2 (cost, consent, carrier rules) — push back if you disagree.

Once we've converged I'm happy to draft the Product Brief as a native artifact for all three of us to edit.

---

## Argon · 22:12:17 UTC

Argon here, engineering seat. Constraints I'm working under: one full-stack engineer, a working email provider, no SMS/payments/calendar. My priorities: dependable sending, unambiguous ownership of appointment changes, and a scope one person can maintain.

Opening positions (please push back):

1. Sending reliability over features. Every email (confirmation, 24h reminder, change, cancel) goes through one durable outbox table: row written in the same transaction as the appointment change, a single worker sends it, retries with backoff (e.g. 1m/5m/30m/2h, max 5), idempotency key per (appointment, message type, appointment version) so retries never double-send. Provider bounces/complaints come back via webhook and mark the customer address as undeliverable, visible to the owner. No second channel in v1.

2. Reminder timing is computed at send time, not scheduled at booking time. Worker scans for appointments starting in 23-25h with no reminder sent for the current version. That way a reschedule automatically 'moves' the reminder, and a cancel automatically suppresses it. If an appointment is booked <24h out, we skip the reminder (confirmation covers it) rather than send two emails minutes apart.

3. Change ownership: every appointment row stores version, last_changed_by (owner/assistant user id), changed_at. Edits use optimistic concurrency (reject stale version, show 'someone else changed this'). An append-only change log per appointment shows who changed what. Assistants can create/edit/cancel; I'd propose only the owner can delete or change business settings. Customers do NOT self-serve reschedule in v1: the email gives a reply-to the business, not a magic link. That removes auth tokens, a public page, and race conditions with staff edits.

4. Timezones: store UTC + business IANA timezone; emails render in the business timezone with the zone shown. CSV import requires an explicit timezone choice per import.

5. CSV import: validate-then-commit. Upload -> preview with row-level errors -> owner confirms -> import as one batch with a batch id that can be undone in full within 24h. Option to import WITHOUT sending confirmations (bulk-loading existing bookings shouldn't spam 200 customers).

Out of scope for v1 from my side: customer self-service links, multiple reminders/custom schedules, SMS, calendar sync, recurring appointments, template editor beyond business name/logo/signature line.

Scale check: 600 appts/week x ~3 emails = ~1,800 emails/week. Trivial volume; risk is correctness, not throughput.

I'll draft engineering + launch-criteria sections into the brief once product and design weigh in on scope and UX. Happy to start the skeleton artifact if nobody else has.

---

## Silica · 22:12:44 UTC

Great — we're ~80% aligned already. Product decisions to converge:

**Accepting from you both:**
- Durable outbox + idempotency + bounce webhook (Argon #1), send-time reminder computation (#2), version/optimistic concurrency/change log (#3, Cobalt #3), business IANA timezone (#4), validate-then-commit CSV with batch undo + "import without confirmations" and the explicit count (Argon #5, Cobalt #4).
- Cobalt's Messages timeline, one-sentence rule, and "Save & notify customer" preview. That *is* the admin-reduction story.
- **Dropping my optional 2nd reminder.** One fixed rule is more explainable and dependable. R2 candidate.
- No self-serve reschedule or cancel by customers. Reply-to the business.

**The one thing I want to keep: a single "Confirm I'll be there" link in the reminder.**
Why: without it, owners still can't tell who's coming, which is the job owners are hiring us for (they currently text/call to chase). It's a read-mostly flag, not an appointment mutation, so it avoids the races Argon worried about:
- Signed token bound to (appointment id, version). If the appointment changed since, the page says "This appointment was updated — check your latest email" and records nothing.
- Reschedule resets status to Unconfirmed; the new reminder carries a new link.
- Landing page shows only business name + date/time + "Thanks, you're confirmed." Idempotent; no login, no PII beyond that, token expires at appointment start.
- Cancel stays "reply to this email" — staff do the cancel, so ownership stays unambiguous.
Argon — is that acceptable for one engineer? If it costs more than ~3 days, I'll cut it to R1.1 rather than squeeze reliability.

**Edge cases (Cobalt's question):** if a reschedule lands inside 24h, the "Updated" email includes the confirm link and counts as the reminder; no separate reminder sent. Booked <24h out: confirmation email carries the confirm link; no reminder. Timeline states which applies.

**Measuring success:** I want one tiny addition: staff can mark a past appointment **No-show** (default = attended). Without it we can't prove the release worked. Launch/success criteria I'll propose: 100% of reminders sent within ±15 min of target or visibly flagged; zero stale/duplicate sends in pilot; ≥60% of reminded customers confirm; no-show rate down vs. 4-week baseline from owners.

If no objections, I'll draft the Product Brief artifact now and you each own your sections (Cobalt: UX; Argon: engineering + reliability launch criteria).

---

## Cobalt · 22:12:49 UTC

Cobalt (design) — good convergence. Where I agree, push back, and propose simplifications:

**Agree:** outbox + idempotency, UTC + business IANA tz shown in emails, optimistic concurrency with 'someone else changed this', change log, no customer self-serve reschedule, no SMS in R1, CSV validate-then-commit with 'import without confirmations'.

**Push back 1 — drop the optional 2nd reminder (Silica #2).** It doubles the rules owners must understand and creates a settings page + per-business edge cases (2h reminder after a late reschedule, etc.). One rule, stated everywhere: *"Confirmation when you book. One reminder 24 hours before."* I'd trade it for Confirm/Cancel, which is the bigger no-show lever.

**Push back 2 — Confirm/Cancel must not act on link click.** Corporate mail scanners prefetch links; a GET that cancels will cancel real appointments. Design: link opens a small page showing business, date/time (with tz), and one button ("Yes, I'll be there" / "Cancel this appointment"). After Cancel: "Cancelled. <Business> has been notified. To rebook, reply to your email or contact <Business>." Tokens are bound to the appointment *version* — if staff changed it, page says "This appointment was updated. Here are the current details" and does nothing. Argon: this is a signed token + one tiny public page, not self-serve — acceptable?

**Push back 3 — reminder time must be concrete to owners.** A 23–25h scan window means the timeline can't say when it sends. Proposal: target = start − 24h, worker runs every ~5 min, so the timeline shows "Reminder: Tue 3:00 PM (24h before)". Statuses: Scheduled / Sent / Won't send — booked less than 24h ahead / Won't send — cancelled / Failed — address bounced.

**Edit/cancel rules (no surprises):**
- Customer-visible change (date/time/location) → save dialog shows the exact update email; button "Save and email customer". Internal notes never email. No 'save silently' option for time changes in R1 — a silently moved appointment is the worst surprise.
- Rescheduled to >24h out → new reminder at new start − 24h. Rescheduled to <24h out → no reminder; the update email is the last message (timeline says so).
- Staff cancel → dialog: "<Customer> will get a cancellation email. No reminder will be sent."
- Delete: only for appointments with no customer emails sent (e.g. data-entry mistakes). Otherwise you must Cancel. Prevents silent disappearance.

**CSV undo (Argon #5):** undo can't unsend emails. If the batch sent confirmations, the undo dialog shows the count and asks "Email these N customers a cancellation?" (default yes). Import preview must also state: "No confirmations will be sent. Reminders will still go out 24 hours before each appointment." — that second line is the surprise people miss.

**Owner view (Silica #3):** yes, Today/This week list with status chips Unconfirmed / Confirmed / Cancelled by customer / Delivery problem, plus 'last changed by'. Customer cancel = owner email + chip. That's the whole dashboard.

If product/eng are OK with this, Silica drafts the brief skeleton and I'll fill the UX section and review accuracy at the end.

---

## Argon · 22:12:52 UTC

Strong overlap already. Where we agree: staff edits notify by default with preview (Cobalt #2), last-changed-by + stale-edit block + activity log, CSV preview + 'import without confirmations', no SMS/calendar/payments/templates/self-serve reschedule. Now the two places I want to push:

**A. Confirm/Cancel from the email (Silica #1).** I agree it's the best no-show lever we have, so I'll support it with guardrails rather than block it:
- Links are GET to a landing page; the state change happens only on a button POST. Corporate/Gmail link scanners prefetch links, and a GET that mutates will silently 'confirm' or, worse, cancel appointments.
- Token is signed, bound to appointment id + version, expires at appointment start. If staff changed the appointment since the email, the page says 'This appointment was updated — see your latest email' and does nothing. That keeps staff as the owner of time/place; the customer only owns their response.
- Customer cancel is a real cancel, recorded with actor = 'Customer (via email)' in the same activity log, owner gets an email + status in Today view. No undo by customer; staff can reinstate.
- No customer accounts, no reschedule from the page.
Cost: ~1 week. Acceptable if we drop B.

**B. Optional 2h second reminder (Silica #2): I'd cut it from R1.** It's a second scheduling path with its own edit-race cases, a per-business setting Cobalt's 'one-sentence rule' has to explain, and it competes directly with the confirm link for the same goal. Silica already offered it as the trade — I'd take that trade. Revisit after pilot data on confirm rates.

**C. CSV duplicate detection:** fine if the rule is simple: same customer email + same start time within the business = duplicate, shown in preview, skipped by default. No fuzzy matching.

**Answers to Cobalt:**
- Timezone: business-level IANA zone only. Customer-local zones need data we don't have. Emails state the zone ('3:00 PM Eastern').
- Edit inside the 24h window: the 'updated' email is sent immediately and includes the new time + confirm/cancel links; it counts as the reminder, so no separate reminder for that version unless the new time is still >24h away (then normal reminder). If an edit lands while the reminder for the old version is mid-send, the idempotency key is version-scoped, so the worker re-checks version before sending and drops stale messages.
- Bounces: provider webhook -> address flagged undeliverable -> red flag on the appointment and in Today view, 'Messages' timeline shows 'Bounced' with the reason. Owner fixes the email; we don't auto-retry a hard bounce.

**Engineering-owned reliability items I want in the brief as non-negotiable:** transactional outbox, version-scoped idempotency, retries with backoff, scanner-based reminders (DST-safe since computed from UTC), stuck-message alert to the engineer (any outbox row unsent >30 min), and a daily reconciliation that every appointment starting tomorrow has a reminder sent or a stated 'won't send' reason. Cobalt's Messages timeline is the user-visible half of the same thing — I like that pairing a lot.

On the artifact: Silica, please go ahead and create the Product Brief; I'll fill Engineering Approach and draft Launch Criteria directly in it. If you'd rather I create the skeleton, say so and I'll do it now.

---

## Silica · 22:13:34 UTC

Brief drafted: artifact **"Relay R1 Product Brief"** (id Relay R1 Product Brief). I pre-filled every section from what you both posted so you're editing, not starting blank.

Product decisions made in it:
- **Confirm AND Cancel links are in** — you both designed customer cancel safely (POST-only, version-bound token, staff reinstate), so I'm reversing my concession; ~1 week, funded by dropping the 2nd reminder.
- 2nd reminder **out**; SMS **R2**; no customer reschedule.
- Adopted Cobalt's concrete reminder target (start − 24h, ~5 min worker), delete-only-if-nothing-sent rule, CSV undo cancellation prompt; Argon's duplicate rule, POST-on-button, monitoring + daily reconciliation as non-negotiable.
- Added **Mark no-show** (§3.7) so we can measure outcome. Success targets in §8 — Argon, sanity-check the 99.5%/15-min number.

Please review/edit your sections (Cobalt §5, Argon §6–7) and say in the room whether you can stand behind the whole brief, or note any disagreement for §9.

---

## Cobalt · 22:14:41 UTC

Cobalt: published brief rev 3 (UX pass). Changes, so you can check them:
§5 UX — added principle "no silent sends, no silent suppression, no silent overwrites"; full timeline status list incl. 'Not sent — imported without confirmation', 'Retrying', 'rescheduled to <24h (update sent instead)', 'Failed — couldn't deliver after retries'; address-fix → 'Save and resend' with preview; **Reinstate always emails the customer** (was unspecified — silent revival would surprise); stale-edit dialog names who changed what, incl. customer actions; Cancelled chip shows actor (staff vs customer).
§5/§9 — **Confirm/Cancel links on every customer email** (confirmation, update, reminder), not just reminder/<24h — one pattern, no special case. Design decision on my side; Silica, shout if this affects the engagement metric definition.
§2/§5 — undo allowed for importer or owner; delete is owner-only (matched §2).
§6 (Argon, small edits, please confirm): customer actions bump version so they trigger staff stale-edit protection; CSV duplicates checked against existing appointments too (overlapping imports by two assistants); hard bounce resend only on staff action.
§7 — added tests: customer cancel racing staff edit, reinstate, overlapping imports, address fix + resend; plus 'every customer-emailing action shows consequence first'.
§3.7 — no-show is internal, no customer email. §8 — added 'zero owner reports of unexpected customer emails'.
With these, I stand behind the brief. Will re-review after your edits.

---

## Argon · 22:15:39 UTC

Published brief rev 4 (engineering pass, merged on top of Cobalt's v2 — §1–5 untouched except one line in §3.7). Changes for you to check:

1. **§6 sequencing + cut line.** ~7 weeks for one engineer. M1 (wk 1–3) = all reliability items + timeline + no-show marking, shippable to pilot on its own. M2 = previews, reinstate, Today view, links. M3 = CSV. If we slip, cut in order: batch undo → duplicate check vs existing appts → Cancel link (Silica's Confirm-only becomes the fallback). Reliability is never the thing that gets cut.
2. **Baseline (Silica, please challenge):** '4 weeks of owner baseline before launch' isn't measurable — no-show marking doesn't exist yet. I moved marking into M1 and require ≥2 weeks of in-product data before links are switched on; owner-reported history stays as a soft reference. Costs ~2 weeks of delay on links.
3. **§7 rewritten as 14 pass/fail tests** (atomicity under process kill, injected provider failures, stale-send race, 24h-window matrix, DST, concurrent edits incl. customer POST, link safety, bounce, CSV, alert drills, kill switch, preview == delivered email, baseline, runbook walked by a second person).
4. **New:** engineer-only kill switch (pause sending); late reminders become Won't send instead of sending after start. **Cobalt:** needs a timeline label, e.g. 'Won't send — sending was paused'. I aligned bounce resend with your 'Save and resend' (no auto-resend).
5. **§8:** added operability measure (≤2 h/week engineer support by week 4) and the weekly outbox-vs-provider-log diff as how we verify 'zero duplicates'.

If you're both OK, I'd suggest Silica does a final consistency read and we each request review on the same revision.

---

## Silica · 22:16:43 UTC

Product pass published as brief **rev 5 (v4)**, on top of Argon's v3. Both your passes accepted as-is; my changes:
1. **TL;DR** at the top so the brief reads in 30 seconds.
2. **Engagement metric redefined** for links-on-every-email (Cobalt's call, agreed): ≥50% of appointments get a Confirm/Cancel response via *any* email link before start; denominator excludes staff-cancelled and undeliverable; we report which email drove it to inform the R2 reminder decision.
3. **Product guardrail on the cut line:** Confirm link, Today/This week view and "Save and email customer" previews are never cut — if they're at risk, the date moves. Argon's cut order otherwise stands (batch undo → cross-file dupes → Cancel link).
4. Added Argon's kill-switch label to Cobalt's timeline list: "Won't send — sending was paused past the appointment start".
5. Accept the ~7-week, M1-first sequencing and the ≥2-week no-show baseline before links go live.

Product stands behind the full brief. **Argon, Cobalt — please confirm you stand behind rev 5** (or edit / log a disagreement in §9), and I'll mark it Agreed.

---

## Cobalt · 22:18:07 UTC

Cobalt: published rev 6 (v5), merged on top of Silica's v4 — nothing of yours removed. Design changes only:
1. **M1 pilot gap (pushback):** M1 goes to real customers but rendered previews arrive in M2, so in M1 staff edits would email customers with no warning — breaks 'no silent sends'. Fix: M1 floor = every customer-emailing action is labelled ("Save and email <customer> an update" / "Cancel and email <customer>"); no plain Save ever enqueues an email. Near-zero cost; added to M1 list, §7.12 and §9.
2. **Kill switch visibility (Argon's ask):** Paused timeline state, staff banner while paused, save-dialog note, owner email if pause >30 min. Kept Silica's 'Won't send — sending was paused past the appointment start' label. Added to §6, §7.11 and §9.
3. **Cut-line copy (§5):** what customers/staff see if batch undo, existing-dup check or Cancel link are cut, so the UI never promises something that didn't ship.
Silica's metric definition and guardrail look right to me. Unless you object to any of the above, I'm ready to sign rev 6 — suggest we all request review on that exact revision.

---

## Silica · 22:19:11 UTC

Read rev 6 end to end. Product accepts all of Cobalt's v5 changes — the M1 labelled-action floor is exactly right (we'd be piloting with real customers in M1), and cut-line copy keeps us honest.

One consistency fix, then I'm ready to sign:
- **M1 pilot go-live list** says "§7 criteria 1–5, 8, 10, 11" in both §6 (sequencing) and the §7 header, but Cobalt's M1 floor now lives in §7.12 (second sentence). It should read **"1–5, 8, 10, 11, and the M1 clause of 12"** in both places. Argon — your sections, so please make that two-line edit (or tell me to and I'll publish it).

After that, nothing else from Product. Proposal for sign-off: whoever publishes the fix marks Status "AGREED v6 — Product, Design, Engineering" in the same revision, and we each confirm here on that exact revision number. Product's sign-off is conditional only on that fix.

---

## Cobalt · 22:19:22 UTC

Cobalt: agree with Silica's fix — M1 pilot gate must include the M1 clause of §7.12, otherwise the labelled-actions floor isn't enforced. Argon, go ahead; I'll re-read the resulting revision and confirm on that exact number.

---

## Argon · 22:19:48 UTC

Published rev 7 (v6) on top of Cobalt's v5. Cobalt's M1 labelled-saves fix is better than what I was about to propose; accepted as-is. My small engineering edits:

1. **Pause notice when the provider is the problem.** Owner email after >30 min pause goes through the same provider, so in a provider outage it can't arrive. Wording now: notices are operational messages that bypass the pause, but if the provider is the cause the engineer contacts the 12 owners directly (contact list in runbook). Banner stays the primary signal. Added a provider-down drill to §7.11. (Cobalt, please check the §5 sentence.)
2. **M1 go-live test set widened.** M1 goes to real customers, so it now also requires 6 (staff-vs-staff stale edit, since change log + concurrency ship in M1), 12 (M1 labelled-action part) and 14 (runbook). Same set referenced from §6.
3. **§8 sanity check (Silica's ask):** 99.5% / 15 min is right. ~3 late reminders/week allowed; normal path is well inside 15 min, so misses will mean provider incidents, which is what we want the metric to show.
4. **§9:** Engineering accepts Product's 'date moves before the core loop is cut', with the recorded risk that 7 weeks has no slack once the three cut-line items are used.

No remaining engineering disagreement. **Engineering stands behind rev 7.** Silica, if you open a sign-off action on rev 7 (artifact revision id document version 6), I'll approve that exact revision. If either of you edits again, I'll re-read before approving.

---

## Silica · 22:20:44 UTC

**Product signs off on brief rev 7** (artifact revision id document version 6, "DRAFT v6"). Read end to end; my M1-gate fix is in (and Argon's wider M1 set — 6, 12-M1, 14 — is better than what I asked for). I also accept the recorded schedule risk in §9.

On mechanics: I tried to open an exact-revision review action, but GRP only allows that for an artifact *created attached to* the action, which would mean duplicating the brief into a second artifact. Not worth the confusion, so I cancelled those two actions. Proposal: **sign-off = each of us confirming rev 7 by revision id here in discussion.** Argon has already done so ("Engineering stands behind rev 7"); Product now has. Cobalt — please confirm on rev 7 and we're done. Nobody edit the artifact further unless we reopen; if anyone does, we re-confirm on the new revision.

(We can leave the Status line as "DRAFT v6 — pending sign-off"; changing it would create a rev 8 and restart confirmations. The room record is the sign-off.)

---

## Argon · 22:20:55 UTC

Agree with Silica's sign-off mechanic. Confirming formally: **Engineering (Argon) approves Relay R1 Product Brief rev 7, revision id document version 6**, verified as the current revision just now. Status line left as-is to avoid a rev 8. Recorded engineering risk is in §9 (no schedule slack after the cut line). Waiting on Cobalt's confirmation; I won't edit further.

---

## Cobalt · 22:21:03 UTC

Cobalt: read Argon's rev 7 end to end — the M1 gate fix, provider-down pause notice and schedule-risk note are all good. One accuracy gap it created in my section: rev 7 says M1 emails carry no links, but §5 said *every* email carries Confirm/Cancel. Published **rev 8** with only that fix: §5 now says links appear once enabled (M2, after §7.13), M1 emails end with "Need to cancel or reschedule? Reply to this email.", and the switch happens for all email types at once. Per Silica's proposal I set Status to "AGREED (rev 8)" in the same revision; nothing else changed (diff vs rev 7 = status line + two §5 customer bullets).

**Design signs off on rev 8.** Silica, Argon — please confirm on rev 8 (or edit if I've misstated anything).

---

## Cobalt · 22:21:16 UTC

Cobalt: our posts crossed — sorry for restarting confirmations. Your rev 7 sign-offs landed seconds before rev 8. I can't sign rev 7 as-is because it contradicts itself on what customers receive: §5 says *every* email carries Confirm/Cancel "no exceptions", while §6 says M1 emails carry no links. Owners and the engineer would read different behaviours from the same brief — exactly the kind of surprise we're designing out.

Rev 8 (revision id document version 7) differs from rev 7 only in: (1) two §5 customer bullets — links appear once enabled in M2 after §7.13; M1 emails end "Need to cancel or reschedule? Reply to this email."; switch happens for all email types at once; (2) the Status/history line. No change to §1–4 or §6–10.

**Design approves rev 8, revision id document version 7.** I won't edit further. Silica, Argon — please re-confirm on rev 8; if you'd rather revert the Status line, fine, but please keep the §5 fix.

---

## Argon · 22:21:18 UTC

Read rev 8 end to end. Diff vs rev 7 is as Cobalt described (status line + §5 customer bullets), and it fixes a real inconsistency I introduced. The 'all emails switch to links at once' rule is also the simpler thing to build: one global flag, read when each email is rendered.

**Engineering (Argon) approves Relay R1 Product Brief rev 8, revision id document version 7.** This supersedes my rev 7 confirmation. No further edits from me.

One non-blocking note for implementation, not the brief: §6 Reminders says the <24h confirmation/update email goes out '(with links)'. Read that as 'with links once enabled', per §5. I'm deliberately not editing it, so we don't restart sign-off. Silica, your confirmation on rev 8 closes this out.

---

## Silica · 22:21:41 UTC

Good catch, Cobalt. I missed that §5/§6 contradiction in my rev 7 read, and it's exactly what the brief is supposed to prevent. Read rev 8 end to end: diff vs rev 7 is only the Status line and the two §5 customer bullets, as you said. M1 emails say "Reply to this email", and links switch on for all email types together after §7.13.

**Product (Silica) approves Relay R1 Product Brief rev 8, revision id document version 7.** This replaces my rev 7 sign-off. I won't edit further.

Argon, could you re-confirm on rev 8? Then all three of us have signed the same revision and the brief is final.

---

## Argon · 22:21:51 UTC

Silica, our posts crossed. My rev 8 approval is already above (22:21:18). To close it out: all three seats have approved **rev 8, revision id document version 7**, and it is still the current revision. The brief is final. Thanks both.

---

## Cobalt · 22:21:51 UTC

Cobalt: confirmed — all three seats have approved rev 8 (revision id document version 7), so the brief is final. Design agrees with Argon's non-blocking reading: §6's "(with links)" means "with links once enabled", per §5. No further edits from me. Thanks both.
