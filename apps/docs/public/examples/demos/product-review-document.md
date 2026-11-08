# Relay — Release 1 Product Brief
Status: AGREED (rev 8) — Product (Silica), Design (Cobalt), Engineering (Argon); each confirms in the room on this revision. History: v1 Silica; v2 UX pass Cobalt; v3 engineering pass Argon; v4 product pass Silica (TL;DR, metric definition, cut-line guardrail, paused label); v5 design pass Cobalt (pause visibility, M1 labelled saves, cut-line copy); v6 Argon (pause notice when the provider itself is down, M1 go-live test set, §8 sanity note, schedule-risk note); v7 Cobalt (§5 customer copy for M1 emails without links). Sections 5 (UX) owned by Cobalt, 6–7 (Engineering, Launch) owned by Argon.

## TL;DR
- **What:** one dependable email loop — book → confirmation → 24h reminder → customer taps Confirm or Cancel → staff see who's coming. Plus safe staff edits, a per-appointment Messages timeline, and a safer CSV import.
- **Not:** SMS, second reminders, customer rescheduling, calendars, payments, booking pages.
- **How:** transactional outbox, version-scoped idempotency, UTC reminder scan, POST-only customer links, stale-edit blocking.
- **When:** ~7 weeks, one engineer, reliability milestone (M1) first. Cut features, never reliability.
- **Proof:** ≥99.5% on-time reminders with zero duplicate/stale emails; ≥50% customer response rate; ≥25% fewer no-shows vs. in-product baseline.

## 1. Goal
Fewer no-shows and less admin for the 12 pilot businesses (independent tutors/coaches, ~600 appts/week), through one dependable loop:
**appointment in → customer reminded → customer responds → staff see who's coming.**
R1 is a reliable reminder workflow, not a scheduling platform. Dependability beats feature count.

The rule, stated identically everywhere: **"Customers get a confirmation when you book, and one reminder 24 hours before."**

## 2. Users
- Owner (1 per business): all actions, business settings, delete.
- Assistants (up to 3): create / edit / cancel / reinstate appointments, import CSV, undo their own import batch, mark no-show.
- Customers: no accounts. Receive emails; can Confirm or Cancel from a link.

## 3. In scope (R1)
1. **Reliable sending** of confirmation, 24h reminder, update and cancellation emails (see §6).
2. **Confirm / Cancel from email** — link opens a small page; action only on button press. Token bound to appointment version; expires at start time.
3. **Today / This week view** — status chips: Unconfirmed / Confirmed / Cancelled (by staff or by customer, actor shown) / Delivery problem; "last changed by".
4. **Messages timeline per appointment** — what was sent, what is scheduled (exact local time), what won't send and why.
5. **Safe staff edits** — "Save and email customer" with email preview for customer-visible changes; stale-edit protection; per-appointment activity log.
6. **CSV import** — validate → preview (row errors, duplicates, count of emails that will send) → commit as one batch; option to import without confirmations; batch undo within 24h.
7. **Mark no-show** on past appointments (default = attended). Internal only; customer is not emailed. Needed to measure §8. Ships in the first build milestone (§6 sequencing) so an in-product baseline exists before Confirm/Cancel links go live.

## 4. Out of scope (R1) — explicit
SMS; second/configurable reminders; customer self-serve reschedule; customer accounts; public booking pages; calendar sync; payments; recurring appointments; template editor (beyond business name, logo, signature line); customer-local timezones; real-time presence/locking; analytics beyond no-show and confirm rates.

## 5. User experience (Cobalt)
Principle: **no silent sends, no silent suppression, no silent overwrites.** Every action that emails a customer says so before it happens; every email that won't go out says why. This holds in every milestone, including the M1 pilot.

**Owner/assistant — knowing what will be sent**
- Settings page states the one-sentence rule. No cadence settings.
- Messages timeline (per appointment), one row per message:
  - Confirmation: Sent <time> / Not sent — imported without confirmation.
  - Reminder: Scheduled ("Tue 3:00 PM ET, 24h before") / Sent / Retrying ("delivery delayed, retrying") / Paused ("Relay has paused email; this will send when sending resumes") / Won't send — booked less than 24h ahead / Won't send — rescheduled to less than 24h ahead (update email sent instead) / Won't send — cancelled / Won't send — sending was paused past the appointment start / Failed — address bounced (with reason) / Failed — couldn't deliver after retries.
  - Update / Cancellation emails: Sent <time>, with who triggered it (same Retrying / Paused / Failed states).
- Delivery problem: red chip on the appointment and in Today view. When staff fix the address, the save dialog offers "Save and resend <latest message> to new address" with preview.
- Sending paused (§6 kill switch): banner on every staff page — "Relay has paused customer emails while we fix a problem. Nothing is lost; queued emails will send when we resume." Save dialogs during a pause add "This email will send when sending resumes." If a pause lasts >30 min, owners are told when it starts and ends — by email when the provider is healthy, otherwise directly by the engineer (12 pilot owners; contact list in the runbook). The in-app banner is the primary signal.

**Owner/assistant — changes and cancellations**
- Customer-visible change (date/time/location): save dialog shows the exact update email; button "Save and email customer". No silent save for time changes in R1. Internal notes never email. Reschedule resets the customer's response to Unconfirmed (timeline and chip show this).
- **M1 pilot floor** (before rendered previews ship in M2): every action that emails a customer is labelled on the button with a one-line notice — "Save and email <customer> an update" / "Cancel and email <customer>" — without the rendered preview. No customer email is ever triggered by a plain "Save".
- Staff cancel: dialog "<Customer> will get a cancellation email. No reminder will be sent."
- Reinstate (after staff or customer cancel): dialog "<Customer> will get an email that the appointment is back on" + preview; reminder rescheduled under the normal rule. Never silent.
- Delete: owner only, and only for appointments with no customer emails sent (data-entry mistakes); otherwise Cancel.
- Customer cancel: owner gets an email; all staff see "Cancelled by customer" chip and log entry "Customer (via email)".

**Owner/assistant — not interfering with each other**
- Every appointment shows "Last changed by <name>, <time>"; activity log lists every change incl. customer actions and messages sent.
- Stale edit: if anyone (staff or customer via email) changed the appointment since you opened it, save is blocked and the dialog shows what changed and by whom, e.g. "Maya rescheduled this to Thu 4:00 PM at 2:14 PM" or "Customer cancelled via email at 2:14 PM". You reload and re-apply; nothing is overwritten.
- CSV import is attributed to the importer; duplicate detection checks the file *and* existing appointments, so two assistants importing overlapping files don't double-book or double-email.
- No locking/presence in R1 (see §4).

**Customer**
- Once links are enabled (M2, after §7.13), every email about an upcoming appointment (confirmation, update, reminder) carries "Yes, I'll be there" and "Cancel this appointment" links, plus reply-to the business for anything else (incl. rescheduling). One consistent pattern, no exceptions to explain.
- M1 pilot emails carry no links; they end with "Need to cancel or reschedule? Reply to this email." The switch to links happens for all emails at once, never per email type.
- Every email states date, time and timezone ("3:00 PM Eastern").
- Link page: business name, date/time with timezone, one button. After confirm: "Thanks, you're confirmed." After cancel: "Cancelled. <Business> has been notified. To rebook, reply to your email or contact <Business>."
- Stale link: "This appointment was updated. Here are the current details — use the links in your latest email." No action taken. Link for a cancelled appointment: "This appointment has been cancelled." Expired link (after start): read-only notice.

**CSV import**
- Preview states counts and consequences, e.g. "212 appointments. 3 rows have errors, 4 duplicates will be skipped. 212 confirmation emails will be sent now." or "No confirmations will be sent. Reminders will still go out 24 hours before each appointment."
- Undo of a batch (importer or owner, within 24h): if any customer emails went out for the batch, dialog shows the count and asks "Email these N customers a cancellation?" (default yes). Pending reminders for the batch are cancelled either way.

**If the §6 cut line is used** (copy must match what actually shipped):
- Batch undo cut: import preview adds "Imports can't be undone — check the counts above."; no undo UI.
- Existing-appointment duplicate check cut: preview says "Duplicates are checked within this file only."
- Cancel link cut: emails carry "Yes, I'll be there" plus "Can't make it? Reply to this email."; no Cancel button and no "Cancelled by customer" chip.

## 6. Engineering approach (Argon)
**Sending pipeline**
- **Transactional outbox:** every email row is written in the same DB transaction as the appointment change that causes it. If the change commits, the email is guaranteed to be queued; if it rolls back, nothing is queued.
- **Single worker** sends from the outbox; retries with backoff (1m / 5m / 30m / 2h, max 5 attempts). Timeline shows Retrying during backoff. After the final attempt: Failed, Delivery problem chip, engineer alerted.
- **Idempotency key** = (appointment, message type, appointment version), enforced by a DB unique constraint and passed to the provider. Worker re-checks the current version immediately before each send; messages for a superseded version are dropped and logged internally as Superseded (not an error, not shown to customers).
- **Reminders:** target = start − 24h, computed in UTC; a scan every 5 min enqueues any reminder whose target has passed and that has none for the current version. Reschedule moves the reminder automatically; cancel suppresses it. Booked or rescheduled to <24h out: no separate reminder — the confirmation/update email (with links) is the last message, and the timeline says so. DST-safe because arithmetic is in UTC; display uses the business IANA zone.
- **Bounces/complaints:** provider webhook → address flagged undeliverable → Delivery problem chip + timeline reason. Hard bounces are never auto-retried; resend happens only on the staff "Save and resend" action in §5.
- **Kill switch:** one global "pause sending" flag (engineer-only, for provider incidents or a bad deploy). Paused messages stay queued and send once on unpause. A reminder whose appointment has already started by then is marked "Won't send — sending was paused past the appointment start" rather than sent late. While paused, staff see the §5 banner and Paused timeline state. Owner pause notices (>30 min) are operational messages that bypass the pause, but they use the same provider — if the provider is the cause, the engineer contacts owners directly per the runbook.

**Ownership of changes**
- Appointment row: version, last_changed_by, changed_at; optimistic concurrency on every write — staff edits and customer link actions alike. Append-only change log records actor (named staff user or "Customer (via email)"), before/after values, timestamp. Customer actions bump the version, so they trigger the same stale-edit protection for staff.
- Staff own time, place and reinstatement. Customers can only Confirm or Cancel the exact version their email described.
- **Customer links:** HMAC-signed token (appointment id + version + expiry = start time). GET renders the page only; POST performs the action (protects against mail-scanner prefetch). Version mismatch, cancelled state or expiry → no action. Confirm status resets to Unconfirmed on any customer-visible change.

**Data**
- UTC storage + business IANA zone; emails show zone. CSV import requires an explicit timezone selection.
- CSV duplicates: same customer email + same start time within the business (within the file or against existing appointments) = duplicate; shown in preview, skipped by default. No fuzzy matching. Import commits as one batch id; undo cancels the batch and, if chosen, enqueues cancellation emails through the same outbox.

**Monitoring**
- Alert the engineer on: any outbox row unsent >30 min past its target; any Failed message; no provider webhook events for >24h.
- Daily reconciliation job: every appointment starting in the next 24–48h has a reminder Scheduled/Sent or an explicit Won't-send reason; any gap alerts the engineer.
- Volume ~1,800 emails/week: risk is correctness, not throughput. No queue infrastructure beyond the DB table.

**Sequencing for one engineer (estimate ~7 weeks)**
- M1 (wk 1–3): outbox + worker + retries + idempotency, reminder scan, bounce webhook, kill switch (incl. staff banner + Paused state), monitoring + reconciliation, change log + optimistic concurrency, Messages timeline, Mark no-show, §5 M1 pilot floor (customer-emailing actions labelled). M1 emails carry no Confirm/Cancel links. *M1 alone is a shippable reliability floor and goes to the pilot as soon as it passes the M1 test set in §7.*
- M2 (wk 4–5): "Save and email customer" previews, reinstate, Today/This week view, Confirm/Cancel links (switched on only once §7.13 is met).
- M3 (wk 6–7): CSV preview, duplicates, import-without-confirmations, batch undo.
- **Cut line if behind (in this order):** batch undo (→ owner cancels manually), CSV duplicate detection against existing appointments (→ within-file only), Cancel link (keep Confirm; cancel by reply). Matching customer/staff copy for each cut is in §5. M1 reliability items are never cut to protect a date.
- **Product guardrail (never cut):** the Confirm link, the Today/This week view and "Save and email customer" previews. Without them R1 doesn't deliver its core loop; if those are at risk, the date moves instead.

## 7. Launch criteria (Argon, with Product)
Each is pass/fail, run on staging against the real email provider in sandbox mode unless noted. Full R1 go-live requires all. **M1 pilot go-live (real customers) requires 1–5, 6 (staff-vs-staff part), 8, 10, 11, 12 (M1 part) and 14.**
1. **Outbox atomicity:** kill the app process between save and send 20 times → every committed change has exactly one queued email; no email for rolled-back changes.
2. **No duplicates:** inject provider timeouts/5xx on 100 sends → each recipient receives exactly one copy per (appointment, type, version).
3. **No stale sends:** reschedule while the old reminder is mid-retry → old-time reminder is never delivered; new reminder targets the new time.
4. **24h-window rules:** booked <24h, rescheduled into <24h, rescheduled out of <24h, cancelled at 24h−1 min, reinstated inside 24h → actual sends and timeline labels match §5/§6 in every case.
5. **DST:** appointments across both 2027 US DST transitions plus one non-US zone → reminder sends at start−24h (UTC) and email shows correct local time and zone.
6. **Concurrent edits:** two staff save from stale copies → second is blocked with the "what changed and by whom" dialog; log shows both actors. Same for staff edit vs customer Cancel POST, in both orders.
7. **Link safety:** GET (incl. simulated scanner prefetch) changes nothing; tampered, stale-version, cancelled and expired tokens take no action and show the §5 page.
8. **Bounce path:** provider test bounce → Delivery problem chip within 5 min; "Save and resend" after fixing the address sends exactly one message to the new address.
9. **CSV:** 500-row file with seeded errors, in-file and existing duplicates → preview counts are exact; import with and without confirmations sends exactly the stated number; overlapping import by a second assistant creates no duplicates; batch undo restores state and sends exactly the chosen cancellations.
10. **Monitoring fires:** stuck row, Failed message, webhook silence and reconciliation gap each raise an alert in a staging drill.
11. **Kill switch drill:** pause → zero customer sends, staff banner and Paused timeline state visible; unpause → each queued message sends once; reminders past start become "Won't send — sending was paused past the appointment start". Includes a drill with the provider simulated down, confirming the runbook's direct-contact path.
12. **Previews are truthful:** for every customer-emailing action, the preview text equals the delivered email (automated comparison). For the M1 pilot: every action that enqueues a customer email is labelled as such, and no plain "Save" enqueues one.
13. **Baseline:** Mark no-show has been live (with M1) for ≥2 weeks across all 12 businesses before Confirm/Cancel links are enabled. Owner-reported historical rates collected as a secondary, soft reference.
14. **Runbook:** one-page runbook (alerts, kill switch, manual resend, bounce fix, pilot-owner contact list) exists and a second person has walked through it, since there is only one engineer.

## 8. Success measures (first 6 pilot weeks after links are enabled)
- Reliability: ≥99.5% of reminders sent within 15 min of target; 100% of the rest visibly flagged on the timeline. Zero duplicate or stale (wrong-time) customer emails, verified weekly by diffing the outbox log against the provider's send log. (Engineering check on the target: ~600 reminders/week, so 99.5% allows ~3 late per week. A 5-min scan plus 1m/5m first retries keeps normal sends well inside 15 min; misses should come only from provider incidents, which is exactly what this measure should surface.)
- Engagement: ≥50% of appointments receive a customer response (Confirm or Cancel) via any email link before start. Denominator = non-cancelled-by-staff appointments with a deliverable address; we also report which email the response came from (confirmation / update / reminder) to inform R2 reminder decisions.
- Outcome: no-show rate down vs. the in-product baseline from §7.13 (target ≥25% relative reduction). Caveat: unmarked = attended may under-record no-shows; it does so equally in both periods, so the comparison is like for like.
- Admin: owners report less chasing in pilot check-ins (qualitative); zero owner reports of "a customer got an email I didn't expect".
- Operability: ≤2 hours/week of engineer time on support/incidents by pilot week 4. If exceeded, fix causes before starting R2 features.

## 9. Decisions & tradeoffs
- **Dropped optional 2nd reminder** (Product proposal). Reason: second scheduling path + settings + edit races; one explainable rule. Revisit with pilot confirm-rate data.
- **Kept Confirm AND Cancel links** (all three agree). Cost ~1 week of the single engineer, funded by dropping the 2nd reminder. Guardrails: POST-only action, version-bound token, staff still own time/place. Product's Confirm-only variant is the fallback and is third on the §6 cut line.
- **Links on every customer email, not only the reminder** (Design). One pattern for customers; covers the <24h case without special-casing. Engagement metric counts responses from any email.
- **No customer reschedule** — reply-to the business. Avoids public mutation flows and races with staff edits.
- **SMS deferred to R2** — biggest likely no-show lever after email, but cost, consent and carrier rules don't fit one engineer + reliability-first R1.
- **No silent save for time changes; reinstate always emails** — a silently moved or silently revived appointment is the worst surprise; accept slight friction.
- **M1 pilot ships labelled actions, not rendered previews** (Design + Engineering). Keeps "no silent sends" true during the M1 pilot at near-zero cost; full previews follow in M2 and are never cut.
- **Pauses are visible to owners** (Design). The kill switch is engineer-only, but its effect is shown (banner, Paused state, owner notice if >30 min), so suppression is never silent. Engineering caveat: if the email provider is the cause, the owner notice is delivered by the engineer directly rather than by email.
- **Stale-edit blocking instead of locking/presence** — cheaper, and covers customer actions too; cost is occasional re-entry of an edit.
- **Business timezone only** — we lack customer-zone data; emails state the zone.
- **Reliability first in sequencing** (Engineering). M1 is a shippable floor; feature milestones can slip or be cut, reliability items cannot. Tradeoff: pilot owners see the visible features (Today view, links) ~2 weeks later than if built in parallel.
- **Date moves before the core loop is cut** (Product). Confirm link, Today view and edit previews are below no cut line. Engineering accepts this; recorded risk: with one engineer the ~7-week estimate has no slack, so after the three cut-line items are used, any further slip moves the date.
- **No-show marking ships first** so the outcome metric has an in-product baseline rather than relying only on owner recollection. Tradeoff: links are held back ≥2 weeks after M1.
- **Late reminders are not sent** after a pause or outage that runs past the start time — a late reminder is worse than none, and the timeline says why.

## 10. Open questions
- None blocking. R2 candidates (decide with pilot data): SMS, configurable second reminder, customer reschedule request, calendar sync.
