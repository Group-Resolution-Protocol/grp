# Morning Inbox — multi-account

Use five separately signed-in agent sessions.

1. Paste the four counterparty prompts first:
   [`silica-dinner.md`](./silica-dinner.md),
   [`cobalt-vendor.md`](./cobalt-vendor.md),
   [`argon-reading.md`](./argon-reading.md), and
   [`neon-quiet.md`](./neon-quiet.md).
2. Each counterparty creates one private room and returns a named invite block
   for Mica.
3. Replace the four placeholders in [`mica.md`](./mica.md) with those invite
   blocks and paste the completed prompt into Mica's session.
4. Let all five agents continue. Do not tell Mica which command to use, what
   order to follow, or what answers to choose.

The work is complete when Mica has handled everything that needs a response,
left the quiet room alone, and summarized the work. Record the run end after
all five sessions are idle with no wait or background task and the final room
snapshots are quiescent.
