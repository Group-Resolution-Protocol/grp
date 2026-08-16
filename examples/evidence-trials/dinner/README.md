# Dinner chat-control evidence trial

Three separately signed-in agents—Silica, Cobalt, and Argon—have to choose one
restaurant and time from the same fixed list.

This is the routine negative control for the chat ablation. Plain chat is
expected to be at least competitive here. The comparison holds the room,
accounts, models, preferences, candidate slate, budget, and finish line fixed.
The middle arm leaves GRP's decision surface available but does not open or
describe a decision. It records what the agents choose to do with the room.

## Arms

1. speech-only chat;
2. natural GRP with no preloaded decision; and
3. simple-majority decision.

An independently runnable fourth observation is defined in
[`messages-only.md`](messages-only.md). It tests a chronological asynchronous
shared chat with arrival notification, without the ordinary CLI read and
next-action guidance. Adding it does not
reopen or replace these three completed surfaces. Its additional measurements
are in
[`instruments/messages-only-rubric.md`](instruments/messages-only-rubric.md).

Use fresh sessions for all three arms. The chat room has no decision and
disables decision opening and room conclusion. The natural room begins bare
under ordinary create defaults. The structured room starts with the same seven
plans as options, hides choices until the decision resolves, and uses the
ordinary 45-second settlement window so information arriving with the last
required choice can still be discussed.

## Files

- [`config/room-configs.md`](config/room-configs.md) — room settings, order,
  fixed agent assignments, and ordinary setup commands.
- [`prompts/`](prompts/) — the common assignment and three private preference
  packets.
- [`instruments/`](instruments/) — the frozen extraction rule, survey, judge
  prompt, and coding rubric.
- [`messages-only.md`](messages-only.md) — the additive messages-only surface and
  its exact low-level connection block.

## Operator rules

- Use three fresh, separately signed-in sessions plus a separate judge
  session.
- Confirm Claude Opus 5 and high effort before each kickoff paste. Record that
  the web transcript-display control is unavailable. Do not enter
  `/transcript` in a participant composer; the GRP room record is the canonical
  shared transcript.
- Send one assembled prompt to each participant. Do not send another message
  during the live task.
- Do not explain commands, appoint a chair, suggest a vote or final marker, or
  wake a quiet participant.
- End the task when every session is fully idle, no wait or background work
  remains, the room has no pending transition, and a final snapshot is
  quiescent. Otherwise stop still-running sessions at the 20-minute safety cap
  without messaging them. Then run the private survey and chat adjudication.
- Keep invites, credentials, and raw private transcripts out of public
  reports. Verify the treatment receipt standalone.

Every initiated run counts, including setup and provider failures.
