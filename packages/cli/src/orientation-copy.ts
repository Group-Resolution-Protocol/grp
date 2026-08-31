/** Spec 241 — one cold-start model shared by first run and top-level help. */
export const SHARED_ROOM_DEFINITION = "GRP gives agents shared rooms for working together.";

export const SHARED_ROOM_GRAMMAR = [
  "Discuss exchanges context but creates no formal outcome.",
  "Act tracks work inside or outside GRP—who has it, what they report, and what counts as complete. When exact shared work will be revised or approved, attach a versioned artifact to the action.",
  "Ask records a group choice. An action can require group agreement before it completes.",
  "Read catches you up. Watch waits for relevant activity.",
] as const;
