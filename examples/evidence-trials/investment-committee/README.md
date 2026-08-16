# Investment committee evidence trial

Five separately signed-in agents represent five members of a fictional
investment committee. They receive different private views of AI diffusion and
risk, but the same real company-reported facts and the same five hypothetical
packages. They have to choose one package and produce a usable allocation memo
afterward.

This is a paper-only coordination exercise. It contains no broker connection,
orders, trading simulator, P&L grade, or investment advice.

## What it compares

The intended paper evidence contains four independent fresh-session runs:

1. messages-only chat;
2. GRP chat with decisions disabled;
3. natural GRP with no preloaded decision;
4. a preloaded ranked-pairwise decision.

The evidence packet, package slate, private mandates, accounts, model settings,
budget, and finish line stay fixed. The messages-only observation is scheduled
independently and does not reopen another arm. The natural arm observes whether
agents reach for the decision surface themselves. Decisions-disabled GRP chat
versus ranked pairwise remains the registered spec-053 ablation. The completed
simple-majority, plurality, ranked-pairwise, and score-vote runs remain
development evidence, not extra paper arms.

An open-slate run may happen later, but it is not part of this comparison.

## Files

- [`evidence-packet.md`](evidence-packet.md) — common facts, exact packages,
  source cutoff, and research limits.
- [`prompts/`](prompts/) — the five private seat packets. Replace the two
  marked placeholders immediately before pasting.
- [`config/room-configs.md`](config/room-configs.md) — frozen room settings and
  arm order plus ordinary operator setup commands.
- [`messages-only.md`](messages-only.md) — the independently runnable minimal
  chat surface.
- [`instruments/survey.md`](instruments/survey.md) — private post-run survey.
- [`instruments/chat-extraction.md`](instruments/chat-extraction.md) —
  mechanical extraction rule.
- [`instruments/judge-prompt.md`](instruments/judge-prompt.md) — blind chat
  adjudication prompt.
- [`instruments/rubric.md`](instruments/rubric.md) — outcome and loser-work
  coding.

## Operator rules

- Use five fresh, separately signed-in agent sessions and one separate judge
  session.
- Keep Argon, Cobalt, Mica, Neon, Silica, and Quartz as the standing account
  and agent identities. Each participant keeps one fixed private mandate
  across all three surfaces; Quartz remains the held-out judge.
- Confirm Claude Opus 5 and high effort before each kickoff paste. Record that
  the web transcript-display control is unavailable. Do not enter
  `/transcript` in a participant composer; the GRP room record is the canonical
  shared transcript.
- Provision the frozen room and named invites. Do not send a participant any
  message after its initial packet during the live task.
- Do not explain GRP commands, appoint a chair, suggest a ballot strategy,
  supply a final marker, or wake a quiet seat.
- End the task when every session is fully idle, no wait or background work
  remains, the room has no pending transition, and a final snapshot is
  quiescent. Otherwise stop still-running sessions at the 45-minute safety cap
  without messaging them. Then run the private survey and chat-only
  adjudication.
- Keep invitation tokens, participant credentials, private transcripts, and
  raw mandate-bearing session material out of published reports.
- Verify every issued receipt standalone.

All operator actions after kickoff go in the nudge ledger. A setup or provider
failure remains in the run record.
