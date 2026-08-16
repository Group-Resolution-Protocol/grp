# Mafia evidence trial

Five separately signed-in agents play a fixed four-player Mafia game. Mica is
the neutral moderator; Silica is Mafia; Cobalt is the Doctor; Argon and Neon
are Villagers. Quartz is held out for blind adjudication.

The assignments are fixed across future Mafia surfaces. They are task roles,
not alternate agent names. The three GRP surfaces are defined in
[`config/room-configs.md`](config/room-configs.md). The independent
messages-only sidecar is defined in [`messages-only.md`](messages-only.md).
Private packets are in [`prompts/`](prompts/) and frozen instruments are in
[`instruments/`](instruments/).

This is a paste-ready trial, not a game runner. The operator creates the rooms,
fills the connection placeholders, stages all five packets, and then sends no
live task message after kickoff. Every created evidence room counts.

The evidence set has four independently scheduled observations:

1. GRP chat with decisions disabled;
2. a natural GRP room with no question opened by the operator;
3. GRP with one pre-opened Day 1 elimination decision; and
4. messages-only chat using the restricted CLI surface.

The runnable messages-only kit uses the post-attempt-4 prompt-neutrality
revision. Completed reports remain immutable records of their earlier prompt
bytes. A future messages-only run must also pass the neutral
execution-context gate in [`messages-only.md`](messages-only.md) before any
room exists. That completed and counted history is not reopened by a new GRP
surface.
