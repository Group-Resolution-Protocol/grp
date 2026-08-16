# Evidence trial run record

| Field | Value |
|---|---|
| Date | |
| Scenario | |
| Arm | |
| Ledger | Development / paper evaluation |
| Host | |
| Room | |
| Source commit | |
| Deployed server build | |
| CLI build | |
| Kit manifest digest | |
| Models / effort | |
| Standing-agent assignment | |
| Final kickoff time | |
| Registered safety cap | |
| Actual task end and reason | All-idle completion / safety cap |
| Result | |
| Decision opened | Yes / no / preloaded |
| Decision opener and event point | |
| Decision question / mechanism / options | |

## Setup integrity

- [ ] All six existing browser windows audited together before room creation
- [ ] Existing tabs reused through sidebar New; no new tabs or windows
- [ ] Browser grid unchanged: no move, resize, maximize, or retile
- [ ] Fresh participant sessions
- [ ] Frozen model and effort
- [ ] Transcript-display availability recorded; no unverified `/transcript`
      command entered in a participant composer
- [ ] Correct element-named invites and fixed role assignments
- [ ] Invitation blocks kept private; diagnostics expose no token or join URL
- [ ] Room settings match the frozen file
- [ ] Options and order match, if applicable
- [ ] Prompt and instrument hashes match the manifest
- [ ] Source, server, CLI, and guidance versions match the frozen battery

Record substitutions or failures. Do not silently repair and erase an
initiated attempt.

## Operator ledger

List every operator action after the final kickoff paste, including read-only
inspection. State `none` if there were none. Do not copy invitation tokens or
participant credentials.

## Outcome

Record the room outcome or the chat extraction result, participation, shared
closure, completion behavior, receipt verification, and the produced artifact.
For an all-idle completion, record the final participant-idle check, absence of
foreground waits/background work, absence of pending room transitions, and
the final quiescent room sequence. For a safety-cap end, record every session
that was still running.

Do not infer background idleness from a provider's finished label. Inspect
every used session for a running-task indicator, expand any indicator, record
the named tasks, and confirm the count reaches zero before the task end and
surveys. At the safety cap, stop remaining watches through their task controls
without sending a message.

For a natural-GRP arm, also record whether the agents stayed in speech, opened
a decision, inspected or changed settings, and improvised a chair, tally,
assent check, final marker, or version record. Do not treat opening a decision
as success by itself.

## Private surveys and blind review

Record exact-match counts and the judge's structured output without publishing
private mandates or raw session material.

## Predictions and rubric

Grade every registered item, including misses and failures. Keep observation,
interpretation, and claim strength separate.

## Closeout

- [ ] Every used tab returned to a blank session through sidebar New
- [ ] Registered repository and source branch restored in all six windows
- [ ] All six windows re-audited together
- [ ] No foreground wait or background process remains
- [ ] Every used session's running-task indicator was explicitly checked and
      reached zero before surveys
- [ ] Browser grid unchanged
