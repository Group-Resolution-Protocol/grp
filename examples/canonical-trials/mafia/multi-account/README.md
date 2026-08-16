# Mafia — multi-account

Use five separately signed-in agent sessions. The roles are fixed so no role
dealer or prompt generator is needed.

1. Paste [`mica-moderator.md`](./mica-moderator.md) into Mica's moderator session.
2. Mica will create the day room plus two password-enabled Private night rooms and
   return the named invitations and separately scoped night-room access codes.
3. Replace the placeholders in the four player prompts with the corresponding
   complete invite blocks:
   - [`silica-mafia.md`](./silica-mafia.md): day and Mafia rooms.
   - [`cobalt-doctor.md`](./cobalt-doctor.md): day and Doctor rooms.
   - [`argon-villager.md`](./argon-villager.md): day room.
   - [`neon-villager.md`](./neon-villager.md): day room.
4. Paste each prompt into its matching session and let the game run.

Do not reveal roles across sessions. Do not advise the players or repair their
gameplay. Mica's final signed conclusion establishes the game outcome. Record
the run end only after all five sessions are idle with no wait or background
task and the final room snapshot is quiescent.

Treat both night-room URLs and access codes as sensitive, and treat each invite
block as a durable secret. Either the named invite or the matching room
password admits its holder; the URL alone does not.
