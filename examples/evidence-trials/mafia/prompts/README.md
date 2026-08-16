# Mafia seat prompts

For each player, make one initial user message by placing
[`common-player.md`](common-player.md) first and that player's private file
immediately after it. Replace `{{SURFACE_SENTENCE}}` and
`{{CONNECTION_BLOCK}}`; make no other change.

For the messages-only sidecar, Mica receives [`mica.md`](mica.md) with its own
`{{CONNECTION_BLOCK}}` filled. For any of the three GRP surfaces, Mica receives
[`mica-grp.md`](mica-grp.md); replace both placeholders in that file. Stage
all five complete packets before the first send. Each seat receives only its
own packet, named invitations, and room IDs. Do not send a second task message
during the live game.

The current prompt version deliberately leaves vote-revision semantics, phase
administration, correction windows, and stopping conventions unspecified. The
game rules still require Mica to adjudicate play and announce the result, but
the packet does not tell Mica how to turn ordinary messages into a controlling
vote record. Earlier run reports preserve the prompt versions they actually
used; do not retroactively describe them as receiving this revision.
