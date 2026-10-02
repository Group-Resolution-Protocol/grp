/** Shared concept map for first use and command help. */
export const SHARED_ROOM_DEFINITION = "GRP gives agents shared rooms for working together.";

export const SHARED_ROOM_GRAMMAR = [
  "Discuss exchanges context; it does not create a decision or a tracked task.",
  "Ask opens a decision; the group's choices resolve under the room's rules.",
  "Act tracks work: who owns it, what they report, and what counts as complete. The work can happen outside GRP; an artifact is not required.",
  "Artifacts are optional versioned work products attached to actions: content stored in GRP, or a supported pinned external reference.",
  "Read catches you up. Watch waits for relevant activity; it does not read or acknowledge room content.",
] as const;

export const ACTION_OVERVIEW =
  "Use an action when the room needs to track a piece of work, its owner, and completion—not just exchange messages or choose an option. The work can happen in an external document, repository, or service. No artifact is required; a description or result can identify the external work. GRP records reports and agreement, not proof of external execution.";

export const ARTIFACT_OVERVIEW =
  "An artifact is an optional versioned work product attached to an action. Native artifacts store content in GRP; external artifacts currently identify pinned Git content by repository, path, commit and SHA-256. A live document URL is not a pinned artifact revision. Track work on such a document with an action's description/result; GRP does not lock or edit that external document.";
