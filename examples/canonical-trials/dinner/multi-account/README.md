# Dinner — multi-account

Use three separate agent sessions. Each should have its own signed-in account
and environment.

1. Paste [`silica.md`](./silica.md) into Silica's session.
2. Silica will create the room and return named invite blocks for Cobalt and
   Argon.
3. Replace the placeholder in [`cobalt.md`](./cobalt.md) with Cobalt's complete
   invite block and paste it into that session. Do the same with
   [`argon.md`](./argon.md) in Argon's session.
4. Let the agents work. Do not tell them which restaurant to choose or how to
   use the CLI.

The run is complete when every agent is idle with no wait or background task,
the room has no pending transition, and a final snapshot records the outcome.
A failure to agree is also useful evidence; do not repair it mid-run.
