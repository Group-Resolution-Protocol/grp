import { grpCommand } from "./command-hints.js";

export type ForegroundPhase = "discussion" | "decision" | "action" | "review";

export interface CliForegroundProjection {
  policy: "phased_serial";
  epoch: string;
  phase: ForegroundPhase;
  decision_id: string | null;
  action_id: string | null;
  artifact_id: string | null;
  artifact_revision_id: string | null;
  return_action_id: string | null;
  your_obligation: Record<string, unknown> | null;
  available_transitions: string[];
  decision?: Record<string, unknown>;
  action?: Record<string, unknown>;
  artifact?: Record<string, unknown>;
}

export interface ForegroundRenderOptions {
  roomArg?: string;
  includeWatch?: boolean;
}

export function foregroundFromResponse(value: unknown): CliForegroundProjection | null {
  if (!isRecord(value)) return null;
  return foregroundFromRecord(isRecord(value.foreground) ? value.foreground : value);
}

function foregroundFromRecord(value: Record<string, unknown>): CliForegroundProjection | null {
  if (value.policy !== "phased_serial") return null;
  const epoch = stringOrNull(value.epoch);
  const phase = stringOrNull(value.phase);
  if (!epoch || !/^(?:0|[1-9][0-9]*)$/.test(epoch)) return null;
  if (phase !== "discussion" && phase !== "decision" && phase !== "action" && phase !== "review") {
    return null;
  }
  if (!Array.isArray(value.available_transitions)) return null;
  return {
    policy: "phased_serial",
    epoch,
    phase,
    decision_id: stringOrNull(value.decision_id),
    action_id: stringOrNull(value.action_id),
    artifact_id: stringOrNull(value.artifact_id),
    artifact_revision_id: stringOrNull(value.artifact_revision_id),
    return_action_id: stringOrNull(value.return_action_id),
    your_obligation: isRecord(value.your_obligation) ? value.your_obligation : null,
    available_transitions: value.available_transitions.filter(
      (transition): transition is string => typeof transition === "string",
    ),
    ...(isRecord(value.decision) ? { decision: value.decision } : {}),
    ...(isRecord(value.action) ? { action: value.action } : {}),
    ...(isRecord(value.artifact) ? { artifact: value.artifact } : {}),
  };
}

export function renderForegroundBlock(
  foreground: CliForegroundProjection,
  options: ForegroundRenderOptions = {},
): string {
  const room = options.roomArg ?? "";
  const includeWatch = options.includeWatch !== false;
  switch (foreground.phase) {
    case "discussion":
      return renderDiscussion(foreground, room, includeWatch);
    case "decision":
      return renderDecision(foreground, room, includeWatch);
    case "action":
      return renderAction(foreground, room, includeWatch);
    case "review":
      return renderReview(foreground, room, includeWatch);
  }
}

function renderDiscussion(
  foreground: CliForegroundProjection,
  room: string,
  includeWatch: boolean,
): string {
  const commands: string[] = [];
  if (has(foreground, "room.discuss")) {
    commands.push(`${grpCommand(`discuss "..."${room}`)}       exchange room context`);
  }
  if (has(foreground, "decision.open")) {
    commands.push(`${grpCommand(`ask "..."${room}`)}           open the foreground decision`);
  }
  if (has(foreground, "action.create")) {
    commands.push(`${grpCommand(`act start --title="..."${room}`)}   start the foreground action`);
  }
  if (has(foreground, "room.conclude")) commands.push(grpCommand(`close${room}`));
  return blockWithCommands(
    ["Foreground: DISCUSSION — no decision or action is active."],
    commands,
    includeWatch ? grpCommand(`watch${room}`) : null,
  );
}

function renderDecision(
  foreground: CliForegroundProjection,
  room: string,
  includeWatch: boolean,
): string {
  const decision = foreground.decision ?? {};
  const seq = numberOrNull(decision.seq);
  const label = seq === null ? (foreground.decision_id ?? "?") : String(seq);
  const question = stringOrNull(decision.question) ?? "Question unavailable";
  const lines = [`Foreground: DECISION ${label} — ${JSON.stringify(question)}`];
  if (foreground.return_action_id) {
    lines.push(`Returns to action ${foreground.return_action_id} when this decision closes.`);
  }
  const obligationKind = stringOrNull(foreground.your_obligation?.kind);
  if (obligationKind === "decision_response") {
    lines.push("You have not responded on this decision.");
  } else if (has(foreground, "decision.choose")) {
    lines.push("Your response is recorded and remains revisable while choices are open.");
  }
  const decisionArg = seq === null ? "" : ` --decision=${seq}`;
  const commands: string[] = [];
  if (has(foreground, "decision.discuss")) {
    commands.push(grpCommand(`discuss "..."${decisionArg}${room}`));
  }
  if (has(foreground, "decision.propose_option")) {
    commands.push(grpCommand(`propose "<option>"${decisionArg}${room}`));
  }
  if (has(foreground, "decision.start_choosing")) {
    commands.push(grpCommand(`start choosing${room}`));
  }
  if (has(foreground, "decision.choose")) {
    const verb = decision.agreement === true ? "accept" : "choose";
    commands.push(grpCommand(`${verb} "<option>"${decisionArg}${room}`));
  }
  if (has(foreground, "decision.abstain")) {
    commands.push(grpCommand(`abstain --reason="..."${decisionArg}${room}`));
  }
  if (has(foreground, "decision.cancel")) {
    commands.push(grpCommand(`cancel ${label} --reason="..."${room}`));
  }
  return blockWithCommands(
    lines,
    commands,
    includeWatch ? grpCommand(`watch${seq === null ? "" : ` --decision=${seq}`}${room}`) : null,
  );
}

function renderAction(
  foreground: CliForegroundProjection,
  room: string,
  includeWatch: boolean,
): string {
  const action = foreground.action ?? {};
  const id = foreground.action_id ?? stringOrNull(action.id) ?? "ACTION_ID";
  const title = stringOrNull(action.title) ?? "Untitled action";
  const mode = stringOrNull(action.mode);
  const requiredIds = stringArray(action.required_participant_ids);
  const respondedIds = stringArray(action.responded_participant_ids);
  if (mode === "all") {
    const lines = [
      `Foreground: ACTION ${id} — all-participant; ${respondedIds.length}/${requiredIds.length} reports recorded.`,
    ];
    if (stringOrNull(foreground.your_obligation?.kind) === "action_report") {
      lines.push(
        `Required: ${grpCommand(`act complete ${id} --result-text="What happened"${room}`)}`,
      );
    } else {
      lines.push("No report is outstanding from you.");
    }
    const commands = has(foreground, "decision.open_blocking")
      ? [grpCommand(`ask "..."${room}`)]
      : [];
    if (has(foreground, "action.cancel")) commands.push(grpCommand(`act cancel ${id}${room}`));
    return blockWithCommands(
      lines,
      commands,
      includeWatch ? grpCommand(`watch --action=${id}${room}`) : null,
      lines.some((line) => line.startsWith("Required:")),
    );
  }

  const holder = stringOrNull(action.holder_id);
  const holderObligation = stringOrNull(foreground.your_obligation?.kind) === "action_holder";
  const lines = [
    holderObligation
      ? `Foreground: ACTION ${id} — ${JSON.stringify(title)}`
      : `Foreground: ACTION ${id} — ${JSON.stringify(title)}${holder ? `; held by ${holder}.` : "."}`,
  ];
  if (holderObligation) lines.push("You hold this action.");
  else lines.push("No action transition is required from you.");
  const commands: string[] = [];
  const targetArtifactId = stringOrNull(action.target_artifact_id);
  const groupArtifact = stringOrNull(action.completion) === "group" && !!targetArtifactId;
  if (has(foreground, "action.complete") && !groupArtifact) {
    commands.push(grpCommand(`act complete ${id} --result-text="What happened"${room}`));
  }
  if (has(foreground, "action.fail")) commands.push(grpCommand(`act fail ${id}${room}`));
  if (has(foreground, "action.handoff")) {
    commands.push(grpCommand(`act handoff ${id} --to=NAME${room}`));
  }
  if (has(foreground, "artifact.mutate") && foreground.artifact_id) {
    commands.push(
      grpCommand(`artifact publish ${foreground.artifact_id} --action=${id} --file=PATH${room}`),
    );
  }
  if (has(foreground, "action.request_review") && stringOrNull(action.completion) === "group") {
    commands.push(grpCommand(`act request-review ${id}${room}`));
  }
  if (has(foreground, "decision.open_blocking")) commands.push(grpCommand(`ask "..."${room}`));
  if (has(foreground, "action.claim")) commands.push(grpCommand(`act take ${id}${room}`));
  if (has(foreground, "action.takeover")) {
    commands.push(grpCommand(`act takeover ${id} --reason="..."${room}`));
  }
  if (has(foreground, "action.cancel")) commands.push(grpCommand(`act cancel ${id}${room}`));
  return blockWithCommands(
    lines,
    commands,
    includeWatch ? grpCommand(`watch --action=${id}${room}`) : null,
  );
}

function renderReview(
  foreground: CliForegroundProjection,
  room: string,
  includeWatch: boolean,
): string {
  const action = foreground.action ?? {};
  const artifact = foreground.artifact ?? {};
  const exact = isRecord(artifact.exact_revision) ? artifact.exact_revision : {};
  const id = foreground.action_id ?? stringOrNull(action.id) ?? "ACTION_ID";
  const ordinal = numberOrNull(exact.ordinal);
  const sha256 = stringOrNull(exact.sha256) ?? "unknown";
  const lines = [
    `Foreground: REVIEW ${id} — artifact v${ordinal ?? "?"} (SHA-256 ${sha256})`,
    "The artifact cannot change while this review is open.",
  ];
  const obligation = stringOrNull(foreground.your_obligation?.kind) === "review";
  if (obligation) lines.push(`Required: ${grpCommand(`act review ${id}${room}`)}`);
  else if (has(foreground, "action.review")) lines.push("Your response is recorded.");
  else lines.push("No review response is required from you.");
  const commands: string[] = [];
  if (!obligation && has(foreground, "action.review")) {
    commands.push(grpCommand(`act review ${id}${room}`));
  }
  if (has(foreground, "action.cancel")) commands.push(grpCommand(`act cancel ${id}${room}`));
  return blockWithCommands(
    lines,
    commands,
    includeWatch ? grpCommand(`watch --action=${id}${room}`) : null,
    obligation,
  );
}

function blockWithCommands(
  facts: string[],
  commands: string[],
  watch: string | null,
  hasRequired = false,
): string {
  const lines = [...facts];
  if (commands.length > 0) {
    lines.push("Available:", ...commands.map((command) => `  ${command}`));
    if (watch) lines.push(`  ${watch}`);
  } else if (watch && !hasRequired) {
    lines.push(`Next: ${watch}`);
  } else if (!hasRequired) {
    lines.push("Available: none");
  }
  return `${lines.join("\n")}\n`;
}

function has(foreground: CliForegroundProjection, transition: string): boolean {
  return foreground.available_transitions.includes(transition);
}

/** Insert the one phased block after the result header. Existing generic
 * command footers are removed so the foreground projection is the only
 * command-orientation block in a phased human response. */
export function insertForegroundBlock(text: string, block: string): string {
  const cleaned = stripLegacyCommandFooters(text);
  const personaBreak = cleaned.startsWith("You are ") ? cleaned.indexOf("\n\n") : -1;
  const headerStart = personaBreak >= 0 ? personaBreak + 2 : 0;
  const headerEnd = cleaned.indexOf("\n", headerStart);
  if (headerEnd < 0) return `${cleaned.trimEnd()}\n${block}`;
  return `${cleaned.slice(0, headerEnd + 1)}${block}${cleaned.slice(headerEnd + 1)}`;
}

function stripLegacyCommandFooters(text: string): string {
  const lines = text.split("\n");
  const sectionHeaders = new Set([
    "Next:",
    "Available:",
    "Other commands:",
    "Room commands:",
    "Run:",
  ]);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (sectionHeaders.has(line)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (line.trim() === "" || /^\s+/.test(line)) continue;
      skipping = false;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
