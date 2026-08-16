# Evidence trials

These are small, pre-registered comparisons used to test claims about how
groups of agents work. They are not scripted demos and they do not include a
runner.

The public findings are summarized at
[grp.dev/examples/evidence-trials](https://grp.dev/examples/evidence-trials).
A formal protocol paper based on the completed observations is in preparation.
This directory contains reproducibility kits and a public-safe run-record
template, not the private transcript, credential, or attempt archive.

- [`dinner/`](dinner/) — a routine negative control across GRP chat, a bare
  GRP room, and a preloaded simple-majority decision, plus an independently
  runnable messages-only chat sidecar.
- [`term-sheet/`](term-sheet/) — a bilateral negotiation across speech-only
  chat, a bare GRP room, and a mutual-assent agreement decision, plus an
  independently runnable messages-only chat sidecar.
- [`mafia/`](mafia/) — a four-player hidden-role game with a neutral moderator
  across GRP chat, a bare GRP room, and one pre-opened Day 1 elimination
  decision; its independently runnable messages-only sidecar tests textual
  votes, private night actions, phase state, and closure without GRP decision
  state.
- [`investment-committee/`](investment-committee/) — five agents with private,
  conflicting mandates use the same facts and candidate packages under
  messages-only chat, GRP chat with decisions disabled, natural GRP, and one
  preloaded ranked-pairwise decision. The earlier four-mechanism sweep remains
  development evidence.
- [`publishing-house/`](publishing-house/) — six coworkers complete one
  artifact-bearing publishing cycle through three overlapping departments
  under messages-only, decisions-disabled, natural-GRP, and configured-GRP
  surfaces.

Every prompt, room setting, prediction, completion rule, safety cap, and
scoring instrument is frozen before a run. Every started run counts, including
failures.

An independently added arm does not reopen or invalidate completed arms. Freeze
that arm before it starts, retain all of its attempts, and disclose its own
date and build metadata. Rerun an older arm only for a concrete comparability
defect, not merely because the matrix gains another column.

The standing participant names are **Silica, Cobalt, Argon, Neon, Mica, and
Quartz**. Use only those names for agents in future-facing kits. A scenario may
assign a functional job, principal, or hidden game role to an element-named
agent, but it does not give the agent a second personal name. Keep that
assignment fixed across a scenario's four paper observations. Historical run
reports retain the names actually used at the time.

## Development and paper records

Development runs find product, prompt, setup, and capture problems. Keep every
attempt and version it by source commit, deployed build, CLI build, and
manifest digest. A rerun after a fix is a new development attempt; it does not
replace the earlier record.

The paper proceeds scenario by scenario. Ordinarily, after one scenario passes
a clean three-surface development rehearsal, freeze that scenario's release
candidate and run its fresh observations. Publishing House is the recorded
exception: its canonical six-account production run and earlier Stage A/B
trials provide the development history, and the principal prospectively waived
a duplicate rehearsal block before its four paper observations began. Every
paper attempt counts. The
observations are independent: retain every clean arm and rerun only an arm
actually affected by a setup, provider, operator, capture, or product defect.
Reopen multiple arms only when a shared treatment, source, build, or evidence
boundary actually touched them.

The same kits are intended for the public rerun suite and GRP's manual
end-to-end regression checks. That is why the artifacts stay paste-ready and
manifest-driven rather than growing a custom harness.

## Fixed browser-grid preflight

When the six standing accounts are already open in a desktop browser grid,
treat that layout as fixed trial infrastructure:

1. Audit all six existing windows as one batch before creating a room.
2. Reuse the existing tab in each browser. Start a fresh session only through
   the Claude Code sidebar's **New** control.
3. Do not open replacement tabs or windows. Do not move, resize, maximize,
   tile, or otherwise change a browser window.
4. Confirm the expected account, private repository, registered source branch,
   model, effort, and blank composer in every window before kickoff.
5. Do not assume a fresh cloud session already has the CLI. Put the official
   `curl -fsSL https://grp.app/grp/install.sh | sh` installer before its first
   join command. This is transport setup, not coordination guidance.
6. Keep invitation connection blocks in private operator storage. Diagnostic
   output records only lengths and pass/fail checks, never invitation tokens or
   join URLs. Revoke any unused invitation rendered outside that boundary.
7. At closeout, return every used tab to a blank session, restore the
   registered source branch if needed, and re-audit all six windows as one
   batch.

For a messages-only arm, repository neutrality is stricter than ordinary
preflight cleanliness. The active private repository and branch names must not
mention GRP, chat, agents, decisions, voting, mechanisms, the scenario, a
prior trial, or another evidence arm. The checked-out tree contains only a
neutral `README.md` unless the frozen assignment itself requires shared
artifacts; in that case it contains only the prospectively registered neutral
seed files. It contains no repository instruction file or previous run
artifact. Treat the visible repository and branch selectors as model context
even when the participant packet says not to use the repository.

This is the standing rule for every development rehearsal and paper set. A
different machine may use a different layout, but it should still freeze and
record that layout before the first room rather than rearranging it mid-study.

## End of a live session

A live task ends at the first operator observation that all of these conditions
hold:

1. every participant's current model turn has finished and its composer is
   idle;
2. no participant has a foreground wait, tool call, or background process
   still running;
3. no room decision is settling and no other scheduled protocol transition
   can still change the room state; and
4. a final read-only room snapshot shows no activity after the participants
   became idle.

Capture that snapshot and record the time as the task end. Do not keep an
otherwise finished run open until the safety cap, and do not use a sealed
decision by itself as the end signal when artifact or follow-through work is
still running. The registered wall-clock limit remains a hard maximum: stop
any unfinished participant at that point without sending a message. Deliver
post-run surveys immediately after either end condition.

Provider text such as “finished” or an idle composer is not enough to prove
item 2. Before declaring the end, inspect every used session for a running-task
indicator and expand it when present. Record each named background task and
confirm that the indicator reaches zero. At the safety cap, stop a remaining
watch or other background task through its task control without sending text.
Only then capture the quiescent snapshot and send surveys.

Use [`run-record-template.md`](run-record-template.md) for the public-safe
record. Do not put invitation tokens, participant credentials, or raw private
session transcripts in it.
