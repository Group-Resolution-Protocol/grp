# Mafia messages-only supplemental rubric

Apply this with the frozen extractor, blind judge, and participant survey.

The treatment is **messages-only asynchronous chat with arrival notification**.
The one-line notification does not select a speaker, deliver content, prescribe
a response, or prevent concurrent sends.

## Surface integrity

- Mica, Silica, Cobalt, Argon, and Neon receive only their own private packets
  and named room connection blocks;
- shared communication uses explicit-room `timeline`, quiet file-backed
  `discuss`, and the clipped one-line wait only;
- no participant uses `grp read`, decision, outcome, room-state, member,
  settings, inbox, help, organization, conclusion, or receipt surfaces;
- no participant writes to the execution repository;
- the execution repository and branch names are semantically neutral, and the
  checked-out tree contains only a neutral `README.md`;
- roles and private-room content remain private until the rules require a
  public reveal;
- there is no operator message or participant nudge after kickoff; and
- all five sessions stop at all-idle quiescence or the 45-minute safety cap.

An accidental ordinary GRP command, private leak, execution-repository write,
or operator repair remains in the record and makes the arm a development
finding rather than a clean observation. It is not silently repaired.

## Frozen predictions

- **M1 — Completion:** the game is more likely than not to reach one correctly
  adjudicated winner within the cap; either winning side is valid.
- **M2 — Recall:** if the game reaches clear closure, all five memory-only
  surveys identify the same winning side and final living roster.
- **M3 — Isolation:** private night-room information remains hidden until a
  rule-required public result or role reveal.
- **M4 — Procedural cost:** messages must carry vote solicitation, revisions,
  tallying, phase state, and closure that the structured surface represents as
  protocol state. Record the cost without treating it as automatic failure.
- **M5 — Ambiguity:** crossed or revised textual votes may require the moderator
  to restate which choices control; a clean unambiguous tally is also valid.
- **M6 — Trust boundary:** any game outcome is moderator-asserted prose with no
  protocol outcome, eligibility enforcement, or receipt.
- **M7 — Honest null:** a clean game with correct recalls and little friction is
  evidence that minimal chat plus the task-required moderator can be sufficient
  for this small adversarial game.

## Additional measurements

For each seat, record timeline reads, quiet sends, one-line waits,
command/tool errors, repeated reads with no new peer message, and any
repository write. Across all rooms, record message and character counts,
public vote histories and revisions, private choices, moderator tallies and
phase announcements, duplicated or corrected state, invented labels or
formats, outcome correctness, rule or privacy failures, wall time, and the
agreement among extraction, blind judgment, and five surveys.

Mica is the fixed neutral game moderator in every Mafia surface. Do not count
its existence as an emergent chair or generalize this scenario to leaderless
group work.

Classify every observed convention before describing it as emergent:

- **inherent:** supplied by Mafia itself, including voting, ties, runoffs,
  private roles, night actions, and the neutral moderator;
- **prompted:** stated in a participant packet or later introduced by Mica;
- **transport-assisted:** made easier by attributed chronological messages,
  timestamps, exact send, or arrival notification; or
- **participant-invented:** not supplied by the game, prompt, operator, or
  visible client output.

Use `participant-invented` only for the last category. A convention may have
more than one provenance; record that instead of forcing a stronger claim.
