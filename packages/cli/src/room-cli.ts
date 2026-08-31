import { readFileSync } from "node:fs";
import {
  publicKeyFromJwks,
  receiptKid,
  verifyAgreementReceiptSemantics,
  verifyCompactReceipt,
} from "../../agent-sdk/src/index.js";
import type { GrpAuth, RoomEvent } from "../../agent-sdk/src/index.js";
import { grpCommand } from "./command-hints.js";
import { finishEvalTraceRequest, preflightEvalTrace, startEvalTraceRequest } from "./eval-trace.js";
import { SHARED_ROOM_DEFINITION } from "./orientation-copy.js";
import {
  clearCurrentRoom,
  findRememberedRoom,
  forgetRoom,
  listRememberedRooms,
  readProviderConfig,
  rememberRoom,
  renderPersonaIdentity,
  resolvePersonaContext,
  resolvePersonaSelection,
  resolveProviderBaseUrl,
  setCurrentRoom,
  setRoomCoordinationStateCapability,
  setRoomLastSeenSeq,
  setRoomObservedStateRevision,
  updateProviderConfig,
} from "./provider-config.js";
import { type CliCreateAccess, resolveCliCreateAccess } from "./room-access.js";

export interface ParsedArgs {
  flags: Record<string, string>;
  positionals: string[];
  /** Flags whose values are meaningful when repeated. Kept separate so the
   * existing single-value flag contract remains backward compatible. */
  multiFlags?: Record<string, string[]>;
}

export interface RoomRef {
  baseUrl: string;
  slug: string;
  token?: string;
  password?: string;
  invite?: string;
}

export interface RoomCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdin: NodeJS.ReadableStream;
  isInteractive: boolean;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  /** Test/embedding override; normal CLI use resolves from process.cwd(). */
  cwd?: string;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
  auth?: CliAuth;
  password?: string;
  accept?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Local-only eval instrumentation; never serialized onto the wire. */
  trace?: { postAnyway?: boolean };
}

type CliAuth = GrpAuth | { kind: "hosted"; accessToken: string; mandate: string };

const CLI_REQUEST_TIMEOUT_MS = 60_000;
const MAX_CLI_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CLI_SSE_BUFFER_BYTES = 2 * 1024 * 1024;

class SseBufferLimitError extends Error {}

/** Spec 224 candidate — a false strong room-state precondition. */
class RoomStateChangedError extends Error {
  readonly code = "state.precondition_failed";
  readonly status = 412;
  readonly posted = false;

  constructor(
    readonly expectedRevision: string,
    readonly currentRevision: string,
  ) {
    super(`Room changed from revision ${expectedRevision} to ${currentRevision}`);
    this.name = "RoomStateChangedError";
  }
}

class CliHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly serverMessage?: string,
    readonly serverHint?: string,
  ) {
    super(message);
    this.name = "CliHttpError";
  }
}

interface SseMessage {
  id?: string;
  event?: string;
  data?: string;
}

interface DrainSseResult {
  rest: string;
  stop: boolean;
  /** The event type that satisfied --until (or woke the watch), when stop is true. */
  stopEvent?: string;
  /** The full room event that stopped the stream, when it was a room event. */
  stopRoomEvent?: RoomEvent;
  /** True when at least one room event came through this drain. */
  sawEvent: boolean;
}

/** What one SSE connection reported back to the watch loop. */
interface DrainStreamResult {
  stopped: boolean;
  stopEvent?: string;
  stopRoomEvent?: RoomEvent;
  sawEvent: boolean;
}

/** Spec 113 — who the watching session is, for own-event filtering. */
interface CallerIdentity {
  participantId?: string;
  displayName?: string;
}

/** Spec 113 — how a foreground watch woke up. */
type WatchWake =
  | { kind: "event"; event?: RoomEvent; stopEvent?: string }
  | { kind: "action_recovery"; response: unknown }
  | { kind: "action_required"; response: unknown }
  | {
      kind: "working";
      signalId: string;
      participantId: string;
      change: string;
    }
  | {
      kind: "needed";
      question: string | null;
      resolved?: boolean;
      votingEndsAt?: string | null;
      decisionSeq?: number | null;
      completionActionId?: string | null;
    }
  | { kind: "timeout"; seconds: number };

/**
 * Spec 109 (WR2-11/WR2-8) — cross-connection watch state. The head seq is
 * recorded once at watch start so --until stop conditions only honor LIVE
 * events (seq > head), never the replayed history the stream backfills.
 * The last-seen cursor survives reconnects so resumed streams neither miss
 * events nor re-print already-shown ones.
 */
interface WatchStreamState {
  /** Highest event seq that existed when the watch started; null when the
   * head could not be read (fall back to occurred_at > watch start). */
  headSeq: number | null;
  /** Wall-clock watch start, the occurred_at fallback gate for --until. */
  startedAtMs: number;
  /** Highest event seq already consumed. Initialized from the durable room
   * mark/head and advanced by SSE frames, so a fresh connection can resume by
   * numeric cursor even before it has an event id. */
  lastSeenSeq: number | null;
  /** Resume cursor for since_event_id / Last-Event-ID on reconnect. */
  lastEventId: string | null;
  /** Spec 113 — unified wake mode: when set, the stream drains quietly and
   * stops at the first substantive event by someone ELSE past the baseline
   * (the stored read mark, else the head at connect). */
  wake?: {
    baselineSeq: number | null;
    identity: CallerIdentity;
  };
}

/** WR2-8 — reconnect backoff: 1s, 2s, then 5s cap. */
const WATCH_RECONNECT_DELAYS_MS = [1000, 2000, 5000];

const AUTHORITY_SETTING_KEYS = new Set([
  "invite_authority",
  "option_proposal_authority",
  "decision_opening_authority",
  "conclusion_authority",
]);

const BOOLEAN_SETTING_KEYS = new Set(["read_receipts", "early_close", "creator_votes"]);

const NUMBER_SETTING_KEYS = new Set([
  "quorum",
  "voting_window",
  "max_participants",
  "max_options",
  "max_deliberation_messages_per_participant",
  "max_total_deliberation_messages",
  "settle_window",
  "max_open_decisions",
]);

const NULLABLE_SETTING_KEYS = new Set(["quorum", "max_participants"]);

const STRING_SETTING_VALUES: Record<string, string[]> = {
  auth: ["token_only", "mandate_required", "either"],
  deliberation_mode: ["optional", "disabled"],
  choice_visibility: ["after_decided", "live", "never"],
};

// Spec 143 (F142-S1) — mirror the server's MUTABLE_ROOM_CONFIG_KEYS exactly:
// the client-side allowlist had drifted (settle_window and the spec-142
// max_open_decisions were mutable server-side but rejected here before HTTP).
const MUTABLE_SETTING_KEYS = [
  "invite_authority",
  "option_proposal_authority",
  "decision_opening_authority",
  "conclusion_authority",
  "auth",
  "quorum",
  "voting_window",
  "deliberation_mode",
  "max_participants",
  "max_options",
  "max_deliberation_messages_per_participant",
  "max_total_deliberation_messages",
  "read_receipts",
  "choice_visibility",
  "early_close",
  "settle_window",
  "creator_votes",
  "max_open_decisions",
];

// Spec 147 (F146-S1) — these flags have a meaningful bare form. They must
// never consume a following room slug as their value: `grp read --full ROOM`
// and `grp read ROOM --full` are the same command. Explicit boolean literals
// remain supported and are normalized because the downstream presentation
// flags intentionally use the simple string `"true"` contract.
const BOOLEAN_CLI_FLAG_KEYS = new Set([
  "agreement",
  "as-discussion",
  "creator-votes",
  "composing",
  "defer-first-decision",
  "dry-run",
  "early-close",
  "enter",
  "expected",
  "exclusive",
  "force",
  "full",
  "historical",
  "h",
  "help",
  "json",
  "jsonl",
  "private",
  "post-anyway",
  "public",
  "quiet",
  "rewrite",
  "override",
  "unlisted",
]);

// These flags also have a bare default, but accept an unambiguous numeric
// value. A non-numeric next token is a positional destination, never a value.
const OPTIONAL_NUMBER_CLI_FLAG_KEYS = new Set(["collect-options", "timeout"]);
const BOOLEAN_CLI_LITERALS = new Set(["true", "false", "1", "0", "yes", "no", "on", "off"]);

export function parseRoomArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  const multiFlags: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === undefined) continue;
    if (!raw.startsWith("--")) {
      positionals.push(raw);
      continue;
    }
    const eq = raw.indexOf("=");
    if (eq !== -1) {
      const key = raw.slice(2, eq);
      const value = raw.slice(eq + 1);
      flags[key] = value;
      if (key === "option") appendMultiFlag(multiFlags, key, value);
      continue;
    }
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (BOOLEAN_CLI_FLAG_KEYS.has(key)) {
      const booleanValue = normalizedBooleanLiteral(next);
      flags[key] = booleanValue ?? "true";
      if (booleanValue !== undefined) i++;
      continue;
    }
    if (OPTIONAL_NUMBER_CLI_FLAG_KEYS.has(key)) {
      const booleanValue = normalizedBooleanLiteral(next);
      const numericValue = next && isOptionalNumberFlagValue(key, next) ? next : undefined;
      flags[key] = booleanValue ?? numericValue ?? "true";
      if (booleanValue !== undefined || numericValue !== undefined) i++;
      continue;
    }
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      if (key === "option") appendMultiFlag(multiFlags, key, next);
      i++;
    } else {
      flags[key] = key === "option" ? "" : "true";
      if (key === "option") appendMultiFlag(multiFlags, key, "");
    }
  }
  return Object.keys(multiFlags).length > 0
    ? { flags, positionals, multiFlags }
    : { flags, positionals };
}

function normalizedBooleanLiteral(raw: string | undefined): string | undefined {
  if (!raw || !BOOLEAN_CLI_LITERALS.has(raw.toLowerCase())) return undefined;
  return parseOptionalBool(raw) ? "true" : "false";
}

function isOptionalNumberFlagValue(key: string, raw: string): boolean {
  return OPTIONAL_NUMBER_CLI_FLAG_KEYS.has(key) && /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw);
}

function appendMultiFlag(flags: Record<string, string[]>, key: string, value: string): void {
  const values = flags[key] ?? [];
  values.push(value);
  flags[key] = values;
}

export function resolveRoomRef(
  raw: string,
  flags: Record<string, string>,
  env = process.env,
): RoomRef {
  let baseUrl: string | undefined =
    flags.base ??
    explicitProviderBaseUrl(flags, env) ??
    env.GRP_BASE_URL ??
    defaultProviderBaseUrl(flags, env);
  let slug = raw;
  let urlToken: string | undefined;
  let urlPassword: string | undefined;
  let urlInvite: string | undefined;

  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    baseUrl = url.origin;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "r" && parts[1]) {
      slug = decodeURIComponent(parts[1]);
    } else if (parts[0] === "api" && parts[1] === "rooms" && parts[2]) {
      slug = decodeURIComponent(parts[2]);
    } else {
      throw new Error("room URL must contain /r/:slug or /api/rooms/:slug");
    }
    urlToken = url.searchParams.get("token") ?? undefined;
    urlPassword = url.searchParams.get("password") ?? undefined;
    urlInvite = url.searchParams.get("invite") ?? undefined;
  } else if (!baseUrl) {
    // Spec 106 (extends spec 091/098) — with no default host, a short ref
    // matching the saved current room or any remembered joined room resolves
    // to that room's host, so a cold machine that joined via a full-URL
    // invite can run the slug-form commands the CLI suggests. Explicit
    // --host/--base flags, full URLs, and env hosts above still win.
    baseUrl = savedRoomBaseUrl(slug, env);
    if (!baseUrl) {
      // Spec 152 W2 — self-heal: an unrecognized short ref usually means the
      // caller meant their current room. Name it so the fix is one edit away.
      const current = resolveCurrentRoomRef(flags, env);
      const currentHint =
        current && current.slug !== slug
          ? ` Your current room is "${current.slug}" — run the command with no room argument to act on it.`
          : "";
      throw new Error(
        [
          "Short room IDs need a default host.",
          "Run `grp init local`, `grp init grp`, pass `--host`/`--base`, or use a full room URL.",
        ].join(" ") + currentHint,
      );
    }
  }

  const resolvedBaseUrl = baseUrl ?? missingDefaultHost();
  const currentCredentials = matchingRememberedRoomCredentials(slug, resolvedBaseUrl, env);
  const token = flags.token ?? urlToken ?? env.GRP_TOKEN ?? currentCredentials.token;
  const password =
    flags.password ?? urlPassword ?? env.GRP_ROOM_PASSWORD ?? currentCredentials.password;
  const invite = flags.invite ?? urlInvite ?? env.GRP_INVITE;
  return withoutUndefined({
    baseUrl: resolvedBaseUrl.replace(/\/$/, ""),
    slug,
    token,
    password,
    invite,
  }) as RoomRef;
}

function roomContextBaseUrl(
  room: { provider?: string; baseUrl?: string } | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  if (!room) return undefined;
  return room.baseUrl ?? (room.provider ? resolveProviderBaseUrl(room.provider, env) : undefined);
}

/**
 * The host a short room ref resolves to when the local session already knows
 * the room: the current room first, then any remembered joined room (spec 098
 * multi-room map). Returns undefined for slugs this session never joined.
 */
function savedRoomBaseUrl(
  slug: string,
  env: Record<string, string | undefined>,
): string | undefined {
  const config = readProviderConfig(env);
  const bases = new Set<string>();
  for (const room of listRememberedRooms(config)) {
    if (room.slug !== slug) continue;
    const base = roomContextBaseUrl(room, env);
    if (base) bases.add(normalizeUrlForCompare(base));
  }
  if (bases.size > 1) {
    throw new Error(
      `Room ${slug} is remembered on multiple hosts. Pass a full room URL or select one with --host/--base.`,
    );
  }
  return [...bases][0];
}

function matchingRememberedRoomCredentials(
  slug: string,
  baseUrl: string,
  env: Record<string, string | undefined>,
): { token?: string; password?: string } {
  const remembered = findRememberedRoom(readProviderConfig(env), slug, baseUrl);
  const credentials: { token?: string; password?: string } = {};
  if (remembered?.token) credentials.token = remembered.token;
  if (remembered?.password) credentials.password = remembered.password;
  return credentials;
}

export function resolveCurrentRoomRef(
  flags: Record<string, string>,
  env = process.env,
): RoomRef | undefined {
  const config = readProviderConfig(env);
  const current = config.currentRoom;
  if (!current) return undefined;
  const baseUrl =
    flags.base ??
    explicitProviderBaseUrl(flags, env) ??
    current.baseUrl ??
    (current.provider ? resolveProviderBaseUrl(current.provider, env) : undefined) ??
    env.GRP_BASE_URL ??
    defaultProviderBaseUrl(flags, env);
  if (!baseUrl) {
    throw new Error(
      [
        "Current room has no resolvable host.",
        "Run `grp enter <full-room-url>` or set a default host with `grp init`.",
      ].join(" "),
    );
  }
  const remembered = findRememberedRoom(config, current.slug, baseUrl);
  const token = flags.token ?? current.token ?? env.GRP_TOKEN ?? remembered?.token;
  const password =
    flags.password ?? current.password ?? env.GRP_ROOM_PASSWORD ?? remembered?.password;
  return withoutUndefined({
    baseUrl: baseUrl.replace(/\/$/, ""),
    slug: current.slug,
    token,
    password,
  }) as RoomRef;
}

export function parseSseMessage(frame: string): SseMessage | null {
  const message: SseMessage = {};
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "id") message.id = value;
    else if (field === "event") message.event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length > 0) message.data = data.join("\n");
  return message.id || message.event || message.data ? message : null;
}

export function renderEventLine(event: RoomEvent): string {
  const decision = event.decision_id ? ` decision=${event.decision_id}` : "";
  return `[${event.seq}] ${event.occurred_at} ${displayEventType(event.event_type)}${decision} ${JSON.stringify(event.data)}`;
}

export function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function runRoomCli(argv: string[], io: Partial<RoomCliIo> = {}): Promise<number> {
  let resolvedIo = resolveIo(io);
  const parsed = parseRoomArgs(argv);
  const [command, maybeTarget] = parsed.positionals;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printRoomHelp(resolvedIo.stdout);
    return 0;
  }
  if (wantsRoomHelp(parsed)) {
    const subcommand = parsed.positionals[1];
    if (
      (command === "act" || command === "action") &&
      subcommand &&
      ![
        "start",
        "read",
        "take",
        "handoff",
        "request-review",
        "review",
        "complete",
        "resume",
        "fail",
        "cancel",
        "takeover",
      ].includes(subcommand)
    ) {
      resolvedIo.stderr(
        "usage: grp act start|read|take|handoff|request-review|review|complete|resume|fail|cancel|takeover ...\n",
      );
      return 1;
    }
    const helpCommand =
      (command === "artifact" && subcommand === "patch") ||
      ((command === "act" || command === "action") &&
        ["request-review", "review", "complete", "resume"].includes(subcommand ?? ""))
        ? `${command === "act" ? "action" : command}:${subcommand}`
        : command;
    printCommandHelp(helpCommand, resolvedIo.stdout);
    return 0;
  }

  try {
    assertOnlyRoomCommandFlags(parsed);
    assertNoIgnoredPositionals(parsed);
    preflightEvalTrace(resolvedIo.env);
    // Pin a workspace marker to its resolved session for the whole command.
    // Network waits must not let a concurrent --force rebind move the response
    // write, read mark, or identity header into a different persona.
    const selection = resolvePersonaSelection(resolvedIo.env, {
      cwd: resolvedIo.cwd ?? process.cwd(),
    });
    if (selection?.source === "workspace") {
      resolvedIo = { ...resolvedIo, env: { ...resolvedIo.env, GRP_SESSION: selection.name } };
    }
    switch (command) {
      case "use":
      case "enter":
        await roomUse(requiredTarget(maybeTarget), parsed.flags, resolvedIo);
        return 0;
      case "current":
      case "pwd":
        await roomCurrent(parsed.flags, resolvedIo);
        return 0;
      case "rooms":
        await roomRooms(parsed.flags, resolvedIo);
        return 0;
      case "forget":
        await roomForget(requiredTarget(maybeTarget), parsed.flags, resolvedIo);
        return 0;
      case "inbox":
        await roomInbox(parsed.flags, resolvedIo);
        return 0;
      case "leave":
        await roomLeave(parsed.flags, resolvedIo);
        return 0;
      case "create":
        await roomCreate(parsed.flags, resolvedIo, parsed.multiFlags?.option);
        return 0;
      case "read":
        await roomRead(
          targetOrCurrent(maybeTarget, parsed.flags, resolvedIo),
          parsed.flags,
          resolvedIo,
        );
        return 0;
      case "join":
        await roomJoin(requiredTarget(maybeTarget), parsed.flags, resolvedIo);
        return 0;
      case "ask": {
        const args = targetAndTextArg(
          parsed.positionals.slice(1),
          parsed.flags,
          resolvedIo,
          "question",
        );
        await roomAsk(args.target, args.flags, resolvedIo, parsed.multiFlags?.option);
        return 0;
      }
      case "cancel": {
        const decision = parsed.positionals[1];
        await roomCancelDecision(
          decision,
          targetOrCurrent(parsed.positionals[2], parsed.flags, resolvedIo),
          parsed.flags,
          resolvedIo,
        );
        return 0;
      }
      case "propose": {
        if ((parsed.multiFlags?.option?.length ?? 0) > 1) {
          throw new Error(
            "grp propose accepts one --option; repeat --option only with grp ask or grp create",
          );
        }
        const args = targetAndTextArg(
          parsed.positionals.slice(1),
          parsed.flags,
          resolvedIo,
          "option",
        );
        await roomPropose(args.target, args.flags, resolvedIo);
        return 0;
      }
      case "discuss": {
        if (parsed.flags.composing === "true") {
          if (parsed.positionals.length > 2) {
            throw new Error("grp discuss --composing takes only an optional room");
          }
          await roomDiscuss(
            targetOrCurrent(maybeTarget, parsed.flags, resolvedIo),
            parsed.flags,
            resolvedIo,
          );
          return 0;
        }
        const args = targetAndTextArg(
          parsed.positionals.slice(1),
          parsed.flags,
          resolvedIo,
          "body",
        );
        await roomDiscuss(args.target, args.flags, resolvedIo);
        return 0;
      }
      case "act":
      case "action":
        await roomAction(parsed.positionals.slice(1), parsed.flags, resolvedIo);
        return 0;
      case "artifact":
        await roomArtifact(parsed.positionals.slice(1), parsed.flags, resolvedIo);
        return 0;
      case "start":
        if (maybeTarget !== "choosing") {
          throw new Error(
            "use `grp start choosing [room]` to open choices for a collect-first question",
          );
        }
        await roomStartChoosing(
          targetOrCurrent(parsed.positionals[2], parsed.flags, resolvedIo),
          parsed.flags,
          resolvedIo,
        );
        return 0;
      // Spec 128 — `accept` is choose's name on agreement questions (a ballot
      // there means acceptance); one wire verb, two honest words.
      case "accept":
      case "choose": {
        // Spec 150 — like --choices, a --scores map ballot carries the whole
        // choice in its flag. Spec 152 W2: a positional shaped like an option
        // handle (bare number / #N) is a redundant restatement of the map,
        // never a room destination — `grp choose 1 --scores=1=5,2=0` must not
        // resolve "1" as a room slug.
        const args =
          parsed.flags.choices !== undefined || parsed.flags.scores !== undefined
            ? mapBallotTarget(parsed.positionals.slice(1), parsed.flags, resolvedIo)
            : targetAndTextArg(parsed.positionals.slice(1), parsed.flags, resolvedIo, "choice");
        await roomChoose(args.target, args.flags, resolvedIo);
        return 0;
      }
      case "abstain":
        await roomAbstain(
          targetOrCurrent(maybeTarget, parsed.flags, resolvedIo),
          parsed.flags,
          resolvedIo,
        );
        return 0;
      case "close": {
        const args = targetAndTextArg(
          parsed.positionals.slice(1),
          parsed.flags,
          resolvedIo,
          "statement",
        );
        await roomClose(args.target, args.flags, resolvedIo);
        return 0;
      }
      case "options":
        await roomOptions(
          targetOrCurrent(maybeTarget, parsed.flags, resolvedIo),
          parsed.flags,
          resolvedIo,
        );
        return 0;
      case "timeline":
      case "history":
        await roomEvents(
          targetOrCurrent(maybeTarget, parsed.flags, resolvedIo),
          parsed.flags,
          resolvedIo,
        );
        return 0;
      case "watch":
        await roomWatch(
          targetOrCurrent(maybeTarget, parsed.flags, resolvedIo),
          parsed.flags,
          resolvedIo,
        );
        return 0;
      case "invite":
        if (maybeTarget === "list") {
          await roomInviteList(
            targetOrCurrent(parsed.positionals[2], parsed.flags, resolvedIo),
            parsed.flags,
            resolvedIo,
          );
          return 0;
        }
        if (maybeTarget === "revoke") {
          await roomInviteRevoke(
            targetOrCurrent(parsed.positionals[3], parsed.flags, resolvedIo),
            parsed.positionals[2],
            parsed.flags,
            resolvedIo,
          );
          return 0;
        }
        await roomInvite(
          targetOrCurrent(maybeTarget, parsed.flags, resolvedIo),
          parsed.flags,
          resolvedIo,
        );
        return 0;
      case "members":
        if (maybeTarget === "set-role") {
          await roomMemberSetRole(
            parsed.positionals[2],
            parsed.positionals[3],
            targetOrCurrent(parsed.positionals[4], parsed.flags, resolvedIo),
            parsed.flags,
            resolvedIo,
          );
          return 0;
        }
        await roomMembers(
          targetOrCurrent(maybeTarget, parsed.flags, resolvedIo),
          parsed.flags,
          resolvedIo,
        );
        return 0;
      case "settings":
        if (maybeTarget === "set") {
          await roomSettingsSet(
            parsed.positionals[4],
            parsed.positionals[2],
            parsed.positionals[3],
            parsed.flags,
            resolvedIo,
          );
          return 0;
        }
        await roomSettings(
          targetOrCurrent(maybeTarget, parsed.flags, resolvedIo),
          parsed.flags,
          resolvedIo,
        );
        return 0;
      case "outcome":
        await roomOutcome(
          targetOrCurrent(maybeTarget, parsed.flags, resolvedIo),
          parsed.flags,
          resolvedIo,
        );
        return 0;
      default:
        resolvedIo.stderr(`unknown room command: ${command}\n`);
        return 2;
    }
  } catch (err) {
    if (err instanceof RoomStateChangedError) {
      const canBypass = roomCommandAllowsFlag(parsed, "post-anyway");
      if (isJson(parsed.flags)) {
        resolvedIo.stdout(
          renderJson({
            error: {
              code: err.code,
              message: roomStateChangedMessage(err, canBypass).split("\n", 1)[0],
              details: {
                expected_state_revision: err.expectedRevision,
                current_state_revision: err.currentRevision,
                posted: false,
              },
            },
            suggested_command: grpCommand("read"),
            ...(canBypass ? { bypass_flag: "--post-anyway" } : {}),
          }),
        );
      } else {
        resolvedIo.stderr(`${roomStateChangedMessage(err, canBypass)}\n`);
      }
      return 1;
    }
    resolvedIo.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function roomStateChangedMessage(_error: RoomStateChangedError, canBypass: boolean): string {
  if (canBypass) {
    return [
      "The room changed since your last read.",
      "Your message was not posted.",
      "",
      `Next: ${grpCommand("read")}`,
      "",
      "If, after reading, the original message is still appropriate, add",
      "--post-anyway to your original command.",
    ].join("\n");
  }
  return [
    "The room changed since your last read.",
    "Nothing was changed.",
    "",
    `Next: ${grpCommand("read")}`,
    "Reading does not cancel your intended action.",
    "If the changed state does not affect the intended transition, rerun your original command.",
  ].join("\n");
}

/** Spec 131 — no room destination or other positional may be silently ignored. */
function assertNoIgnoredPositionals(parsed: ParsedArgs): void {
  const [command, subcommand] = parsed.positionals;
  if (!command) return;
  let max = 2;
  if (["current", "pwd", "leave", "create", "rooms", "inbox"].includes(command)) max = 1;
  else if (["ask", "propose", "discuss", "choose", "accept", "close"].includes(command)) {
    const optionIsTextInput = command === "propose" && parsed.flags.option !== undefined;
    max =
      parsed.flags.choices !== undefined ||
      parsed.flags.body !== undefined ||
      parsed.flags.choice !== undefined ||
      optionIsTextInput ||
      parsed.flags.question !== undefined ||
      parsed.flags.statement !== undefined
        ? 2
        : 3;
  } else if (command === "cancel") max = 3;
  else if (command === "start") max = 3;
  else if (command === "act" || command === "action") {
    max = subcommand === "start" ? 3 : 4;
  } else if (command === "artifact") {
    max =
      subcommand === "create"
        ? 3
        : ["review", "replace", "insert-before", "insert-after", "delete"].includes(
              subcommand ?? "",
            )
          ? 5
          : 4;
  } else if (command === "invite")
    max = subcommand === "revoke" ? 4 : subcommand === "list" ? 3 : 2;
  else if (command === "members") max = subcommand === "set-role" ? 5 : 2;
  else if (command === "settings") max = subcommand === "set" ? 5 : 2;
  if (parsed.positionals.length > max) {
    throw new Error(`too many arguments for grp ${command}; run \`grp ${command} --help\``);
  }
}

function wantsRoomHelp(parsed: ParsedArgs): boolean {
  return (
    parsed.flags.help === "true" ||
    parsed.flags.h === "true" ||
    parsed.positionals.slice(1).includes("-h")
  );
}

function resolveIo(io: Partial<RoomCliIo>): RoomCliIo {
  const stdin = io.stdin ?? process.stdin;
  const env = io.env ?? process.env;
  const stdinIsTty = Boolean((stdin as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY);
  const stdoutIsTty = Boolean(process.stdout.isTTY);
  return {
    stdout: io.stdout ?? ((text) => process.stdout.write(text)),
    stderr: io.stderr ?? ((text) => process.stderr.write(text)),
    stdin,
    isInteractive: io.isInteractive ?? (stdinIsTty && stdoutIsTty && env.GRP_NO_INPUT !== "1"),
    fetch: io.fetch ?? fetch,
    env,
    ...(io.cwd ? { cwd: io.cwd } : {}),
  };
}

// Spec 192 — a typo in a destination-looking flag must never disappear into
// the current-room fallback. Keep the accepted surface command-scoped so a
// real flag from another command is still an error here (for example,
// `grp ask --room=...` or `grp create --name=...`).
const ROOM_REFERENCE_FLAG_KEYS = ["base", "host", "provider", "token", "password"];
const ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS = [...ROOM_REFERENCE_FLAG_KEYS, "bearer", "mandate"];
const ROOM_ACTION_OUTPUT_FLAG_KEYS = ["json", "quiet"];
const SUBSTANTIAL_DISCUSSION_CHARACTERS = 10_000;

function roomFlagSet(...groups: string[][]): ReadonlySet<string> {
  return new Set(groups.flat());
}

const ROOM_COMMAND_FLAG_KEYS: Record<string, ReadonlySet<string>> = {
  enter: roomFlagSet(ROOM_REFERENCE_FLAG_KEYS, ["json"]),
  current: roomFlagSet(["json"]),
  rooms: roomFlagSet(["json"]),
  forget: roomFlagSet(ROOM_REFERENCE_FLAG_KEYS, ["json"]),
  inbox: roomFlagSet(["json"]),
  leave: roomFlagSet(["json"]),
  create: roomFlagSet(
    ["base", "host", "provider", "token", "bearer", "mandate", "password", "passcode"],
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    [
      "about",
      "ask",
      "question",
      "context",
      "option",
      "options",
      "defer-first-decision",
      "type",
      "visibility",
      "public",
      "unlisted",
      "private",
      "mechanism",
      "auth",
      "invite-authority",
      "option-proposal-authority",
      "decision-opening-authority",
      "conclusion-authority",
      "quorum",
      "threshold",
      "voting-window",
      "settle-window",
      "pace",
      "deliberation-mode",
      "max-participants",
      "max-options",
      "max-deliberation-messages-per-participant",
      "max-total-deliberation-messages",
      "max-open-decisions",
      "read-receipts",
      "choice-visibility",
      "early-close",
      "creator-votes",
    ],
  ),
  read: roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, [
    "json",
    "quiet",
    "full",
    "decision",
    "since",
  ]),
  join: roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, ROOM_ACTION_OUTPUT_FLAG_KEYS, [
    "invite",
    "as",
    "name",
    "display-name",
    "enter",
  ]),
  ask: roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, ROOM_ACTION_OUTPUT_FLAG_KEYS, [
    "ask",
    "question",
    "context",
    "option",
    "options",
    "eligible",
    "voting-window",
    "proposal-window",
    "collect-options",
    "agreement",
    "post-anyway",
  ]),
  cancel: roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, ROOM_ACTION_OUTPUT_FLAG_KEYS, [
    "reason",
  ]),
  propose: roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, ROOM_ACTION_OUTPUT_FLAG_KEYS, [
    "option",
    "file",
    "decision",
    "post-anyway",
  ]),
  discuss: roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, ROOM_ACTION_OUTPUT_FLAG_KEYS, [
    "body",
    "file",
    "stance",
    "decision",
    "composing",
    "ttl",
    "as-discussion",
    "post-anyway",
  ]),
  "action:start": roomFlagSet(
    ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS,
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    [
      "title",
      "description",
      "to",
      "mode",
      "completion",
      "required",
      "artifact",
      "artifact-name",
      "artifact-file",
      "deadline",
      "ttl",
      "idempotency-key",
    ],
  ),
  "action:read": roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, ["json"]),
  "action:take": roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, ROOM_ACTION_OUTPUT_FLAG_KEYS, [
    "ttl",
    "idempotency-key",
  ]),
  "action:handoff": roomFlagSet(
    ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS,
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    ["to", "note", "ttl", "idempotency-key"],
  ),
  "action:request-review": roomFlagSet(
    ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS,
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    ["idempotency-key"],
  ),
  "action:review": roomFlagSet(
    ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS,
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    ["approve", "request-changes", "body", "file", "idempotency-key"],
  ),
  "action:complete": roomFlagSet(
    ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS,
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    ["result-text", "idempotency-key"],
  ),
  "action:resume": roomFlagSet(
    ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS,
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    ["reason", "idempotency-key"],
  ),
  "action:fail": roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, ROOM_ACTION_OUTPUT_FLAG_KEYS, [
    "result-text",
    "idempotency-key",
  ]),
  "action:cancel": roomFlagSet(
    ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS,
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    ["idempotency-key"],
  ),
  "action:takeover": roomFlagSet(
    ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS,
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    ["reason", "override", "ttl", "idempotency-key"],
  ),
  "artifact:create": roomFlagSet(
    ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS,
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    [
      "name",
      "kind",
      "media-type",
      "action",
      "file",
      "content",
      "external-provider",
      "uri",
      "path",
      "provider-revision",
      "sha256",
      "idempotency-key",
    ],
  ),
  "artifact:read": roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, [
    "json",
    "version",
    "revision-id",
  ]),
  "artifact:wait": roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, [
    "json",
    "timeout",
    "from-revision",
  ]),
  "artifact:claim": roomFlagSet(
    ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS,
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    ["revision", "ttl", "idempotency-key"],
  ),
  "artifact:renew": roomFlagSet(
    ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS,
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    ["epoch", "ttl", "idempotency-key"],
  ),
  "artifact:release": roomFlagSet(
    ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS,
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    ["epoch", "idempotency-key"],
  ),
  "artifact:publish": roomFlagSet(
    ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS,
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    [
      "action",
      "file",
      "content",
      "rewrite",
      "external-provider",
      "uri",
      "path",
      "provider-revision",
      "sha256",
      "idempotency-key",
    ],
  ),
  "artifact:patch": roomFlagSet(
    ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS,
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    ["action", "file", "idempotency-key"],
  ),
  "artifact:replace": roomFlagSet(
    ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS,
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    ["action", "file", "content", "idempotency-key"],
  ),
  "artifact:insert-before": roomFlagSet(
    ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS,
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    ["action", "file", "content", "idempotency-key"],
  ),
  "artifact:insert-after": roomFlagSet(
    ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS,
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    ["action", "file", "content", "idempotency-key"],
  ),
  "artifact:delete": roomFlagSet(
    ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS,
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    ["action", "idempotency-key"],
  ),
  "artifact:review": roomFlagSet(
    ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS,
    ROOM_ACTION_OUTPUT_FLAG_KEYS,
    ["disposition", "body", "body-file", "historical", "review-revision", "idempotency-key"],
  ),
  start: roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, ROOM_ACTION_OUTPUT_FLAG_KEYS, [
    "decision-id",
  ]),
  choose: roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, ROOM_ACTION_OUTPUT_FLAG_KEYS, [
    "choice",
    "choices",
    "scores",
    "why",
    "reason",
    "rationale",
    "decision",
  ]),
  abstain: roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, ROOM_ACTION_OUTPUT_FLAG_KEYS, [
    "reason",
    "decision",
  ]),
  close: roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, ROOM_ACTION_OUTPUT_FLAG_KEYS, [
    "statement",
  ]),
  options: roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, ["json", "full", "decision"]),
  timeline: roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, [
    "json",
    "jsonl",
    "limit",
    "since-seq",
    "since-event-id",
  ]),
  watch: roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, [
    "jsonl",
    "timeout",
    "until",
    "action",
    "artifact",
    "decision",
    "since-event-id",
    "last-event-id",
  ]),
  "invite:create": roomFlagSet(ROOM_REFERENCE_FLAG_KEYS, [
    "json",
    "name",
    "label",
    "role",
    "expected",
    "expires-at",
    "email",
    "account",
    "principal",
    "sso-subject",
    "sso_subject",
  ]),
  "invite:list": roomFlagSet(ROOM_REFERENCE_FLAG_KEYS, ["json"]),
  "invite:revoke": roomFlagSet(ROOM_REFERENCE_FLAG_KEYS, ["json"]),
  members: roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, ["json"]),
  "members:set-role": roomFlagSet(ROOM_REFERENCE_FLAG_KEYS, ["json"]),
  settings: roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, ["json"]),
  "settings:set": roomFlagSet(ROOM_REFERENCE_FLAG_KEYS, ["json", "participant-ids"]),
  outcome: roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, ["json"]),
};

const ROOM_COMMAND_FLAG_ALIASES: Record<string, string> = {
  use: "enter",
  pwd: "current",
  history: "timeline",
  accept: "choose",
  act: "action",
};

function roomCommandFlagKey(parsed: ParsedArgs): string | undefined {
  const [rawCommand, subcommand] = parsed.positionals;
  if (!rawCommand) return undefined;
  const command = ROOM_COMMAND_FLAG_ALIASES[rawCommand] ?? rawCommand;
  return command === "invite"
    ? `invite:${subcommand === "list" || subcommand === "revoke" ? subcommand : "create"}`
    : command === "members" && subcommand === "set-role"
      ? "members:set-role"
      : command === "settings" && subcommand === "set"
        ? "settings:set"
        : command === "working" || command === "action" || command === "artifact"
          ? `${command}:${subcommand ?? ""}`
          : command;
}

function roomCommandAllowsFlag(parsed: ParsedArgs, flag: string): boolean {
  const key = roomCommandFlagKey(parsed);
  return key !== undefined && ROOM_COMMAND_FLAG_KEYS[key]?.has(flag) === true;
}

function assertOnlyRoomCommandFlags(parsed: ParsedArgs): void {
  const [rawCommand] = parsed.positionals;
  if (!rawCommand) return;
  const key = roomCommandFlagKey(parsed);
  if (!key) return;
  const allowed = ROOM_COMMAND_FLAG_KEYS[key];
  if (!allowed) return;
  const unknown = Object.keys(parsed.flags).find((flag) => !allowed.has(flag));
  if (unknown) throw new Error(`grp ${rawCommand}: unknown flag --${unknown}`);
}

async function roomUse(
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const ref = resolveRoomRef(target, flags, io.env);
  const existingConfig = readProviderConfig(io.env);
  const requestedHost =
    flags.host ??
    flags.provider ??
    io.env.GRP_HOST ??
    io.env.GRP_PROVIDER ??
    existingConfig.defaultProvider;
  const provider = !flags.base && !/^https?:\/\//i.test(target) ? requestedHost : undefined;
  const config = updateProviderConfig(
    (current) =>
      setCurrentRoom(current, {
        ...(provider ? { provider } : {}),
        ...(!provider ? { baseUrl: ref.baseUrl } : {}),
        slug: ref.slug,
        ...(ref.token ? { token: ref.token } : {}),
        ...(ref.password ? { password: ref.password } : {}),
      }),
    io.env,
  );
  const current = config.currentRoom;
  if (!current) throw new Error("failed to set current room");
  writeCurrentRoom(current, flags, io);
}

async function roomCurrent(flags: Record<string, string>, io: RoomCliIo): Promise<void> {
  const current = readProviderConfig(io.env).currentRoom;
  if (!current) throw new Error(`no current room; run \`${grpCommand("enter <room-url|slug>")}\``);
  writeCurrentRoom(current, flags, io);
}

interface RememberedRoomRow {
  current: boolean;
  slug: string;
  baseUrl: string;
  host: string;
  role: "participant" | "observer" | null;
  lastSeenSeq: number | null;
  token?: string;
  password?: string;
}

type InboxRow =
  | (RememberedRoomRow & {
      status: "choice_needed";
      question: string | null;
      votingEndsAt: string | null;
      // Spec 142 (D8) — the decision number, so a room with several owed
      // choices fans out to one row per decision and each names its selector.
      decisionSeq: number | null;
      completionActionId: string | null;
    })
  | (RememberedRoomRow & { status: "question_resolved"; question: string | null })
  | (RememberedRoomRow & {
      status: "new_activity";
      eventType: string | null;
      who: string | null;
    })
  | (RememberedRoomRow & {
      status: "action_recovery";
      actionId: string | null;
      title: string | null;
      holderId: string | null;
    })
  | (RememberedRoomRow & {
      status: "action_required";
      actionId: string | null;
      title: string | null;
      mode: string | null;
    })
  | (RememberedRoomRow & { status: "quiet" })
  | (RememberedRoomRow & { status: "unavailable"; error: string });

/**
 * Spec 139 (C1) — humane time-to-deadline for attention surfaces. The wire
 * has always carried voting_ends_at (spec 031); an agent that only wakes on
 * a schedule triages by it, so the inbox and needs-you copy must show it.
 */
function describeTimeUntil(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.round((at - nowMs) / 1000);
  if (seconds <= 0) return "closing now";
  if (seconds < 90) return `closes in ~${seconds}s`;
  if (seconds < 90 * 60) return `closes in ~${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 36 * 3600) return `closes in ~${Math.round(seconds / 3600)}h`;
  return `closes in ~${Math.round(seconds / 86400)}d`;
}

/**
 * Spec 139 (C1) — inbox rows surface most-urgent-first: choices by soonest
 * deadline, then a sealed own question, then activity, then unavailable.
 * Sort is stable, so within a band rooms keep their remembered order.
 */
function inboxUrgencyRank(row: InboxRow): number {
  if (row.status === "choice_needed") return 0;
  if (row.status === "question_resolved") return 1;
  if (row.status === "action_required") return 2;
  if (row.status === "action_recovery") return 3;
  if (row.status === "new_activity") return 4;
  if (row.status === "unavailable") return 5;
  return 6;
}

function sortInboxRows(rows: InboxRow[]): InboxRow[] {
  return [...rows].sort((a, b) => {
    const rank = inboxUrgencyRank(a) - inboxUrgencyRank(b);
    if (rank !== 0) return rank;
    if (a.status === "choice_needed" && b.status === "choice_needed") {
      const aAt = a.votingEndsAt ? Date.parse(a.votingEndsAt) : Number.POSITIVE_INFINITY;
      const bAt = b.votingEndsAt ? Date.parse(b.votingEndsAt) : Number.POSITIVE_INFINITY;
      if (aAt !== bAt) return aAt - bAt;
    }
    return 0;
  });
}

/** Spec 131 — the local, credential-free index of rooms known to this session. */
async function roomRooms(flags: Record<string, string>, io: RoomCliIo): Promise<void> {
  const rows = rememberedRoomRows(io.env);
  if (isJson(flags)) {
    io.stdout(
      renderJson({
        current_room: rows.find((row) => row.current)?.slug ?? null,
        rooms: rows.map(publicRememberedRoomRow),
      }),
    );
    return;
  }
  if (rows.length === 0) {
    io.stdout(`No remembered rooms. Join one with: ${grpCommand("join <room>")}\n`);
    return;
  }
  const lines = ["CURRENT  ROOM            HOST                        ROLE"];
  lines.push(
    ...rows.map((row) => {
      const marker = row.current ? "CURRENT" : "       ";
      return `${marker}  ${row.slug.padEnd(14)}  ${row.host.padEnd(26)}  ${row.role ?? "—"}`;
    }),
  );
  lines.push(
    "",
    `Local memory only. Run \`${grpCommand("inbox")}\` to check live room status; use \`${grpCommand("forget ROOM")}\` to remove a stale entry.`,
  );
  io.stdout(`${lines.join("\n")}\n`);
}

/** Remove one remembered room locally. This never contacts or deletes the hosted room. */
async function roomForget(
  slug: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const config = readProviderConfig(io.env);
  const explicitBase =
    flags.base ??
    (flags.host || flags.provider
      ? resolveProviderBaseUrl(flags.host ?? flags.provider, io.env)
      : undefined);
  const matches = listRememberedRooms(config).filter((room) => {
    if (room.slug !== slug) return false;
    if (!explicitBase) return true;
    const candidateBase = roomContextBaseUrl(room, io.env);
    return (
      !!candidateBase &&
      normalizeUrlForCompare(candidateBase) === normalizeUrlForCompare(explicitBase)
    );
  });
  if (matches.length === 0) throw new Error(`room is not remembered locally: ${slug}`);
  if (matches.length > 1) {
    throw new Error(
      `more than one remembered host has room ${slug}; select one with --host=NAME or --base=URL`,
    );
  }
  const baseUrl = roomContextBaseUrl(matches[0], io.env);
  if (!baseUrl) throw new Error(`cannot resolve the remembered host for room ${slug}`);
  updateProviderConfig((current) => forgetRoom(current, slug, baseUrl), io.env);
  if (isJson(flags)) {
    io.stdout(renderJson({ forgotten: true, slug, base_url: baseUrl, hosted_room_deleted: false }));
    return;
  }
  io.stdout(
    `Forgot ${slug} on ${roomHostLabel(baseUrl)} locally. The hosted room was not changed.\n`,
  );
}

/**
 * Spec 131 — a bounded, explicit cross-room scan. It uses the existing
 * zero-wait activity long-poll and deliberately does not persist a cursor.
 */
async function roomInbox(flags: Record<string, string>, io: RoomCliIo): Promise<void> {
  const rooms = rememberedRoomRows(io.env);
  if (rooms.length === 0) {
    if (isJson(flags)) {
      io.stdout(renderJson({ rooms: [] }));
    } else {
      io.stdout(`No remembered rooms. Join one with: ${grpCommand("join <room>")}\n`);
    }
    return;
  }
  const rows = sortInboxRows(
    (await Promise.all(rooms.map((room) => checkRoomAttention(room, io)))).flat(),
  );
  if (isJson(flags)) {
    io.stdout(
      renderJson({
        rooms: rows.map((row) => {
          const base = publicRememberedRoomRow(row);
          if (row.status === "choice_needed") {
            return {
              ...base,
              status: row.status,
              question: row.question,
              voting_ends_at: row.votingEndsAt,
              ...(row.completionActionId ? { completion_action_id: row.completionActionId } : {}),
              ...(row.decisionSeq !== null ? { decision_seq: row.decisionSeq } : {}),
            };
          }
          if (row.status === "question_resolved") {
            return { ...base, status: row.status, question: row.question };
          }
          if (row.status === "new_activity") {
            return {
              ...base,
              status: row.status,
              event_type: row.eventType,
              who: row.who,
            };
          }
          if (row.status === "action_recovery") {
            return {
              ...base,
              status: row.status,
              action_id: row.actionId,
              title: row.title,
              holder_id: row.holderId,
            };
          }
          if (row.status === "action_required") {
            return {
              ...base,
              status: row.status,
              action_id: row.actionId,
              title: row.title,
              mode: row.mode,
            };
          }
          if (row.status === "unavailable") {
            return { ...base, status: row.status, error: row.error };
          }
          return { ...base, status: row.status };
        }),
      }),
    );
    return;
  }

  const visible = rows.filter((row) => row.status !== "quiet");
  if (visible.length === 0) {
    const lines = [`No remembered rooms need attention (${rows.length} checked).`];
    if (rows.some((row) => row.current)) {
      lines.push(`Stay present now: ${grpCommand("watch")}`);
    }
    lines.push(
      `Or return later using your agent runtime's scheduling tools, then run ${grpCommand("inbox")}.`,
    );
    io.stdout(`${lines.join("\n")}\n`);
    return;
  }
  const nowMs = Date.now();
  // Spec 142 (D8) — when one room contributes several choice rows, each names
  // its decision number so the follow-up choose can target it.
  const choiceRowsPerRoom = new Map<string, number>();
  for (const row of visible) {
    if (row.status === "choice_needed") {
      const key = `${row.baseUrl}|${row.slug}`;
      choiceRowsPerRoom.set(key, (choiceRowsPerRoom.get(key) ?? 0) + 1);
    }
  }
  const lines: string[] = [];
  for (const row of visible) {
    if (row.status === "choice_needed") {
      const deadline = describeTimeUntil(row.votingEndsAt, nowMs);
      const multi = (choiceRowsPerRoom.get(`${row.baseUrl}|${row.slug}`) ?? 0) > 1;
      const seqTag = multi && row.decisionSeq !== null ? ` (decision ${row.decisionSeq})` : "";
      const label = row.completionActionId ? "ACTION COMPLETION NEEDED" : "CHOICE NEEDED";
      const actionTag = row.completionActionId ? ` — action ${row.completionActionId}` : "";
      lines.push(
        `${label}  ${row.slug}  ${row.question ? `"${clipInboxText(row.question)}"` : "open question"}${deadline ? ` — ${deadline}` : ""}${seqTag}${actionTag}`,
      );
    } else if (row.status === "question_resolved") {
      lines.push(
        `RESOLVED       ${row.slug}  ${row.question ? `"${clipInboxText(row.question)}"` : "your question"} — your question sealed`,
      );
    } else if (row.status === "new_activity") {
      const actor = row.who ? `${row.who}: ` : "";
      lines.push(
        `NEW ACTIVITY   ${row.slug}  ${actor}${displayEventType(row.eventType ?? "room activity")}`,
      );
    } else if (row.status === "action_recovery") {
      lines.push(
        `ACTION READY   ${row.slug}  ${row.title ? `"${clipInboxText(row.title)}"` : (row.actionId ?? "action")} — holder lease expired; take over only if assuming responsibility`,
      );
    } else if (row.status === "action_required") {
      lines.push(
        `ACTION NEEDED  ${row.slug}  ${row.title ? `"${clipInboxText(row.title)}"` : (row.actionId ?? "action")} — ${row.mode?.replaceAll("_", "-") ?? "action"} requires your report`,
      );
    } else {
      lines.push(`UNAVAILABLE    ${row.slug}  ${clipInboxText(row.error)}`);
    }
  }
  const first = visible.find((row) => row.status !== "unavailable");
  if (first) {
    const target = first.current ? "" : ` ${first.baseUrl}/r/${encodeURIComponent(first.slug)}`;
    lines.push("", "Open one:", `  ${grpCommand(`read${target}`)}`);
  }
  io.stdout(`${lines.join("\n")}\n`);
}

function rememberedRoomRows(env: Record<string, string | undefined>): RememberedRoomRow[] {
  const config = readProviderConfig(env);
  const current = config.currentRoom;
  return listRememberedRooms(config)
    .map((room): RememberedRoomRow | null => {
      const baseUrl = roomContextBaseUrl(room, env);
      if (!baseUrl) return null;
      const normalizedBase = normalizeUrlForCompare(baseUrl);
      const currentBase = roomContextBaseUrl(current, env);
      return {
        current:
          current?.slug === room.slug &&
          !!currentBase &&
          normalizeUrlForCompare(currentBase) === normalizedBase,
        slug: room.slug,
        baseUrl: normalizedBase,
        host: roomHostLabel(normalizedBase),
        role: room.role ?? null,
        lastSeenSeq: room.lastSeenSeq ?? null,
        ...(room.token ? { token: room.token } : {}),
        ...(room.password ? { password: room.password } : {}),
      };
    })
    .filter((row): row is RememberedRoomRow => row !== null)
    .sort((a, b) => Number(b.current) - Number(a.current) || a.slug.localeCompare(b.slug));
}

async function checkRoomAttention(room: RememberedRoomRow, io: RoomCliIo): Promise<InboxRow[]> {
  const ref: RoomRef = {
    baseUrl: room.baseUrl,
    slug: room.slug,
    ...(room.token ? { token: room.token } : {}),
    ...(room.password ? { password: room.password } : {}),
  };
  try {
    const options = readRequestOptions(ref, {}, io.env);
    options.query = {
      ...(options.query ?? {}),
      for: "activity",
      since_seq: room.lastSeenSeq ?? 0,
      wait: 0,
    };
    const response = await requestJson<Record<string, unknown>>(
      room.baseUrl,
      `/api/rooms/${encodeURIComponent(room.slug)}/next-action`,
      io,
      options,
    );
    if (response.status === "actionable") {
      const decision = isRecord(response.decision) ? response.decision : {};
      // Spec 139 — an actionable RESOLVED decision is the opener-seal wake
      // (spec 125): the caller's own question sealed. That is "read the
      // outcome", not "choose", and the row must not claim otherwise.
      if (stringOrNull(decision.status) === "resolved") {
        return [
          { ...room, status: "question_resolved", question: stringOrNull(decision.question) },
        ];
      }
      const rows: InboxRow[] = [
        {
          ...room,
          status: "choice_needed",
          question: stringOrNull(decision.question),
          votingEndsAt: stringOrNull(decision.voting_ends_at),
          decisionSeq: typeof decision.seq === "number" ? decision.seq : null,
          completionActionId: stringOrNull(decision.completion_action_id),
        },
      ];
      // Spec 142 (D8) — a multi-open room may owe the caller several choices
      // at once; each rides as its own row so the deadline sort ranks
      // DECISIONS across rooms, not rooms.
      if (Array.isArray(response.also_actionable)) {
        for (const extra of response.also_actionable) {
          if (!isRecord(extra)) continue;
          if (stringOrNull(extra.status) === "resolved") continue;
          rows.push({
            ...room,
            status: "choice_needed",
            question: stringOrNull(extra.question),
            votingEndsAt: stringOrNull(extra.voting_ends_at),
            decisionSeq: typeof extra.seq === "number" ? extra.seq : null,
            completionActionId: stringOrNull(extra.completion_action_id),
          });
        }
      }
      return rows;
    }
    if (response.status === "activity") {
      const event = isRecord(response.event) ? response.event : {};
      return [
        {
          ...room,
          status: "new_activity",
          eventType: stringOrNull(event.type),
          who: stringOrNull(event.who),
        },
      ];
    }
    if (response.status === "action_recovery") {
      const action = isRecord(response.action) ? response.action : {};
      return [
        {
          ...room,
          status: "action_recovery",
          actionId: stringOrNull(action.id),
          title: stringOrNull(action.title),
          holderId: stringOrNull(action.holder_id) ?? stringOrNull(action.assignee_id),
        },
      ];
    }
    if (response.status === "action_required") {
      const action = isRecord(response.action) ? response.action : {};
      return [
        {
          ...room,
          status: "action_required",
          actionId: stringOrNull(action.id),
          title: stringOrNull(action.title),
          mode: actionModeFromWire(action.mode),
        },
      ];
    }
    return [{ ...room, status: "quiet" }];
  } catch (err) {
    return [
      {
        ...room,
        status: "unavailable",
        error: err instanceof Error ? err.message : String(err),
      },
    ];
  }
}

function publicRememberedRoomRow(room: RememberedRoomRow): Record<string, unknown> {
  return {
    current: room.current,
    slug: room.slug,
    host: room.host,
    role: room.role,
    last_seen_seq: room.lastSeenSeq,
  };
}

function roomHostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function clipInboxText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact;
}

async function roomLeave(flags: Record<string, string>, io: RoomCliIo): Promise<void> {
  updateProviderConfig((current) => clearCurrentRoom(current), io.env);
  if (isJson(flags)) {
    io.stdout(renderJson({ current_room: null }));
    return;
  }
  io.stdout("left current room\n");
}

async function roomCreate(
  flags: Record<string, string>,
  io: RoomCliIo,
  repeatedOptions?: string[],
): Promise<void> {
  const config = readProviderConfig(io.env);
  const requestedProvider =
    flags.host ??
    flags.provider ??
    io.env.GRP_HOST ??
    io.env.GRP_PROVIDER ??
    config.defaultProvider;
  const baseUrl = (
    flags.base ??
    explicitProviderBaseUrl(flags, io.env) ??
    io.env.GRP_BASE_URL ??
    defaultProviderBaseUrl(flags, io.env) ??
    missingDefaultHost()
  ).replace(/\/$/, "");
  const question = flags.ask ?? flags.question;
  const about = await resolveCreateAbout(flags, question, io);
  const deferFirstDecision =
    flags["defer-first-decision"] !== undefined
      ? parseOptionalBool(flags["defer-first-decision"])
      : undefined;
  const access = resolveCliCreateAccess(flags);
  const options = seedOptions(flags, repeatedOptions);
  if (!question && options.length > 0) {
    throw new Error("--option/--options requires --ask");
  }
  // Spec 109 (WR2-2) — the creator's participant row takes the saved profile
  // display name; without one, the server keeps its default. Old servers
  // ignore the extra field.
  const creatorDisplayName = readProviderConfig(io.env).profile?.displayName;
  const body = withoutUndefined({
    about,
    question,
    context: question ? flags.context : undefined,
    options: question || flags.options !== undefined ? options : undefined,
    password: access.password,
    defer_first_decision: deferFirstDecision,
    display_name: creatorDisplayName,
    config: buildConfig({
      ...flags,
      ...(access.visibility ? { visibility: access.visibility } : {}),
    }),
  });
  const createOptions: RequestOptions = {
    method: "POST",
    body,
  };
  const auth = authFromFlags(flags, { baseUrl, slug: "" }, io.env);
  if (auth?.kind === "hosted" || auth?.kind === "mandate") createOptions.auth = auth;
  const response = await requestJson<unknown>(baseUrl, "/api/rooms", io, createOptions);
  rememberCreatedRoom(response, {
    baseUrl,
    ...(!flags.base && requestedProvider ? { provider: requestedProvider } : {}),
    ...(access.password ? { password: access.password } : {}),
    env: io.env,
  });
  if (isJson(flags) || flags.quiet === "true") {
    const structured = isRecord(response)
      ? {
          ...response,
          ...(!stringOrNull(response.url) && stringOrNull(response.slug)
            ? { url: `${baseUrl}/r/${encodeURIComponent(stringOrNull(response.slug) as string)}` }
            : {}),
          ...(access.passwordGenerated ? { room_password: access.password } : {}),
        }
      : response;
    writeStructured(structured, flags, io, "slug");
    return;
  }
  io.stdout(
    renderRoomCreated(
      response,
      baseUrl,
      access,
      about ?? null,
      creatorDisplayName ?? null,
      question ?? null,
      options.length,
    ),
  );
}

async function resolveCreateAbout(
  flags: Record<string, string>,
  question: string | undefined,
  io: RoomCliIo,
): Promise<string | undefined> {
  const explicit = flags.about?.trim();
  if (explicit) return explicit;
  if (question || !io.isInteractive || isJson(flags) || flags.quiet === "true") return undefined;

  io.stdout(
    [
      "Create a GRP room",
      "",
      "What is this room for?",
      'Example: "Planning Friday dinner" or "Triage customer bugs"',
      "",
      "Room purpose: ",
    ].join("\n"),
  );
  const answer = (await readLine(io.stdin)).trim();
  return answer || "New GRP room";
}

async function readLine(input: NodeJS.ReadableStream): Promise<string> {
  const iterator = input[Symbol.asyncIterator]();
  let out = "";
  while (true) {
    const next = await iterator.next();
    if (next.done) return out;
    const chunk =
      typeof next.value === "string" ? next.value : Buffer.from(next.value).toString("utf8");
    const newline = chunk.search(/\r?\n/);
    if (newline !== -1) return `${out}${chunk.slice(0, newline)}`;
    out += chunk;
  }
}

async function readAll(input: NodeJS.ReadableStream): Promise<string> {
  let out = "";
  for await (const value of input) {
    out += typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  }
  return out;
}

function rememberCreatedRoom(
  response: unknown,
  options: {
    baseUrl: string;
    provider?: string;
    password?: string;
    env: Record<string, string | undefined>;
  },
): void {
  if (!isRecord(response)) return;
  const slug = stringOrNull(response.slug);
  if (!slug) return;
  const token = stringOrNull(response.creator_token) ?? stringOrNull(response.creatorToken);
  // Spec 116 (WR8-1) — the creator persists its participant id exactly like
  // a joiner: without it, the creator's own name-less discussion events woke
  // its own watch (run 8's Iridium self-wake loop).
  const participantId =
    stringOrNull(response.participant_id) ?? stringOrNull(response.participantId);
  updateProviderConfig(
    (current) =>
      setCurrentRoom(current, {
        ...(options.provider ? { provider: options.provider } : { baseUrl: options.baseUrl }),
        slug,
        ...(token ? { token } : {}),
        ...(options.password ? { password: options.password } : {}),
        ...(participantId ? { participantId } : {}),
      }),
    options.env,
  );
}

function renderRoomCreated(
  response: unknown,
  baseUrl: string,
  access: CliCreateAccess,
  requestedAbout: string | null,
  creatorName: string | null = null,
  requestedQuestion: string | null = null,
  requestedOptionCount = 0,
): string {
  const room = isRecord(response) ? response : {};
  const slug = stringOrNull(room.slug) ?? "unknown";
  const url = stringOrNull(room.url) ?? `${baseUrl}/r/${encodeURIComponent(slug)}`;
  const about = stringOrNull(room.about) ?? requestedAbout;
  const responseConfig = isRecord(room.config) ? room.config : {};
  const visibility = stringOrNull(responseConfig.visibility) ?? access.visibility;
  const auth = stringOrNull(responseConfig.auth) ?? "either";
  const roomAccess =
    visibility === "public"
      ? "Public — anyone can read or join"
      : visibility === "private"
        ? access.password !== undefined
          ? "Private — valid invite or room password required"
          : "Private — valid invite required"
        : "Unlisted — anyone with the link can join, then read and participate";
  const lines = [
    "Room created",
    "",
    `Room: ${slug}`,
    `URL: ${url}`,
    `Room access: ${roomAccess}`,
    ...(access.passwordGenerated && access.password
      ? [
          `Room password: ${access.password}`,
          "Saved in your owner-only GRP config. Share it separately and keep it out of URLs, recordings, screenshots, transcripts, and logs.",
        ]
      : []),
    ...(auth === "mandate_required" ? ["Identity: Signed mandate required to join and act"] : []),
    ...(about ? [`About: ${about}`] : []),
    ...(requestedQuestion
      ? [
          `Question opened: "${requestedQuestion}" (${requestedOptionCount} option${requestedOptionCount === 1 ? "" : "s"})`,
        ]
      : []),
    // Spec 109 (WR2-2) — name the identity the room roster will show.
    ...(creatorName ? [`You: ${creatorName} (creator)`] : []),
    "Current room: set",
    "",
    "Room commands:",
    `  ${grpCommand("invite --name NAME")}`,
    `  ${grpCommand("read")}`,
  ];
  return `${lines.join("\n")}\n`;
}

async function roomRead(
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const ref = resolveRoomRef(target, flags, io.env);
  // Spec 142 (D9) — the FOCUSED read: one decision's thread (question,
  // options, status/outcome, attached discussion). NON-CONSUMING by ruling
  // P-6: it never advances the room's read mark — a focused read of one
  // thread must not eat the other threads' wakes. Only the full room read
  // moves the cursor.
  const focusedSeq = parseDecisionFlag(flags.decision);
  if (focusedSeq !== undefined) {
    const focusedOptions = readRequestOptions(ref, flags, io.env);
    focusedOptions.query = { ...(focusedOptions.query ?? {}), include: "full" };
    const full = await requestJson<Record<string, unknown>>(
      ref.baseUrl,
      `/api/rooms/${encodeURIComponent(ref.slug)}`,
      io,
      focusedOptions,
    );
    const rendered = renderFocusedDecision(full, focusedSeq, ref, flags, io);
    io.stdout(
      isJson(flags) || flags.quiet === "true" ? rendered : withPersonaReadHeader(rendered, io.env),
    );
    return;
  }
  // Spec 113 — delta by default: with a stored high-water mark (or an
  // explicit --since) the read asks the host for everything after that seq.
  // --full always takes the snapshot.
  const since = resolveReadSince(flags, ref, io.env);
  const options = readRequestOptions(ref, flags, io.env);
  if (since !== undefined) options.query = { ...(options.query ?? {}), since };
  const response = await requestJson<Record<string, unknown>>(
    ref.baseUrl,
    `/api/rooms/${encodeURIComponent(ref.slug)}`,
    io,
    options,
  );
  // Feature detection: a delta-capable host answers a `since` read with the
  // anchored delta (its `new` array); old hosts ignore the unknown query
  // param and return the snapshot agent view.
  if (since !== undefined && Array.isArray(response.new)) {
    if (isJson(flags)) {
      const currentThrough = numberOrNull(response.current_through);
      if (currentThrough !== null) persistLastSeenSeq(ref, currentThrough, io.env);
      // JSON exports the complete anchored delta; unlike the paged human
      // rendering, it does not hide a suffix from the caller.
      persistObservedStateRevisionFromRead(ref, response, io.env);
      io.stdout(renderJson(response));
      return;
    }
    // Spec 193 — a human delta is acknowledged page by page. Long room
    // deltas drove agents to `head`/`tail`; the downstream filter hid a
    // suffix after the CLI had already persisted the host's high-water mark.
    // Keep messages whole, bound the ordinary page, and persist only through
    // the final entry that this page actually includes. JSON remains the
    // explicit complete structured export.
    const page = humanDeltaPage(response, ref, io.env);
    const currentThrough = numberOrNull(page.response.current_through);
    if (currentThrough !== null) persistLastSeenSeq(ref, currentThrough, io.env);
    if (!page.moreUnread) {
      persistObservedStateRevisionFromRead(ref, response, io.env);
    } else {
      persistCoordinationCapabilityFromRead(ref, response, io.env);
    }
    io.stdout(
      withPersonaReadHeader(
        renderRoomDelta(page.response, ref, io.env, { moreUnread: page.moreUnread }),
        io.env,
      ),
    );
    return;
  }
  // Spec 119 (WR11-1) — fresh working-set snapshots still advance the mark. The old
  // rule ("--full never touches the mark") left it parked at a pointer wake's
  // seq-1 and made the next watch re-fire. Spec 193 changes only paged human
  // deltas; working-set snapshots and old-host fallbacks keep this contract.
  const currentThrough = numberOrNull(response.current_through);
  if (currentThrough !== null) persistLastSeenSeq(ref, currentThrough, io.env);
  persistObservedStateRevisionFromRead(ref, response, io.env);
  if (isJson(flags)) {
    io.stdout(renderJson(response));
    return;
  }
  const deltaUnsupportedNote =
    since !== undefined ? renderDimNote("(this host does not support delta reads)", io) : "";
  if (typeof response.brief === "string" || response.decision !== undefined) {
    io.stdout(
      withPersonaReadHeader(renderRoomRead(response, ref, io.env), io.env) + deltaUnsupportedNote,
    );
    return;
  }
  const decisions = Array.isArray(response.decisions) ? response.decisions.length : 0;
  io.stdout(
    withPersonaReadHeader(
      [
        `room ${String(response.slug ?? ref.slug)}`,
        `status=${String(response.status ?? "unknown")}`,
        `participants=${String(response.participant_count ?? "unknown")}`,
        `decisions=${decisions}`,
        response.active_decision_id
          ? `active_decision=${String(response.active_decision_id)}`
          : null,
      ]
        .filter(Boolean)
        .join(" "),
      io.env,
    ),
  );
  io.stdout("\n");
  if (deltaUnsupportedNote) io.stdout(deltaUnsupportedNote);
}

function withPersonaReadHeader(rendered: string, env: Record<string, string | undefined>): string {
  const persona = resolvePersonaContext(env);
  return persona ? `${renderPersonaIdentity(persona)}\n\n${rendered}` : rendered;
}

/**
 * Spec 113 — which event seq this read should start from. Undefined = full
 * snapshot. Explicit `--since=N` wins; `--since=last` requires a stored mark;
 * a bare read uses the stored mark when one exists. `--full` bypasses the
 * mark for the REQUEST (always the snapshot) but — spec 119 (WR11-1) — the
 * rendered picture advances it. Deviation from the spec sketch: `--last=N`
 * is not implemented — the wire supports `since` only.
 */
function resolveReadSince(
  flags: Record<string, string>,
  ref: RoomRef,
  env: Record<string, string | undefined>,
): number | undefined {
  if (flags.full === "true") return undefined;
  const stored = rememberedLastSeenSeq(ref, env);
  const raw = flags.since;
  if (raw !== undefined) {
    if (raw === "last" || raw === "true") {
      if (stored === undefined) {
        throw new Error(
          `no stored position for this room — run \`${grpCommand("watch")}\` once, or \`${grpCommand("read --full")}\``,
        );
      }
      return stored;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error("--since must be a non-negative event seq, or `last`");
    }
    return n;
  }
  return stored;
}

/** The stored spec-113 high-water mark for this room, when one exists. */
function rememberedLastSeenSeq(
  ref: RoomRef,
  env: Record<string, string | undefined>,
): number | undefined {
  return findRememberedRoom(readProviderConfig(env), ref.slug, ref.baseUrl)?.lastSeenSeq;
}

/** Persist the spec-113 high-water mark for this room. */
function persistLastSeenSeq(
  ref: RoomRef,
  seq: number,
  env: Record<string, string | undefined>,
): void {
  if (!Number.isInteger(seq) || seq < 0) return;
  updateProviderConfig((current) => setRoomLastSeenSeq(current, ref.slug, ref.baseUrl, seq), env);
}

/** A room-wide canonical read is the only read surface that may advance this. */
function persistObservedStateRevisionFromRead(
  ref: RoomRef,
  response: Record<string, unknown>,
  env: Record<string, string | undefined>,
): void {
  const revision = stringOrNull(response.state_revision);
  persistCoordinationCapability(ref, revision ? "experimental" : "absent", env);
  if (!revision) return;
  persistObservedStateRevision(ref, revision, env);
}

/** A partial human page may discover capability support but cannot adopt the
 * revision attached to content it deliberately has not shown yet. */
function persistCoordinationCapabilityFromRead(
  ref: RoomRef,
  response: Record<string, unknown>,
  env: Record<string, string | undefined>,
): void {
  if (stringOrNull(response.state_revision)) {
    persistCoordinationCapability(ref, "experimental", env);
  }
}

function rememberedObservedStateRevision(
  ref: RoomRef,
  env: Record<string, string | undefined>,
): string | undefined {
  return findRememberedRoom(readProviderConfig(env), ref.slug, ref.baseUrl)?.observedStateRevision;
}

function persistCoordinationCapability(
  ref: RoomRef,
  capability: "experimental" | "absent",
  env: Record<string, string | undefined>,
): void {
  // Discovery should refine a room the user already remembers; it must not
  // create local room state merely because an explicit one-off URL was read.
  if (!findRememberedRoom(readProviderConfig(env), ref.slug, ref.baseUrl)) return;
  updateProviderConfig(
    (current) => setRoomCoordinationStateCapability(current, ref.slug, ref.baseUrl, capability),
    env,
  );
}

async function guardedExpectedRoomRevision(
  ref: RoomRef,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<string | undefined> {
  if (flags["post-anyway"] === "true") return undefined;
  const discovery = await requestJson<Record<string, unknown>>(
    ref.baseUrl,
    "/.well-known/grp.json",
    io,
    {},
  );
  const metadata = isRecord(discovery.metadata) ? discovery.metadata : {};
  const candidate = isRecord(metadata.experimental_coordination_state)
    ? metadata.experimental_coordination_state
    : null;
  const capability = candidate?.status === "experimental" ? "experimental" : "absent";
  persistCoordinationCapability(ref, capability, io.env);
  if (capability === "absent") return undefined;
  const revision = rememberedObservedStateRevision(ref, io.env);
  if (!revision) {
    throw new Error(
      `This host requires a fresh room read before guarded writes. Run: ${grpCommand("read")}`,
    );
  }
  return revision;
}

function persistObservedStateRevision(
  ref: RoomRef,
  revision: string,
  env: Record<string, string | undefined>,
): void {
  updateProviderConfig(
    (current) => setRoomObservedStateRevision(current, ref.slug, ref.baseUrl, revision),
    env,
  );
}

/**
 * Spec 142 (D9) — render one decision's thread from a full room read:
 * question, options, live status or sealed outcome, and the discussion
 * attached to this decision. The caller guarantees the read mark was NOT
 * advanced (ruling P-6): a focused read of one thread must never eat the
 * other threads' wakes.
 */
function renderFocusedDecision(
  full: Record<string, unknown>,
  seq: number,
  _ref: RoomRef,
  flags: Record<string, string>,
  _io: RoomCliIo,
): string {
  const decision = requireDecisionBySeq(full, seq);
  const decisionId = stringOrNull(decision.id);
  const participants = Array.isArray(full.participants) ? full.participants.filter(isRecord) : [];
  const nameById = new Map(
    participants.map((p) => [stringOrNull(p.id) ?? "", stringOrNull(p.display_name) ?? "unknown"]),
  );
  const discussion = (
    Array.isArray(full.discussion) ? full.discussion.filter(isRecord) : []
  ).filter((m) => decisionId !== null && stringOrNull(m.decision_id) === decisionId);

  if (isJson(flags) || flags.quiet === "true") {
    return renderJson({
      decision,
      discussion: discussion.map((m) => ({
        who: nameById.get(stringOrNull(m.participant_id) ?? "") ?? "unknown",
        body: m.body,
        ...(m.stance ? { stance: m.stance } : {}),
        posted_at: m.posted_at,
      })),
    });
  }

  const status = stringOrNull(decision.status) ?? "unknown";
  const question = stringOrNull(decision.question) ?? "";
  const lines: string[] = [`Decision ${seq}: "${question}"`, `Status: ${status}`];
  const options = Array.isArray(decision.options) ? decision.options : [];
  if (options.length > 0) {
    lines.push("", "Options:");
    options.forEach((opt, i) => {
      const text = typeof opt === "string" ? opt : String(opt);
      lines.push(`  ${i + 1}. ${text.length > 2000 ? `${text.slice(0, 2000)}…` : text}`);
    });
  }
  if (status === "resolved") {
    const winner = stringOrNull(decision.resolved_winner);
    const outcome = stringOrNull(decision.resolved_outcome) ?? "unknown";
    lines.push("", winner ? `Outcome: ${outcome} — "${winner}"` : `Outcome: ${outcome}`);
    const receipt = stringOrNull(decision.receipt_hash);
    if (receipt) lines.push(`Receipt: ${receipt}`);
  } else {
    const deadline = describeTimeUntil(stringOrNull(decision.voting_ends_at), Date.now());
    if (deadline) lines.push(`Window: ${deadline}`);
  }
  if (discussion.length > 0) {
    lines.push("", `Discussion on this decision (${discussion.length}):`);
    for (const m of discussion) {
      const who = nameById.get(stringOrNull(m.participant_id) ?? "") ?? "unknown";
      const body = stringOrNull(m.body) ?? "";
      const stance = stringOrNull(m.stance);
      lines.push(`  ${who}${stance ? ` (${stance})` : ""}: ${body}`);
    }
  }
  if (status !== "resolved") {
    lines.push("", `Act on it: ${grpCommand(`choose <option> --decision=${seq}`)}`);
  }
  lines.push("", "(focused read — your room position did not move)");
  return `${lines.join("\n")}\n`;
}

/** Resolve the public room-local decision selector from a full room read. */
function requireDecisionBySeq(full: Record<string, unknown>, seq: number): Record<string, unknown> {
  const decisions = Array.isArray(full.decisions) ? full.decisions.filter(isRecord) : [];
  const decision = decisions.find((d) => numberOrNull(d.seq) === seq);
  if (decision) return decision;
  const open = decisions.filter((d) => stringOrNull(d.status) !== "resolved");
  const list = open
    .map((d) => `seq ${numberOrNull(d.seq)}: "${clipInboxText(stringOrNull(d.question) ?? "")}"`)
    .join("; ");
  throw new Error(
    list
      ? `no decision numbered ${seq} in this room — open decisions: ${list}`
      : `no decision numbered ${seq} in this room — the room has no open decision`,
  );
}

function renderDimNote(note: string, io: RoomCliIo): string {
  return io.isInteractive ? `\u001b[2m${note}\u001b[0m\n` : `${note}\n`;
}

/** Server-advertised actions are the source of truth for authority-sensitive hints. */
function hasRoomAction(response: Record<string, unknown>, action: string): boolean {
  return isRecord(response.more) && typeof response.more[action] === "string";
}

function appendDiscussGuidance(lines: string[], suffix: string): void {
  const shortCommand = grpCommand(`discuss "..."${suffix}`);
  const fileCommand = grpCommand(`discuss --file=PATH${suffix}`);
  const commandWidth = Math.max(shortCommand.length, fileCommand.length) + 2;
  lines.push(
    `  ${shortCommand.padEnd(commandWidth)}short, shell-safe context`,
    `  ${fileCommand.padEnd(commandWidth)}shell-sensitive discussion from a file`,
  );
}

function appendIdleGuidance(
  lines: string[],
  response: Record<string, unknown>,
  room: string,
  callerId?: string,
): void {
  lines.push("  Discuss — exchange context; creates no formal outcome.");
  if (coordinationAvailable(response)) {
    lines.push(
      "  Act — track work inside or outside GRP and what counts as complete:",
      `    ${grpCommand(`act start --title="Describe the work"${room}`)}`,
      `    Attach an artifact for exact shared work. Modes and artifacts: ${grpCommand("act --help")}`,
    );
  }
  if (hasRoomAction(response, "ask")) {
    lines.push("  Ask — record a group choice.");
  }
  // A live shared turn carries its own action-scoped watch above. Otherwise
  // keep the ordinary room doorbell as an equally weighted idle choice.
  const recommended = activePeerWatchRecommendations(response, callerId);
  if (recommended.length === 0) {
    lines.push("  Watch — wait for relevant room activity.");
  }
}

/** Spec 231 — candidate reads advertise actions structurally, even when the
 * current action list is empty. Older hosts omit all three fields. */
function coordinationAvailable(response: Record<string, unknown>): boolean {
  return (
    typeof response.state_revision === "string" ||
    Array.isArray(response.actions) ||
    Array.isArray(response.artifacts)
  );
}

/**
 * Spec 113 item 1 — the anchored delta read: a constant-size anchor (room,
 * project, brief, own standing), everything that happened since the caller's
 * mark rendered oldest-first with FULL text, then the Next block for the
 * caller's own standing.
 */
function renderRoomDelta(
  response: Record<string, unknown>,
  ref: RoomRef,
  env: Record<string, string | undefined>,
  options: { moreUnread?: boolean } = {},
): string {
  const slug = String(response.slug ?? ref.slug);
  // Spec 117 (the delta diet) — one thin header, the new events, Next.
  // No premise, no restated question, no roster: an agent in its own thread
  // was never disoriented; the full picture is one reach away (--full).
  // Old hosts still send `brief`; fall back to it.
  const state = stringOrNull(response.state) ?? stringOrNull(response.brief);
  const lines = [state ? `${slug} — ${state}` : `Room ${slug}`];
  const yourStatus = stringOrNull(response.your_status);
  if (yourStatus) lines.push(`You: ${yourStatus}`);

  const entries = Array.isArray(response.new) ? response.new.filter(isRecord) : [];
  const currentThrough = numberOrNull(response.current_through);
  const room = roomHintArg(slug, ref, env);
  if (entries.length === 0) {
    lines.push(
      "",
      `Nothing new since seq ${currentThrough ?? "?"}. Fresh working-set snapshot: ${grpCommand(`read --full${room}`)}`,
    );
  } else {
    lines.push("", "New since your last read:");
    for (const entry of entries) lines.push(...renderDeltaEntry(entry, room));
  }

  const isObserver = callerRole(response, ref, env) === "observer";
  appendCoordinationState(lines, response, ref, env);

  lines.push("", "Next:");
  if (options.moreUnread) {
    lines.push(`  More unread activity remains: ${grpCommand(`read${room}`)}`);
    lines.push("", `Current through seq ${currentThrough ?? "?"}.`);
    return `${lines.join("\n")}\n`;
  }
  const decision = activeDecision(response);
  const completion =
    decision && isRecord(decision.action_completion) ? decision.action_completion : null;
  const completionActionId = completion ? stringOrNull(completion.action_id) : null;
  const roomStatus = String(response.status ?? "open");
  if (roomStatus === "concluded" || roomStatus === "expired") {
    lines.push(`  Final record: ${grpCommand(`outcome${room}`)}`);
  } else if (isObserver) {
    lines.push("  You are an observer in this room: follow along; choosing is for participants.");
    lines.push(`  Wait for what's next: ${grpCommand(`watch${room}`)}`);
  } else if (decision && completion && completionActionId) {
    const actions = Array.isArray(response.actions) ? response.actions.filter(isRecord) : [];
    const action =
      actions.find((candidate) => stringOrNull(candidate.id) === completionActionId) ??
      ({
        id: completionActionId,
        status: "awaiting_completion",
        result: completion.result,
      } as Record<string, unknown>);
    lines.push(
      ...completionActionGuidance(action, decision, response, ref, env).map((line) => `  ${line}`),
    );
  } else if (yourStatus?.startsWith("you have not chosen")) {
    // Spec 112 (WR4-4b) — engagement, not speed: deliberate, then choose.
    lines.push(...choosingGuidance());
    if (hasDecisionTargetInStatus(yourStatus)) {
      // Spec 145 (F144-S2) — a plural delta is deliberately thin, so its
      // your_status is the feature-detection signal. Teach the focused read
      // and selector loop instead of silently pointing at the oldest ballot.
      lines.push(
        `  Review each owed thread: ${grpCommand(`read --decision=N${room}`)}`,
        `  See a slate: ${grpCommand(`options --decision=N${room}`)}`,
        `  Choose: ${grpCommand(`choose "<option>" --decision=N${room}`)}`,
      );
    } else {
      lines.push(`  Choose: ${grpCommand(`choose "<option>"${room}`)}`);
    }
    lines.push(`  Then wait for what's next: ${grpCommand(`watch${room}`)}`);
  } else if (state === "no question open") {
    const callerId = callerIdentity(ref, env).participantId;
    if (hasCallerActionObligation(response, callerId)) {
      lines.push("  Continue with the action guidance above.");
    } else {
      appendIdleGuidance(lines, response, room, callerId);
    }
  } else {
    lines.push(`  Wait for what's next: ${grpCommand(`watch${room}`)}`);
  }

  if (entries.length > 0) {
    lines.push("", `Current through seq ${currentThrough ?? "?"}.`);
  }
  return `${lines.join("\n")}\n`;
}

// A human-facing page must remain small enough that agents do not need shell
// clipping, while every individual event remains byte-for-byte whole. One
// oversized event is therefore a valid one-entry page.
const HUMAN_DELTA_PAGE_MAX_RENDERED_LINES = 100;
const HUMAN_DELTA_PAGE_MAX_RENDERED_CHARACTERS = 100_000;

function humanDeltaPage(
  response: Record<string, unknown>,
  ref: RoomRef,
  env: Record<string, string | undefined>,
): { response: Record<string, unknown>; moreUnread: boolean } {
  const entries = Array.isArray(response.new) ? response.new.filter(isRecord) : [];
  if (entries.length <= 1) return { response, moreUnread: false };

  const room = roomHintArg(String(response.slug ?? ref.slug), ref, env);
  const selected: Record<string, unknown>[] = [];
  let renderedLines = 0;
  let renderedCharacters = 0;

  for (const entry of entries) {
    const rendered = renderDeltaEntry(entry, room);
    const entryLines = rendered.length;
    const entryCharacters = rendered.reduce((sum, line) => sum + line.length + 1, 0);
    const exceedsPage =
      selected.length > 0 &&
      (renderedLines + entryLines > HUMAN_DELTA_PAGE_MAX_RENDERED_LINES ||
        renderedCharacters + entryCharacters > HUMAN_DELTA_PAGE_MAX_RENDERED_CHARACTERS);
    if (exceedsPage) break;
    selected.push(entry);
    renderedLines += entryLines;
    renderedCharacters += entryCharacters;
  }

  if (selected.length === entries.length) return { response, moreUnread: false };
  const safeThrough = numberOrNull(selected.at(-1)?.seq);
  // Delta entries from current hosts always carry seq. If an old or malformed
  // host omits it, do not invent a partial acknowledgement boundary.
  if (safeThrough === null) return { response, moreUnread: false };
  return {
    response: { ...response, new: selected, current_through: safeThrough },
    moreUnread: true,
  };
}

function hasDecisionTargetInStatus(yourStatus: string): boolean {
  return (
    yourStatus.includes("(choose with decision:") ||
    yourStatus.includes("(target each with decision:")
  );
}

/** One delta entry, rendered with full text (no truncation on the delta). */
function renderDeltaEntry(entry: Record<string, unknown>, room = ""): string[] {
  const who = stringOrNull(entry.who) ?? "unknown";
  switch (stringOrNull(entry.type)) {
    case "discussion": {
      const stance = stringOrNull(entry.stance);
      const said = typeof entry.said === "string" ? entry.said : "";
      const [first = "", ...rest] = said.split("\n");
      return [
        `  ${who}${stance ? ` (${stance})` : ""}: ${first}`,
        ...rest.map((line) => `    ${line}`),
      ];
    }
    case "option_proposed": {
      const text = String(entry.option ?? "");
      const shown =
        text.length > 300
          ? `${text.slice(0, 300)}… (full: ${grpCommand(`options --full${room}`)})`
          : text;
      return [`  ${who} proposed: ${JSON.stringify(shown)}`];
    }
    case "decision_opened": {
      const opener = stringOrNull(entry.who);
      // Spec 128 — an agreement question announces its own rule to joiners.
      const agreementNote =
        entry.agreement === true
          ? " (agreement — resolves only when every voter accepts the same option)"
          : "";
      return [
        `  Decision opened${opener ? ` by ${opener}` : ""}: ${JSON.stringify(String(entry.question ?? ""))}${agreementNote}`,
      ];
    }
    case "decision_revised": {
      const revisedBy = stringOrNull(entry.who);
      return [
        `  Decision premise replaced${revisedBy ? ` by ${revisedBy}` : ""}; prior choices cleared: ${JSON.stringify(String(entry.question ?? ""))}`,
      ];
    }
    case "choosing_started": {
      const question = stringOrNull(entry.question);
      return [question ? `  Choosing started: ${JSON.stringify(question)}` : "  Choosing started."];
    }
    case "choice_submitted": {
      // Spec 117 — the record speaks in numbers: "#5", never the option's
      // full text (that lives in grp options --full / the outcome / receipt).
      // Spec 128 — a ballot on an agreement decision reads as an acceptance.
      const verb = entry.agreement === true ? "accepted" : "chose";
      const optionNumber = numberOrNull(entry.option);
      const choice = typeof entry.choice === "string" ? entry.choice : null;
      const revised = entry.revised === true ? " (revised)" : "";
      if (optionNumber !== null) {
        return [`  ${who} ${verb} #${optionNumber}${revised}`];
      }
      // Spec 152 W4 — a map ballot renders as scores, not as an escaped-JSON
      // blob (Stage A: every score ballot in the record was unreadable, so
      // the graded preferences never entered deliberation).
      const ballotMap = choice ? parseBallotMapForDisplay(choice) : null;
      if (ballotMap) {
        const parts = Object.entries(ballotMap).map(([option, score]) => {
          const label = option.length > 40 ? `${option.slice(0, 40)}…` : option;
          return `${label} = ${score}`;
        });
        return [`  ${who} scored${revised}: ${parts.join(", ")}`];
      }
      const clipped = choice && choice.length > 120 ? `${choice.slice(0, 120)}…` : choice;
      return [`  ${who} ${verb}${revised}${clipped ? `: ${JSON.stringify(clipped)}` : ""}`];
    }
    case "decision_resolved": {
      const question = stringOrNull(entry.question) ?? "unknown";
      const outcome = stringOrNull(entry.outcome);
      const rawWinner = stringOrNull(entry.winner);
      // Spec 115 (WR7-8) — a tie is a status, never a winner named "null".
      // Spec 128 — an agreement question that ends winnerless ends honestly.
      if (rawWinner === null) {
        const label =
          entry.agreement === true
            ? "no agreement reached"
            : outcome === "tied"
              ? "tied — no winner"
              : (outcome ?? "no outcome");
        return [`  Decision resolved: ${JSON.stringify(question)} → ${label}`];
      }
      const winner =
        rawWinner.length > 300
          ? `${rawWinner.slice(0, 300)}… (full: ${grpCommand("outcome")})`
          : rawWinner;
      return [`  Decision resolved: ${JSON.stringify(question)} → ${winner}`];
    }
    case "joined":
      return [`  ${who} joined (${stringOrNull(entry.role) ?? "participant"})`];
    case "role_updated":
      return [`  ${who} is now ${stringOrNull(entry.role) ?? "a member"}`];
    case "invite_created": {
      const name = stringOrNull(entry.name) ?? "unnamed";
      const role = stringOrNull(entry.role);
      return [`  Invite created: ${name}${role ? ` (${role})` : ""}`];
    }
    case "room_concluded": {
      const statement = stringOrNull(entry.closing_statement);
      return [statement ? `  Room concluded: ${statement}` : "  Room concluded."];
    }
    case "action_handed_off": {
      const actionId = stringOrNull(entry.action_id) ?? "unknown";
      const from = stringOrNull(entry.from) ?? "A participant";
      if (entry.to_you === true) return [`  ${from} handed action ${actionId} to you.`];
      if (entry.to_group === true) return [`  ${from} handed action ${actionId} to the group.`];
      const to = stringOrNull(entry.to) ?? "another participant";
      return [`  ${from} handed action ${actionId} to ${to}.`];
    }
    default:
      // Forward compatibility: unknown entry types still show up as activity.
      return [`  ${stringOrNull(entry.type) ?? "activity"}`];
  }
}

async function roomJoin(
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const ref = resolveRoomRef(target, flags, io.env);
  assertJoinTokenFlags(ref);
  const displayName = joinDisplayName(flags, io.env);
  const auth = authFromFlags(flags, ref, io.env);
  const options: RequestOptions = {
    method: "POST",
    body: withoutUndefined({
      display_name: displayName,
      password: flags.password ?? ref.password,
      invite: flags.invite ?? ref.invite,
    }),
  };
  if (auth?.kind === "hosted" || auth?.kind === "mandate") options.auth = auth;
  const response = await requestJson<unknown>(
    ref.baseUrl,
    `/api/rooms/${encodeURIComponent(ref.slug)}/join`,
    io,
    options,
  );
  const joinedState = rememberJoinedRoom(ref, response, flags, io);
  if (isJson(flags) || flags.quiet === "true") {
    writeStructured(response, flags, io, "participant_token");
    return;
  }
  io.stdout(renderRoomJoined(ref, response, joinedState));
}

function assertJoinTokenFlags(ref: RoomRef): void {
  if (!ref.invite && ref.token && looksLikeInviteToken(ref.token)) {
    throw new Error(
      `That looks like an invite token. Join with \`${grpCommand("join <room-id> --invite <invite-token>")}\`.`,
    );
  }
}

function looksLikeInviteToken(value: string): boolean {
  return value.startsWith("it_");
}

interface JoinedRoomState {
  mode: "set" | "unchanged" | "kept" | "switched";
  currentSlug: string;
}

function renderRoomJoined(ref: RoomRef, response: unknown, state: JoinedRoomState): string {
  const joined = isRecord(response) ? response : {};
  const role = stringOrNull(joined.role);
  const lines = [`Joined room ${ref.slug}.`];
  if (state.mode === "set") lines.push("Current room: set.");
  else if (state.mode === "unchanged") lines.push(`Current room unchanged: ${state.currentSlug}.`);
  else if (state.mode === "switched") lines.push(`Current room switched to: ${state.currentSlug}.`);
  else {
    lines.push(
      `Current room kept: ${state.currentSlug}.`,
      `To switch: ${grpCommand(`enter ${ref.baseUrl}/r/${encodeURIComponent(ref.slug)}`)}`,
    );
  }
  if (role) lines.push(`Role: ${role}.`);
  const readTarget =
    state.mode === "kept" ? ` ${ref.baseUrl}/r/${encodeURIComponent(ref.slug)}` : "";
  lines.push("", "Run:", `  ${grpCommand(`read${readTarget}`)}`);
  return `${lines.join("\n")}\n`;
}

async function roomAsk(
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
  repeatedOptions?: string[],
): Promise<void> {
  const ref = resolveRoomRef(target, flags, io.env);
  const eligible = splitCsv(flags.eligible ?? "");
  const question = requireQuestion(flags);
  let response: unknown;
  try {
    response = await actionRequest(
      ref,
      "/ask",
      flags,
      io,
      {
        question,
        context: flags.context,
        options: seedOptions(flags, repeatedOptions),
        eligible: eligible.length > 0 ? eligible : undefined,
        voting_window: parseOptionalNumber(flags["voting-window"]),
        proposal_window: collectOptionsWindow(flags),
        // Spec 128 — agreement question: resolves only on unanimous acceptance.
        agreement: flags.agreement !== undefined ? parseOptionalBool(flags.agreement) : undefined,
      },
      true,
    );
  } catch (error) {
    const remembered = findRememberedRoom(readProviderConfig(io.env), ref.slug, ref.baseUrl);
    if (
      error instanceof Error &&
      /a decision is already open/.test(error.message) &&
      remembered?.coordinationStateCapability === "experimental"
    ) {
      const openDecision = error.message.match(/\bseq\s+([1-9][0-9]*)\b/i)?.[1];
      throw new Error(
        [
          error.message,
          "Questions are immutable. Someone with room conclusion authority may cancel the open question without erasing its choices or history:",
          `Run: ${grpCommand(`cancel ${openDecision ?? "<decision-number>"} --reason="Premise changed"`)}`,
          `Then open the corrected question as a new decision: ${grpCommand('ask "<corrected question>"')}`,
        ].join("\n"),
      );
    }
    throw error;
  }
  if (isJson(flags) || flags.quiet === "true") {
    writeStructured(response, flags, io);
    return;
  }
  io.stdout(renderQuestionOpened(response, ref, question, io.env));
}

function parseDecisionCancellationRef(raw: string | undefined): string {
  const value = raw?.trim().replace(/^#(?=[1-9][0-9]*$)/, "") ?? "";
  if (!value) {
    throw new Error('usage: grp cancel <decision-number|id> --reason="..." [room]');
  }
  if (value.length > 200 || /\s/u.test(value) || /\p{Cc}/u.test(value)) {
    throw new Error("decision must be one decision number or id from grp read");
  }
  if (
    /^[0-9]+$/.test(value) &&
    (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
  ) {
    throw new Error("decision number must be a positive safe integer");
  }
  return value;
}

function decisionCancellationReason(flags: Record<string, string>): string {
  const reason = flags.reason?.trim() ?? "";
  if (!reason) {
    throw new Error('usage: grp cancel <decision-number|id> --reason="..." [room]');
  }
  if (reason.length > 500) throw new Error("--reason is too long (max 500 characters)");
  if (/\p{Cc}/u.test(reason)) throw new Error("--reason must not contain control characters");
  return reason;
}

async function roomCancelDecision(
  decision: string | undefined,
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const ref = resolveRoomRef(target, flags, io.env);
  const decisionRef = parseDecisionCancellationRef(decision);
  const reason = decisionCancellationReason(flags);
  const response = await actionRequest(
    ref,
    `/decisions/${encodeURIComponent(decisionRef)}/cancel`,
    flags,
    io,
    { reason },
    true,
  );
  if (isJson(flags) || flags.quiet === "true") {
    writeStructured(response, flags, io, "receipt_hash");
    return;
  }
  io.stdout(renderDecisionCanceled(response, ref, reason, io.env));
}

async function roomPropose(
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const ref = resolveRoomRef(target, flags, io.env);
  // Spec 119 (WR11-4) — options are document-sized artifacts (spec 114);
  // take them as documents instead of forcing them through shell quoting
  // (run 11's Silica lost a propose to a quoting error and detoured through
  // a temp file and $(cat …)). `--file=PATH` reads the file; a bare `-`
  // reads stdin. Empty documents fall through to the option-required error.
  let effective = flags;
  if (flags.file) {
    if (flags.option) throw new Error("pass either --file or option text, not both");
    effective = { ...flags, option: readFileSync(flags.file, "utf8").trim() };
  } else if (flags.option === "-") {
    effective = { ...flags, option: (await readAll(io.stdin)).trim() };
  }
  const option = requireFlag(effective, "option");
  // Spec 114 — the option text IS the proposal (agents choose by number;
  // reads clip; receipts keep it whole). The cap is an abuse rail only.
  if (option.length > 500_000) {
    throw new Error(
      `option text is too long (max 500,000 characters); this one is ${option.length}. Split the proposal or move commentary to discussion.`,
    );
  }
  const response = await actionRequest(
    ref,
    "/options",
    flags,
    io,
    {
      option,
      decision: parseDecisionFlag(flags.decision),
    },
    true,
  );
  if (isJson(flags) || flags.quiet === "true") {
    writeStructured(response, flags, io);
    return;
  }
  io.stdout(renderOptionProposed(response, ref, option, io.env));
}

async function roomDiscuss(
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const ref = resolveRoomRef(target, flags, io.env);
  if (flags.composing === "true") {
    if (
      flags.body ||
      flags.file ||
      flags.stance ||
      flags.decision ||
      flags["as-discussion"] ||
      flags["post-anyway"]
    ) {
      throw new Error(
        "--composing only signals that you are preparing a message; post the message with a separate grp discuss command",
      );
    }
    const response = await experimentalResourceRequest(ref, "/composing", flags, io, "POST", {
      ttl_seconds: parseOptionalIntegerFlag(flags.ttl, "--ttl"),
    });
    if (isJson(flags)) {
      io.stdout(renderJson(response));
    } else if (flags.quiet !== "true") {
      io.stdout(
        "Composing signal active.\nIt will clear when you post or when it expires.\n\nNext: post normally with grp discuss.\n",
      );
    }
    return;
  }
  // Spec 164 — read file/stdin discussion as one exact snapshot rather than
  // forcing shell-sensitive text through quoting. Spec 241 keeps transport
  // separate from intent: substantial content needs an explicit confirmation
  // before it is placed in chat, regardless of how the bytes arrived.
  let effective = flags;
  if (flags.file) {
    if (flags.body) throw new Error("pass either --file or message text, not both");
    effective = { ...flags, body: readFileSync(flags.file, "utf8") };
  } else if (flags.body === "-") {
    effective = { ...flags, body: await readAll(io.stdin) };
  }
  const body = requireFlag(effective, "body");
  if (body.length > SUBSTANTIAL_DISCUSSION_CHARACTERS && flags["as-discussion"] !== "true") {
    throw new Error(
      [
        `This discussion is ${body.length.toLocaleString("en-US")} characters.`,
        "",
        "If this is shared work that others will revise or approve, preserve one exact version through an action and artifact.",
        "",
        "Continue as intentional discussion: add --as-discussion",
        `Structured shared work: ${grpCommand("act --help")}`,
      ].join("\n"),
    );
  }
  const response = await actionRequest(
    ref,
    "/discuss",
    flags,
    io,
    {
      body,
      stance: parseStance(flags.stance),
      decision: parseDecisionFlag(flags.decision),
    },
    true,
  );
  if (isJson(flags) || flags.quiet === "true") {
    writeStructured(response, flags, io, "id");
    return;
  }
  io.stdout(renderDiscussionPosted(ref, io.env));
}

async function roomAction(
  args: string[],
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const [operation, id, room] = args;
  if (operation === "start") {
    const ref = resolveRoomRef(targetOrCurrent(id, flags, io), flags, io.env);
    const mode = normalizeActionMode(flags.mode);
    const completion = normalizeActionCompletion(flags.completion, mode);
    const artifactName = flags["artifact-name"];
    const artifactFile = flags["artifact-file"];
    const startsArtifact = artifactName !== undefined || artifactFile !== undefined;
    if ((artifactName === undefined) !== (artifactFile === undefined)) {
      throw new Error("--artifact-name and --artifact-file must be used together");
    }
    if (startsArtifact && flags.artifact !== undefined) {
      throw new Error(
        "pass either an existing --artifact target or --artifact-name with --artifact-file, not both",
      );
    }
    if (startsArtifact && mode === "all") {
      throw new Error(
        "--mode=all cannot own one artifact; use separate actions or report individual results",
      );
    }
    if (artifactFile === "-") {
      throw new Error("--artifact-file requires a file path");
    }
    // Read before any remote lookup/write so a missing file cannot leave an
    // action behind.
    const artifactContent = artifactFile ? readFileSync(artifactFile, "utf8") : undefined;
    const toParticipantId = flags.to
      ? await resolveParticipantSelector(ref, flags.to, flags, io)
      : undefined;
    if (mode === "all" && flags.to) {
      throw new Error("--to is not used with --mode=all; use --required=NAME,NAME if needed");
    }
    const participantIds =
      mode === "all" && flags.required
        ? await resolveActionParticipantSelectors(ref, flags.required, flags, io)
        : undefined;
    if (mode !== "all" && flags.required !== undefined) {
      throw new Error("--required is only used with --mode=all");
    }
    const response = await experimentalResourceRequest(
      ref,
      "/actions",
      flags,
      io,
      "POST",
      {
        title: requireFlag(flags, "title"),
        description: flags.description,
        assignee_id: toParticipantId,
        start: true,
        mode,
        ...(mode === "all" ? {} : { completion }),
        participant_ids: participantIds,
        target_artifact_id: flags.artifact,
        deadline_at: flags.deadline,
        ttl_seconds: parseOptionalIntegerFlag(flags.ttl, "--ttl"),
      },
      true,
    );
    if (startsArtifact && artifactName && artifactFile && artifactContent !== undefined) {
      const action = actionFromResponse(response);
      const actionId = stringOrNull(action.id);
      if (!actionId) throw new Error("host did not return the started action ID");
      let artifactResponse: unknown;
      try {
        artifactResponse = await experimentalResourceRequest(
          ref,
          "/artifacts",
          flags,
          io,
          "POST",
          {
            name: artifactName,
            kind: "native",
            content: artifactContent,
            action_id: actionId,
            expected_action_revision: requireActionRevision(action),
          },
          false,
        );
      } catch (error) {
        const roomArg = roomHintArg(ref.slug, ref, io.env);
        throw new Error(
          [
            `Action ${actionId} started, but its artifact was not created.`,
            error instanceof Error ? error.message : String(error),
            "The action remains in the room; nothing was silently canceled.",
            `Continue: ${grpCommand(
              `artifact create --name=${JSON.stringify(artifactName)} --action=${actionId} --file=${JSON.stringify(artifactFile)}${roomArg}`,
            )}`,
          ].join("\n"),
        );
      }
      writeArtifactResponse(artifactResponse, ref, flags, io, "created");
      return;
    }
    await writeActionResponse(response, ref, flags, io, "started");
    return;
  }
  if (
    ![
      "read",
      "take",
      "handoff",
      "request-review",
      "review",
      "complete",
      "resume",
      "fail",
      "cancel",
      "takeover",
    ].includes(operation ?? "") ||
    !id
  ) {
    throw new Error(
      "usage: grp act start|read|take|handoff|request-review|review|complete|resume|fail|cancel|takeover ...",
    );
  }
  const ref = resolveRoomRef(targetOrCurrent(room, flags, io), flags, io.env);
  const current = await experimentalResourceRequest(
    ref,
    `/actions/${encodeURIComponent(id)}`,
    flags,
    io,
    "GET",
  );
  if (operation === "read") {
    await writeActionResponse(current, ref, flags, io, "read");
    return;
  }
  const currentAction = actionFromResponse(current);
  const expectedRevision = requireActionRevision(currentAction);
  if (operation === "request-review") {
    const artifactId = stringOrNull(currentAction.target_artifact_id);
    if (!artifactId) throw new Error("this action has no artifact to review");
    if (actionCompletionFromWire(currentAction.completion) !== "group") {
      throw new Error("exact artifact review requires an action started with --completion=group");
    }
    const exact = await experimentalResourceRequest(
      ref,
      `/artifacts/${encodeURIComponent(artifactId)}`,
      flags,
      io,
      "GET",
    );
    const descriptor = artifactResponseDescriptor(exact);
    if (!descriptor?.resourceRevision || !descriptor.revisionId) {
      throw new Error("host did not return the exact current artifact revision");
    }
    const response = await experimentalResourceRequest(
      ref,
      `/actions/${encodeURIComponent(id)}/request-review`,
      flags,
      io,
      "POST",
      {
        expected_action_revision: expectedRevision,
        expected_artifact_revision: descriptor.resourceRevision,
        artifact_revision_id: descriptor.revisionId,
      },
      false,
    );
    await writeActionResponse(response, ref, flags, io, "review requested");
    return;
  }
  if (operation === "review") {
    const review = isRecord(currentAction.review) ? currentAction.review : null;
    const artifactId = stringOrNull(currentAction.target_artifact_id);
    const revisionId = review ? stringOrNull(review.artifact_revision_id) : null;
    if (!review || !artifactId || !revisionId || stringOrNull(review.state) !== "pending") {
      throw new Error("this action has no pending exact artifact review");
    }
    const exact = await experimentalResourceRequest(
      ref,
      `/artifacts/${encodeURIComponent(artifactId)}`,
      flags,
      io,
      "GET",
      undefined,
      false,
      { revision: revisionId },
    );
    const approve = flags.approve === "true";
    const requestChanges = flags["request-changes"] === "true";
    if (approve && requestChanges) {
      throw new Error("choose either --approve or --request-changes");
    }
    if (!approve && !requestChanges) {
      if (isJson(flags)) {
        io.stdout(renderJson({ action: currentAction, exact_artifact: exact }));
      } else {
        io.stdout(
          `${renderArtifactRead(exact, ref, io.env).trimEnd()}\n\n${renderActionReviewChoice(currentAction, ref, io.env)}`,
        );
      }
      return;
    }
    let body: string | undefined;
    if (flags.file) {
      if (flags.body) throw new Error("pass either --file or --body, not both");
      body = readFileSync(flags.file, "utf8");
    } else {
      body = flags.body;
    }
    if (requestChanges && !body?.trim()) {
      throw new Error("--request-changes requires --body=TEXT or --file=PATH");
    }
    if (approve && body !== undefined) {
      throw new Error("approval records the exact revision; omit --body and --file");
    }
    const exactRecord = isRecord(exact) ? exact : {};
    const reviews = Array.isArray(exactRecord.reviews) ? exactRecord.reviews.filter(isRecord) : [];
    const callerId = callerIdentity(ref, io.env).participantId;
    const ownReview = callerId
      ? reviews.find((candidate) => stringOrNull(candidate.reviewer_id) === callerId)
      : undefined;
    const response = await experimentalResourceRequest(
      ref,
      `/actions/${encodeURIComponent(id)}/review`,
      flags,
      io,
      "PUT",
      {
        expected_action_revision: expectedRevision,
        disposition: approve ? "approve" : "changes_requested",
        body: requestChanges ? body : undefined,
        expected_review_revision: ownReview
          ? (stringOrNull(ownReview.revision) ?? undefined)
          : undefined,
      },
      false,
    );
    await writeActionResponse(
      response,
      ref,
      flags,
      io,
      approve ? "exact revision approved" : "changes requested",
    );
    return;
  }
  if (operation === "take") {
    let response: unknown;
    try {
      response = await experimentalResourceRequest(
        ref,
        `/actions/${encodeURIComponent(id)}/claim`,
        flags,
        io,
        "POST",
        {
          expected_revision: expectedRevision,
          ttl_seconds: parseOptionalIntegerFlag(flags.ttl, "--ttl"),
        },
      );
    } catch (error) {
      if (error instanceof CliHttpError && error.code === "claim.active") {
        const roomArg = roomHintArg(ref.slug, ref, io.env);
        throw new Error(`${error.message}\nNext: ${grpCommand(`watch --action=${id}${roomArg}`)}`);
      }
      throw error;
    }
    await writeActionResponse(response, ref, flags, io, "taken");
    return;
  }
  if (operation === "handoff") {
    const to = requireFlag(flags, "to");
    const toGroup = to.trim().toLocaleLowerCase() === "group";
    const toParticipantId = toGroup
      ? undefined
      : await resolveParticipantSelector(ref, to, flags, io);
    const response = await experimentalResourceRequest(
      ref,
      `/actions/${encodeURIComponent(id)}/handoff`,
      flags,
      io,
      "POST",
      {
        expected_revision: expectedRevision,
        to_participant_id: toParticipantId,
        to_group: toGroup || undefined,
        note: flags.note,
        ttl_seconds: parseOptionalIntegerFlag(flags.ttl, "--ttl"),
      },
    );
    await writeActionResponse(response, ref, flags, io, "handed off");
    return;
  }
  if (operation === "takeover") {
    const response = await experimentalResourceRequest(
      ref,
      `/actions/${encodeURIComponent(id)}/takeover`,
      flags,
      io,
      "POST",
      {
        expected_revision: expectedRevision,
        reason: requireFlag(flags, "reason"),
        override: flags.override === "true",
        ttl_seconds: parseOptionalIntegerFlag(flags.ttl, "--ttl"),
      },
    );
    await writeActionResponse(response, ref, flags, io, "taken over");
    return;
  }
  if (operation === "resume") {
    const response = await experimentalResourceRequest(
      ref,
      `/actions/${encodeURIComponent(id)}/resume`,
      flags,
      io,
      "POST",
      {
        expected_revision: expectedRevision,
        reason: requireFlag(flags, "reason"),
      },
      true,
    );
    await writeActionResponse(response, ref, flags, io, "resumed for revision");
    return;
  }
  const transition = operation as "complete" | "fail" | "cancel";
  const result = flags["result-text"]
    ? { kind: "text", reference: flags["result-text"] }
    : undefined;
  const completion = actionCompletionFromWire(currentAction.completion);
  if (
    transition === "complete" &&
    completion === "group" &&
    stringOrNull(currentAction.target_artifact_id)
  ) {
    throw new Error(
      `group completion with an artifact uses exact review; run ${grpCommand(`act request-review ${id}${roomHintArg(ref.slug, ref, io.env)}`)}`,
    );
  }
  if (
    transition === "complete" &&
    completion === "group" &&
    !result &&
    !stringOrNull(currentAction.target_artifact_id)
  ) {
    throw new Error("--result-text is required for group completion without an artifact");
  }
  const response = await experimentalResourceRequest(
    ref,
    `/actions/${encodeURIComponent(id)}/${transition}`,
    flags,
    io,
    "POST",
    {
      expected_revision: expectedRevision,
      result,
    },
    transition === "complete" && completion === "group",
  );
  await writeActionResponse(
    response,
    ref,
    flags,
    io,
    transition === "complete" && completion === "group" ? "completion proposed" : transition,
  );
}

function actionFromResponse(response: unknown): Record<string, unknown> {
  const record = isRecord(response) ? response : {};
  const action = isRecord(record.action) ? record.action : null;
  if (!action) throw new Error("host did not return an action record");
  return action;
}

function requireActionRevision(action: Record<string, unknown>): string {
  const revision = stringOrNull(action.revision);
  if (!revision) throw new Error("host did not return the action resource revision");
  return revision;
}

function normalizeActionMode(raw: string | undefined): "single" | "handoff" | "all" {
  const normalized = (raw ?? "single").trim().toLocaleLowerCase();
  if (normalized !== "single" && normalized !== "handoff" && normalized !== "all") {
    throw new Error("--mode must be single, handoff, or all");
  }
  return normalized;
}

function normalizeActionCompletion(
  raw: string | undefined,
  mode: "single" | "handoff" | "all",
): "holder" | "group" | undefined {
  if (mode === "all") {
    if (raw !== undefined) throw new Error("--completion is not used with --mode=all");
    return undefined;
  }
  const normalized = (raw ?? "holder").trim().toLocaleLowerCase();
  if (normalized !== "holder" && normalized !== "group") {
    throw new Error("--completion must be holder or group");
  }
  return normalized;
}

function actionCompletionFromWire(raw: unknown): "holder" | "group" | "all" {
  const completion = stringOrNull(raw);
  if (completion === "group" || completion === "all") return completion;
  return "holder";
}

function actionModeFromWire(raw: unknown): "single" | "handoff" | "all" {
  const mode = stringOrNull(raw);
  if (mode === "all") return "all";
  if (mode === "handoff" || mode === "turn_taking") return "handoff";
  return "single";
}

async function fullRoomForResource(
  ref: RoomRef,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<Record<string, unknown>> {
  return requestJson<Record<string, unknown>>(
    ref.baseUrl,
    `/api/rooms/${encodeURIComponent(ref.slug)}`,
    io,
    fullReadRequestOptions(ref, flags, io.env),
  );
}

async function resolveParticipantSelector(
  ref: RoomRef,
  selector: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<string> {
  const full = await fullRoomForResource(ref, flags, io);
  const participants = Array.isArray(full.participants) ? full.participants.filter(isRecord) : [];
  return resolveParticipantFromRows(selector, participants);
}

function resolveParticipantFromRows(
  selector: string,
  participants: Record<string, unknown>[],
): string {
  const exactId = participants.find((participant) => stringOrNull(participant.id) === selector);
  if (exactId) return selector;
  const folded = selector.trim().toLocaleLowerCase();
  const matches = participants.filter(
    (participant) =>
      (stringOrNull(participant.display_name) ?? "").trim().toLocaleLowerCase() === folded,
  );
  if (matches.length === 0) {
    throw new Error(`no joined participant matches "${selector}"; run ${grpCommand("members")}`);
  }
  if (matches.length > 1) {
    throw new Error(`participant name "${selector}" is ambiguous; use an exact participant ID`);
  }
  const id = stringOrNull(matches[0]?.id);
  if (!id) throw new Error("matched participant has no ID");
  return id;
}

async function resolveActionParticipantSelectors(
  ref: RoomRef,
  raw: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<string[]> {
  const full = await fullRoomForResource(ref, flags, io);
  const participants = Array.isArray(full.participants) ? full.participants.filter(isRecord) : [];
  const votingParticipants = participants.filter(
    (participant) => (stringOrNull(participant.role) ?? "participant") === "participant",
  );
  const selectors =
    raw.trim().toLocaleLowerCase() === "all"
      ? votingParticipants.map((participant) => stringOrNull(participant.id) ?? "")
      : raw
          .split(",")
          .map((selector) => selector.trim())
          .filter(Boolean)
          .map((selector) => resolveParticipantFromRows(selector, votingParticipants));
  const ids = selectors.filter(Boolean);
  if (ids.length === 0) throw new Error("--required must name at least one participant");
  if (new Set(ids).size !== ids.length) {
    throw new Error("--required must not contain duplicates");
  }
  return ids;
}

async function writeActionResponse(
  response: unknown,
  ref: RoomRef,
  flags: Record<string, string>,
  io: RoomCliIo,
  event: string,
): Promise<void> {
  const action = actionFromResponse(response);
  const review = isRecord(action.review) ? action.review : null;
  const reviewState = review ? stringOrNull(review.state) : null;
  const artifactId = stringOrNull(action.target_artifact_id);
  const revisionId = review ? stringOrNull(review.artifact_revision_id) : null;
  const exactArtifact =
    reviewState === "changes_requested" && artifactId && revisionId
      ? await experimentalResourceRequest(
          ref,
          `/artifacts/${encodeURIComponent(artifactId)}`,
          flags,
          io,
          "GET",
          undefined,
          false,
          { revision: revisionId },
        )
      : null;
  if (isJson(flags)) {
    io.stdout(
      renderJson(
        exactArtifact && isRecord(response)
          ? { ...response, exact_artifact: exactArtifact }
          : response,
      ),
    );
    return;
  }
  if (flags.quiet === "true") {
    io.stdout(`${stringOrNull(action.id) ?? ""}\n`);
    return;
  }
  const full = await fullRoomForResource(ref, flags, io);
  io.stdout(renderActionState(action, ref, io.env, full, event, exactArtifact));
}

function linkedCompletionDecision(
  full: Record<string, unknown>,
  action: Record<string, unknown>,
): Record<string, unknown> | null {
  const decisionId = stringOrNull(action.completion_decision_id);
  if (!decisionId) return null;
  const decisions = Array.isArray(full.decisions) ? full.decisions.filter(isRecord) : [];
  return decisions.find((decision) => stringOrNull(decision.id) === decisionId) ?? null;
}

function completionActionGuidance(
  action: Record<string, unknown>,
  decision: Record<string, unknown> | null,
  full: Record<string, unknown>,
  ref: RoomRef,
  env: Record<string, string | undefined>,
  event?: string,
): string[] {
  const id = stringOrNull(action.id) ?? "ACTION_ID";
  const room = roomHintArg(ref.slug, ref, env);
  const seq = decision ? numberOrNull(decision.seq) : null;
  const decisionArg = seq === null ? "" : ` --decision=${seq}`;
  const completion =
    decision && isRecord(decision.action_completion) ? decision.action_completion : null;
  const result =
    (isRecord(action.result) ? action.result : null) ??
    (completion && isRecord(completion.result) ? completion.result : null);
  const lines: string[] = [];
  if (result?.kind === "artifact_revision" && isRecord(result.reference)) {
    const artifactId = stringOrNull(result.reference.artifact_id);
    const revisionId = stringOrNull(result.reference.revision_id);
    const sha256 = stringOrNull(result.reference.sha256);
    if (artifactId && revisionId) {
      lines.push(
        `Inspect exact result: ${grpCommand(`artifact read ${artifactId} --revision-id=${revisionId}${room}`)}${sha256 ? ` (SHA-256 ${sha256})` : ""}`,
      );
    }
  } else if (result?.kind === "text" && typeof result.reference === "string") {
    lines.push(`Exact text result: ${JSON.stringify(result.reference)}`);
  }

  const callerId = callerIdentity(ref, env).participantId;
  const proposedBy = stringOrNull(action.completion_proposed_by_id);
  if (event === "completion proposed" && callerId && proposedBy === callerId) {
    lines.push("You proposed completion; GRP did not mark the action complete on your behalf.");
  }
  const participants = Array.isArray(full.participants) ? full.participants.filter(isRecord) : [];
  const caller = participants.find((participant) => stringOrNull(participant.id) === callerId);
  const eligibleIds =
    decision && Array.isArray(decision.eligible_participant_ids)
      ? decision.eligible_participant_ids.filter(
          (value): value is string => typeof value === "string",
        )
      : null;
  const eligible =
    typeof completion?.eligible === "boolean"
      ? completion.eligible
      : callerId && eligibleIds
        ? eligibleIds.includes(callerId)
        : caller
          ? stringOrNull(caller.role) !== "observer"
          : null;
  const accepted = completion?.accepted_by_you === true;
  if (accepted) {
    lines.push("You marked this action complete.");
  } else if (eligible !== false) {
    lines.push(
      `Mark complete only if this exact result finishes the action: ${grpCommand(`accept 1${decisionArg}${room}`)}`,
    );
  } else {
    lines.push("You are not eligible to mark this action complete.");
  }
  if (callerId && proposedBy === callerId) {
    lines.push(
      `Resume to revise: ${grpCommand(`act resume ${id} --reason="What changed"${room}`)}`,
    );
  }
  lines.push(
    `Discuss this completion: ${grpCommand(`discuss "..."${decisionArg}${room}`)}`,
    `Then wait: ${grpCommand(`watch --action=${id}${room}`)}`,
  );
  return lines;
}

function renderActionReviewChoice(
  action: Record<string, unknown>,
  ref: RoomRef,
  env: Record<string, string | undefined>,
): string {
  const id = stringOrNull(action.id) ?? "ACTION_ID";
  const review = isRecord(action.review) ? action.review : {};
  const revisionId = stringOrNull(review.artifact_revision_id) ?? "unknown";
  const room = roomHintArg(ref.slug, ref, env);
  return `${[
    `Action review ${id} targets exact artifact revision ${revisionId}.`,
    "Required: record one review response for these exact bytes.",
    `Approve these exact bytes: ${grpCommand(`act review ${id} --approve${room}`)}`,
    `Request changes: ${grpCommand(`act review ${id} --request-changes --file=review.md${room}`)}`,
    "A response may be updated while this review round remains open.",
  ].join("\n")}\n`;
}

function renderActionState(
  action: Record<string, unknown>,
  ref: RoomRef,
  env: Record<string, string | undefined>,
  full: Record<string, unknown>,
  event: string,
  exactArtifact: unknown = null,
): string {
  const id = stringOrNull(action.id) ?? "ACTION_ID";
  const status = stringOrNull(action.status) ?? "unknown";
  const holderId = stringOrNull(action.holder_id) ?? stringOrNull(action.assignee_id);
  const participants = Array.isArray(full.participants) ? full.participants.filter(isRecord) : [];
  const holder = participants.find((participant) => stringOrNull(participant.id) === holderId);
  const holderName = holder
    ? (stringOrNull(holder.display_name) ?? holderId ?? "unknown")
    : (holderId ?? "unassigned");
  const callerId = callerIdentity(ref, env).participantId;
  const callerHolds = callerId !== undefined && callerId === holderId;
  const mode = actionModeFromWire(action.mode);
  const completion = actionCompletionFromWire(action.completion);
  const room = roomHintArg(ref.slug, ref, env);
  const version = stringOrNull(action.revision) ?? "?";
  const participation = Array.isArray(action.participants)
    ? action.participants.filter(isRecord)
    : [];
  const progress = isRecord(action.progress) ? action.progress : {};
  const completed = numberOrNull(progress.completed) ?? 0;
  const required = numberOrNull(progress.required) ?? participation.length;
  const lines = [`Action ${id} ${event}.`, `Work: ${stringOrNull(action.title) ?? "untitled"}`];
  if (mode === "all") {
    lines.push(
      `State: ${status}; all participants ${completed}/${required} complete; action v${version}.`,
    );
  } else {
    lines.push(
      `State: ${status}; ${mode.replaceAll("_", "-")}; completion ${completion}; holder ${holderName}; action v${version}.`,
    );
  }
  const note = stringOrNull(action.handoff_note);
  if (note) lines.push(`Handoff note: ${note}`);
  const target = stringOrNull(action.target_artifact_id);
  if (target) lines.push(`Artifact target: ${target}.`);
  const completionResultFlag = target ? "" : ' --result-text="What happened"';
  const result = isRecord(action.result) ? action.result : null;
  if (result && status !== "awaiting_completion") lines.push(`Result: ${JSON.stringify(result)}.`);
  const review = isRecord(action.review) ? action.review : null;
  const reviewState = review ? stringOrNull(review.state) : null;
  if (reviewState === "changes_requested") {
    const exact = isRecord(exactArtifact) ? exactArtifact : {};
    const responses = Array.isArray(exact.reviews) ? exact.reviews.filter(isRecord) : [];
    const revisionId = review ? stringOrNull(review.artifact_revision_id) : null;
    lines.push(
      "",
      `Review round closed on exact artifact revision ${revisionId ?? "unknown"}; changes were requested.`,
      "Formal review responses:",
    );
    for (const response of responses) {
      const reviewerId = stringOrNull(response.reviewer_id);
      const participant = participants.find(
        (candidate) => stringOrNull(candidate.id) === reviewerId,
      );
      const reviewer = stringOrNull(participant?.display_name) ?? reviewerId ?? "unknown reviewer";
      const disposition = stringOrNull(response.disposition)?.replaceAll("_", " ") ?? "reviewed";
      lines.push(`  ${reviewer} — ${disposition}`);
      const body = stringOrNull(response.body);
      if (body) {
        for (const bodyLine of body.split("\n")) lines.push(`    ${bodyLine}`);
      }
    }
    lines.push("These responses are pinned to the exact revision above.");
  }
  if (status === "in_review") {
    const revisionId = review ? stringOrNull(review.artifact_revision_id) : null;
    const requiredIds =
      review && Array.isArray(review.required_participant_ids)
        ? review.required_participant_ids.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
    const respondedIds =
      review && Array.isArray(review.responded_participant_ids)
        ? review.responded_participant_ids.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
    const requestedById = review ? stringOrNull(review.requested_by_id) : null;
    const artifact = Array.isArray(full.artifacts)
      ? full.artifacts.filter(isRecord).find((candidate) => stringOrNull(candidate.id) === target)
      : undefined;
    const reviewStatus = artifact && isRecord(artifact.review_status) ? artifact.review_status : {};
    const currentReviews = Array.isArray(reviewStatus.current)
      ? reviewStatus.current.filter(isRecord)
      : [];
    const ownReview = currentReviews.find(
      (candidate) =>
        stringOrNull(candidate.reviewer_id) === callerId &&
        stringOrNull(candidate.revision_id) === revisionId,
    );
    lines.push(
      "",
      `Review is open on exact artifact revision ${revisionId ?? "unknown"}; the artifact cannot change while responses are collected.`,
    );
    if (callerId && respondedIds.includes(callerId)) {
      if (callerId === requestedById) {
        lines.push(
          `Your approval is recorded: ${stringOrNull(ownReview?.disposition) ?? "approve"}.`,
          `Outstanding responses: ${Math.max(0, requiredIds.length - respondedIds.length)}.`,
          `Available: ${grpCommand(`watch --action=${id}${room}`)}`,
        );
      } else {
        lines.push(
          `Your response is recorded: ${stringOrNull(ownReview?.disposition) ?? "reviewed"}.`,
          "No review response is outstanding for you in this round.",
          `Available: update with ${grpCommand(`act review ${id}${room}`)} or ${grpCommand(`watch --action=${id}${room}`)}.`,
        );
      }
    } else if (callerId && requiredIds.includes(callerId)) {
      lines.push(`Required: ${grpCommand(`act review ${id}${room}`)}`);
    } else {
      lines.push(
        "No review response is required from you in this round.",
        `Available: ${grpCommand(`watch --action=${id}${room}`)}`,
      );
    }
  } else if (status === "awaiting_completion") {
    const decision = linkedCompletionDecision(full, action);
    const seq = decision ? numberOrNull(decision.seq) : null;
    lines.push(
      "",
      seq === null
        ? `This action has a pending group-completion proposal in decision ${stringOrNull(action.completion_decision_id) ?? "unknown"}.`
        : `This action has a pending group-completion proposal in decision ${seq}.`,
      ...completionActionGuidance(action, decision, full, ref, env, event),
    );
  } else if (["completed", "failed", "cancelled"].includes(status)) {
    lines.push("", `Read room changes: ${grpCommand(`read${room}`)}`);
  } else if (mode === "all") {
    const own = participation.find(
      (participant) => stringOrNull(participant.participant_id) === callerId,
    );
    const ownStatus = own ? (stringOrNull(own.status) ?? "pending") : null;
    if (ownStatus === "completed") {
      lines.push(
        "",
        `Your report is recorded. Outstanding reports: ${Math.max(0, required - completed)}.`,
        `Available: ${grpCommand(`watch --action=${id}${room}`)}`,
      );
    } else if (ownStatus === "working") {
      lines.push(
        "",
        "Your report is required. GRP records your report, not proof of external execution.",
        `When done: ${grpCommand(`act complete ${id} --result-text="What happened"${room}`)}`,
      );
    } else if (ownStatus === "pending") {
      lines.push(
        "",
        "Your report is required. There is no take step.",
        `Report when done: ${grpCommand(`act complete ${id} --result-text="What happened"${room}`)}`,
      );
    } else {
      lines.push(
        "",
        "No report is required from you for this action.",
        `Available: ${grpCommand(`watch --action=${id}${room}`)}`,
      );
    }
  } else if (action.recoverable === true && !callerHolds) {
    lines.push(
      "",
      "The holder lease expired; this action is recoverable. GRP does not infer whether the external work stopped.",
      `Next: ${grpCommand(`act takeover ${id} --reason="Resuming after holder lease expiry"${room}`)}`,
    );
  } else if (action.available === true && mode === "handoff") {
    lines.push(
      "",
      "This handoff action is available. The first successful take becomes its holder.",
      `Take it: ${grpCommand(`act take ${id}${room}`)}`,
      `Or keep watching: ${grpCommand(`watch --action=${id}${room}`)}`,
    );
  } else if (callerHolds && mode === "handoff") {
    lines.push(
      "",
      "You hold this handoff action.",
      "Available:",
      completion === "group" && target
        ? `Request exact artifact review: ${grpCommand(`act request-review ${id}${room}`)}`
        : completion === "group"
          ? `Propose completion with the exact result: ${grpCommand(`act complete ${id}${completionResultFlag}${room}`)}`
          : `Finish on your report: ${grpCommand(`act complete ${id}${room}`)}`,
      `Hand to one participant: ${grpCommand(`act handoff ${id} --to=NAME${room}`)}`,
      `Open the next turn to the group: ${grpCommand(`act handoff ${id} --to=group${room}`)}`,
    );
  } else if (mode === "handoff") {
    lines.push(
      "",
      `${holderName} holds this handoff action. Holder-scoped transitions are unavailable to you.`,
      `Available: ${grpCommand(`watch --action=${id}${room}`)}`,
    );
  } else if (callerHolds) {
    lines.push(
      "",
      "You hold this single action. GRP records your report, not proof of external execution.",
      "This action does not block unrelated room work.",
      completion === "group" && target
        ? `Request exact artifact review: ${grpCommand(`act request-review ${id}${room}`)}`
        : completion === "group"
          ? `Propose completion with the exact result: ${grpCommand(`act complete ${id}${completionResultFlag}${room}`)}`
          : `Finish on your report: ${grpCommand(`act complete ${id}${room}`)}`,
    );
  } else {
    lines.push("", `${holderName} holds this single action; unrelated work may continue.`);
  }
  return `${lines.join("\n")}\n`;
}

type ArtifactPatchEdit =
  | { op: "replace"; block: number; text: string }
  | { op: "delete"; block: number }
  | { op: "insert-before" | "insert-after"; block: number; text: string }
  | { op: "replace-text"; find: string; replace: string; expected: number };

interface ArtifactPatchFile {
  baseRevision: string;
  edits: ArtifactPatchEdit[];
}

function exactPatchKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function positivePatchInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function parseArtifactPatchFile(path: string): ArtifactPatchFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `could not read artifact patch JSON from ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) throw new Error("artifact patch file must contain one JSON object");
  exactPatchKeys(parsed, ["base_revision", "edits"], "artifact patch file");
  const baseRevision = stringOrNull(parsed.base_revision)?.trim();
  if (!baseRevision) throw new Error("artifact patch base_revision is required");
  if (!Array.isArray(parsed.edits) || parsed.edits.length < 1 || parsed.edits.length > 50) {
    throw new Error("artifact patch edits must contain between 1 and 50 edits");
  }
  const edits = parsed.edits.map((untrusted, index): ArtifactPatchEdit => {
    if (!isRecord(untrusted)) throw new Error(`artifact patch edit ${index + 1} must be an object`);
    const op = stringOrNull(untrusted.op);
    if (op === "replace") {
      exactPatchKeys(untrusted, ["op", "block", "text"], `artifact patch edit ${index + 1}`);
      if (typeof untrusted.text !== "string") {
        throw new Error(`artifact patch edit ${index + 1} text must be a string`);
      }
      return {
        op,
        block: positivePatchInteger(untrusted.block, `artifact patch edit ${index + 1} block`),
        text: untrusted.text,
      };
    }
    if (op === "delete") {
      exactPatchKeys(untrusted, ["op", "block"], `artifact patch edit ${index + 1}`);
      return {
        op,
        block: positivePatchInteger(untrusted.block, `artifact patch edit ${index + 1} block`),
      };
    }
    if (op === "insert-before" || op === "insert-after") {
      exactPatchKeys(untrusted, ["op", "block", "text"], `artifact patch edit ${index + 1}`);
      if (typeof untrusted.text !== "string") {
        throw new Error(`artifact patch edit ${index + 1} text must be a string`);
      }
      return {
        op,
        block: positivePatchInteger(untrusted.block, `artifact patch edit ${index + 1} block`),
        text: untrusted.text,
      };
    }
    if (op === "replace-text") {
      exactPatchKeys(
        untrusted,
        ["op", "find", "replace", "expected"],
        `artifact patch edit ${index + 1}`,
      );
      if (typeof untrusted.find !== "string" || untrusted.find.length === 0) {
        throw new Error(`artifact patch edit ${index + 1} find must be a non-empty string`);
      }
      if (typeof untrusted.replace !== "string") {
        throw new Error(`artifact patch edit ${index + 1} replace must be a string`);
      }
      return {
        op,
        find: untrusted.find,
        replace: untrusted.replace,
        expected: positivePatchInteger(
          untrusted.expected,
          `artifact patch edit ${index + 1} expected`,
        ),
      };
    }
    throw new Error(
      `artifact patch edit ${index + 1} op must be replace, delete, insert-before, insert-after, or replace-text`,
    );
  });
  return { baseRevision, edits };
}

function artifactPatchBaseMatches(
  supplied: string,
  revisionId: string,
  ordinal: number | undefined,
): boolean {
  return (
    supplied === revisionId ||
    (ordinal !== undefined && (supplied === `rev_${ordinal}` || supplied === `v${ordinal}`))
  );
}

async function roomArtifact(
  args: string[],
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const [operation, id, revisionIdOrRoom, room] = args;
  if (operation === "create") {
    const ref = resolveRoomRef(targetOrCurrent(id, flags, io), flags, io.env);
    const actionId = requireFlag(flags, "action");
    const name = requireFlag(flags, "name");
    const kind = flags.kind ?? "native";
    if (kind !== "native" && kind !== "external") {
      throw new Error("--kind must be native or external");
    }
    const content = artifactContentFromFlags(flags);
    const external = kind === "external" ? externalArtifactReference(flags) : undefined;
    const actionResponse = await experimentalResourceRequest(
      ref,
      `/actions/${encodeURIComponent(actionId)}`,
      flags,
      io,
      "GET",
    );
    const action = actionFromResponse(actionResponse);
    const response = await experimentalResourceRequest(
      ref,
      "/artifacts",
      flags,
      io,
      "POST",
      {
        name,
        kind,
        media_type: flags["media-type"],
        content: kind === "native" ? content : undefined,
        external,
        sha256: flags.sha256,
        action_id: actionId,
        expected_action_revision: requireActionRevision(action),
      },
      false,
    );
    writeArtifactResponse(response, ref, flags, io, "created");
    return;
  }
  if (!id) throw new Error("usage: grp artifact create|read|patch|publish ...");
  if (["wait", "claim", "renew", "release", "review"].includes(operation ?? "")) {
    throw new Error(
      `grp artifact ${operation} is not part of the action-centered surface; use grp act and grp watch`,
    );
  }
  if (operation === "patch") {
    const ref = resolveRoomRef(targetOrCurrent(revisionIdOrRoom, flags, io), flags, io.env);
    const actionId = requireFlag(flags, "action");
    const patch = parseArtifactPatchFile(requireFlag(flags, "file"));
    const exact = await experimentalResourceRequest(
      ref,
      `/artifacts/${encodeURIComponent(id)}`,
      flags,
      io,
      "GET",
    );
    const descriptor = artifactResponseDescriptor(exact);
    if (!descriptor?.resourceRevision || !descriptor.revisionId) {
      throw new Error("host did not return the exact current artifact revision");
    }
    if (!artifactPatchBaseMatches(patch.baseRevision, descriptor.revisionId, descriptor.ordinal)) {
      throw new Error(
        `Artifact changed since patch base ${patch.baseRevision}; current is ${descriptor.revisionId}.\nNothing was written.\nRead again: ${grpCommand(`artifact read ${id}${roomHintArg(ref.slug, ref, io.env)}`)}`,
      );
    }
    const exactRecord = isRecord(exact) ? exact : {};
    const revision = isRecord(exactRecord.revision) ? exactRecord.revision : {};
    const blocks = Array.isArray(revision.blocks) ? revision.blocks.filter(isRecord) : [];
    const operations = patch.edits.map((edit) => {
      if (edit.op === "replace-text") {
        return {
          op: "replace_text",
          find: edit.find,
          replace: edit.replace,
          expected_matches: edit.expected,
        };
      }
      const block = blocks.find((candidate) => numberOrNull(candidate.number) === edit.block);
      if (!block) {
        throw new Error(
          `block ¶${edit.block} is not present in exact base revision ${descriptor.revisionId}`,
        );
      }
      const blockId = stringOrNull(block.id);
      const blockDigest = stringOrNull(block.content_sha256);
      if (!blockId || !blockDigest) throw new Error("host returned an unaddressable native block");
      if (edit.op === "replace") {
        return {
          op: "replace",
          block_id: blockId,
          expected_content_sha256: blockDigest,
          content: edit.text,
        };
      }
      if (edit.op === "delete") {
        return {
          op: "delete",
          block_id: blockId,
          expected_content_sha256: blockDigest,
        };
      }
      return {
        op: edit.op === "insert-before" ? "insert_before" : "insert_after",
        anchor_block_id: blockId,
        content: edit.text,
      };
    });
    let response: unknown;
    try {
      response = await experimentalResourceRequest(
        ref,
        `/artifacts/${encodeURIComponent(id)}/revisions`,
        flags,
        io,
        "POST",
        {
          expected_revision: descriptor.resourceRevision,
          base_revision_id: descriptor.revisionId,
          action_id: actionId,
          operations,
        },
        false,
      );
    } catch (error) {
      if (error instanceof CliHttpError && error.code === "artifact.block_conflict") {
        const serverMessage = error.serverMessage ?? error.message;
        const recovery = serverMessage.includes("exactly one addressable CommonMark block")
          ? "Replace with the first block, then add each remaining block with ordered insert-after edits in the same patch file against the same base revision."
          : "Fix the patch file, then retry from the same base revision.";
        throw new Error(
          [
            "Artifact patch could not be applied to this exact revision.",
            serverMessage,
            "Nothing was written.",
            recovery,
          ].join("\n"),
        );
      }
      if (
        error instanceof CliHttpError &&
        ["artifact.base_conflict", "artifact.precondition_failed"].includes(error.code ?? "")
      ) {
        throw new Error(
          `Artifact changed while you were editing.\nNothing was written.\nRead again: ${grpCommand(`artifact read ${id}${roomHintArg(ref.slug, ref, io.env)}`)}`,
        );
      }
      throw error;
    }
    if (isJson(flags)) {
      io.stdout(renderJson(response));
      return;
    }
    if (flags.quiet === "true") {
      const next = artifactResponseDescriptor(response);
      io.stdout(`${next?.revisionId ?? ""}\n`);
      return;
    }
    const next = artifactResponseDescriptor(response);
    if (!next?.revisionId) throw new Error("host did not return the new artifact revision");
    const oldLabel =
      descriptor.ordinal === undefined ? descriptor.revisionId : `rev_${descriptor.ordinal}`;
    const newLabel = next.ordinal === undefined ? next.revisionId : `rev_${next.ordinal}`;
    const roomArg = roomHintArg(ref.slug, ref, io.env);
    const actionAfterEdit = actionFromResponse(
      await experimentalResourceRequest(
        ref,
        `/actions/${encodeURIComponent(actionId)}`,
        flags,
        io,
        "GET",
      ),
    );
    const finishGuidance =
      actionCompletionFromWire(actionAfterEdit.completion) === "group"
        ? `  Request exact review: ${grpCommand(`act request-review ${actionId}${roomArg}`)}`
        : `  Complete the owning action: ${grpCommand(`act complete ${actionId}${roomArg}`)}`;
    io.stdout(
      `${[
        `Artifact updated: ${oldLabel} → ${newLabel}`,
        `Applied ${patch.edits.length} edits atomically.`,
        "",
        "Available:",
        `  Review the result: ${grpCommand(`artifact read ${id}${roomArg}`)}`,
        `  Continue editing:  ${grpCommand(`artifact patch ${id} --action=${actionId} --file=changes.json${roomArg}`)}`,
        finishGuidance,
      ].join("\n")}\n`,
    );
    return;
  }
  if (["replace", "insert-before", "insert-after", "delete"].includes(operation ?? "")) {
    if (!revisionIdOrRoom) {
      throw new Error(`usage: grp artifact ${operation} <artifact-id> <block-number> [room]`);
    }
    const blockNumber = Number(revisionIdOrRoom);
    if (!Number.isInteger(blockNumber) || blockNumber < 1) {
      throw new Error("block number must be a positive integer from grp artifact read");
    }
    const ref = resolveRoomRef(targetOrCurrent(room, flags, io), flags, io.env);
    const actionId = requireFlag(flags, "action");
    const exact = await experimentalResourceRequest(
      ref,
      `/artifacts/${encodeURIComponent(id)}`,
      flags,
      io,
      "GET",
      undefined,
      false,
    );
    const exactRecord = isRecord(exact) ? exact : {};
    const descriptor = artifactResponseDescriptor(exact);
    if (!descriptor?.resourceRevision || !descriptor.revisionId) {
      throw new Error("host did not return the exact current artifact version");
    }
    const baseRevisionId = descriptor.revisionId;
    const revision = isRecord(exactRecord.revision) ? exactRecord.revision : {};
    const blocks = Array.isArray(revision.blocks) ? revision.blocks.filter(isRecord) : [];
    const block = blocks.find((candidate) => numberOrNull(candidate.number) === blockNumber);
    if (!block) {
      throw new Error(
        `block ¶${blockNumber} is not present in exact base revision ${baseRevisionId}`,
      );
    }
    const blockId = stringOrNull(block.id);
    const blockDigest = stringOrNull(block.content_sha256);
    if (!blockId || !blockDigest) throw new Error("host returned an unaddressable native block");
    const content = operation === "delete" ? undefined : artifactContentFromFlags(flags);
    if (operation !== "delete" && content === undefined) {
      throw new Error(`artifact ${operation} requires --file=PATH or --content=TEXT`);
    }
    const patchOperation =
      operation === "replace"
        ? {
            op: "replace",
            block_id: blockId,
            expected_content_sha256: blockDigest,
            content,
          }
        : operation === "delete"
          ? { op: "delete", block_id: blockId, expected_content_sha256: blockDigest }
          : {
              op: operation === "insert-before" ? "insert_before" : "insert_after",
              anchor_block_id: blockId,
              content,
            };
    const response = await experimentalResourceRequest(
      ref,
      `/artifacts/${encodeURIComponent(id)}/revisions`,
      flags,
      io,
      "POST",
      {
        expected_revision: descriptor.resourceRevision,
        base_revision_id: baseRevisionId,
        action_id: actionId,
        operations: [patchOperation],
      },
      false,
    );
    const actionAfterEdit = actionFromResponse(
      await experimentalResourceRequest(
        ref,
        `/actions/${encodeURIComponent(actionId)}`,
        flags,
        io,
        "GET",
      ),
    );
    writeArtifactResponse(response, ref, flags, io, "updated", actionAfterEdit);
    return;
  }
  const ref = resolveRoomRef(targetOrCurrent(revisionIdOrRoom, flags, io), flags, io.env);
  if (operation === "read") {
    const response = await experimentalResourceRequest(
      ref,
      `/artifacts/${encodeURIComponent(id)}`,
      flags,
      io,
      "GET",
      undefined,
      false,
      flags.version
        ? { version: flags.version }
        : flags["revision-id"]
          ? { revision: flags["revision-id"] }
          : undefined,
    );
    io.stdout(isJson(flags) ? renderJson(response) : renderArtifactRead(response, ref, io.env));
    return;
  }
  if (operation === "publish") {
    const actionId = requireFlag(flags, "action");
    const current = await experimentalResourceRequest(
      ref,
      `/artifacts/${encodeURIComponent(id)}`,
      flags,
      io,
      "GET",
    );
    const descriptor = artifactResponseDescriptor(current);
    if (!descriptor?.resourceRevision || !descriptor.revisionId) {
      throw new Error("host did not return the exact current artifact version");
    }
    const content = artifactContentFromFlags(flags);
    const hasExternal = flags["external-provider"] !== undefined;
    const rewrite = flags.rewrite === "true";
    if (content !== undefined && hasExternal) {
      throw new Error("publish either native content or an external reference, not both");
    }
    if (hasExternal && rewrite) {
      throw new Error("--rewrite applies only to native artifacts");
    }
    const response = await experimentalResourceRequest(
      ref,
      `/artifacts/${encodeURIComponent(id)}/revisions`,
      flags,
      io,
      "POST",
      {
        expected_revision: descriptor.resourceRevision,
        base_revision_id: descriptor.revisionId,
        action_id: actionId,
        ...(content === undefined ? {} : rewrite ? { content } : { sync_content: content }),
        external: hasExternal ? externalArtifactReference(flags) : undefined,
        sha256: flags.sha256,
      },
      false,
    );
    const actionAfterEdit = actionFromResponse(
      await experimentalResourceRequest(
        ref,
        `/actions/${encodeURIComponent(actionId)}`,
        flags,
        io,
        "GET",
      ),
    );
    writeArtifactResponse(response, ref, flags, io, "updated", actionAfterEdit);
    return;
  }
  throw new Error("usage: grp artifact create|read|patch|publish ...");
}

function writeArtifactResponse(
  response: unknown,
  ref: RoomRef,
  flags: Record<string, string>,
  io: RoomCliIo,
  event: string,
  owningAction?: Record<string, unknown>,
): void {
  if (isJson(flags)) {
    io.stdout(renderJson(response));
    return;
  }
  const descriptor = artifactResponseDescriptor(response);
  const record = isRecord(response) ? response : {};
  const artifact = isRecord(record.artifact) ? record.artifact : {};
  if (flags.quiet === "true") {
    io.stdout(`${descriptor?.artifactId ?? ""}\n`);
    return;
  }
  if (!descriptor?.artifactId || !descriptor.revisionId) {
    throw new Error("host did not return an exact artifact descriptor");
  }
  const room = roomHintArg(ref.slug, ref, io.env);
  const ordinal = descriptor.ordinal ?? "?";
  if (event === "created") {
    const action = isRecord(record.action) ? record.action : {};
    const actionId = stringOrNull(action.id) ?? stringOrNull(artifact.action_id) ?? "ACTION_ID";
    io.stdout(
      `${[
        `Artifact ${descriptor.artifactId} created and attached to action ${actionId}.`,
        `Revision: rev_${ordinal}`,
        "",
        "Only the current action holder may edit this native artifact.",
        "Reads label the current revision ¶1, ¶2, ¶3, ...",
        "",
        "Next:",
        `  Read it:       ${grpCommand(`artifact read ${descriptor.artifactId}${room}`)}`,
        `  Edit it:       ${grpCommand(`artifact patch ${descriptor.artifactId} --action=${actionId} --file=changes.json${room}`)}`,
        `  Patch format:  ${grpCommand("artifact patch --help")}`,
      ].join("\n")}\n`,
    );
    return;
  }
  const actionId = stringOrNull(owningAction?.id) ?? stringOrNull(artifact.action_id);
  const finishGuidance =
    actionId && actionCompletionFromWire(owningAction?.completion) === "group"
      ? `Request exact review: ${grpCommand(`act request-review ${actionId}${room}`)}`
      : actionId
        ? `Complete the owning action: ${grpCommand(`act complete ${actionId}${room}`)}`
        : "Continue from the owning action after reviewing these bytes.";
  io.stdout(
    `${[
      `Artifact ${descriptor.artifactId} ${event}: ${stringOrNull(artifact.name) ?? "unnamed"}.`,
      `Current version: v${ordinal}.`,
      `Read numbered blocks: ${grpCommand(`artifact read ${descriptor.artifactId}${room}`)}`,
      finishGuidance,
    ].join("\n")}\n`,
  );
}

function renderArtifactRead(
  response: unknown,
  ref: RoomRef,
  env: Record<string, string | undefined>,
): string {
  const record = isRecord(response) ? response : {};
  const artifact = isRecord(record.artifact) ? record.artifact : {};
  const revision = isRecord(record.revision) ? record.revision : {};
  const artifactId = stringOrNull(artifact.id) ?? "ID";
  const room = roomHintArg(ref.slug, ref, env);
  const ordinal = numberOrNull(revision.ordinal) ?? "?";
  const lines = [
    `Artifact: ${stringOrNull(artifact.name) ?? stringOrNull(artifact.id) ?? "unknown"}`,
    `Version: v${ordinal}`,
    `Revision: rev_${ordinal}`,
  ];
  const claim = isRecord(artifact.claim) ? artifact.claim : null;
  if (claim)
    lines.push(`Current editor: action holder ${stringOrNull(claim.holder_id) ?? "unknown"}.`);
  const blocks = Array.isArray(revision.blocks) ? revision.blocks.filter(isRecord) : [];
  if (blocks.length > 0) {
    lines.push("", "Numbered blocks:");
    for (const block of blocks) {
      const number = numberOrNull(block.number) ?? "?";
      const kind = stringOrNull(block.kind) ?? "block";
      lines.push(`¶${number} [${kind}]`);
      const content = stringOrNull(block.content) ?? "";
      for (const line of content.split("\n")) lines.push(`  ${line}`);
      lines.push("");
    }
    lines.push(
      `Action holder edit: ${grpCommand(`artifact patch ${artifactId} --action=ACTION_ID --file=changes.json${room}`)}`,
    );
  } else if (stringOrNull(revision.content) !== null) {
    lines.push("", "Content:", stringOrNull(revision.content) ?? "");
  } else if (isRecord(revision.external)) {
    lines.push("", `External reference: ${JSON.stringify(revision.external)}`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

interface ArtifactResponseDescriptor {
  artifactId: string;
  resourceRevision?: string;
  revisionId?: string;
  sha256?: string;
  claimEpoch?: string;
  batonMode?: string;
  ordinal?: number;
}

function artifactResponseDescriptor(response: unknown): ArtifactResponseDescriptor | undefined {
  const record = isRecord(response) ? response : {};
  const artifact = isRecord(record.artifact) ? record.artifact : {};
  const claim = isRecord(artifact.claim) ? artifact.claim : {};
  const revision = isRecord(record.revision)
    ? record.revision
    : isRecord(record.current_revision)
      ? record.current_revision
      : {};
  const artifactId = stringOrNull(artifact.id);
  if (!artifactId) return undefined;
  return withoutUndefined({
    artifactId,
    resourceRevision: stringOrNull(artifact.revision) ?? undefined,
    revisionId:
      stringOrNull(revision.id) ?? stringOrNull(artifact.current_revision_id) ?? undefined,
    sha256:
      stringOrNull(revision.sha256) ??
      stringOrNull(revision.content_sha256) ??
      stringOrNull(artifact.current_sha256) ??
      undefined,
    claimEpoch: stringOrNull(claim.epoch) ?? undefined,
    batonMode:
      stringOrNull(artifact.baton_mode) ?? (artifact.exclusive === true ? "enforced" : undefined),
    ordinal: numberOrNull(revision.ordinal) ?? undefined,
  }) as ArtifactResponseDescriptor;
}

async function experimentalResourceRequest(
  ref: RoomRef,
  path: string,
  flags: Record<string, string>,
  io: RoomCliIo,
  method: NonNullable<RequestOptions["method"]>,
  body?: Record<string, unknown>,
  guardRoomState = false,
  query?: Record<string, string | number | undefined>,
): Promise<unknown> {
  const options: RequestOptions = {
    method,
    ...(body ? { body: withoutUndefined(body) } : {}),
    ...(query ? { query } : {}),
    trace: { postAnyway: flags["post-anyway"] === "true" },
  };
  const auth = authFromFlags(flags, ref, io.env);
  if (auth) options.auth = auth;
  const password = flags.password ?? ref.password;
  if (password) options.password = password;
  const idempotencyKey = validatedIdempotencyKey(flags["idempotency-key"]);
  if (idempotencyKey) options.headers = { "idempotency-key": idempotencyKey };
  const expectedRevision = guardRoomState
    ? await guardedExpectedRoomRevision(ref, flags, io)
    : undefined;
  if (expectedRevision) {
    options.headers = {
      ...(options.headers ?? {}),
      "x-grp-expected-room-revision": expectedRevision,
    };
  }
  const response = await requestJson<unknown>(
    ref.baseUrl,
    `/api/rooms/${encodeURIComponent(ref.slug)}${path}`,
    io,
    options,
  );
  // Only a mutation guarded by the caller's previously observed room revision
  // can safely advance that observation. A resource-only claim/renew/release
  // response may contain a newer room token while omitting intervening room
  // content; treating it as a read would launder unseen changes.
  if (expectedRevision && isRecord(response)) {
    const revision = stringOrNull(response.state_revision);
    if (revision) persistObservedStateRevision(ref, revision, io.env);
  }
  return response;
}

function artifactContentFromFlags(flags: Record<string, string>): string | undefined {
  if (flags.file !== undefined && flags.content !== undefined) {
    throw new Error("pass either --file or --content, not both");
  }
  if (flags.file === "-") throw new Error("use --content or a file path for artifact content");
  return flags.file !== undefined ? readFileSync(flags.file, "utf8") : flags.content;
}

function validatedIdempotencyKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const hasControl = [...raw].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!raw || raw.length > 255 || raw.trim() !== raw || hasControl) {
    throw new Error("--idempotency-key must be 1-255 HTTP-safe characters");
  }
  return raw;
}

function externalArtifactReference(flags: Record<string, string>): Record<string, string> {
  const provider = requireFlag(flags, "external-provider");
  const rawUri = requireFlag(flags, "uri");
  const path = requireFlag(flags, "path");
  const providerRevision = requireFlag(flags, "provider-revision");
  const digest = requireFlag(flags, "sha256");
  if (provider !== "git") {
    throw new Error("--external-provider currently supports git only");
  }
  let uri: URL;
  try {
    uri = new URL(rawUri);
  } catch {
    throw new Error("--uri must be a valid HTTPS URL");
  }
  if (
    uri.protocol !== "https:" ||
    uri.username ||
    uri.password ||
    uri.hash ||
    uri.searchParams.toString()
  ) {
    throw new Error("--uri must be credential-free HTTPS without query or fragment");
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(providerRevision)) {
    throw new Error("--provider-revision must be a 40- or 64-hex Git commit");
  }
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("--sha256 must be a lowercase 64-character SHA-256 digest");
  }
  if (!path || path.length > 1_000 || path.startsWith("/") || path.includes("..")) {
    throw new Error("--path must be a bounded relative repository path without '..'");
  }
  return {
    provider,
    uri: uri.toString(),
    path,
    provider_revision: providerRevision,
    // The base candidate is assertion-only and never dereferences an
    // arbitrary provider URI. Provider-verified references require a future
    // bounded adapter; make the weaker trust statement explicit on the wire.
    verification: "asserted",
  };
}

function actionResultFromFlags(flags: Record<string, string>): Record<string, unknown> | undefined {
  const artifactResultFlags = ["result-artifact", "result-revision", "result-sha256"] as const;
  const hasArtifactResult = artifactResultFlags.some((key) => flags[key] !== undefined);
  const resultKinds = [flags["result-text"] !== undefined, hasArtifactResult].filter(
    Boolean,
  ).length;
  if (resultKinds > 1) {
    throw new Error(
      "pass one result form: --result-text or the three --result-artifact/--result-revision/--result-sha256 flags",
    );
  }
  if (hasArtifactResult) {
    const missing = artifactResultFlags.filter((key) => !flags[key]);
    if (missing.length > 0) {
      throw new Error(
        `an artifact result requires --result-artifact, --result-revision, and --result-sha256 (missing: ${missing.map((key) => `--${key}`).join(", ")})`,
      );
    }
    const sha256 = flags["result-sha256"] as string;
    if (!/^[0-9a-f]{64}$/i.test(sha256)) {
      throw new Error("--result-sha256 must be a 64-character hexadecimal SHA-256 digest");
    }
    return {
      kind: "artifact_revision",
      reference: {
        artifact_id: flags["result-artifact"],
        revision_id: flags["result-revision"],
        sha256: sha256.toLowerCase(),
      },
    };
  }
  if (flags["result-text"] !== undefined) {
    return { kind: "text", reference: flags["result-text"] };
  }
  return undefined;
}

function parseOptionalIntegerFlag(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

async function roomStartChoosing(
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const ref = resolveRoomRef(target, flags, io.env);
  const response = await actionRequest(ref, "/start-choosing", flags, io, {
    decision_id: flags["decision-id"],
  });
  if (isJson(flags) || flags.quiet === "true") {
    writeStructured(response, flags, io);
    return;
  }
  io.stdout(renderChoosingStarted(response, ref, io.env));
}

async function roomChoose(
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const ref = resolveRoomRef(target, flags, io.env);
  const choice = resolveChoiceInput(flags);
  let response: unknown;
  try {
    response = await actionRequest(ref, "/choose", flags, io, {
      choice,
      rationale: flags.why ?? flags.reason ?? flags.rationale,
      decision: parseDecisionFlag(flags.decision),
    });
  } catch (error) {
    // Spec 152 W4 — when the server wants a map ballot, name the CLI form
    // here instead of sending the caller to help/trial-and-error.
    if (error instanceof Error && /requires a score\/allocation map ballot/.test(error.message)) {
      throw new Error(`${error.message}\nTry: ${grpCommand('choose --scores="1=5,2=0" [room]')}`);
    }
    throw error;
  }
  if (isJson(flags) || flags.quiet === "true") {
    writeStructured(response, flags, io);
    return;
  }
  io.stdout(renderChoiceRecorded(response, ref, choice, io.env));
}

async function roomAbstain(
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const ref = resolveRoomRef(target, flags, io.env);
  const response = await actionRequest(ref, "/abstain", flags, io, {
    reason: requireFlag(flags, "reason"),
    decision: parseDecisionFlag(flags.decision),
  });
  if (isJson(flags) || flags.quiet === "true") {
    writeStructured(response, flags, io);
    return;
  }
  io.stdout(
    [
      "Abstention recorded.",
      `Room: ${ref.slug}`,
      `Reason: ${flags.reason}`,
      "You may replace it with a choice while the decision remains open.",
      "",
    ].join("\n"),
  );
}

async function roomClose(
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const ref = resolveRoomRef(target, flags, io.env);
  const response = await actionRequest(ref, "/close", flags, io, {
    statement: flags.statement,
  });
  if (isJson(flags) || flags.quiet === "true") {
    writeStructured(response, flags, io, "receipt_hash");
    return;
  }
  io.stdout(renderRoomClosed(response, ref, io.env));
}

async function roomOptions(
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const ref = resolveRoomRef(target, flags, io.env);
  const focusedSeq = parseDecisionFlag(flags.decision);
  // Spec 114 — option text can be document-sized; the default list clips at
  // 200 chars per option and `--full` fetches the uncut slate. Spec 145 — a
  // decision-targeted options read also needs the full room representation so
  // it can resolve the stable room-local seq without a new wire endpoint.
  const wantFull = flags.full === "true";
  const options = readRequestOptions(ref, flags, io.env);
  if (wantFull || focusedSeq !== undefined) {
    options.query = { ...(options.query ?? {}), include: "full" };
  }
  const roomResponse = await requestJson<Record<string, unknown>>(
    ref.baseUrl,
    `/api/rooms/${encodeURIComponent(ref.slug)}`,
    io,
    options,
  );
  const response =
    focusedSeq === undefined
      ? roomResponse
      : { ...roomResponse, decision: requireDecisionBySeq(roomResponse, focusedSeq) };
  if (isJson(flags)) {
    io.stdout(renderJson(optionState(response, focusedSeq)));
    return;
  }
  io.stdout(renderOptions(response, wantFull, roomHintArg(ref.slug, ref, io.env), focusedSeq));
}

async function roomOutcome(
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const ref = resolveRoomRef(target, flags, io.env);
  const response = await requestJson<Record<string, unknown>>(
    ref.baseUrl,
    `/api/rooms/${encodeURIComponent(ref.slug)}/outcome`,
    io,
    readRequestOptions(ref, flags, io.env),
  );
  const outcome = latestOutcome(response);
  const receiptVerification = outcome ? await verifyOutcomeReceiptChain(response, io) : null;
  if (isJson(flags)) {
    // Spec 120 — structured output includes the portable receipt artifacts,
    // not only their hashes, so an agent can archive or independently verify
    // the exact signed chain it just inspected.
    io.stdout(
      renderJson({
        slug: response.slug ?? ref.slug,
        outcome: outcome
          ? {
              question: outcome.question,
              winner: outcome.winner,
              outcome: outcome.outcome,
              status: outcome.winner === null && outcome.outcome === "tied" ? "tied" : "complete",
              ...(outcome.receipt ? { receipt: outcome.receipt } : {}),
              ...(outcome.receiptJws ? { receipt_jws: outcome.receiptJws } : {}),
            }
          : null,
        verification: receiptVerification,
        chain: {
          jwks_url: isRecord(response.verification)
            ? stringOrNull(response.verification.jwks_url)
            : null,
          decisions: Array.isArray(response.decisions) ? response.decisions : [],
          conclusion: response.conclusion ?? null,
        },
      }),
    );
    return;
  }
  if (!outcome) {
    const room = roomHintArg(ref.slug, ref, io.env);
    io.stdout(
      `${[
        "No outcome yet.",
        "",
        "Next:",
        "  Keep monitoring until the decision resolves.",
        `  Wait for what's next: ${grpCommand(`watch${room}`)}`,
        `  Check again: ${grpCommand(`outcome${room}`)}`,
        "",
        "Other commands:",
        `  ${grpCommand(`read${room}`)}`,
        `  ${grpCommand(`options${room}`)}`,
      ].join("\n")}\n`,
    );
    return;
  }
  // Spec 114 (WR6-2) / 115 (WR7-9) — winner and outcome are distinct facts;
  // a tie is a status, never a winning option named "tied".
  const isTied = outcome.winner === null && outcome.outcome === "tied";
  const lines = isTied
    ? [
        "Outcome",
        `Question: ${outcome.question}`,
        "Status: tied — no winner",
        // Spec 115 — receipt self-containment: a runoff whose options are
        // pointers ("X's version") binds NO artifact in the winning receipt.
        "Break it: ask a runoff and propose each tied option\u2019s FULL TEXT (not a label pointing at it) — the runoff winner\u2019s receipt should carry the artifact itself.",
      ]
    : outcome.winner === null
      ? ["Outcome", `Question: ${outcome.question}`, `Status: ${outcome.outcome ?? "no outcome"}`]
      : [
          "Outcome",
          `Question: ${outcome.question}`,
          `Chosen: ${outcome.winner}`,
          "Status: complete",
        ];
  // Spec 125 — receipts verify under the hood on every outcome read; the
  // surface stays quiet when the record checks out and gets loud only when
  // it does not (browser-padlock posture; principal decision narrowing the
  // spec-119/120 render — the invite no longer promises receipts, so nothing
  // is asserted-but-invisible). The full chain, JWS artifacts, hashes, and
  // verification result live in `grp outcome --json` and the docs.
  if (receiptVerification?.status === "failed") {
    lines.push(
      `Verification: failed — ${receiptVerification.reason ?? "the signed record does not match this outcome"}`,
      `Details: ${grpCommand("outcome --json")} — standalone verifier: ${ref.baseUrl}/receipt`,
    );
  }
  // Spec 112 (WR4-6) — while the room stays open, the loop continues past
  // this outcome. Feature-detected; unknown status stays silent.
  if (String(response.status ?? "") === "open") {
    const room = roomHintArg(String(response.slug ?? ref.slug), ref, io.env);
    lines.push(
      "",
      `Room is still open. Next: ${grpCommand(`read${room}`)} — the shared state may have changed; stay with the room.`,
    );
  }
  io.stdout(`${lines.join("\n")}\n`);
}

interface OutcomeReceiptVerification {
  status: "verified" | "unavailable" | "failed";
  receipts: number;
  jwks_url: string | null;
  reason?: string;
}

/** Verify the portable outcome chain without trusting the room that served it. */
async function verifyOutcomeReceiptChain(
  response: Record<string, unknown>,
  io: RoomCliIo,
): Promise<OutcomeReceiptVerification> {
  const verification = isRecord(response.verification) ? response.verification : null;
  const jwksUrl = verification ? stringOrNull(verification.jwks_url) : null;
  const decisions = Array.isArray(response.decisions)
    ? response.decisions.filter(isRecord).filter((decision) => stringOrNull(decision.receipt_hash))
    : [];
  const conclusion = isRecord(response.conclusion) ? response.conclusion : null;
  const conclusionHash = conclusion ? stringOrNull(conclusion.receipt_hash) : null;
  const receiptCount = decisions.length + (conclusionHash ? 1 : 0);

  if (receiptCount === 0) {
    return {
      status: "unavailable",
      receipts: 0,
      jwks_url: jwksUrl,
      reason: "no signed receipt is available yet",
    };
  }
  if (!jwksUrl) {
    return {
      status: "unavailable",
      receipts: receiptCount,
      jwks_url: null,
      reason: "the host did not publish a receipt-verification key",
    };
  }

  try {
    const jwksResponse = await io.fetch(jwksUrl, {
      headers: { accept: "application/json" },
    });
    if (!jwksResponse.ok) {
      return {
        status: "failed",
        receipts: receiptCount,
        jwks_url: jwksUrl,
        reason: `the published signing keys returned HTTP ${jwksResponse.status}`,
      };
    }
    const jwks = (await jwksResponse.json()) as { keys?: unknown[] };
    // Spec 142 (D3) — receipts chain in SEAL order, which under
    // max_open_decisions > 1 can differ from decision-number order. The
    // chain check therefore follows HASH POINTERS, not seq order: each
    // receipt is verified independently, then the links must form one
    // linear chain (exactly one root, no forks, no cycles, every receipt
    // on the path). At one-decision-at-a-time the two orders coincide, so
    // every pre-142 chain verifies identically.
    const chainLinks: { seq: number | null; hash: string; prev: string | null }[] = [];

    for (const decision of decisions) {
      const seq = numberOrNull(decision.seq);
      const receiptHash = stringOrNull(decision.receipt_hash);
      const receiptJws = stringOrNull(decision.receipt_jws);
      const prevHash = stringOrNull(decision.prev_hash);
      if (!receiptHash || !receiptJws) {
        return {
          status: "failed",
          receipts: receiptCount,
          jwks_url: jwksUrl,
          reason: `decision ${seq ?? "?"} has a receipt hash but no compact JWS`,
        };
      }
      chainLinks.push({ seq, hash: receiptHash, prev: prevHash });
      const kid = receiptKid(receiptJws);
      if (!kid) throw new Error(`decision ${seq ?? "?"} receipt has no signing-key id`);
      const verified = await verifyCompactReceipt({
        jws: receiptJws,
        publicKey: publicKeyFromJwks(jwks, kid),
        expectedHash: receiptHash,
      });
      const payload = isRecord(verified.payload) ? verified.payload : null;
      const grp = payload && isRecord(payload.grp) ? payload.grp : null;
      if (!grp || !("prev_hash" in grp)) {
        throw new Error(`decision ${seq ?? "?"} signed payload has no prev_hash`);
      }
      const signedPrevHash = stringOrNull(grp.prev_hash);
      if (signedPrevHash !== prevHash) {
        throw new Error(`decision ${seq ?? "?"} signed prev_hash does not match its chain entry`);
      }
      if (seq !== null && numberOrNull(grp.sequence) !== seq) {
        throw new Error(`decision ${seq} signed sequence does not match its chain entry`);
      }
      // Spec 129 — signatures prove who committed to bytes; agreement replay
      // proves those bytes actually describe unanimity. Legacy/plain receipts
      // remain compatible because the SDK marks them not_applicable.
      const semantic = verifyAgreementReceiptSemantics(verified.payload);
      if (semantic.status === "failed") {
        throw new Error(`decision ${seq ?? "?"} semantic verification failed: ${semantic.reason}`);
      }
      if (semantic.status === "unavailable") {
        return {
          status: "unavailable",
          receipts: receiptCount,
          jwks_url: jwksUrl,
          reason: `decision ${seq ?? "?"}: ${semantic.reason}`,
        };
      }
    }

    // The linked-list walk: one root (prev null), every other prev must name
    // another receipt's hash, no two receipts share a prev (no forks), and
    // walking back from the terminal must visit every receipt (no cycles or
    // islands). The terminal is the receipt no other receipt points at.
    const terminalHash = verifyReceiptChainLinks(chainLinks);

    if (conclusionHash && conclusion) {
      const receiptJws = stringOrNull(conclusion.receipt_jws);
      if (!receiptJws) throw new Error("the conclusion has a receipt hash but no compact JWS");
      if (stringOrNull(conclusion.prev_hash) !== terminalHash) {
        throw new Error("the conclusion does not link to the final decision receipt");
      }
      const kid = receiptKid(receiptJws);
      if (!kid) throw new Error("the conclusion receipt has no signing-key id");
      const verified = await verifyCompactReceipt({
        jws: receiptJws,
        publicKey: publicKeyFromJwks(jwks, kid),
        expectedHash: conclusionHash,
      });
      const payload = isRecord(verified.payload) ? verified.payload : null;
      const grp = payload && isRecord(payload.grp) ? payload.grp : null;
      if (!grp || !("prev_hash" in grp)) {
        throw new Error("the conclusion signed payload has no prev_hash");
      }
      if (stringOrNull(grp.prev_hash) !== stringOrNull(conclusion.prev_hash)) {
        throw new Error("the conclusion signed prev_hash does not match its chain entry");
      }
    }

    return {
      status: "verified",
      receipts: receiptCount,
      jwks_url: jwksUrl,
    };
  } catch (err) {
    return {
      status: "failed",
      receipts: receiptCount,
      jwks_url: jwksUrl,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Spec 142 (D3) — assert the receipts form one linear hash chain regardless
 * of enumeration order, and return the terminal (chain-head) hash. Throws an
 * instructive error on any root/fork/broken-link/cycle defect.
 */
function verifyReceiptChainLinks(
  links: { seq: number | null; hash: string; prev: string | null }[],
): string | null {
  if (links.length === 0) return null;
  const byHash = new Map(links.map((l) => [l.hash, l]));
  if (byHash.size !== links.length) throw new Error("two receipts share the same receipt hash");
  const roots = links.filter((l) => l.prev === null);
  if (roots.length !== 1) {
    throw new Error(
      roots.length === 0
        ? "the receipt chain has no root (no receipt with a null prev_hash)"
        : `the receipt chain has ${roots.length} roots — receipts ${roots.map((l) => l.seq ?? "?").join(", ")} all claim to start the chain`,
    );
  }
  const seenPrev = new Set<string>();
  for (const l of links) {
    if (l.prev === null) continue;
    if (!byHash.has(l.prev)) {
      throw new Error(`decision ${l.seq ?? "?"} links to a receipt hash that is not in the chain`);
    }
    if (seenPrev.has(l.prev)) {
      throw new Error("the receipt chain forks: two receipts link to the same prior receipt");
    }
    seenPrev.add(l.prev);
  }
  const terminal = links.find((l) => !seenPrev.has(l.hash));
  if (!terminal) throw new Error("the receipt chain has no terminal receipt (a cycle)");
  let cursor: { hash: string; prev: string | null } | undefined = terminal;
  let visited = 0;
  while (cursor) {
    visited += 1;
    if (visited > links.length) throw new Error("the receipt chain contains a cycle");
    cursor = cursor.prev === null ? undefined : byHash.get(cursor.prev);
  }
  if (visited !== links.length) {
    throw new Error("the receipt chain does not connect every receipt into one sequence");
  }
  return terminal.hash;
}

async function roomMembers(
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const ref = resolveRoomRef(target, flags, io.env);
  const response = await requestJson<Record<string, unknown>>(
    ref.baseUrl,
    `/api/rooms/${encodeURIComponent(ref.slug)}`,
    io,
    fullReadRequestOptions(ref, flags, io.env),
  );
  if (isJson(flags)) {
    io.stdout(
      renderJson({ slug: response.slug ?? ref.slug, members: response.participants ?? [] }),
    );
    return;
  }
  io.stdout(renderMembers(response, ref));
}

async function roomMemberSetRole(
  participant: string | undefined,
  role: string | undefined,
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  if (!participant || !role) {
    throw new Error("usage: grp members set-role <member> <participant|observer> [room]");
  }
  const normalizedRole = normalizeMemberRole(role);
  const ref = resolveRoomRef(target, flags, io.env);
  const response = await requestJson<Record<string, unknown>>(
    ref.baseUrl,
    `/api/rooms/${encodeURIComponent(ref.slug)}/members/${encodeURIComponent(participant)}`,
    io,
    {
      method: "PATCH",
      auth: { kind: "token", token: memberManagerToken(ref, flags) },
      body: {
        role: normalizedRole,
      },
    },
  );
  if (isJson(flags)) {
    io.stdout(renderJson(response));
    return;
  }
  io.stdout(renderMemberRoleUpdated(response, ref, io.env));
}

async function roomSettings(
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const ref = resolveRoomRef(target, flags, io.env);
  const response = await requestJson<Record<string, unknown>>(
    ref.baseUrl,
    `/api/rooms/${encodeURIComponent(ref.slug)}`,
    io,
    fullReadRequestOptions(ref, flags, io.env),
  );
  if (isJson(flags)) {
    io.stdout(renderJson({ slug: response.slug ?? ref.slug, config: response.config ?? null }));
    return;
  }
  io.stdout(renderSettings(response, ref));
}

async function roomSettingsSet(
  target: string | undefined,
  key: string | undefined,
  value: string | undefined,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  if (!key || !value) {
    throw new Error("usage: grp settings set <setting> <value> [room]");
  }
  const settings = parseSettingsPatch(key, value, flags);
  const ref = resolveRoomRef(targetOrCurrent(target, flags, io), flags, io.env);
  const response = await requestJson<Record<string, unknown>>(
    ref.baseUrl,
    `/api/rooms/${encodeURIComponent(ref.slug)}/settings`,
    io,
    {
      method: "PATCH",
      auth: { kind: "token", token: settingsManagerToken(ref, flags) },
      body: {
        settings,
      },
    },
  );
  if (isJson(flags)) {
    io.stdout(renderJson(response));
    return;
  }
  io.stdout(renderSettingsUpdated(response, ref));
}

async function roomInvite(
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const ref = resolveRoomRef(target, flags, io.env);
  const name = flags.name ?? flags.label;
  if (!name) {
    await roomInviteList(target, flags, io);
    return;
  }
  const response = await requestJson<Record<string, unknown>>(
    ref.baseUrl,
    `/api/rooms/${encodeURIComponent(ref.slug)}/invites`,
    io,
    {
      method: "POST",
      auth: { kind: "token", token: inviteManagerToken(ref, flags) },
      body: withoutUndefined({
        label: name,
        role: flags.role,
        expected: parseOptionalBool(flags.expected),
        expires_at: flags["expires-at"],
        binding: parseInviteBindingFlags(flags),
      }),
    },
  );
  if (isJson(flags)) {
    io.stdout(renderJson(response));
    return;
  }
  io.stdout(renderCreatedInvite(response, ref, io.env));
}

async function roomInviteList(
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const ref = resolveRoomRef(target, flags, io.env);
  const response = await requestJson<{ slug?: string; invites?: unknown[] }>(
    ref.baseUrl,
    `/api/rooms/${encodeURIComponent(ref.slug)}/invites`,
    io,
    { auth: { kind: "token", token: inviteManagerToken(ref, flags) } },
  );
  if (isJson(flags)) {
    io.stdout(renderJson(response));
    return;
  }
  io.stdout(renderInviteList(response, ref, io.env));
}

async function roomInviteRevoke(
  target: string,
  code: string | undefined,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  if (!code) throw new Error("invite code is required: grp invite revoke <code>");
  const ref = resolveRoomRef(target, flags, io.env);
  const response = await requestJson<Record<string, unknown>>(
    ref.baseUrl,
    `/api/rooms/${encodeURIComponent(ref.slug)}/invites/${encodeURIComponent(code)}`,
    io,
    {
      method: "DELETE",
      auth: { kind: "token", token: inviteManagerToken(ref, flags) },
    },
  );
  if (isJson(flags)) {
    io.stdout(renderJson(response));
    return;
  }
  const invite = isRecord(response.invite) ? response.invite : null;
  const label = invite ? stringOrNull(invite.label) : null;
  io.stdout(`revoked ${code}${label ? ` (${label})` : ""}\n`);
}

async function roomEvents(
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const ref = resolveRoomRef(target, flags, io.env);
  // Raw stream (audit). Fetch every page by default: the gap-recovery endpoint
  // deliberately caps one response at 1,000 events, while audit timelines can
  // be much longer. An explicit --limit remains a total-result cap.
  if (flags.jsonl === "true" || isJson(flags)) {
    const response = await fetchAllRoomEvents(ref, flags, io);
    const events = response.events ?? [];
    if (flags.jsonl === "true") {
      for (const event of events) io.stdout(`${JSON.stringify(event)}\n`);
    } else {
      io.stdout(renderJson(response));
    }
    return;
  }
  // Spec 115 (WR7-4) — the human timeline is the room's story, not its
  // database: the full delta from event 0, name-keyed with joined discussion
  // text, one compact line per entry. Raw payloads stay behind --jsonl.
  // Spec 193 — the accepted timeline bounds apply to this human path too;
  // previously they were honored only by JSON/JSONL while plain output always
  // fetched the entire room.
  const rawLimit = flags.limit;
  const totalLimit = rawLimit === undefined ? Number.POSITIVE_INFINITY : Number(rawLimit);
  if (rawLimit !== undefined && (!Number.isInteger(totalLimit) || totalLimit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  const rawSince = flags["since-seq"];
  const sinceSeq = rawSince === undefined ? 0 : Number(rawSince);
  if (!Number.isInteger(sinceSeq) || sinceSeq < 0) {
    throw new Error("--since-seq must be a non-negative integer");
  }
  const options = readRequestOptions(ref, flags, io.env);
  options.query = { ...(options.query ?? {}), since: sinceSeq };
  const response = await requestJson<Record<string, unknown>>(
    ref.baseUrl,
    `/api/rooms/${encodeURIComponent(ref.slug)}`,
    io,
    options,
  );
  const entries = (Array.isArray(response.new) ? response.new.filter(isRecord) : []).slice(
    0,
    totalLimit,
  );
  if (entries.length === 0) {
    // Old host (no delta support) — fall back to the raw line rendering.
    const rawResponse = await fetchAllRoomEvents(ref, flags, io);
    for (const event of rawResponse.events ?? []) io.stdout(`${renderEventLine(event)}\n`);
    return;
  }
  const lines = [`Timeline for ${String(response.slug ?? ref.slug)}`];
  for (const entry of entries) {
    const at = stringOrNull(entry.at);
    const stamp = at ? `${at.slice(11, 16)} ` : "";
    for (const [i, line] of renderDeltaEntry(entry).entries()) {
      lines.push(i === 0 ? `  ${stamp}${line.trimStart()}` : line);
    }
  }
  io.stdout(`${lines.join("\n")}\n`);
}

const EVENT_PAGE_SIZE = 1000;

/** Fetch a complete raw room timeline using the endpoint's monotonic seq cursor. */
async function fetchAllRoomEvents(
  ref: RoomRef,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<{ slug: string; events: RoomEvent[] }> {
  const rawLimit = flags.limit;
  const totalLimit = rawLimit === undefined ? Number.POSITIVE_INFINITY : Number(rawLimit);
  if (rawLimit !== undefined && (!Number.isInteger(totalLimit) || totalLimit < 1)) {
    throw new Error("--limit must be a positive integer");
  }

  const rawSince = flags["since-seq"];
  let cursor = rawSince === undefined ? undefined : Number(rawSince);
  if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 0)) {
    throw new Error("--since-seq must be a non-negative integer");
  }

  const events: RoomEvent[] = [];
  let slug = ref.slug;
  let firstPage = true;
  while (events.length < totalLimit) {
    const pageLimit = Math.min(EVENT_PAGE_SIZE, totalLimit - events.length);
    const options = eventRequestOptions(ref, flags, io.env);
    options.query = {
      ...(options.query ?? {}),
      limit: pageLimit,
      ...(cursor === undefined ? {} : { since_seq: cursor }),
    };
    if (!firstPage) options.query.since_event_id = undefined;

    const page = await requestJson<{ slug?: string; events?: RoomEvent[] }>(
      ref.baseUrl,
      `/api/rooms/${encodeURIComponent(ref.slug)}/events`,
      io,
      options,
    );
    slug = page.slug ?? slug;
    const next = page.events ?? [];
    if (next.length === 0) break;
    events.push(...next.slice(0, totalLimit - events.length));
    if (events.length >= totalLimit || next.length < pageLimit) break;

    const lastSeq = next.at(-1)?.seq;
    if (
      typeof lastSeq !== "number" ||
      !Number.isInteger(lastSeq) ||
      (cursor !== undefined && lastSeq <= cursor)
    ) {
      throw new Error("timeline pagination did not advance its event cursor");
    }
    cursor = lastSeq;
    firstPage = false;
  }
  return { slug, events };
}

/**
 * Spec 112 (WR4-4a) — `--until=needed`: wake when the room needs you. GRP has
 * no turns; everyone acts concurrently while a question is open. The old
 * my-turn spellings stay as silent, undocumented aliases.
 */
const NEEDED_UNTIL_VALUES = new Set(["needed", "my-turn", "my_turn"]);
const FUTURE_RESOLVED_UNTIL_VALUES = new Set([
  "next-resolved",
  "complete",
  "decision.completed",
  "closed",
  "room.concluded",
]);

/** Spec 113 — the substantive event types that wake a bare `grp watch`.
 * decision.voting_phase_started folds into the decision-opened wake. */
const WAKE_EVENT_TYPES = new Set([
  "discussion.posted",
  "option.proposed",
  "choice.abstained",
  "decision.opened",
  "decision.revised",
  "decision.voting_phase_started",
  "decision.completed",
  "action.created",
  "action.claimed",
  "action.participant_started",
  "action.participant_completed",
  "action.handed_off",
  "action.taken_over",
  "action.completion_proposed",
  "action.resumed",
  "action.completed",
  "action.failed",
  "action.cancelled",
  "room.concluded",
]);

/**
 * Spec 136 — a foreground agent wait must be re-entrant. 110 seconds is long
 * enough for the host's ordinary long poll while still returning control
 * before tool runtimes tend to park the command as an orphaned background
 * task. Recorders remain explicitly continuous through --jsonl, and scripts
 * can opt back into an unbounded foreground wait with --timeout=0.
 */
export const DEFAULT_FOREGROUND_WATCH_TIMEOUT_SECONDS = 110;

/** Parse --timeout=N (seconds, 1-3600); null = explicitly/no default bound. */
export function parseWatchTimeout(
  raw: string | undefined,
  defaultSeconds: number | null = null,
): number | null {
  if (raw === undefined || raw === "" || raw === "true") return defaultSeconds;
  const n = Number(raw);
  if (n === 0) return null;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(3600, Math.max(1, Math.floor(n)));
}

async function roomWatch(
  target: string,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const ref = resolveRoomRef(target, flags, io.env);
  const selectors = [flags.action, flags.artifact, flags.decision].filter(
    (value): value is string => value !== undefined,
  );
  if (selectors.length > 1) {
    throw new Error("watch accepts only one of --action, --artifact, or --decision");
  }
  if (selectors.length === 1) {
    if (flags.jsonl === "true" || flags.until !== undefined) {
      throw new Error("a filtered watch cannot be combined with --jsonl or --until");
    }
    await roomFilteredWatch(ref, flags, io);
    return;
  }
  // Spec 113 — --jsonl stays the raw flight-recorder stream: every event as
  // JSON, no wake logic, and it NEVER advances the stored read mark. A
  // background recorder that ate the foreground's delta would be the
  // client-side version of the shared-cursor bug spec 113 refused to build
  // server-side — the recorder and the acting session must keep separate
  // cursors, so only foreground reads/wakes move the mark.
  if (flags.jsonl === "true") {
    await watchJsonlStream(ref, flags, io);
    return;
  }
  if (flags.until !== undefined && NEEDED_UNTIL_VALUES.has(flags.until)) {
    // --until=needed is the needs-me wake alone (script filter; it IS the
    // floor). It never advances the mark: no event seq is involved.
    await watchUntilNeeded(ref, flags, io);
    return;
  }
  if (flags.until === "resolved") {
    const resolved = await watchResolutionAtStart(ref, flags, io);
    if (resolved) {
      io.stdout(resolved);
      return;
    }
  }

  // Spec 113 item 2 — unified watch. Bare `grp watch` blocks until the first
  // substantive event by someone ELSE (or the room needing the caller);
  // --until=resolved keeps its stream filter. Either way the needs-me
  // long-poll runs alongside the stream (FLOOR RULE, WR5-1): an open decision
  // awaiting the caller's choice always wakes the watcher, whatever filter is
  // armed — the right watch mode must never be a judgment call again.
  const wakeMode = flags.until === undefined;
  const mark = rememberedLastSeenSeq(ref, io.env);
  // Spec 109 (WR2-11) — the stream backfills history; only events past the
  // baseline may stop the watch. Wake mode baselines on the stored mark when
  // one exists (unseen activity wakes immediately), else the head at connect.
  const headSeq = wakeMode && mark !== undefined ? null : await fetchWatchHeadSeq(ref, flags, io);
  const resumeSeq = mark ?? headSeq;
  const state: WatchStreamState = {
    headSeq,
    startedAtMs: Date.now(),
    lastSeenSeq: resumeSeq,
    lastEventId: flags["since-event-id"] ?? flags["last-event-id"] ?? null,
    ...(wakeMode
      ? { wake: { baselineSeq: mark ?? headSeq, identity: callerIdentity(ref, io.env) } }
      : {}),
  };

  const controller = new AbortController();
  const racers: Promise<WatchWake>[] = [watchEventStream(ref, flags, io, state, controller.signal)];
  const auth = authFromFlags(flags, ref, io.env);
  if (auth) {
    racers.push(
      wakeMode
        ? activityWakePoll(ref, io, auth, mark ?? headSeq ?? 0, controller.signal)
        : needsMeWakePoll(ref, flags, io, auth, controller.signal),
    );
  }
  // Spec 116 (WR8-4) — native bounded wait. Harnesses that block sleep/
  // timeout chaining built read-polling monitors instead (run 8's Argon);
  // --timeout=N gives them a clean "nothing new" exit 0.
  const timeoutSeconds = parseWatchTimeout(
    flags.timeout,
    wakeMode ? DEFAULT_FOREGROUND_WATCH_TIMEOUT_SECONDS : null,
  );
  if (timeoutSeconds !== null) {
    racers.push(
      new Promise<WatchWake>((resolve) => {
        const timer = setTimeout(
          () => resolve({ kind: "timeout", seconds: timeoutSeconds }),
          timeoutSeconds * 1000,
        );
        if (typeof timer.unref === "function") timer.unref();
      }),
    );
  }
  let wake: WatchWake;
  try {
    wake = await Promise.race(racers);
  } finally {
    controller.abort();
    for (const racer of racers) racer.catch(() => undefined);
  }

  const room = roomHintArg(ref.slug, ref, io.env);
  if (wake.kind === "timeout") {
    // Spec 231 — use the light read to surface action recovery and size the
    // next wait, but do not interpret an idle room as a demand for a decision.
    // `grp read` is the neutral reassessment surface.
    const watchPhase = await roomWatchPhase(
      ref,
      flags,
      io,
      state.lastSeenSeq ?? mark ?? headSeq ?? 0,
    );
    if (watchPhase.recoverableAction && watchPhase.full) {
      io.stdout(
        renderActionState(
          watchPhase.recoverableAction,
          ref,
          io.env,
          watchPhase.full,
          "recoverable",
        ),
      );
      return;
    }
    const tail = watchTimeoutTail(room, watchPhase.closesInSeconds);
    io.stdout(
      `Nothing new after ${wake.seconds}s \u2014 reassess with ${grpCommand(`read${room}`)}, or ${tail}.\n`,
    );
    return;
  }
  if (wake.kind === "action_recovery") {
    await writeActionResponse(wake.response, ref, flags, io, "recoverable");
    return;
  }
  if (wake.kind === "action_required") {
    await writeActionResponse(wake.response, ref, flags, io, "requires you");
    return;
  }
  if (wake.kind === "needed") {
    io.stdout(
      renderNeedsYouWake(
        wake.question,
        room,
        wake.resolved,
        wake.votingEndsAt,
        wake.decisionSeq,
        wake.completionActionId,
      ),
    );
    return;
  }
  if (wake.kind === "working") {
    io.stdout(
      `${[
        `Working state changed (${wake.change}) for participant ${wake.participantId}.`,
        `Signal: ${wake.signalId}`,
        `Read the current active set: ${grpCommand(`read${room}`)}`,
      ].join("\n")}\n`,
    );
    return;
  }
  // Spec 113 — for pointer-only wakes (discussion, option: the wake line
  // names WHO but the text lives in the delta) the mark parks JUST BEFORE
  // the wake event, so the follow-up `grp read` includes it. The cost is
  // deliberate: a seat that acts without reading is re-woken until it reads.
  // Spec 116 (WR8-2) — full-content wakes are consumed: the mark advances
  // THROUGH the event, so a watch-after-watch with no read between never
  // re-fires the same event. Originally decision.completed/room.concluded
  // (run 8's duplicate wakes); spec 125 (WR12-2) adds decision.opened and
  // decision.voting_phase_started — since spec 117 their wake lines carry
  // the event's whole payload (actor + question), and run 12's Argon seat
  // was re-woken by the same choosing-started event after it voted without
  // reading (the wake had already said everything the delta would).
  if (wake.event) {
    const fullContentWake =
      wake.event.event_type === "decision.completed" ||
      wake.event.event_type === "room.concluded" ||
      wake.event.event_type === "decision.opened" ||
      wake.event.event_type === "decision.voting_phase_started";
    persistLastSeenSeq(ref, fullContentWake ? wake.event.seq : wake.event.seq - 1, io.env);
  }
  io.stdout(await renderEventWake(wake, ref, flags, io, room));
}

type FilteredWatchWake =
  | {
      kind: "action";
      response: unknown;
      reason: "assigned" | "available" | "terminal" | "recoverable";
    }
  | {
      kind: "artifact";
      response: unknown;
      fromRevisionId: string;
      revisionChanged: boolean;
    }
  | { kind: "decision"; decision: Record<string, unknown> }
  | { kind: "direct_action"; action: Record<string, unknown> }
  | Extract<WatchWake, { kind: "needed" } | { kind: "timeout" }>;

async function roomFilteredWatch(
  ref: RoomRef,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const controller = new AbortController();
  const initialFull = await fullRoomForResource(ref, flags, io);
  const racers: Promise<FilteredWatchWake>[] = [];
  if (flags.action) racers.push(pollActionWatch(ref, flags.action, flags, io, controller.signal));
  else if (flags.artifact) {
    racers.push(pollArtifactWatch(ref, flags.artifact, flags, io, controller.signal));
  } else if (flags.decision) {
    racers.push(pollDecisionWatch(ref, flags.decision, flags, io, controller.signal));
  }
  racers.push(pollDirectActionObligation(ref, initialFull, flags, io, controller.signal));
  const auth = authFromFlags(flags, ref, io.env);
  if (auth) {
    racers.push(
      needsMeWakePoll(ref, flags, io, auth, controller.signal) as Promise<FilteredWatchWake>,
    );
  }
  const timeoutSeconds = parseWatchTimeout(flags.timeout, DEFAULT_FOREGROUND_WATCH_TIMEOUT_SECONDS);
  if (timeoutSeconds !== null) {
    racers.push(
      new Promise<FilteredWatchWake>((resolve) => {
        const timer = setTimeout(
          () => resolve({ kind: "timeout", seconds: timeoutSeconds }),
          timeoutSeconds * 1000,
        );
        if (typeof timer.unref === "function") timer.unref();
      }),
    );
  }
  let wake: FilteredWatchWake;
  try {
    wake = await Promise.race(racers);
  } finally {
    controller.abort();
    for (const racer of racers) racer.catch(() => undefined);
  }
  const room = roomHintArg(ref.slug, ref, io.env);
  if (wake.kind === "timeout") {
    const target = flags.action
      ? `action ${flags.action}`
      : flags.artifact
        ? `artifact ${flags.artifact}`
        : `decision ${flags.decision}`;
    io.stdout(`Nothing relevant changed for ${target} after ${wake.seconds}s.\n`);
    return;
  }
  if (wake.kind === "needed") {
    io.stdout(
      renderNeedsYouWake(
        wake.question,
        room,
        wake.resolved,
        wake.votingEndsAt,
        wake.decisionSeq,
        wake.completionActionId,
      ),
    );
    return;
  }
  if (wake.kind === "direct_action") {
    io.stdout(
      renderActionState(
        wake.action,
        ref,
        io.env,
        await fullRoomForResource(ref, flags, io),
        "is now yours",
      ),
    );
    return;
  }
  if (wake.kind === "action") {
    await writeActionResponse(wake.response, ref, flags, io, wake.reason);
    return;
  }
  if (wake.kind === "artifact") {
    const descriptor = artifactResponseDescriptor(wake.response);
    io.stdout(
      `${[
        wake.revisionChanged
          ? `Artifact ${descriptor?.artifactId ?? flags.artifact} advanced from ${wake.fromRevisionId} to v${descriptor?.ordinal ?? "?"}.`
          : `Artifact ${descriptor?.artifactId ?? flags.artifact} state changed at v${descriptor?.ordinal ?? "?"}.`,
        `Next: ${grpCommand(`artifact read ${descriptor?.artifactId ?? flags.artifact}${room}`)}`,
      ].join("\n")}\n`,
    );
    return;
  }
  const seq = numberOrNull(wake.decision.seq) ?? flags.decision;
  io.stdout(
    `Decision ${seq} resolved.\n\nNext: ${grpCommand(`read${room}`)}\nThen: ${grpCommand(`outcome${room}`)}\n`,
  );
}

async function pollActionWatch(
  ref: RoomRef,
  actionId: string,
  flags: Record<string, string>,
  io: RoomCliIo,
  signal: AbortSignal,
): Promise<FilteredWatchWake> {
  while (!signal.aborted) {
    const response = await experimentalResourceRequest(
      ref,
      `/actions/${encodeURIComponent(actionId)}`,
      flags,
      io,
      "GET",
    );
    const action = actionFromResponse(response);
    const status = stringOrNull(action.status) ?? "unknown";
    if (["completed", "failed", "cancelled"].includes(status)) {
      return { kind: "action", response, reason: "terminal" };
    }
    if (status === "in_review") {
      const callerId = callerIdentity(ref, io.env).participantId;
      const review = isRecord(action.review) ? action.review : null;
      const requiredIds =
        review && Array.isArray(review.required_participant_ids)
          ? review.required_participant_ids.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
      const respondedIds =
        review && Array.isArray(review.responded_participant_ids)
          ? review.responded_participant_ids.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
      if (callerId && requiredIds.includes(callerId) && !respondedIds.includes(callerId)) {
        return { kind: "action", response, reason: "assigned" };
      }
      await abortablePollDelay(signal);
      continue;
    }
    if (status === "awaiting_completion") {
      await abortablePollDelay(signal);
      continue;
    }
    const callerId = callerIdentity(ref, io.env).participantId;
    const holderId = stringOrNull(action.holder_id) ?? stringOrNull(action.assignee_id);
    if (callerId && holderId === callerId) {
      return { kind: "action", response, reason: "assigned" };
    }
    const mode = actionModeFromWire(action.mode);
    if (mode === "handoff" && action.available === true) {
      return { kind: "action", response, reason: "available" };
    }
    if (mode === "all" && callerId) {
      const participants = Array.isArray(action.participants)
        ? action.participants.filter(isRecord)
        : [];
      const own = participants.find(
        (participant) => stringOrNull(participant.participant_id) === callerId,
      );
      const ownStatus = own ? stringOrNull(own.status) : null;
      if (ownStatus === "pending" || ownStatus === "working") {
        return { kind: "action", response, reason: "assigned" };
      }
    }
    if (action.recoverable === true) {
      return { kind: "action", response, reason: "recoverable" };
    }
    await abortablePollDelay(signal);
  }
  return neverSettles();
}

async function pollArtifactWatch(
  ref: RoomRef,
  artifactId: string,
  flags: Record<string, string>,
  io: RoomCliIo,
  signal: AbortSignal,
): Promise<FilteredWatchWake> {
  let baselineRevisionId: string | null = null;
  let baselineState: string | null = null;
  while (!signal.aborted) {
    const response = await experimentalResourceRequest(
      ref,
      `/artifacts/${encodeURIComponent(artifactId)}`,
      flags,
      io,
      "GET",
      undefined,
      false,
      { view: "metadata" },
    );
    const descriptor = artifactResponseDescriptor(response);
    if (!descriptor?.revisionId) throw new Error("host did not return an artifact version");
    const state = [
      descriptor.resourceRevision ?? "",
      descriptor.revisionId,
      descriptor.claimEpoch ?? "",
    ].join(":");
    if (baselineState === null) {
      baselineState = state;
      baselineRevisionId = descriptor.revisionId;
    } else if (state !== baselineState) {
      return {
        kind: "artifact",
        response,
        fromRevisionId: baselineRevisionId ?? descriptor.revisionId,
        revisionChanged: descriptor.revisionId !== baselineRevisionId,
      };
    }
    await abortablePollDelay(signal);
  }
  return neverSettles();
}

async function pollDecisionWatch(
  ref: RoomRef,
  selector: string,
  flags: Record<string, string>,
  io: RoomCliIo,
  signal: AbortSignal,
): Promise<FilteredWatchWake> {
  while (!signal.aborted) {
    const full = await fullRoomForResource(ref, flags, io);
    const decisions = Array.isArray(full.decisions) ? full.decisions.filter(isRecord) : [];
    const numeric = Number(selector);
    const decision = decisions.find(
      (candidate) =>
        stringOrNull(candidate.id) === selector ||
        (Number.isInteger(numeric) && numberOrNull(candidate.seq) === numeric),
    );
    if (!decision) throw new Error(`decision ${selector} was not found in this room`);
    if (
      stringOrNull(decision.status) === "resolved" ||
      stringOrNull(decision.resolved_at) !== null
    ) {
      return { kind: "decision", decision };
    }
    await abortablePollDelay(signal);
  }
  return neverSettles();
}

async function pollDirectActionObligation(
  ref: RoomRef,
  initialFull: Record<string, unknown>,
  flags: Record<string, string>,
  io: RoomCliIo,
  signal: AbortSignal,
): Promise<FilteredWatchWake> {
  const callerId = callerIdentity(ref, io.env).participantId;
  if (!callerId) return neverSettles();
  const initial = Array.isArray(initialFull.actions) ? initialFull.actions.filter(isRecord) : [];
  const directAction = (actions: Record<string, unknown>[]) =>
    actions.find((action) => {
      const status = stringOrNull(action.status) ?? "unknown";
      if (["awaiting_completion", "completed", "failed", "cancelled"].includes(status)) {
        return false;
      }
      const holder = stringOrNull(action.holder_id) ?? stringOrNull(action.assignee_id);
      if (holder === callerId) return true;
      if (action.mode !== "all") return false;
      const participants = Array.isArray(action.participants)
        ? action.participants.filter(isRecord)
        : [];
      const own = participants.find(
        (participant) => stringOrNull(participant.participant_id) === callerId,
      );
      return own?.status === "pending" || own?.status === "working";
    });
  const initialDirect = directAction(initial);
  if (initialDirect) return { kind: "direct_action", action: initialDirect };
  while (!signal.aborted) {
    const full = await fullRoomForResource(ref, flags, io);
    const actions = Array.isArray(full.actions) ? full.actions.filter(isRecord) : [];
    const direct = directAction(actions);
    if (direct) return { kind: "direct_action", action: direct };
    await abortablePollDelay(signal);
  }
  return neverSettles();
}

function abortablePollDelay(signal: AbortSignal, ms = 1_500): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * `--until=resolved` is state-aware: if the room is already at a resolved
 * boundary, report that boundary immediately. A room with any open decision
 * keeps waiting even when an older decision is resolved. `next-resolved`
 * deliberately skips this preflight and retains the future-event behavior.
 */
async function watchResolutionAtStart(
  ref: RoomRef,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<string | null> {
  const options = readRequestOptions(ref, flags, io.env);
  options.query = { ...(options.query ?? {}), include: "full" };
  const response = await requestJson<Record<string, unknown>>(
    ref.baseUrl,
    `/api/rooms/${encodeURIComponent(ref.slug)}`,
    io,
    options,
  );
  const status = stringOrNull(response.status);
  const room = roomHintArg(String(response.slug ?? ref.slug), ref, io.env);
  if (
    status === "concluded" ||
    status === "closed" ||
    status === "expired" ||
    stringOrNull(response.concluded_at) !== null
  ) {
    return `Room already concluded.\n\nNext:\n  ${grpCommand(`outcome${room}`)}\n`;
  }

  const decisions: Record<string, unknown>[] = [];
  const addDecision = (value: unknown) => {
    if (isRecord(value) && !decisions.includes(value)) decisions.push(value);
  };
  addDecision(response.decision);
  addDecision(response.active_decision);
  if (Array.isArray(response.decisions_open)) response.decisions_open.forEach(addDecision);
  if (Array.isArray(response.decisions)) response.decisions.forEach(addDecision);
  const isResolved = (decision: Record<string, unknown>) =>
    stringOrNull(decision.status) === "resolved" ||
    stringOrNull(decision.resolved_at) !== null ||
    stringOrNull(decision.receipt_hash) !== null;
  if (decisions.some((decision) => !isResolved(decision))) return null;

  const hasResolvedDecision =
    decisions.some(isResolved) ||
    (Array.isArray(response.decided) && response.decided.some(isRecord)) ||
    status === "resolved";
  if (!hasResolvedDecision) return null;
  const latest = latestOutcome(response);
  const projected = decisions.filter(isResolved).at(-1);
  const winner =
    latest?.winner ??
    latest?.outcome ??
    (projected
      ? (stringOrNull(projected.resolved_winner) ??
        stringOrNull(projected.winner) ??
        stringOrNull(projected.resolved_outcome) ??
        stringOrNull(projected.outcome))
      : null);
  return `${winner ? `Decision already resolved: "${winner}"` : "Decision already resolved."}\n\nNext:\n  ${grpCommand(`outcome${room}`)}\n`;
}

/**
 * The foreground stream side of the watch race: follow the SSE stream with
 * the existing reconnect/backoff/resume machinery until a stop condition
 * (wake event or --until filter) fires.
 */
async function watchEventStream(
  ref: RoomRef,
  flags: Record<string, string>,
  io: RoomCliIo,
  state: WatchStreamState,
  signal: AbortSignal,
): Promise<WatchWake> {
  let drops = 0;
  while (true) {
    let streamed: DrainStreamResult;
    try {
      streamed = await streamRoomEventsOnce(ref, flags, io, state, signal);
    } catch (err) {
      // The needs-me side already woke us; retire quietly.
      if (signal.aborted) return neverSettles();
      throw err;
    }
    if (streamed.stopped) {
      return {
        kind: "event",
        ...(streamed.stopRoomEvent ? { event: streamed.stopRoomEvent } : {}),
        ...(streamed.stopEvent ? { stopEvent: streamed.stopEvent } : {}),
      };
    }
    if (signal.aborted) return neverSettles();
    // Spec 109 (WR2-8) — the stream dropped (idle timeout, transport blip)
    // without a stop: reconnect with small backoff, resuming from the last
    // seen event so nothing is missed and nothing re-prints. Hard failures
    // (room gone, auth revoked) throw above and keep the existing error copy.
    drops = streamed.sawEvent ? 1 : drops + 1;
    io.stderr(renderDimNote("[watch] stream ended; reconnecting...", io));
    await sleepMs(watchReconnectDelayMs(drops, io.env));
  }
}

/**
 * Spec 113 (FLOOR RULE, WR5-1) — the needs-me side of the watch race:
 * long-poll next-action (for=my_choice) with the room credentials, silently,
 * until an open decision needs the caller's choice. Hosts that do not speak
 * next-action retire this side quietly; the stream keeps the watch alive.
 */
async function needsMeWakePoll(
  ref: RoomRef,
  flags: Record<string, string>,
  io: RoomCliIo,
  auth: CliAuth,
  signal: AbortSignal,
): Promise<WatchWake> {
  while (!signal.aborted) {
    let response: Record<string, unknown>;
    try {
      const options: RequestOptions = {
        query: withoutUndefined({
          for: "my_choice",
          wait: 50,
        }),
        auth,
        signal,
      };
      response = await requestJson<Record<string, unknown>>(
        ref.baseUrl,
        `/api/rooms/${encodeURIComponent(ref.slug)}/next-action`,
        io,
        options,
      );
    } catch {
      // Aborted (the stream side won) or the host has no next-action
      // endpoint — retire without failing the watch.
      return neverSettles();
    }
    if (isRecord(response) && response.status === "actionable") {
      const decision = isRecord(response.decision) ? response.decision : {};
      return {
        kind: "needed",
        question: stringOrNull(decision.question),
        resolved: stringOrNull(decision.status) === "resolved",
        votingEndsAt: stringOrNull(decision.voting_ends_at),
        decisionSeq: numberOrNull(decision.seq),
        completionActionId: stringOrNull(decision.completion_action_id),
      };
    }
    // Anything but an explicit long-poll timeout means this host does not
    // speak next-action the way we expect; retire instead of spinning.
    if (!isRecord(response) || response.status !== "timeout") return neverSettles();
    // Timeout — re-poll immediately and silently; waiting is the action.
  }
  return neverSettles();
}

/** Spec 224 candidate — bare watch composes durable activity, the needs-me
 * floor, and transient working-signal wakes through the host's activity
 * long-poll. Either the activity poll or the richer SSE path may deliver a
 * durable wake; the caller still performs an ordinary read for canonical
 * state. */
async function activityWakePoll(
  ref: RoomRef,
  io: RoomCliIo,
  auth: CliAuth,
  sinceSeq: number,
  signal: AbortSignal,
): Promise<WatchWake> {
  while (!signal.aborted) {
    let response: Record<string, unknown>;
    try {
      response = await requestJson<Record<string, unknown>>(
        ref.baseUrl,
        `/api/rooms/${encodeURIComponent(ref.slug)}/next-action`,
        io,
        {
          query: { for: "activity", since_seq: sinceSeq, wait: 50 },
          auth,
          signal,
        },
      );
    } catch {
      return neverSettles();
    }
    if (response.status === "actionable") {
      const decision = isRecord(response.decision) ? response.decision : {};
      return {
        kind: "needed",
        question: stringOrNull(decision.question),
        resolved: stringOrNull(decision.status) === "resolved",
        votingEndsAt: stringOrNull(decision.voting_ends_at),
        decisionSeq: numberOrNull(decision.seq),
        completionActionId: stringOrNull(decision.completion_action_id),
      };
    }
    if (response.status === "working") {
      const change = isRecord(response.signal_change) ? response.signal_change : {};
      const signalId = stringOrNull(change.signal_id);
      const participantId = stringOrNull(change.participant_id);
      if (!signalId || !participantId) return neverSettles();
      return {
        kind: "working",
        signalId,
        participantId,
        change: stringOrNull(change.change) ?? "changed",
      };
    }
    if (response.status === "action_recovery" && isRecord(response.action)) {
      return { kind: "action_recovery", response };
    }
    if (response.status === "action_required" && isRecord(response.action)) {
      return { kind: "action_required", response };
    }
    if (response.status === "activity") {
      const activity = isRecord(response.event) ? response.event : {};
      const seq = numberOrNull(activity.seq);
      const eventType = stringOrNull(activity.type);
      if (seq === null || eventType === null) return neverSettles();
      const who = stringOrNull(activity.who);
      // The activity long-poll is an independent durable wake path, not just
      // a hint that the richer SSE racer will eventually win. In proxied or
      // cross-host deployments the long-poll can observe committed state even
      // when that particular SSE connection misses the fan-out. Preserve the
      // event cursor and render the ordinary follow-up-read wake from the
      // pointer the host already returned.
      return {
        kind: "event",
        event: {
          id: `activity:${seq}`,
          seq,
          event_type: eventType,
          occurred_at: new Date().toISOString(),
          decision_id: null,
          data: who ? { display_name: who } : {},
        },
      };
    }
    if (response.status !== "timeout") return neverSettles();
  }
  return neverSettles();
}

/** A promise that never settles: how a retired racer leaves the race. */
function neverSettles(): Promise<never> {
  return new Promise<never>(() => undefined);
}

/** Spec 113 — the watching session's own identity for own-event filtering:
 * the participant id saved from the join response (new configs), falling
 * back to the profile display name (existing configs). */
function callerIdentity(ref: RoomRef, env: Record<string, string | undefined>): CallerIdentity {
  const config = readProviderConfig(env);
  const remembered = findRememberedRoom(config, ref.slug, ref.baseUrl);
  return {
    ...(remembered?.participantId ? { participantId: remembered.participantId } : {}),
    ...(config.profile?.displayName ? { displayName: config.profile.displayName } : {}),
  };
}

/** True when the event qualifies as a wake: substantive, past the baseline,
 * and by someone other than the caller. */
function wakeQualifies(
  event: RoomEvent,
  wake: NonNullable<WatchStreamState["wake"]>,
  state: WatchStreamState,
): boolean {
  if (!WAKE_EVENT_TYPES.has(event.event_type)) return false;
  if (event.event_type === "action.handed_off") {
    const toHolder = stringOrNull(event.data.to_holder_id);
    if (!wake.identity.participantId || toHolder !== wake.identity.participantId) return false;
  }
  if (wake.baselineSeq !== null) {
    if (event.seq <= wake.baselineSeq) return false;
  } else {
    const occurredAt = Date.parse(event.occurred_at);
    if (Number.isFinite(occurredAt) && occurredAt <= state.startedAtMs) return false;
  }
  return !isOwnRoomEvent(event, wake.identity);
}

/** Spec 113 — own events never wake. Prefers the saved participant id; falls
 * back to display-name comparison where the event payload carries one. */
function isOwnRoomEvent(event: RoomEvent, identity: CallerIdentity): boolean {
  const data = isRecord(event.data) ? event.data : {};
  const proposedBy = isRecord(data.proposed_by) ? data.proposed_by : null;
  const participant = isRecord(data.participant) ? data.participant : null;
  // Spec 114 (WR6-11) — decision.opened / voting_phase_started now carry the
  // actor, so an agent's own ask / start-choosing never wakes them.
  const openedBy = isRecord(data.opened_by) ? data.opened_by : null;
  const startedBy = isRecord(data.started_by) ? data.started_by : null;
  const actorId =
    stringOrNull(data.participant_id) ??
    (proposedBy ? stringOrNull(proposedBy.participant_id) : null) ??
    (participant ? stringOrNull(participant.participant_id) : null) ??
    (openedBy ? stringOrNull(openedBy.participant_id) : null) ??
    (startedBy ? stringOrNull(startedBy.participant_id) : null);
  if (identity.participantId) {
    if (actorId) return actorId === identity.participantId;
    const concludedBy = stringOrNull(data.concluded_by);
    if (concludedBy === `participant:${identity.participantId}`) return true;
  }
  const actorName =
    (proposedBy ? stringOrNull(proposedBy.display_name) : null) ??
    (participant ? stringOrNull(participant.display_name) : null) ??
    (openedBy ? stringOrNull(openedBy.display_name) : null) ??
    (startedBy ? stringOrNull(startedBy.display_name) : null) ??
    stringOrNull(data.display_name);
  if (identity.displayName && actorName) return actorName === identity.displayName;
  return false;
}

/** The needs-you wake block (shared by the floor rule and --until=needed). */
function renderNeedsYouWake(
  question: string | null,
  room: string,
  resolved?: boolean,
  votingEndsAt?: string | null,
  decisionSeq?: number | null,
  completionActionId?: string | null,
): string {
  // Spec 125 (WR12-1) — the opener-seal wake: the caller's own question
  // resolved with nothing else open; the next move is theirs, not a choice.
  if (resolved) {
    return [
      `Your question resolved: "${question ?? "the decision you opened"}"`,
      "",
      "Next:",
      `  ${grpCommand(`read${room}`)}`,
      `  ${grpCommand(`outcome${room}`)}`,
      "",
    ].join("\n");
  }
  // Spec 139 (C1) — the wake names its deadline so a caller that cannot act
  // immediately knows how long the door stays open.
  const deadline = describeTimeUntil(votingEndsAt, Date.now());
  if (completionActionId) {
    const decisionArg = decisionSeq ? ` --decision=${decisionSeq}` : "";
    return [
      `The room needs your decision about action completion: "${question ?? "mark an action complete with its exact result"}"${deadline ? ` — ${deadline}` : ""}`,
      "",
      "Next:",
      `  ${grpCommand(`act read ${completionActionId}${room}`)}`,
      `  If GRP should mark the action complete with that exact result: ${grpCommand(`accept 1${decisionArg}${room}`)}`,
      "",
    ].join("\n");
  }
  return [
    `The room needs you: "${question ?? "a decision needs your choice"}"${deadline ? ` — ${deadline}` : ""}`,
    "",
    "Next:",
    `  ${grpCommand(`read${room}`)}`,
    `  ${grpCommand(`choose "<option>"${room}`)}`,
    "",
  ].join("\n");
}

/**
 * Spec 113 — the wake block for an event wake: one reason line, then the
 * next step. The follow-up read's delta includes the event that woke us.
 */
async function renderEventWake(
  wake: { event?: RoomEvent; stopEvent?: string },
  ref: RoomRef,
  flags: Record<string, string>,
  io: RoomCliIo,
  room: string,
): Promise<string> {
  const event = wake.event;
  const type = event?.event_type ?? wake.stopEvent ?? "";
  if (type === "room.concluded") {
    return `Room concluded.\n\nNext:\n  ${grpCommand(`outcome${room}`)}\n`;
  }
  let reason = "The room has new activity.";
  if (type === "decision.completed") {
    const data = event && isRecord(event.data) ? event.data : {};
    const winner = stringOrNull(data.resolved_winner) ?? stringOrNull(data.winner);
    reason = winner ? `Decision resolved: "${winner}"` : "Decision resolved.";
  } else if (type === "decision.opened") {
    const data = event && isRecord(event.data) ? event.data : {};
    const question = stringOrNull(data.question);
    // Spec 117 — wakes name their actor: self-identifying transcripts, and
    // any own-event-filter anomaly becomes diagnosable at a glance.
    const openedBy = isRecord(data.opened_by) ? stringOrNull(data.opened_by.display_name) : null;
    const by = openedBy ? ` by ${openedBy}` : "";
    reason = question ? `Decision opened${by}: "${question}"` : `Decision opened${by}.`;
  } else if (type === "decision.revised") {
    const data = event && isRecord(event.data) ? event.data : {};
    const question = stringOrNull(data.question);
    const revisedBy = isRecord(data.revised_by) ? stringOrNull(data.revised_by.display_name) : null;
    const by = revisedBy ? ` by ${revisedBy}` : "";
    reason = question
      ? `Decision premise replaced${by}; prior choices cleared: "${question}"`
      : `Decision premise replaced${by}; prior choices cleared.`;
  } else if (type === "decision.voting_phase_started") {
    // Spec 117 — no longer folded into "Decision opened": say what happened.
    const data = event && isRecord(event.data) ? event.data : {};
    const startedBy = isRecord(data.started_by) ? stringOrNull(data.started_by.display_name) : null;
    const by = startedBy ? ` by ${startedBy}` : "";
    const entry = event ? await wakeDeltaEntry(ref, flags, io, event.seq) : null;
    const question = entry ? stringOrNull(entry.question) : null;
    reason = question ? `Choosing started${by}: "${question}"` : `Choosing started${by}.`;
  } else if (type === "option.proposed") {
    const data = event && isRecord(event.data) ? event.data : {};
    const proposedBy = isRecord(data.proposed_by) ? data.proposed_by : null;
    const who = proposedBy ? stringOrNull(proposedBy.display_name) : null;
    reason = who ? `New option from ${who}.` : "New option proposed.";
  } else if (type === "discussion.posted") {
    // The event payload carries no name; the delta read joins it back.
    const entry = event ? await wakeDeltaEntry(ref, flags, io, event.seq) : null;
    const who = entry ? stringOrNull(entry.who) : null;
    reason = who ? `${who} posted discussion.` : "New discussion posted.";
  } else if (type === "action.completion_proposed") {
    reason = "A participant proposed marking an action complete with one exact result.";
  } else if (type === "action.resumed") {
    reason = "An action returned to its holder for more work.";
  } else if (type === "action.handed_off") {
    const entry = event ? await wakeDeltaEntry(ref, flags, io, event.seq) : null;
    const actionId = entry ? stringOrNull(entry.action_id) : null;
    const from = entry ? stringOrNull(entry.from) : null;
    const to = entry ? stringOrNull(entry.to) : null;
    reason =
      entry?.to_you === true
        ? `${from ?? "A participant"} handed action ${actionId ?? "unknown"} to you.`
        : entry?.to_group === true
          ? `${from ?? "A participant"} handed action ${actionId ?? "unknown"} to the group.`
          : from && to
            ? `${from} handed action ${actionId ?? "unknown"} to ${to}.`
            : "An action was handed off.";
  } else if (
    type === "artifact.created" ||
    type === "artifact.claimed" ||
    type === "artifact.claim_released" ||
    type === "artifact.revision_published" ||
    type === "artifact.reviewed"
  ) {
    const data = event && isRecord(event.data) ? event.data : {};
    const who = stringOrNull(data.display_name);
    const verb =
      type === "artifact.created"
        ? "created an artifact"
        : type === "artifact.claimed"
          ? "claimed an artifact"
          : type === "artifact.claim_released"
            ? "released an artifact claim"
            : type === "artifact.revision_published"
              ? "published an artifact revision"
              : "reviewed an artifact";
    reason = who ? `${who} ${verb}.` : `A collaborator ${verb}.`;
  }
  return `${reason}\n\nNext:\n  ${grpCommand(`read${room}`)}\n`;
}

/** Best-effort lookup of the wake event's delta entry (for names/questions
 * the raw event payload does not carry). Never advances the stored mark. */
async function wakeDeltaEntry(
  ref: RoomRef,
  flags: Record<string, string>,
  io: RoomCliIo,
  seq: number,
): Promise<Record<string, unknown> | null> {
  try {
    const options = readRequestOptions(ref, flags, io.env);
    options.query = { ...(options.query ?? {}), since: seq - 1 };
    const response = await requestJson<Record<string, unknown>>(
      ref.baseUrl,
      `/api/rooms/${encodeURIComponent(ref.slug)}`,
      io,
      options,
    );
    if (!Array.isArray(response.new)) return null;
    const entry = response.new.find((e) => isRecord(e) && numberOrNull(e.seq) === seq);
    return isRecord(entry) ? entry : null;
  } catch {
    return null;
  }
}

/** The raw --jsonl stream loop (previous watch behavior, machine-clean:
 * no wake logic, no epilogue, and the stored read mark is never touched). */
async function watchJsonlStream(
  ref: RoomRef,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const state: WatchStreamState = {
    headSeq: flags.until ? await fetchWatchHeadSeq(ref, flags, io) : null,
    startedAtMs: Date.now(),
    lastSeenSeq: null,
    lastEventId: flags["since-event-id"] ?? flags["last-event-id"] ?? null,
  };

  let drops = 0;
  while (true) {
    const streamed = await streamRoomEventsOnce(ref, flags, io, state);
    if (streamed.stopped) return;
    // Dropped stream: reconnect with backoff, resuming from the last seen
    // event (WR2-8); JSONL prints no status lines.
    drops = streamed.sawEvent ? 1 : drops + 1;
    await sleepMs(watchReconnectDelayMs(drops, io.env));
  }
}

/**
 * Spec 112 (WR4-4a) — the wake tripwire: long-poll the room's next-action
 * endpoint (for=my_choice, 50s waits) with the saved room credentials,
 * printing nothing on timeouts, until a decision needs the caller's choice.
 */
async function watchUntilNeeded(
  ref: RoomRef,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<void> {
  const auth = authFromFlags(flags, ref, io.env);
  if (!auth) {
    throw new Error(
      `Waiting for the room needs your room credentials. Join first: ${grpCommand("join <room-id>")}`,
    );
  }
  // Spec 125 — --timeout was silently IGNORED on this branch (it lived only
  // in the unified watch's racers), so `watch --until=needed --timeout=N`
  // blocked forever when the room never needed the caller. Run 12's
  // Showrunner leaned on exactly that flag combination; its bounded waits
  // never had a self-recovery path.
  const timeoutSeconds = parseWatchTimeout(flags.timeout);
  const deadline = timeoutSeconds === null ? null : Date.now() + timeoutSeconds * 1000;
  while (true) {
    if (deadline !== null && Date.now() >= deadline) {
      const room = roomHintArg(ref.slug, ref, io.env);
      const info = await roomWatchPhase(ref, flags, io, rememberedLastSeenSeq(ref, io.env) ?? 0);
      const tail = watchTimeoutTail(room, info.closesInSeconds);
      io.stdout(
        `Nothing new after ${timeoutSeconds}s — reassess with ${grpCommand(`read${room}`)}, or ${tail}.\n`,
      );
      return;
    }
    const remainingSeconds =
      deadline === null ? 50 : Math.max(1, Math.min(50, Math.ceil((deadline - Date.now()) / 1000)));
    const options: RequestOptions = {
      query: withoutUndefined({
        for: "my_choice",
        wait: remainingSeconds,
      }),
      auth,
    };
    const response = await requestJson<Record<string, unknown>>(
      ref.baseUrl,
      `/api/rooms/${encodeURIComponent(ref.slug)}/next-action`,
      io,
      options,
    );
    if (isRecord(response) && response.status === "actionable") {
      const decision = isRecord(response.decision) ? response.decision : {};
      const room = roomHintArg(ref.slug, ref, io.env);
      // Spec 125 (WR12-1) opener-seal + spec 139 (C1) deadline: one renderer
      // for every needs-you wake so the copy cannot drift between modes.
      io.stdout(
        renderNeedsYouWake(
          stringOrNull(decision.question),
          room,
          stringOrNull(decision.status) === "resolved",
          stringOrNull(decision.voting_ends_at),
          numberOrNull(decision.seq),
          stringOrNull(decision.completion_action_id),
        ),
      );
      return;
    }
    // Timeout — say nothing and re-poll immediately; waiting is the action.
  }
}

/**
 * One SSE connection: connect, drain frames, and report whether a --until
 * stop condition fired before the stream ended. Connect-time failures throw
 * (hard failure); mid-stream read errors are treated as a drop so the caller
 * reconnects.
 */
async function streamRoomEventsOnce(
  ref: RoomRef,
  flags: Record<string, string>,
  io: RoomCliIo,
  state: WatchStreamState,
  signal?: AbortSignal,
): Promise<DrainStreamResult> {
  const url = apiUrl(ref.baseUrl, `/api/rooms/${encodeURIComponent(ref.slug)}/events/stream`, {
    ...readQuery(ref),
    since_event_id: state.lastEventId ?? undefined,
    // Run 8 / CH22 — a durable foreground mark is a numeric room-local
    // sequence. Carry it into the first SSE connection instead of requesting
    // the room's uncursored first page. Once a live frame supplies an event id,
    // reconnects keep using standard Last-Event-ID semantics.
    since_seq: state.lastEventId === null ? (state.lastSeenSeq ?? undefined) : undefined,
  });
  const headers = new Headers({ accept: "text/event-stream" });
  const auth = authFromFlags(flags, ref, io.env);
  if (auth?.kind === "token") headers.set("authorization", `Bearer ${auth.token}`);
  if (auth?.kind === "bearer") headers.set("authorization", `Bearer ${auth.token}`);
  if (auth?.kind === "mandate") headers.set("x-mandate", auth.mandate);
  if (auth?.kind === "hosted") {
    headers.set("authorization", `Bearer ${auth.accessToken}`);
    headers.set("x-mandate", auth.mandate);
  }
  if (flags.password ?? ref.password) {
    headers.set("x-room-password", flags.password ?? ref.password ?? "");
  }
  if (state.lastEventId) headers.set("last-event-id", state.lastEventId);

  const response = await io.fetch(url, {
    headers,
    redirect: "manual",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw await httpError(response);
  if (!response.body) throw new Error("event stream response had no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawEvent = false;
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      if (read.value.byteLength > MAX_CLI_SSE_BUFFER_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SseBufferLimitError(
          `event stream frame exceeded ${MAX_CLI_SSE_BUFFER_BYTES} bytes`,
        );
      }
      buffer += decoder.decode(read.value, { stream: true });
      const drained = drainSseBuffer(buffer, flags, io, state);
      buffer = drained.rest;
      if (Buffer.byteLength(buffer, "utf8") > MAX_CLI_SSE_BUFFER_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SseBufferLimitError(
          `event stream frame exceeded ${MAX_CLI_SSE_BUFFER_BYTES} bytes`,
        );
      }
      if (drained.sawEvent) sawEvent = true;
      if (drained.stop) {
        await reader.cancel().catch(() => undefined);
        return {
          stopped: true,
          ...(drained.stopEvent ? { stopEvent: drained.stopEvent } : {}),
          ...(drained.stopRoomEvent ? { stopRoomEvent: drained.stopRoomEvent } : {}),
          sawEvent,
        };
      }
    }
    buffer += decoder.decode();
    const tail = drainSseBuffer(`${buffer}\n\n`, flags, io, state);
    if (tail.sawEvent) sawEvent = true;
    if (tail.stop) {
      return {
        stopped: true,
        ...(tail.stopEvent ? { stopEvent: tail.stopEvent } : {}),
        ...(tail.stopRoomEvent ? { stopRoomEvent: tail.stopRoomEvent } : {}),
        sawEvent,
      };
    }
  } catch (error) {
    if (error instanceof SseBufferLimitError) throw error;
    // Mid-stream transport error behaves like a dropped stream; reconnect.
  }
  return { stopped: false, sawEvent };
}

/**
 * Spec 109 (WR2-11) — the room's event head at watch start: the highest seq
 * already in the log. Returns null (occurred_at fallback) when the events
 * endpoint cannot be read; the stream connect will surface hard failures.
 */
/** Spec 125 (WR12-3) — one light state check for the phase-aware watch
 *  timeout: a delta read anchored at the watcher's own cursor, whose thin
 *  `state` line is exactly "no question open" when nothing is open. True
 *  only on that positive report; any error or unknown shape returns false
 *  (generic timeout copy). */
async function roomHasNoOpenQuestion(
  ref: RoomRef,
  flags: Record<string, string>,
  io: RoomCliIo,
  sinceSeq: number,
): Promise<boolean> {
  return (await roomWatchPhase(ref, flags, io, sinceSeq)).phase === "no_question";
}

/** Spec 125/128 — the light phase probe behind the phase-aware watch timeout:
 *  "no_question" when nothing is open, "agreement" when an agreement question
 *  is open (a withheld acceptance is a legitimate standing state, so the
 *  timeout copy teaches the accept verb instead of nagging), else "other". */
type WatchPhaseInfo = {
  phase: "no_question" | "agreement" | "other";
  /** Spec 152 W5 — seconds until the soonest open deadline the light read
   * exposes, so the timeout tail can size its --timeout suggestion from the
   * room's actual state instead of a static example. */
  closesInSeconds: number | null;
  /** Computed action recovery is time-driven and may have no room event. */
  recoverableAction: Record<string, unknown> | null;
  /** Reuse the timeout probe's room snapshot when rendering recovery. */
  full: Record<string, unknown> | null;
};

async function roomWatchPhase(
  ref: RoomRef,
  flags: Record<string, string>,
  io: RoomCliIo,
  _sinceSeq: number,
): Promise<WatchPhaseInfo> {
  try {
    const options: RequestOptions = {
      // Spec 153 (F152-S1) — the delta view intentionally carries only a
      // human state line, so it cannot supply the structured deadline W5
      // needs. This probe runs only after a quiet timeout; ask for the bounded
      // full agent view instead of parsing prose or expanding the delta diet.
      query: readQuery(ref),
    };
    const auth = authFromFlags(flags, ref, io.env);
    const password = flags.password ?? ref.password;
    if (auth) options.auth = auth;
    if (password) options.password = password;
    const response = await requestJson<Record<string, unknown>>(
      ref.baseUrl,
      `/api/rooms/${encodeURIComponent(ref.slug)}`,
      io,
      options,
    );
    if (!isRecord(response)) {
      return {
        phase: "other",
        closesInSeconds: null,
        recoverableAction: null,
        full: null,
      };
    }
    const closesInSeconds = soonestOpenDeadlineSeconds(response);
    const recoverableAction = recoverablePeerWatchActions(response, ref, io.env)[0] ?? null;
    const common = { closesInSeconds, recoverableAction, full: response };
    const decision = isRecord(response.decision) ? response.decision : null;
    if (!decision) return { phase: "no_question", ...common };
    if (decision.agreement === true) return { phase: "agreement", ...common };
    return { phase: "other", ...common };
  } catch {
    return {
      phase: "other",
      closesInSeconds: null,
      recoverableAction: null,
      full: null,
    };
  }
}

/** Spec 152 W5 / spec 153 F152-S1 — soonest future voting deadline among
 * open decisions in a real full agent view, in whole seconds; null when
 * nothing open carries one. Compatibility fields remain accepted for hosts
 * that still expose the older decision-list vocabulary. */
function soonestOpenDeadlineSeconds(response: Record<string, unknown>): number | null {
  const now = Date.now();
  const candidates: number[] = [];
  const consider = (value: unknown) => {
    if (!isRecord(value)) return;
    if (stringOrNull(value.status) === "resolved" || value.resolved_at) return;
    const ends = stringOrNull(value.closes_at) ?? stringOrNull(value.voting_ends_at);
    if (!ends) return;
    const at = Date.parse(ends);
    if (Number.isFinite(at) && at > now) candidates.push(Math.ceil((at - now) / 1000));
  };
  consider(response.decision);
  if (Array.isArray(response.decisions_open))
    for (const entry of response.decisions_open) consider(entry);
  if (Array.isArray(response.decisions)) for (const entry of response.decisions) consider(entry);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

/** Spec 152 W5 (P-3 ruling: deadline-derived, flag-without-number fallback) —
 * the "wait longer" tail of a quiet watch. With an open deadline the
 * suggestion covers it exactly; without one the flag is taught with no
 * anchoring value (a static 1800 was rejected as overfit to one trial's
 * cadence). */
function watchTimeoutTail(room: string, closesInSeconds: number | null): string {
  const returnLater = `or return later using your agent runtime's scheduling tools, then run ${grpCommand("inbox")}`;
  if (closesInSeconds !== null) {
    const timeout = Math.max(60, Math.ceil(closesInSeconds / 60) * 60);
    const human =
      closesInSeconds < 120
        ? `${closesInSeconds}s`
        : closesInSeconds < 7200
          ? `${Math.round(closesInSeconds / 60)}m`
          : `${Math.round(closesInSeconds / 3600)}h`;
    return `the open question closes in ~${human} — ${grpCommand(`watch --timeout=${timeout}${room}`)} covers it; ${returnLater}`;
  }
  return `stay armed through quiet stretches with ${grpCommand(`watch --timeout=N${room}`)} (seconds), or run ${grpCommand(`watch${room}`)} again; ${returnLater}`;
}

async function fetchWatchHeadSeq(
  ref: RoomRef,
  flags: Record<string, string>,
  io: RoomCliIo,
): Promise<number | null> {
  try {
    const options: RequestOptions = { query: withoutUndefined({ ...readQuery(ref) }) };
    const auth = authFromFlags(flags, ref, io.env);
    const password = flags.password ?? ref.password;
    if (auth) options.auth = auth;
    if (password) options.password = password;
    const response = await requestJson<{ events?: unknown[] }>(
      ref.baseUrl,
      `/api/rooms/${encodeURIComponent(ref.slug)}/events`,
      io,
      options,
    );
    let head = 0;
    for (const event of response?.events ?? []) {
      if (isRoomEvent(event) && event.seq > head) head = event.seq;
    }
    return head;
  } catch {
    return null;
  }
}

function watchReconnectDelayMs(drop: number, env: Record<string, string | undefined>): number {
  // Undocumented test/ops override: a fixed reconnect delay in milliseconds.
  const override = env.GRP_WATCH_RECONNECT_MS;
  if (override !== undefined) {
    const n = Number(override);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const index = Math.min(Math.max(drop, 1) - 1, WATCH_RECONNECT_DELAYS_MS.length - 1);
  return WATCH_RECONNECT_DELAYS_MS[index] ?? 5000;
}

function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function actionRequest(
  ref: RoomRef,
  path: string,
  flags: Record<string, string>,
  io: RoomCliIo,
  body: Record<string, unknown>,
  guardRoomState = false,
): Promise<unknown> {
  const auth = authFromFlags(flags, ref, io.env);
  const options: RequestOptions = {
    method: "POST",
    body: withoutUndefined(body),
    trace: { postAnyway: flags["post-anyway"] === "true" },
  };
  if (auth) options.auth = auth;
  const idempotencyKey = validatedIdempotencyKey(flags["idempotency-key"]);
  if (idempotencyKey) options.headers = { "idempotency-key": idempotencyKey };
  const expectedRevision = guardRoomState
    ? await guardedExpectedRoomRevision(ref, flags, io)
    : undefined;
  if (expectedRevision) {
    options.headers = {
      ...(options.headers ?? {}),
      "x-grp-expected-room-revision": expectedRevision,
    };
  }
  const response = await requestJson<unknown>(
    ref.baseUrl,
    `/api/rooms/${encodeURIComponent(ref.slug)}${path}`,
    io,
    options,
  );
  // Only a successful guarded transition can safely advance the observation
  // without a fresh read. An unguarded legacy/bypass response does not.
  if (expectedRevision && isRecord(response)) {
    const revision = stringOrNull(response.state_revision);
    if (revision) persistObservedStateRevision(ref, revision, io.env);
  }
  return response;
}

function eventRequestOptions(
  ref: RoomRef,
  flags: Record<string, string>,
  env: Record<string, string | undefined>,
): RequestOptions {
  const options: RequestOptions = {
    query: withoutUndefined({
      ...readQuery(ref),
      since_seq: flags["since-seq"],
      since_event_id: flags["since-event-id"],
      limit: flags.limit,
    }),
  };
  const auth = authFromFlags(flags, ref, env);
  const password = flags.password ?? ref.password;
  if (auth) options.auth = auth;
  if (password) options.password = password;
  return options;
}

function readRequestOptions(
  ref: RoomRef,
  flags: Record<string, string>,
  env: Record<string, string | undefined>,
): RequestOptions {
  const options: RequestOptions = { query: readQuery(ref) };
  const auth = authFromFlags(flags, ref, env);
  const password = flags.password ?? ref.password;
  if (auth) options.auth = auth;
  if (password) options.password = password;
  return options;
}

function fullReadRequestOptions(
  ref: RoomRef,
  flags: Record<string, string>,
  env: Record<string, string | undefined>,
): RequestOptions {
  const options = readRequestOptions(ref, flags, env);
  options.query = { ...(options.query ?? {}), include: "full" };
  return options;
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  io: RoomCliIo,
  options: RequestOptions = {},
): Promise<T> {
  const url = apiUrl(baseUrl, path, options.query);
  const headers = new Headers(options.headers);
  headers.set("accept", options.accept ?? "application/json");
  if (options.password) headers.set("x-room-password", options.password);
  if (options.auth?.kind === "mandate") headers.set("x-mandate", options.auth.mandate);
  if (options.auth?.kind === "token") headers.set("authorization", `Bearer ${options.auth.token}`);
  if (options.auth?.kind === "bearer") headers.set("authorization", `Bearer ${options.auth.token}`);
  if (options.auth?.kind === "hosted") {
    headers.set("authorization", `Bearer ${options.auth.accessToken}`);
    headers.set("x-mandate", options.auth.mandate);
  }

  // Never forward room credentials across an HTTP redirect. A moved endpoint
  // is surfaced as an error so the operator can verify the new origin first.
  const timeoutSignal = AbortSignal.timeout(CLI_REQUEST_TIMEOUT_MS);
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
    redirect: "manual",
    signal: options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal,
  };
  let serializedBody: string | undefined;
  if (options.body) {
    headers.set("content-type", "application/json");
    serializedBody = JSON.stringify(options.body);
    init.body = serializedBody;
  }
  const expectedRoomRevision = headers.get("x-grp-expected-room-revision");
  const trace = startEvalTraceRequest(io.env, {
    method: String(init.method ?? "GET"),
    path,
    ...(serializedBody === undefined ? {} : { serializedBody }),
    ...(expectedRoomRevision === null ? {} : { expectedRoomRevision }),
    ...(options.trace?.postAnyway === undefined ? {} : { postAnyway: options.trace.postAnyway }),
  });
  let responseStatus: number | undefined;
  let traceFinished = false;
  try {
    const response = await io.fetch(url, init);
    responseStatus = response.status;
    if (!response.ok) {
      const error = await httpError(response, url);
      traceFinished = true;
      finishEvalTraceRequest(trace, {
        status: response.status,
        errorCode: requestErrorCode(error, response.status),
      });
      throw error;
    }
    const text = await readBoundedResponseText(response);
    const parsed = (text ? JSON.parse(text) : null) as T;
    traceFinished = true;
    finishEvalTraceRequest(trace, { status: response.status });
    return parsed;
  } catch (error) {
    if (!traceFinished) {
      traceFinished = true;
      finishEvalTraceRequest(trace, {
        ...(responseStatus === undefined ? {} : { status: responseStatus }),
        errorCode: requestErrorCode(error, responseStatus),
      });
    }
    throw error;
  }
}

function requestErrorCode(error: unknown, status?: number): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  if (error instanceof SyntaxError) return "client.response_invalid";
  return status === undefined ? "network.error" : "http.error";
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CLI_JSON_RESPONSE_BYTES) {
    throw new Error(`response exceeded ${MAX_CLI_JSON_RESPONSE_BYTES} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_CLI_JSON_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`response exceeded ${MAX_CLI_JSON_RESPONSE_BYTES} bytes`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function apiUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | undefined>,
): URL {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

function authFromFlags(
  flags: Record<string, string>,
  ref: RoomRef,
  env: Record<string, string | undefined>,
): CliAuth | undefined {
  if (flags.bearer && flags.mandate) {
    return { kind: "hosted", accessToken: flags.bearer, mandate: flags.mandate };
  }
  if (flags.mandate) return { kind: "mandate", mandate: flags.mandate };
  if (flags.bearer) return { kind: "bearer", token: flags.bearer };
  if (flags.token ?? ref.token) return { kind: "token", token: flags.token ?? ref.token ?? "" };
  const credential = readProviderConfig(env).auth;
  if (
    credential &&
    normalizeUrlForCompare(credential.baseUrl) === normalizeUrlForCompare(ref.baseUrl)
  ) {
    return {
      kind: "hosted",
      accessToken: credential.accessToken,
      mandate: credential.mandate,
    };
  }
  return undefined;
}

function normalizeUrlForCompare(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function readQuery(_ref: RoomRef): Record<string, string | undefined> {
  // Credentials travel in Authorization / X-Room-Password headers. Keeping
  // this helper makes cursor composition explicit without ever rebuilding a
  // capability-bearing URL.
  return {};
}

function inviteManagerToken(ref: RoomRef, flags: Record<string, string>): string {
  const token = flags.token ?? ref.token;
  if (!token) {
    throw new Error(
      "participant token is required to manage invites; join or enter the room with your token first",
    );
  }
  return token;
}

function settingsManagerToken(ref: RoomRef, flags: Record<string, string>): string {
  const token = flags.token ?? ref.token;
  if (!token) {
    throw new Error(
      "operator token is required to update settings; enter the room with the creator token or pass --token",
    );
  }
  return token;
}

function memberManagerToken(ref: RoomRef, flags: Record<string, string>): string {
  const token = flags.token ?? ref.token;
  if (!token) {
    throw new Error(
      "operator token is required to update members; enter the room with the creator token or pass --token",
    );
  }
  return token;
}

function normalizeMemberRole(raw: string): "participant" | "observer" {
  if (raw === "participant" || raw === "observer") return raw;
  throw new Error("role must be one of: participant, observer");
}

function drainSseBuffer(
  buffer: string,
  flags: Record<string, string>,
  io: RoomCliIo,
  state?: WatchStreamState,
): DrainSseResult {
  let rest = buffer;
  let sawEvent = false;
  while (true) {
    const index = rest.indexOf("\n\n");
    if (index === -1) return { rest, stop: false, sawEvent };
    const frame = rest.slice(0, index);
    rest = rest.slice(index + 2);
    const message = parseSseMessage(frame);
    if (!message?.data) continue;
    const payload = safeJson(message.data);
    const event = isRoomEvent(payload) ? payload : null;
    if (event && state) {
      // WR2-8 — replay after a reconnect must not re-print already-shown
      // events; the resume cursor still advances past them.
      if (state.lastSeenSeq !== null && event.seq <= state.lastSeenSeq) {
        state.lastEventId = stringOrNull(event.id) ?? message.id ?? state.lastEventId;
        continue;
      }
      state.lastSeenSeq = event.seq;
      state.lastEventId = stringOrNull(event.id) ?? message.id ?? state.lastEventId;
    }
    if (event) sawEvent = true;
    // Spec 113 — wake mode drains quietly: nothing prints until the wake
    // block itself. Spec 115 (WR7-11) — --until modes are quiet too: run 7's
    // showrunner got the room's ENTIRE replayed history re-printed as raw
    // JSON on every `watch --until=resolved` call. Only --jsonl streams.
    if (flags.jsonl === "true") {
      io.stdout(`${JSON.stringify(payload)}\n`);
    }
    if (event && state?.wake && wakeQualifies(event, state.wake, state)) {
      return {
        rest: "",
        stop: true,
        stopEvent: event.event_type,
        stopRoomEvent: event,
        sawEvent,
      };
    }
    if (shouldStopWatching(payload, flags, state)) {
      return {
        rest: "",
        stop: true,
        ...(event ? { stopEvent: event.event_type, stopRoomEvent: event } : {}),
        sawEvent,
      };
    }
  }
}

function shouldStopWatching(
  payload: unknown,
  flags: Record<string, string>,
  state?: WatchStreamState,
): boolean {
  const until = flags.until;
  if (!until) return false;
  if (!isRoomEvent(payload)) return false;
  const stopOnResolved = until === "resolved" || FUTURE_RESOLVED_UNTIL_VALUES.has(until);
  if (!stopOnResolved) return false;
  const isStopEvent =
    payload.event_type === "decision.completed" || payload.event_type === "room.concluded";
  if (!isStopEvent) return false;
  // Spec 109 (WR2-11) — the stream backfills history before following live;
  // only events past the head recorded at watch start satisfy --until.
  if (!state) return true;
  if (state.headSeq !== null) return payload.seq > state.headSeq;
  const occurredAt = Date.parse(payload.occurred_at);
  return !Number.isFinite(occurredAt) || occurredAt > state.startedAtMs;
}

function displayEventType(eventType: string): string {
  switch (eventType) {
    case "participant.joined":
      return "joined";
    case "invite.created":
      return "invite created";
    case "invite.revoked":
      return "invite revoked";
    case "invite.accepted":
      return "invite accepted";
    case "room.settings_updated":
      return "settings updated";
    case "option.proposed":
      return "option proposed";
    case "discussion.posted":
      return "discussion posted";
    case "vote.cast":
      return "choice submitted";
    case "choice.abstained":
      return "abstained";
    case "decision.voting_phase_started":
      return "choice window opened";
    case "decision.completed":
      return "decision completed";
    case "action.completion_proposed":
      return "action completion proposed";
    case "action.resumed":
      return "action resumed";
    case "room.concluded":
      return "room closed";
    default:
      return eventType;
  }
}

function optionState(
  response: Record<string, unknown>,
  focusedSeq?: number,
): Record<string, unknown> {
  const decision = activeDecision(response);
  const options = decision ? decisionOptions(decision) : [];
  const canProposeMore = decision ? booleanOrNull(decision.can_propose_more) : null;
  const canStartChoosing = decision ? booleanOrNull(decision.can_start_choosing) : null;
  // Spec 118 (WR10-1) — proposal status comes from the wire, never from phase
  // inference when a wire truth exists: fluid decisions keep taking proposals
  // while choices are open, so "voting" never implied "closed". Preference
  // order: can_propose_more (agent view; role- and authority-aware) →
  // proposals_open (full read; the propose guard's exact mirror) →
  // voting_opens_at derivation (old hosts) → phase inference (last resort).
  const proposalsOpen = decision ? booleanOrNull(decision.proposals_open) : null;
  const proposers = decision ? stringOrNullArray(decision.option_proposers) : null;
  const status = decision ? (stringOrNull(decision.status) ?? stringOrNull(decision.phase)) : null;
  return {
    slug: response.slug ?? null,
    ...(focusedSeq !== undefined ? { decision: focusedSeq } : {}),
    question: decision ? stringOrNull(decision.question) : null,
    phase: status,
    choice_mode: choiceMode(response),
    proposal_status: decision
      ? (renderBoolStatus(
          canProposeMore ??
            proposalsOpen ??
            (status === "voting" && "voting_opens_at" in decision
              ? decision.voting_opens_at === null
              : null),
        ) ?? proposalStatus(decision))
      : null,
    // Start-choosing is a slate-phase verb; never derive it from proposal
    // status, which a fluid decision correctly reports open during voting.
    can_start_choosing: canStartChoosing ?? status === "proposing",
    options: options.map((option, index) => ({
      number: index + 1,
      text: option,
      ...(proposers?.[index] ? { proposed_by: proposers[index] } : {}),
    })),
  };
}

function renderBoolStatus(value: boolean | null): "open" | "closed" | null {
  if (value === null) return null;
  return value ? "open" : "closed";
}

/** Spec 152 W4 — a stored map ballot (score/quadratic) parsed for display,
 * or null when the choice is not a numeric map. */
function parseBallotMapForDisplay(choice: string): Record<string, number> | null {
  if (!choice.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(choice);
    if (!isRecord(parsed)) return null;
    const entries = Object.entries(parsed);
    if (entries.length === 0) return null;
    if (entries.some(([, value]) => typeof value !== "number")) return null;
    return parsed as Record<string, number>;
  } catch {
    return null;
  }
}

/** Spec 118 — `option_proposers` is a (string | null)[] aligned with options. */
function stringOrNullArray(value: unknown): (string | null)[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((item) => (typeof item === "string" && item.length > 0 ? item : null));
}

function renderOptions(
  response: Record<string, unknown>,
  full = false,
  room = "",
  focusedSeq?: number,
): string {
  const state = optionState(response, focusedSeq);
  const decision = focusedSeq === undefined ? "" : ` --decision=${focusedSeq}`;
  if (!state.question) {
    const lines = ["No open decision.", "", "Next:"];
    appendIdleGuidance(lines, response, room);
    return `${lines.join("\n")}\n`;
  }
  const options = Array.isArray(state.options)
    ? (state.options as Array<{ number: number; text: string; proposed_by?: string }>)
    : [];
  const lines = [
    `Question: ${state.question}`,
    `Phase: ${formatPhase(String(state.phase ?? "unknown"))}`,
    // Spec 152 W4 — never fabricate a mode: unknown is honest, "single
    // choice" on a score room guaranteed a first-ballot rejection.
    `Choice mode: ${state.choice_mode ?? "unknown"}`,
    `Proposal status: ${state.proposal_status ?? "unknown"}`,
    "",
    "Options:",
  ];
  let clipped = false;
  if (options.length === 0) {
    lines.push("  none yet");
  } else {
    for (const option of options) {
      const text =
        !full && option.text.length > 200 ? `${option.text.slice(0, 200)}…` : option.text;
      if (text !== option.text) clipped = true;
      // Spec 118 (WR10-3) — attribution the run-10 seats hand-tracked
      // ("option 2 (Argon's)") from the discussion feed.
      const by = option.proposed_by ? ` — proposed by ${option.proposed_by}` : "";
      lines.push(`  ${option.number}. ${text}${by}`);
    }
  }
  if (clipped) {
    lines.push(
      "",
      `Long options clipped — full text: ${grpCommand(`options --full${decision}${room}`)}`,
    );
  }
  lines.push("", "Other commands:");
  const phase = String(state.phase ?? "unknown");
  if (phase === "resolved") {
    lines.push(`  ${grpCommand(`read${decision}${room}`)}`, `  ${grpCommand(`outcome${room}`)}`);
    return `${lines.join("\n")}\n`;
  }
  if (state.proposal_status === "open")
    lines.push(`  ${grpCommand(`propose "..."${decision}${room}`)}`);
  // start-choosing still selects by decision UUID on the wire. Do not emit a
  // targetless command from a seq-focused slate; the proposal timer remains
  // the safe backstop until that separate selector surface is ruled.
  if (state.can_start_choosing === true && focusedSeq === undefined) {
    lines.push(`  ${grpCommand(`start choosing${room}`)}`);
  }
  if (phase !== "proposing") {
    lines.push(`  ${choiceCommand(state.choice_mode, decision, room)}`);
    const focused = isRecord(response.decision) ? response.decision : activeDecision(response);
    if (focused?.agreement !== true) {
      lines.push(`  ${grpCommand(`abstain --reason="..."${decision}${room}`)}`);
    }
  }
  appendDiscussGuidance(lines, `${decision}${room}`);
  if (state.proposal_status === "open") {
    lines.push(
      "",
      `Note: propose an option's full text; commentary goes in ${grpCommand(`discuss "..."${decision}${room}`)}.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderMembers(response: Record<string, unknown>, ref: RoomRef): string {
  const members = Array.isArray(response.participants) ? response.participants : [];
  const config = isRecord(response.config) ? response.config : null;
  const creatorIsNonVoting = config?.creator_votes === false;
  const lines = [`Members for ${String(response.slug ?? ref.slug)}`];
  if (members.length === 0) {
    lines.push("No members yet.");
    return `${lines.join("\n")}\n`;
  }
  members.forEach((member, index) => {
    if (!isRecord(member)) {
      lines.push(`${index + 1}. unknown`);
      return;
    }
    const name = stringOrNull(member.display_name) ?? stringOrNull(member.displayName) ?? "unnamed";
    const role = stringOrNull(member.role);
    const roleLabel =
      index === 0 && role === "participant" && creatorIsNonVoting
        ? "participant; non-voting host"
        : role;
    // Spec 115 (WR7-7) — dates, not millisecond ISO timestamps.
    const joined = stringOrNull(member.joined_at) ?? stringOrNull(member.joinedAt);
    const lastSeen = stringOrNull(member.last_seen_at) ?? stringOrNull(member.lastSeenAt);
    const day = (iso: string): string => iso.slice(0, 10);
    lines.push(
      `${index + 1}. ${name}${roleLabel ? ` (${roleLabel})` : ""}${joined ? ` joined ${day(joined)}` : ""}${lastSeen ? ` last seen ${day(lastSeen)}` : ""}`,
    );
  });
  return `${lines.join("\n")}\n`;
}

function renderMemberRoleUpdated(
  response: Record<string, unknown>,
  ref: RoomRef,
  env: Record<string, string | undefined>,
): string {
  const participant = isRecord(response.participant) ? response.participant : {};
  const name =
    stringOrNull(participant.display_name) ??
    stringOrNull(participant.displayName) ??
    stringOrNull(participant.id) ??
    "member";
  const role = stringOrNull(participant.role) ?? "unknown";
  const room = roomHintArg(String(response.slug ?? ref.slug), ref, env);
  return `Updated ${name}: ${role}.\n\nRun:\n  ${grpCommand(`members${room}`)}\n`;
}

function renderSettings(response: Record<string, unknown>, ref: RoomRef): string {
  const config = isRecord(response.config) ? response.config : {};
  const lines = [`Settings for ${String(response.slug ?? ref.slug)}`];
  lines.push(`Access: ${String(config.visibility ?? "unknown")}`);
  lines.push(`Room type: ${String(config.type ?? "unknown")}`);
  lines.push(`Mechanism: ${String(config.mechanism ?? "unknown")}`);
  // Spec 152 W3 (P-2: settings-only, keyed off mechanism capability, never
  // content) — Stage A's Mica asked this exact surface "how is formal
  // acceptance recorded" and got no answer; --agreement was typed zero times
  // in any transcript.
  if (config.mechanism === "simple_majority" || config.mechanism === "supermajority") {
    lines.push(
      `Agreement questions: supported — ${grpCommand('ask --agreement "..."')} resolves only when every eligible voter accepts the same option (${grpCommand("accept N")} to accept).`,
    );
  }
  lines.push(
    `Quorum: ${config.quorum === null || config.quorum === undefined ? "host default" : String(config.quorum)}`,
  );
  lines.push(`Choice visibility: ${String(config.choice_visibility ?? "unknown")}`);
  lines.push(`Early close: ${String(config.early_close ?? "unknown")}`);
  if (config.settle_window !== undefined)
    lines.push(`Settle window: ${String(config.settle_window)}s`);
  lines.push(`Creator chooses: ${String(config.creator_votes ?? "unknown")}`);
  const proposal = isRecord(config.option_proposal_authority)
    ? String(config.option_proposal_authority.kind ?? "unknown")
    : "unknown";
  const invites = isRecord(config.invite_authority)
    ? String(config.invite_authority.kind ?? "unknown")
    : "unknown";
  const asking = isRecord(config.decision_opening_authority)
    ? String(config.decision_opening_authority.kind ?? "unknown")
    : "unknown";
  const closing = isRecord(config.conclusion_authority)
    ? String(config.conclusion_authority.kind ?? "unknown")
    : "unknown";
  lines.push(`Can invite: ${invites}`);
  lines.push(`Can propose: ${proposal}`);
  lines.push(`Can ask: ${asking}`);
  lines.push(`Can close: ${closing}`);
  return `${lines.join("\n")}\n`;
}

function renderSettingsUpdated(response: Record<string, unknown>, ref: RoomRef): string {
  const changed = Array.isArray(response.changed) ? response.changed.map(String) : [];
  const lines = [`Settings updated for ${String(response.slug ?? ref.slug)}`];
  lines.push(`Changed: ${changed.length > 0 ? changed.join(", ") : "none"}`, "");
  lines.push(renderSettings(response, ref).trimEnd());
  return `${lines.join("\n")}\n`;
}

function renderCreatedInvite(
  response: Record<string, unknown>,
  ref: RoomRef,
  env: Record<string, string | undefined>,
): string {
  const invite = isRecord(response.invite) ? response.invite : {};
  const label = stringOrNull(invite.label) ?? "unnamed";
  const code = stringOrNull(invite.code) ?? "unknown";
  const role = stringOrNull(invite.role) ?? "participant";
  const expected = invite.expected === false ? "optional" : "expected";
  const binding = inviteBindingText(invite);
  // Spec 106 — the pasted join command must be self-sufficient: a full room
  // URL works with no default host configured. Prefer the host-built command;
  // fall back to building the same full-URL form from the resolved ref.
  const slug = String(response.slug ?? ref.slug);
  const joinCommand =
    stringOrNull(response.join_command) ??
    `grp join ${ref.baseUrl}/r/${encodeURIComponent(slug)} --invite ${String(response.invite_token ?? "<invite_token>")}`;
  // Spec 111 (WR-2 + WR3-2) — prefer the server-built self-grounding paste
  // block so every current client relays the identical artifact. Older hosts
  // do not return discovery identity here, so the local fallback names only
  // the service URL rather than inventing an operator.
  const pasteBlock =
    stringOrNull(response.paste_block) ??
    buildInvitePasteBlock(ref.baseUrl, joinCommand, label, role);
  const lines = [
    `Invite created for ${label}`,
    `Management code (list/revoke): ${code}`,
    `Role: ${role} (${expected})`,
  ];
  // Spec 111 (WR3-1) — observer stays an operator-level concept: the one
  // prominence surface is right here, where the admin just picked a role.
  if (role === "participant") {
    lines.push("Watch-only seat? Re-create with --role observer.");
  }
  lines.push(`Binding: ${binding}`);
  lines.push(
    "Secret join credential: included only in the paste block below.",
    "Credential warning: this invite can recover its named seat even after acceptance.",
    "Keep it out of recordings, screenshots, transcripts, logs, and browser URLs.",
    `If exposed, revoke it with: ${grpCommand(`invite revoke ${code}${roomHintArg(ref.slug, ref, env)}`)}`,
  );
  const joinUrl = credentialFreeRoomUrl(stringOrNull(response.join_url));
  if (joinUrl) {
    lines.push("", "Browser link:");
    lines.push(`  ${joinUrl}`);
  }
  // Spec 113 (WR5-2) — the paste block comes LAST (recency for relaying
  // agents) with an explicit relay instruction; run-5 Silica relayed bare
  // join commands when the block sat mid-output.
  lines.push("", "Relay the whole block below — every line matters to the receiving agent.");
  lines.push("Paste this to the agent, intact:");
  for (const blockLine of pasteBlock.split("\n")) lines.push(`  ${blockLine}`);
  return `${lines.join("\n")}\n`;
}

function credentialFreeRoomUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    for (const key of [
      "invite",
      "invite_token",
      "token",
      "participant_token",
      "password",
      "passcode",
    ]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Spec 111/213 — client-side fallback for hosts that predate `paste_block`.
 * Their invite response does not carry discovery identity, so ground the
 * recipient with the service URL without claiming who operates it.
 */
function buildInvitePasteBlock(
  baseUrl: string,
  joinCommand: string,
  label: string,
  role: string,
): string {
  const lines = [`You’re invited to join a GRP room. ${SHARED_ROOM_DEFINITION}`, ""];
  lines.push(`This invite is for ${inviteAboutLine(label)} (${inviteAboutLine(role)}).`, "");
  lines.push(`Room service: ${baseUrl.replace(/\/+$/, "")}.`, "");
  lines.push(
    "If needed, install the open-source GRP CLI:",
    "npm install -g @grp-protocol/cli",
    "",
    `After joining, ${grpCommand("read")} shows the room’s purpose and current shared state.`,
    "",
    "Join the room:",
    joinCommand,
  );
  return lines.join("\n");
}

function inviteAboutLine(about: string): string {
  // Spec 126 (TS1-3) — never clip: the block says "paste intact", and the
  // about may carry the room's operative rules. Flatten whitespace only.
  return about.replace(/\s+/g, " ").trim();
}

function renderInviteList(
  response: { slug?: string; invites?: unknown[] },
  ref: RoomRef,
  env: Record<string, string | undefined>,
): string {
  const invites = Array.isArray(response.invites) ? response.invites : [];
  const lines = [`Invites for ${String(response.slug ?? ref.slug)}`];
  if (invites.length === 0) {
    const room = roomHintArg(String(response.slug ?? ref.slug), ref, env);
    lines.push("No named invites yet.", "", "Create one:");
    lines.push(`  ${grpCommand(`invite --name <name>${room}`)}`);
    return `${lines.join("\n")}\n`;
  }
  for (const invite of invites) {
    if (!isRecord(invite)) continue;
    const label = stringOrNull(invite.label) ?? "unnamed";
    const code = stringOrNull(invite.code) ?? "unknown";
    const role = stringOrNull(invite.role) ?? "participant";
    const status = stringOrNull(invite.status) ?? "unknown";
    const expected = invite.expected === false ? "optional" : "expected";
    const binding = inviteBindingText(invite);
    lines.push(`- ${label} ${code} ${role} ${expected} ${status} ${binding}`);
  }
  return `${lines.join("\n")}\n`;
}

function inviteBindingText(invite: Record<string, unknown>): string {
  // Spec 106 — the binding object is the one wire shape for invite bindings.
  const binding = isRecord(invite.binding) ? invite.binding : null;
  const kind = stringOrNull(binding?.kind) ?? "token";
  const value = stringOrNull(binding?.value);
  if (kind === "token") return "token invite";
  return value ? `${kind} ${value}` : kind;
}

function renderRoomRead(
  response: Record<string, unknown>,
  ref: RoomRef,
  env: Record<string, string | undefined>,
): string {
  const lines = [`Room ${String(response.slug ?? ref.slug)}`];
  const about = stringOrNull(response.about);
  if (about) lines.push(`Project: ${about}`);
  const brief = typeof response.brief === "string" ? response.brief.trim() : "";
  const initialDecision = activeDecision(response);
  if (
    brief.length > 0 &&
    !(
      initialDecision === null &&
      /^(?:(?:there is )?no (?:open )?(?:decision|question)|no (?:decision|question) is open)[.!]?$/i.test(
        brief,
      )
    )
  ) {
    lines.push(brief);
  }
  // Spec 109 (WR2-1) — role-aware guidance: observers get watch/read
  // guidance, never choose/propose/discuss/ask affordances. Unknown role
  // (old servers, no saved join role) keeps the participant rendering.
  const isObserver = callerRole(response, ref, env) === "observer";
  // Shared-work state must precede generic decision/chat guidance. In
  // particular, a live enforced lock should be visible before an agent encounters a
  // broad "Next" suggestion that could send it into overlapping work.
  appendCoordinationState(lines, response, ref, env);
  const decision = initialDecision;
  const state = optionState(response);
  if (decision) {
    const options = decisionOptions(decision);
    const choicesCast = numberOrNull(decision.choices_cast) ?? numberOrNull(decision.votes_cast);
    const eligibleVoters = numberOrNull(decision.eligible_voters);
    const hasProgress = choicesCast !== null && eligibleVoters !== null;
    let waitingForChoices = false;
    // Spec 115 (WR7-6) — say each fact once: the brief already carries the
    // question, phase, and progress; the body adds only what the brief
    // doesn't (the numbered options, eligibility, discussion, next steps).
    lines.push("", `Question: ${stringOrNull(decision.question) ?? "unknown"}`);
    if (choicesCast !== null && eligibleVoters !== null && choicesCast < eligibleVoters) {
      waitingForChoices = true;
    }
    const eligible = stringArray(decision.eligible);
    if (eligible.length > 0) lines.push(`Who can choose: ${eligible.join(", ")}`);
    if (options.length > 0) {
      lines.push("Options:");
      for (const [index, option] of options.entries()) lines.push(`  ${index + 1}. ${option}`);
    }
    appendDiscussion(lines, response);
    if (isObserver) {
      appendObserverGuidance(lines, response, ref, env);
    } else {
      appendOpenDecisionGuidance(
        lines,
        response,
        ref,
        state,
        { hasProgress, waitingForChoices },
        env,
      );
    }
  } else if (String(response.status ?? "") === "open") {
    appendDiscussion(lines, response);
    const room = roomHintArg(String(response.slug ?? ref.slug), ref, env);
    if (isObserver) {
      lines.push("", "Next:", `  Wait for room activity: ${grpCommand(`watch${room}`)}`);
    } else {
      const callerId = callerIdentity(ref, env).participantId;
      if (!hasCallerActionObligation(response, callerId)) {
        lines.push("", "Nothing currently needs your response.", "", "Next:");
        appendIdleGuidance(lines, response, room, callerId);
      }
    }
  }
  lines.push("", "Other commands:");
  // Spec 106 — closed rooms must not advertise dead actions: a concluded
  // (or expired) room is read-only forever, so only read-side actions apply.
  const roomStatus = String(response.status ?? "open");
  const room = roomHintArg(String(response.slug ?? ref.slug), ref, env);
  if (roomStatus === "concluded" || roomStatus === "expired") {
    lines.push(`  ${grpCommand(`outcome${room}`)}`, `  ${grpCommand(`members${room}`)}`);
  } else if (isObserver) {
    lines.push(
      `  ${grpCommand(`read${room}`)}`,
      `  ${grpCommand(`watch${room}`)}`,
      `  ${grpCommand(`outcome${room}`)}`,
      `  ${grpCommand(`members${room}`)}`,
    );
  } else {
    lines.push(
      `  ${grpCommand(`invite${room}`)}`,
      `  ${grpCommand(`members${room}`)}`,
      `  ${grpCommand(`settings${room}`)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Spec 224 candidate — bounded shared-work state carried by ordinary reads. */
function appendCoordinationState(
  lines: string[],
  response: Record<string, unknown>,
  ref: RoomRef,
  env: Record<string, string | undefined>,
): void {
  const composing = Array.isArray(response.composing) ? response.composing.filter(isRecord) : [];
  if (composing.length > 0) {
    const names = composing.map(
      (signal) =>
        stringOrNull(signal.display_name) ?? stringOrNull(signal.participant_id) ?? "unknown",
    );
    if (names.length === 1) {
      lines.push("", `Presence: ${names[0]} is composing a message.`);
    } else {
      lines.push("", `Presence: ${names.join(", ")} are composing messages.`);
    }
  }
  const actions = Array.isArray(response.actions) ? response.actions.filter(isRecord) : [];
  const decisions = Array.isArray(response.decisions) ? response.decisions.filter(isRecord) : [];
  const callerId = callerIdentity(ref, env).participantId;
  const recoverableActionIds = new Set(
    recoverablePeerWatchActions(response, ref, env).map((action) => stringOrNull(action.id)),
  );
  const room = roomHintArg(String(response.slug ?? ref.slug), ref, env);
  if (actions.length > 0) {
    lines.push("", "Shared actions:");
    for (const action of actions) {
      const id = stringOrNull(action.id) ?? "unknown";
      const revision = stringOrNull(action.revision) ?? "?";
      const status = stringOrNull(action.status) ?? "unknown";
      const title = stringOrNull(action.title) ?? "untitled";
      const holderId = stringOrNull(action.holder_id);
      const target = stringOrNull(action.target_artifact_id);
      const mode = actionModeFromWire(action.mode);
      const completion = actionCompletionFromWire(action.completion);
      const isActive = !["completed", "failed", "cancelled"].includes(status);
      const isRecoverable = recoverableActionIds.has(id);
      const isHolder = holderId !== null && holderId === callerId;
      const holder = isHolder
        ? "you"
        : (stringOrNull(action.holder_display_name) ?? holderId ?? "unassigned");
      const completionResult = target ? "" : ' --result-text="Exact result"';
      const completionDecision = decisions.find(
        (decision) => stringOrNull(decision.id) === stringOrNull(action.completion_decision_id),
      );
      const completionSeq = completionDecision ? numberOrNull(completionDecision.seq) : null;
      const review = isRecord(action.review) ? action.review : null;
      const reviewRevisionId = review ? stringOrNull(review.artifact_revision_id) : null;
      const reviewRequestedById = review ? stringOrNull(review.requested_by_id) : null;
      const reviewRequiredIds =
        review && Array.isArray(review.required_participant_ids)
          ? review.required_participant_ids.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
      const reviewRespondedIds =
        review && Array.isArray(review.responded_participant_ids)
          ? review.responded_participant_ids.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
      const artifact = Array.isArray(response.artifacts)
        ? response.artifacts
            .filter(isRecord)
            .find((candidate) => stringOrNull(candidate.id) === target)
        : undefined;
      const reviewStatus =
        artifact && isRecord(artifact.review_status) ? artifact.review_status : {};
      const currentReviews = Array.isArray(reviewStatus.current)
        ? reviewStatus.current.filter(isRecord)
        : [];
      const ownExactReview = currentReviews.find(
        (candidate) =>
          stringOrNull(candidate.reviewer_id) === callerId &&
          stringOrNull(candidate.revision_id) === reviewRevisionId,
      );
      const guidance =
        status === "in_review"
          ? `; reviewing exact revision ${reviewRevisionId ?? "unknown"}`
          : status === "awaiting_completion"
            ? `; completion proposed${completionSeq === null ? "" : ` in decision ${completionSeq}`}`
            : isRecoverable
              ? "; RECOVERABLE — holder lease expired"
              : isActive && mode === "handoff" && action.available === true
                ? "; AVAILABLE to take"
                : isActive && mode === "handoff"
                  ? "; held by another participant"
                  : isActive && mode === "all"
                    ? `; ${numberOrNull(isRecord(action.progress) ? action.progress.completed : null) ?? 0}/${numberOrNull(isRecord(action.progress) ? action.progress.required : null) ?? "?"} complete`
                    : "";
      lines.push(
        `  ${id} [rev ${revision}] ${status} — ${title}; ${mode.replaceAll("_", "-")}; completion ${completion}${mode === "all" ? "" : `; holder ${holder}`}${target ? `; artifact ${target}` : ""}${guidance}`,
      );
      if (status === "in_review") {
        if (callerId && reviewRespondedIds.includes(callerId)) {
          if (callerId === reviewRequestedById) {
            lines.push(
              `    Your approval is recorded; ${Math.max(0, reviewRequiredIds.length - reviewRespondedIds.length)} responses remain outstanding.`,
              `    Available: ${grpCommand(`watch --action=${id}${room}`)}`,
            );
          } else {
            lines.push(
              `    Your review response is recorded (${stringOrNull(ownExactReview?.disposition) ?? "reviewed"}).`,
              `    Available: ${grpCommand(`act review ${id}${room}`)} or ${grpCommand(`watch --action=${id}${room}`)}`,
            );
          }
        } else if (callerId && reviewRequiredIds.includes(callerId)) {
          lines.push(`    Required: ${grpCommand(`act review ${id}${room}`)}`);
        } else {
          lines.push(
            "    No review response is required from you.",
            `    Available: ${grpCommand(`watch --action=${id}${room}`)}`,
          );
        }
      } else if (status === "awaiting_completion") {
        // The open completion question below carries the one actionable Next
        // block. Repeating it here made ecological reads look like two flows.
      } else if (isRecoverable) {
        lines.push(
          `    Next: ${grpCommand(`act takeover ${id} --reason="Resuming after holder lease expiry"${room}`)}`,
        );
      } else if (isActive && mode === "handoff" && action.available === true) {
        lines.push(
          `    Next: ${grpCommand(`act take ${id}${room}`)} or ${grpCommand(`watch --action=${id}${room}`)}`,
        );
      } else if (isActive && mode === "handoff" && isHolder) {
        lines.push(
          completion === "group" && target
            ? `    Request exact review: ${grpCommand(`act request-review ${id}${room}`)}`
            : completion === "group"
              ? `    Propose completion: ${grpCommand(`act complete ${id}${completionResult}${room}`)}`
              : `    Finish on your report: ${grpCommand(`act complete ${id}${room}`)}`,
          `    Hand off the shared turn: ${grpCommand(`act handoff ${id} --to=NAME --note="What is next"${room}`)}`,
        );
      } else if (isActive && mode === "handoff" && holder !== callerId) {
        lines.push(`    Next: ${grpCommand(`watch --action=${id}${room}`)}`);
      } else if (isActive && mode === "single" && isHolder) {
        lines.push(
          completion === "group" && target
            ? `    Request exact review: ${grpCommand(`act request-review ${id}${room}`)}`
            : completion === "group"
              ? `    Propose completion: ${grpCommand(`act complete ${id}${completionResult}${room}`)}`
              : `    Finish on your report: ${grpCommand(`act complete ${id}${room}`)}`,
        );
      } else if (isActive && mode === "all") {
        const actionParticipants = Array.isArray(action.participants)
          ? action.participants.filter(isRecord)
          : [];
        const own = actionParticipants.find(
          (participant) => stringOrNull(participant.participant_id) === callerId,
        );
        const ownStatus = own ? stringOrNull(own.status) : null;
        if (ownStatus === "pending") {
          lines.push(
            `    Your report is required: ${grpCommand(`act complete ${id} --result-text="What happened"${room}`)}`,
          );
        } else if (ownStatus === "completed") {
          lines.push(`    Your report is recorded: ${grpCommand(`watch --action=${id}${room}`)}`);
        }
      }
    }
  }

  const artifacts = Array.isArray(response.artifacts) ? response.artifacts.filter(isRecord) : [];
  if (artifacts.length > 0) {
    lines.push("", "Shared artifacts:");
    for (const artifact of artifacts) {
      const id = stringOrNull(artifact.id) ?? "unknown";
      const revision = stringOrNull(artifact.revision) ?? "?";
      const name = stringOrNull(artifact.name) ?? "unnamed";
      const current = stringOrNull(artifact.current_revision_id) ?? "none";
      const claim = isRecord(artifact.claim) ? artifact.claim : null;
      const activeTargetAction = actions.find((action) => {
        const actionStatus = stringOrNull(action.status) ?? "unknown";
        return (
          !["completed", "failed", "cancelled"].includes(actionStatus) &&
          stringOrNull(action.target_artifact_id) === id
        );
      });
      const activeTargetActionId = activeTargetAction ? stringOrNull(activeTargetAction.id) : null;
      const targetAwaitingCompletion =
        activeTargetAction && stringOrNull(activeTargetAction.status) === "awaiting_completion";
      const actionHolderId = activeTargetAction ? stringOrNull(activeTargetAction.holder_id) : null;
      const actionHolder =
        actionHolderId !== null && actionHolderId === callerId
          ? "you"
          : activeTargetAction
            ? (stringOrNull(activeTargetAction.holder_display_name) ?? actionHolderId ?? "unknown")
            : "unknown";
      const claimText = targetAwaitingCompletion
        ? "; frozen while its action completion decision is open"
        : activeTargetActionId
          ? `; current editor ${actionHolder} via action ${activeTargetActionId}`
          : claim
            ? `; current editor ${stringOrNull(claim.holder_id) ?? "unknown"}`
            : "; no active editor";
      lines.push(`  ${id} [rev ${revision}] — ${name}; current ${current}${claimText}`);
    }
  }
}

/** Spec 231 — whether the room already gives this seat a concrete action
 * next-step. When true, do not follow it with the generic idle menu. */
function hasCallerActionObligation(response: Record<string, unknown>, callerId?: string): boolean {
  const actions = Array.isArray(response.actions) ? response.actions.filter(isRecord) : [];
  return actions.some((action) => {
    const status = stringOrNull(action.status) ?? "unknown";
    if (["completed", "failed", "cancelled", "awaiting_completion"].includes(status)) return false;
    const mode = actionModeFromWire(action.mode);
    const holder = stringOrNull(action.holder_id) ?? stringOrNull(action.assignee_id);
    if (mode === "handoff") return true;
    if (mode === "single") return callerId !== undefined && holder === callerId;
    if (mode !== "all" || callerId === undefined) return false;
    const participants = Array.isArray(action.participants)
      ? action.participants.filter(isRecord)
      : [];
    return participants.some(
      (participant) => stringOrNull(participant.participant_id) === callerId,
    );
  });
}

function activePeerWatchRecommendations(
  response: Record<string, unknown>,
  callerId?: string,
): Array<{ id: string }> {
  const actions = Array.isArray(response.actions) ? response.actions.filter(isRecord) : [];
  return actions.flatMap((action) => {
    const id = stringOrNull(action.id);
    const status = stringOrNull(action.status) ?? "unknown";
    const holderId = stringOrNull(action.holder_id) ?? stringOrNull(action.assignee_id);
    if (
      id === null ||
      actionModeFromWire(action.mode) !== "handoff" ||
      action.recoverable === true ||
      status === "awaiting_completion" ||
      (callerId !== undefined && holderId === callerId) ||
      ["completed", "failed", "cancelled"].includes(status)
    ) {
      return [];
    }
    return [{ id }];
  });
}

function recoverablePeerWatchActions(
  response: Record<string, unknown>,
  ref: RoomRef,
  env: Record<string, string | undefined>,
): Record<string, unknown>[] {
  const callerId = callerIdentity(ref, env).participantId;
  const actions = Array.isArray(response.actions) ? response.actions.filter(isRecord) : [];
  return actions
    .filter((action) => {
      const status = stringOrNull(action.status) ?? "unknown";
      const holderId = stringOrNull(action.holder_id) ?? stringOrNull(action.assignee_id);
      return (
        action.recoverable === true &&
        actionModeFromWire(action.mode) === "handoff" &&
        status !== "awaiting_completion" &&
        holderId !== null &&
        holderId !== callerId &&
        !["completed", "failed", "cancelled"].includes(status)
      );
    })
    .sort((left, right) => {
      const leftAt = Date.parse(stringOrNull(left.lease_expires_at) ?? "");
      const rightAt = Date.parse(stringOrNull(right.lease_expires_at) ?? "");
      const normalizedLeft = Number.isFinite(leftAt) ? leftAt : Number.NEGATIVE_INFINITY;
      const normalizedRight = Number.isFinite(rightAt) ? rightAt : Number.NEGATIVE_INFINITY;
      return normalizedLeft - normalizedRight;
    });
}

/**
 * Spec 112 (WR4-5) — render the discussion tail the agent view already
 * carries. Spec 115 (WR7-1): UNCLIPPED. The read is the flagship catch-up
 * surface — run 7's joiners lost the premise's tail to a 600-char display
 * cap and detoured through --json/timeline to recover it. The tail is
 * server-windowed, so the render stays bounded without a per-entry cap.
 */
function appendDiscussion(lines: string[], response: Record<string, unknown>): void {
  const discussion = Array.isArray(response.discussion) ? response.discussion : [];
  const entries = discussion.filter(isRecord);
  if (entries.length === 0) return;
  lines.push("Discussion:");
  for (const entry of entries) {
    const who = stringOrNull(entry.who) ?? "unknown";
    const stance = stringOrNull(entry.stance);
    const said = stringOrNull(entry.said) ?? "";
    const [first = "", ...restLines] = said.split("\n");
    lines.push(`  ${who}${stance ? ` (${stance})` : ""}: ${first}`);
    for (const restLine of restLines) lines.push(`    ${restLine}`);
  }
  const earlier = numberOrNull(response.discussion_earlier);
  if (earlier !== null && earlier > 0)
    lines.push(`  (+${earlier} earlier — ${grpCommand("timeline")})`);
}

/**
 * Spec 109 (WR2-1) — observer read guidance: follow the room, do not act on
 * the ballot. Rendered instead of the participant Next: block.
 */
function appendObserverGuidance(
  lines: string[],
  response: Record<string, unknown>,
  ref: RoomRef,
  env: Record<string, string | undefined>,
): void {
  const room = roomHintArg(String(response.slug ?? ref.slug), ref, env);
  lines.push("", "Next:");
  lines.push("  You are an observer in this room: follow along; choosing is for participants.");
  // Spec 113 — watch wakes observers too (any activity by others).
  lines.push(`  Wait for what's next: ${grpCommand(`watch${room}`)}`);
  lines.push(`  Check the result: ${grpCommand(`outcome${room}`)}`);
}

/**
 * Spec 109 (WR2-1) — the caller's own room role. Prefers the role the server
 * reports on the read (new servers, always current); falls back to the role
 * saved from the join response (spec 090/098 room memory); null when unknown.
 */
function callerRole(
  response: Record<string, unknown>,
  ref: RoomRef,
  env: Record<string, string | undefined>,
): "participant" | "observer" | null {
  const fromResponse =
    readRoleValue(response.role) ??
    readRoleValue(response.your_role) ??
    readRoleValue(isRecord(response.you) ? response.you.role : undefined) ??
    readRoleValue(isRecord(response.caller) ? response.caller.role : undefined) ??
    readRoleValue(isRecord(response.viewer) ? response.viewer.role : undefined);
  if (fromResponse) return fromResponse;
  const remembered = findRememberedRoom(readProviderConfig(env), ref.slug, ref.baseUrl);
  return readRoleValue(remembered?.role);
}

function readRoleValue(value: unknown): "participant" | "observer" | null {
  return value === "participant" || value === "observer" ? value : null;
}

function appendOpenDecisionGuidance(
  lines: string[],
  response: Record<string, unknown>,
  ref: RoomRef,
  state: Record<string, unknown>,
  progress: { hasProgress: boolean; waitingForChoices: boolean },
  env: Record<string, string | undefined>,
): void {
  // Spec 106 — targetless hints when this is the current room (the form that
  // works on cold machines with no default host); slug form otherwise.
  const room = roomHintArg(String(response.slug ?? ref.slug), ref, env);
  const phase = String(state.phase ?? "unknown");
  const multiOpen = Array.isArray(response.decisions_open) && response.decisions_open.length > 1;
  lines.push("", "Next:");
  const decision = activeDecision(response);
  const completion =
    decision && isRecord(decision.action_completion) ? decision.action_completion : null;
  const completionActionId = completion ? stringOrNull(completion.action_id) : null;
  if (decision && completion && completionActionId) {
    const actions = Array.isArray(response.actions) ? response.actions.filter(isRecord) : [];
    const action =
      actions.find((candidate) => stringOrNull(candidate.id) === completionActionId) ??
      ({
        id: completionActionId,
        status: "awaiting_completion",
        result: completion.result,
      } as Record<string, unknown>);
    if (multiOpen) {
      lines.push(
        `  This completion proposal is decision ${numberOrNull(decision.seq) ?? "?"}; other open decisions remain separately scoped.`,
      );
    }
    lines.push(
      ...completionActionGuidance(action, decision, response, ref, env).map((line) => `  ${line}`),
    );
    return;
  }
  if (multiOpen) {
    // Spec 145 (F144-S2) — the projection is the oldest open decision, but
    // the obligations are plural. Keep every act explicitly thread-scoped.
    lines.push(
      `  Review each open thread: ${grpCommand(`read --decision=N${room}`)}`,
      `  See its slate: ${grpCommand(`options --decision=N${room}`)}`,
      `  Act in that thread using the ballot form shown by ${grpCommand(`options --decision=N${room}`)}; discussion and proposals stay thread-scoped too.`,
    );
    appendDiscussGuidance(lines, ` --decision=N${room}`);
    lines.push(`  Then wait for what's next: ${grpCommand(`watch${room}`)}`);
    return;
  }
  if (phase === "proposing") {
    lines.push("  Build the option slate through the room.");
    lines.push("  Propose the full option text; keep commentary in the room discussion.");
    lines.push(`  Propose next: ${grpCommand(`propose "..."${room}`)}`);
    appendDiscussGuidance(lines, room);
    if (state.can_start_choosing === true) {
      lines.push(`  When the slate is ready: ${grpCommand(`start choosing${room}`)}`);
    }
    return;
  }
  if (progress.waitingForChoices) {
    // Spec 112 (WR4-4b) — room mechanics, never agent duties: engagement,
    // not speed. Deliberation before choosing is the product's core value.
    lines.push(...choosingGuidance());
    appendDiscussGuidance(lines, room);
    lines.push(`  See the options: ${grpCommand(`options${room}`)}`);
    if (phase !== "proposing") {
      lines.push(`  If you have not responded yet: ${choiceCommand(state.choice_mode, "", room)}`);
      const active = activeDecision(response);
      if (active?.agreement !== true) {
        lines.push(`  Or formally abstain: ${grpCommand(`abstain --reason="..."${room}`)}`);
      }
    }
    if (state.proposal_status === "open") {
      lines.push("  If the option set is incomplete, propose another candidate answer:");
      lines.push(`  ${grpCommand(`propose "..."${room}`)}`);
    }
    // Spec 113 — ONE wait: watch wakes on any activity by others, and always
    // when the room needs your choice. No resolved/needed split to pick.
    lines.push(`  Wait for what's next: ${grpCommand(`watch${room}`)}`);
    return;
  }
  if (!progress.hasProgress) {
    lines.push("  Continue through the room until an outcome exists.");
    lines.push(`  Wait for what's next: ${grpCommand(`watch${room}`)}`);
    lines.push(`  Check the result: ${grpCommand(`outcome${room}`)}`);
    return;
  }
  lines.push("  Choices are in or the room is still updating.");
  lines.push(`  Wait for what's next: ${grpCommand(`watch${room}`)}`);
  lines.push(`  Check the result: ${grpCommand(`outcome${room}`)}`);
}

/** Spec 147 (F146-S2) — mechanism-neutral and honest under early close. */
function choosingGuidance(): string[] {
  return [
    "  This room resolves when its configured choice rules determine the outcome;",
    "  read the discussion, add your view, then choose (choices can be revised until the outcome locks).",
  ];
}

function activeDecision(response: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(response.decision)) return response.decision;
  if (isRecord(response.active_decision)) return response.active_decision;
  if (Array.isArray(response.decisions)) {
    const active = response.decisions.find(
      (decision) => isRecord(decision) && decision.status !== "resolved",
    );
    return isRecord(active) ? active : null;
  }
  return null;
}

function decisionOptions(decision: Record<string, unknown>): string[] {
  if (!Array.isArray(decision.options)) return [];
  return decision.options
    .map((option) => {
      if (typeof option === "string") return option;
      if (!isRecord(option)) return null;
      return (
        stringOrNull(option.text) ??
        stringOrNull(option.option) ??
        stringOrNull(option.label) ??
        stringOrNull(option.value)
      );
    })
    .filter((option): option is string => Boolean(option));
}

function latestOutcome(response: Record<string, unknown>): {
  question: string;
  winner: string | null;
  outcome: string | null;
  receipt: string | null;
  receiptJws: string | null;
} | null {
  if (Array.isArray(response.decided) && response.decided.length > 0) {
    const latest = response.decided[response.decided.length - 1];
    if (isRecord(latest)) {
      // Spec 119 (WR11-2) — the receipt hash rides the decided entry.
      const receipt = stringOrNull(latest.receipt);
      // Spec 115 (WR7-9) — new hosts send winner/outcome distinctly; old
      // hosts conflated them into `outcome`.
      const winner = stringOrNull(latest.winner);
      const outcome = stringOrNull(latest.outcome);
      if (winner !== null)
        return {
          question: stringOrNull(latest.question) ?? "unknown",
          winner,
          outcome,
          receipt,
          receiptJws: null,
        };
      if (outcome !== null && (outcome === "tied" || outcome === "no_pass" || outcome === "pass")) {
        return {
          question: stringOrNull(latest.question) ?? "unknown",
          winner: null,
          outcome,
          receipt,
          receiptJws: null,
        };
      }
      return {
        question: stringOrNull(latest.question) ?? "unknown",
        winner: outcome,
        outcome: null,
        receipt,
        receiptJws: null,
      };
    }
  }
  if (Array.isArray(response.decisions)) {
    const chain = response.decisions.filter((decision): decision is Record<string, unknown> =>
      isRecord(decision),
    );
    // The canonical /outcome wire keeps the latest resolution at the top
    // level and its portable receipt in decisions[]. Accept that real shape
    // before the older per-decision status aliases below.
    const responseStatus = stringOrNull(response.status);
    const topLevelResolved =
      responseStatus === "resolved" ||
      responseStatus === "concluded" ||
      stringOrNull(response.resolved_at) !== null;
    if (topLevelResolved) {
      const receiptEntry = [...chain]
        .reverse()
        .find((decision) => stringOrNull(decision.receipt_hash) !== null);
      return {
        question: stringOrNull(response.question) ?? "unknown",
        winner: stringOrNull(response.resolved_winner) ?? stringOrNull(response.resolvedWinner),
        outcome: stringOrNull(response.resolved_outcome) ?? stringOrNull(response.resolvedOutcome),
        receipt: receiptEntry
          ? (stringOrNull(receiptEntry.receipt_hash) ?? stringOrNull(receiptEntry.receiptHash))
          : null,
        receiptJws: receiptEntry
          ? (stringOrNull(receiptEntry.receipt_jws) ?? stringOrNull(receiptEntry.receiptJws))
          : null,
      };
    }
    const resolved = response.decisions
      .filter((decision): decision is Record<string, unknown> => isRecord(decision))
      // Current /outcome chain entries have a receipt hash but no `status`;
      // older and third-party hosts may include the explicit status.
      .filter(
        (decision) =>
          decision.status === "resolved" || stringOrNull(decision.receipt_hash) !== null,
      );
    const latest = resolved[resolved.length - 1];
    if (latest) {
      const winner = stringOrNull(latest.resolvedWinner) ?? stringOrNull(latest.resolved_winner);
      const outcome = stringOrNull(latest.resolvedOutcome) ?? stringOrNull(latest.resolved_outcome);
      return {
        question: stringOrNull(latest.question) ?? "unknown",
        winner,
        outcome,
        receipt: stringOrNull(latest.receipt_hash) ?? stringOrNull(latest.receiptHash),
        receiptJws: stringOrNull(latest.receipt_jws) ?? stringOrNull(latest.receiptJws),
      };
    }
  }
  return null;
}

function choiceMode(response: Record<string, unknown>): string | null {
  const rules = isRecord(response.rules) ? response.rules : null;
  const raw = rules ? stringOrNull(rules.how_to_choose) : null;
  if (raw) {
    // Spec 115 — the screen wants a label, not the wire's teaching sentence.
    if (raw.startsWith("choose with a single option")) return "single choice";
    if (raw.includes("array of every option")) return "approval (choose every acceptable option)";
    if (raw.includes("ranked array")) return "ranked (best first)";
    if (raw.includes("scores from")) return "score map";
    if (raw.includes("credits")) return "quadratic credits";
    return raw.replace(/\b[Vv]ote\b/g, (match) => (match === "Vote" ? "Choose" : "choose"));
  }
  // Spec 152 W4 — full reads carry config but not rules; derive the label
  // from the mechanism instead of leaving the renderer to fabricate
  // "single choice" (Stage A: options --full told a score room it was
  // single-choice while the server demanded a map).
  const config = isRecord(response.config) ? response.config : null;
  switch (config ? stringOrNull(config.mechanism) : null) {
    case "approval":
      return "approval (choose every acceptable option)";
    case "ranked_choice":
    case "ranked_pairwise":
      return "ranked (best first)";
    case "score_vote":
      return `score map (${grpCommand("choose --scores=1=5,2=0")})`;
    case "quadratic_vote":
      return `quadratic credits (${grpCommand("choose --scores=1=4,2=1")})`;
    case "simple_majority":
    case "supermajority":
    case "plurality":
      return "single choice";
    default:
      return null;
  }
}

function choiceCommand(mode: unknown, decision = "", room = ""): string {
  const label = typeof mode === "string" ? mode : "";
  if (label.startsWith("score map")) {
    return grpCommand(`choose --scores=1=5,2=0${decision}${room}`);
  }
  if (label.startsWith("quadratic credits")) {
    return grpCommand(`choose --scores=1=4,2=1${decision}${room}`);
  }
  if (label.startsWith("approval")) {
    return grpCommand(`choose --choices=1,3${decision}${room}`);
  }
  if (label.startsWith("ranked")) {
    return grpCommand(`choose --choices=2,1,3${decision}${room}`);
  }
  if (label === "single choice") {
    return grpCommand(`choose N${decision}${room}`);
  }
  return `${grpCommand(`options --full${decision}${room}`)}  # host did not report the ballot shape`;
}

function proposalStatus(decision: Record<string, unknown>): "open" | "closed" | "unknown" {
  const phase = stringOrNull(decision.status) ?? stringOrNull(decision.phase);
  if (phase === "proposing") return "open";
  if (phase === "voting" || phase === "resolved") return "closed";
  return "unknown";
}

function formatPhase(phase: string): string {
  if (phase === "proposing") return "Discussing";
  if (phase === "voting") return "Choosing";
  if (phase === "resolved") return "Complete";
  return phase;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item : null))
    .filter((item): item is string => !!item);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Spec 111 — count-first observer display. New servers put PARTICIPANTS only
 * in `roster.joined` and observers as the `roster.observers` count; old
 * servers listed observers inline in `joined` with a role field. Feature-
 * detect on `roster.observers` being a number and tolerate both shapes.
 */
function memberCountsFromList(response: Record<string, unknown>): {
  participants: number;
  observers: number;
} {
  const roster = isRecord(response.roster) ? response.roster : null;
  const joined = roster && Array.isArray(roster.joined) ? roster.joined : null;
  if (roster && typeof roster.observers === "number" && Number.isFinite(roster.observers)) {
    return { participants: joined?.length ?? 0, observers: roster.observers };
  }
  if (joined) {
    const observers = joined.filter(
      (member) => isRecord(member) && member.role === "observer",
    ).length;
    return { participants: joined.length - observers, observers };
  }
  const explicit = numberOrNull(response.participant_count);
  if (explicit !== null) return { participants: explicit, observers: 0 };
  return {
    participants: Array.isArray(response.participants) ? response.participants.length : 0,
    observers: 0,
  };
}

function writeStructured(
  response: unknown,
  flags: Record<string, string>,
  io: RoomCliIo,
  quietKey?: string,
): void {
  if (flags.quiet === "true" && quietKey && response && typeof response === "object") {
    const value = (response as Record<string, unknown>)[quietKey];
    if (value !== undefined && value !== null) {
      io.stdout(`${String(value)}\n`);
      return;
    }
  }
  io.stdout(renderJson(response));
}

// --- Spec 106 — write-path guidance ----------------------------------------
// Every mutating command prints a one-line human confirmation plus a Next:
// block (agent-surface principles: outputs are instructions; every state
// names its next action). --json keeps the exact raw response for scripts.

/**
 * Spec 106 — suggested commands use the targetless form when the room is the
 * saved current room (the form that always works, including on a cold machine
 * with no default host), and the explicit slug form only when pointing at
 * some other room.
 */
function roomHintArg(slug: string, ref: RoomRef, env: Record<string, string | undefined>): string {
  const current = readProviderConfig(env).currentRoom;
  if (!current || current.slug !== slug) return ` ${slug}`;
  const base = roomContextBaseUrl(current, env);
  if (base && normalizeUrlForCompare(base) !== normalizeUrlForCompare(ref.baseUrl)) {
    return ` ${slug}`;
  }
  return "";
}

function renderQuestionOpened(
  response: unknown,
  ref: RoomRef,
  requestedQuestion: string,
  env: Record<string, string | undefined>,
): string {
  const record = isRecord(response) ? response : {};
  const room = roomHintArg(String(record.slug ?? ref.slug), ref, env);
  const decision = isRecord(record.decision) ? record.decision : {};
  const question = stringOrNull(decision.question) ?? requestedQuestion;
  const agreement = decision.agreement === true;
  const lines = [
    agreement
      ? `Question opened (agreement): "${question}"${writeDestinationNote(ref, env)}`
      : `Question opened: "${question}"${writeDestinationNote(ref, env)}`,
  ];
  if (agreement) {
    lines.push(
      `It resolves only when every voter accepts the same option — disagreement never ends it early. Propose, discuss, revise; ${grpCommand(`accept N${room}`)} when an option works.`,
    );
  }
  if (stringOrNull(decision.status) === "proposing") {
    lines.push("Collecting options first: propose options, then start choosing.");
  }
  lines.push(
    "",
    "Next:",
    `  Read the room: ${grpCommand(`read${room}`)}`,
    `  Wait for what's next: ${grpCommand(`watch --timeout=300${room}`)}`,
  );
  return `${lines.join("\n")}\n`;
}

function renderDecisionCanceled(
  response: unknown,
  ref: RoomRef,
  requestedReason: string,
  env: Record<string, string | undefined>,
): string {
  const record = isRecord(response) ? response : {};
  const decision = isRecord(record.decision) ? record.decision : {};
  const room = roomHintArg(String(record.slug ?? ref.slug), ref, env);
  const seq = numberOrNull(decision.seq);
  const id = stringOrNull(decision.id);
  const label = seq !== null ? `#${seq}` : (id ?? "question");
  const reason = stringOrNull(record.reason) ?? requestedReason;
  const receipt = stringOrNull(record.receipt_hash);
  const lines = [
    `Decision ${label} canceled.${writeDestinationNote(ref, env)}`,
    `Reason: ${reason}`,
    "Its question, options, choices, and abstentions remain in the record. The room remains open.",
  ];
  if (receipt) lines.push(`Receipt: ${receipt}`);
  lines.push(
    "",
    "Next:",
    `  Read the room: ${grpCommand(`read${room}`)}`,
    `  Open a corrected question as a new decision: ${grpCommand(`ask "<question>"${room}`)}`,
  );
  return `${lines.join("\n")}\n`;
}

function renderOptionProposed(
  response: unknown,
  ref: RoomRef,
  option: string,
  env: Record<string, string | undefined>,
): string {
  const record = isRecord(response) ? response : {};
  const room = roomHintArg(String(record.slug ?? ref.slug), ref, env);
  const lines =
    record.accepted === false
      ? [
          `Option not added: "${option}" — ${stringOrNull(record.reason) ?? "not accepted"}.${writeDestinationNote(ref, env)}`,
        ]
      : [`Option proposed: "${option}"${writeDestinationNote(ref, env)}`];
  const count = Array.isArray(record.options) ? record.options.length : null;
  if (count !== null) lines.push(`Options on the slate: ${count}`);
  // Spec 118 (WR10-2) — the next gate depends on the decision's phase, which
  // the propose response now carries. Fluid decisions take proposals while
  // choices are OPEN, so the spec-116 slate copy ("when the slate is ready:
  // grp start choosing") was a stale gate for every mid-choosing propose in
  // run 10. Old hosts omit the field; keep the slate copy there — it is only
  // wrong for fluid decisions on pre-118 hosts.
  if (record.choosing_open === true) {
    lines.push(
      "",
      "Next:",
      `  See the slate: ${grpCommand(`options${room}`)}`,
      `  Choices are open — cast or revise yours: ${grpCommand(`choose N${room}`)}`,
    );
  } else {
    // Spec 116 (WR8-5) — during the slate phase the gate is start choosing,
    // not choose: dangling the choose verb early cost run 8 four premature
    // 400s ("you can't choose yet").
    lines.push(
      "",
      "Next:",
      `  See the slate: ${grpCommand(`options${room}`)}`,
      `  When the slate is ready: ${grpCommand(`start choosing${room}`)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderDiscussionPosted(ref: RoomRef, env: Record<string, string | undefined>): string {
  const room = roomHintArg(ref.slug, ref, env);
  const destination = room ? ` Room: ${ref.slug}.` : "";
  const lines = [`Discussion posted.${destination}`];
  lines.push(
    "",
    "Next:",
    `  Read the room: ${grpCommand(`read${room}`)}`,
    `  Stay with the room: ${grpCommand(`watch --timeout=300${room}`)}`,
  );
  return `${lines.join("\n")}\n`;
}

function renderChoosingStarted(
  response: unknown,
  ref: RoomRef,
  env: Record<string, string | undefined>,
): string {
  const record = isRecord(response) ? response : {};
  const room = roomHintArg(String(record.slug ?? ref.slug), ref, env);
  const decision = isRecord(record.decision) ? record.decision : {};
  const options = decisionOptions(decision);
  // Spec 117 — the door race is an idempotent success: someone else
  // opened choices first, which is exactly the state the caller wanted.
  const lines = [
    record.already_open === true
      ? "Choices are already open — someone beat you to it."
      : "Choices are open.",
  ];
  if (options.length > 0) lines.push(`Options: ${options.length} on the slate`);
  lines.push(
    "",
    "Next:",
    `  Submit your choice: ${grpCommand(`choose "<option>"${room}`)}`,
    `  See the options: ${grpCommand(`options${room}`)}`,
  );
  return `${lines.join("\n")}\n`;
}

function renderChoiceRecorded(
  response: unknown,
  ref: RoomRef,
  requested: string | string[] | Record<string, number>,
  env: Record<string, string | undefined>,
): string {
  const record = isRecord(response) ? response : {};
  const room = roomHintArg(String(record.slug ?? ref.slug), ref, env);
  const cast = record.cast_choice ?? requested;
  // Spec 150 — a score/quadratic map ballot confirms as "#1=5, #2=2".
  const castRaw = Array.isArray(cast)
    ? cast.map(String).join(", ")
    : isRecord(cast)
      ? Object.entries(cast)
          .map(([option, score]) => `#${option}=${String(score)}`)
          .join(", ")
      : String(cast);
  // Spec 114 — canonical option text can be document-sized; confirm compactly.
  const castText = castRaw.length > 300 ? `${castRaw.slice(0, 300)}…` : castRaw;
  const winner = stringOrNull(record.resolved_winner);
  const resolved = winner !== null || record.status === "resolved";
  const agreement = record.agreement === true;
  const lines = [
    agreement
      ? `Acceptance recorded: "${castText}"${writeDestinationNote(ref, env)}`
      : `Choice recorded: "${castText}"${writeDestinationNote(ref, env)}`,
  ];
  if (agreement && !resolved) {
    lines.push(
      `The question resolves when every voter accepts the same option; ${grpCommand("read")} shows where others stand. You can revise until it seals.`,
    );
  }
  // Spec 115 — the settle window at the moment it matters.
  const settling = isRecord(record.settling) ? record.settling : null;
  if (!resolved && settling) {
    const sealsIn = numberOrNull(settling.seals_in_seconds);
    lines.push(
      `Outcome currently determined — late choices and revisions still count${sealsIn !== null ? `; seals in ~${sealsIn}s` : ""}.`,
    );
  }
  if (resolved) {
    const outcome = winner ?? stringOrNull(record.resolved_outcome);
    lines.push(outcome ? `Decision resolved: "${outcome}"` : "Decision resolved.");
    // The resolved-winner case keeps the outcome first; the loop continues.
    lines.push(
      "",
      "Next:",
      `  See the outcome: ${grpCommand(`outcome${room}`)}`,
      `  Then wait for what's next: ${grpCommand(`watch${room}`)}`,
    );
  } else {
    // Spec 113 — the loop is watch → read → act → watch: one wait, no modes.
    lines.push("", "Next:", `  Wait for what's next: ${grpCommand(`watch${room}`)}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderRoomClosed(
  response: unknown,
  ref: RoomRef,
  env: Record<string, string | undefined>,
): string {
  const record = isRecord(response) ? response : {};
  const room = roomHintArg(String(record.slug ?? ref.slug), ref, env);
  const destination = roomHintArg(ref.slug, ref, env) ? ` Room: ${ref.slug}.` : "";
  return `Room closed.${destination}\n\nNext:\n  Final record: ${grpCommand(`outcome${room}`)}\n`;
}

function writeDestinationNote(ref: RoomRef, env: Record<string, string | undefined>): string {
  return roomHintArg(ref.slug, ref, env) ? ` — room ${ref.slug}` : "";
}

/**
 * Spec 139 (C2) — named pace presets. `async` sizes the room for seats that
 * check in on a schedule instead of holding a live watch: a days-scale
 * choice window with a minutes-scale settle. `early_close` (already the CLI
 * create default) keeps the fast path fast — a long window costs nothing
 * when everyone is live; a short one silently excludes routine-cadence
 * seats. Explicit --voting-window / --settle-window always win.
 */
const PACE_PRESETS: Record<string, { voting_window?: number; settle_window?: number }> = {
  live: {},
  async: { voting_window: 3 * 24 * 3600, settle_window: 300 },
};

function parsePaceFlag(
  raw: string | undefined,
): { voting_window?: number; settle_window?: number } | undefined {
  if (raw === undefined) return undefined;
  const preset = PACE_PRESETS[raw];
  if (!preset) {
    throw new Error(
      '--pace must be "live" or "async". async sets a ~3-day choice window with a 5-minute settle for rooms whose seats check in on a schedule; if a seat runs on a routine, keep the window longer than its cadence and use quorum or eligibility to require its voice.',
    );
  }
  return preset;
}

function buildConfig(flags: Record<string, string>): Record<string, unknown> | undefined {
  const pace = parsePaceFlag(flags.pace);
  const config = withoutUndefined({
    type: flags.type,
    visibility: flags.visibility,
    mechanism: flags.mechanism,
    auth: flags.auth,
    invite_authority: parseOptionalAuthority(flags["invite-authority"], "--invite-authority"),
    option_proposal_authority: parseOptionalAuthority(flags["option-proposal-authority"]),
    decision_opening_authority: parseOptionalAuthority(
      flags["decision-opening-authority"],
      "--decision-opening-authority",
    ),
    conclusion_authority: parseOptionalAuthority(
      flags["conclusion-authority"],
      "--conclusion-authority",
    ),
    quorum: parseOptionalNumber(flags.quorum),
    threshold: parseOptionalNumber(flags.threshold),
    voting_window: parseOptionalNumber(flags["voting-window"]) ?? pace?.voting_window,
    settle_window: parseOptionalNumber(flags["settle-window"]) ?? pace?.settle_window,
    deliberation_mode: flags["deliberation-mode"],
    max_participants: parseOptionalNumber(flags["max-participants"]),
    max_options: parseOptionalNumber(flags["max-options"]),
    max_deliberation_messages_per_participant: parseOptionalNumber(
      flags["max-deliberation-messages-per-participant"],
    ),
    max_total_deliberation_messages: parseOptionalNumber(flags["max-total-deliberation-messages"]),
    // Spec 143 (F142-S1) — create-time room cap; validated server-side
    // (integer 1..5, host ceiling), so host policy is never duplicated here.
    max_open_decisions: parseOptionalNumber(flags["max-open-decisions"]),
    read_receipts: parseOptionalBool(flags["read-receipts"]),
    choice_visibility: flags["choice-visibility"],
    early_close:
      flags["early-close"] === undefined ? true : parseOptionalBool(flags["early-close"]),
    creator_votes: parseOptionalBool(flags["creator-votes"]),
  });
  return Object.keys(config).length > 0 ? config : undefined;
}

function collectOptionsWindow(flags: Record<string, string>): number | undefined {
  const explicit = parseOptionalNumber(flags["proposal-window"]);
  if (explicit !== undefined) return explicit;
  const collect = flags["collect-options"];
  if (collect === undefined || collect === "false" || collect === "0" || collect === "no") {
    return undefined;
  }
  if (collect === "true") return 60 * 60 * 24;
  const parsed = Number(collect);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--collect-options must be a positive number of seconds when given a value");
  }
  return parsed;
}

function splitCsv(raw: string): string[] {
  if (raw.trim().length === 0) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function seedOptions(flags: Record<string, string>, repeatedOptions?: string[]): string[] {
  if (repeatedOptions?.some((option) => !option.trim())) {
    throw new Error("--option requires a value");
  }
  const repeated = (repeatedOptions ?? []).map((option) => option.trim()).filter(Boolean);
  if (repeated.length > 0 && flags.options !== undefined) {
    throw new Error("pass repeatable --option=TEXT or legacy --options=A,B, not both");
  }
  return repeated.length > 0 ? repeated : splitCsv(flags.options ?? "");
}

function resolveChoiceInput(
  flags: Record<string, string>,
): string | string[] | Record<string, number> {
  if (flags.scores !== undefined) {
    if (flags.choices !== undefined || flags.choice !== undefined) {
      throw new Error("--scores cannot be combined with --choice or --choices");
    }
    return parseScoresFlag(flags.scores);
  }
  if (flags.choices !== undefined) {
    const choices = splitCsv(flags.choices);
    if (choices.length === 0) throw new Error("--choices must include at least one choice");
    return choices;
  }
  return requireFlag(flags, "choice");
}

/**
 * Spec 150 — score/quadratic map ballots from the CLI. Keys are option
 * NUMBERS (the record's canonical handle since spec 117; numbers also dodge
 * the spec-133 comma-in-option-text CSV trap), values are the scores:
 * `--scores="1=5,2=2,3=0"`. Validated before HTTP; the server resolves the
 * numeric handles to exact option text at cast time.
 */
function parseScoresFlag(raw: string): Record<string, number> {
  const ballot: Record<string, number> = {};
  const pairs = raw
    .split(",")
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0);
  if (pairs.length === 0) {
    throw new Error('--scores must look like "1=5,2=2" (option number = score)');
  }
  for (const pair of pairs) {
    const m = /^#?(\d{1,4})\s*=\s*(\d+(?:\.\d+)?)$/.exec(pair);
    if (!m) {
      throw new Error(
        `--scores entry "${pair}" must be option-number=score (numbers only, e.g. 1=5); run ${grpCommand("options")} to see the numbered slate`,
      );
    }
    const key = String(Number(m[1]));
    if (Number(m[1]) < 1) throw new Error(`--scores option number must be 1 or higher: "${pair}"`);
    if (key in ballot) throw new Error(`--scores lists option ${key} twice`);
    ballot[key] = Number(m[2]);
  }
  return ballot;
}

function isJson(flags: Record<string, string>): boolean {
  return flags.json === "true";
}

function parseOptionalNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`expected number, got ${raw}`);
  return n;
}

function parseOptionalBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const value = raw.toLowerCase();
  if (value === "true" || value === "1" || value === "yes" || value === "on") return true;
  if (value === "false" || value === "0" || value === "no" || value === "off") return false;
  throw new Error(`expected boolean, got ${raw}`);
}

function parseStance(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "agree" || value === "disagree" || value === "clarify" || value === "extend") {
    return value;
  }
  throw new Error("available discussion stances are: agree, disagree, clarify, extend");
}

/**
 * Spec 141 — the optional decision selector: the room-local decision NUMBER
 * (the "seq N" shown in grp read), mirroring the option-number convention.
 * Validated before HTTP so a typo never reaches the wire.
 */
function parseDecisionFlag(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw.trim().replace(/^#/, ""));
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      '--decision must be a decision number — the "seq N" shown in grp read (e.g. --decision=3)',
    );
  }
  return n;
}

function parseInviteBindingFlags(
  flags: Record<string, string>,
): Record<string, string> | undefined {
  const entries: { kind: string; value: string | undefined }[] = [
    { kind: "email", value: flags.email },
    { kind: "account", value: flags.account },
    { kind: "principal", value: flags.principal },
    { kind: "sso_subject", value: flags["sso-subject"] ?? flags.sso_subject },
  ].filter((entry) => entry.value !== undefined);
  if (entries.length === 0) return undefined;
  if (entries.length > 1) {
    throw new Error(
      "use only one invite binding flag: --email, --account, --principal, or --sso-subject",
    );
  }
  const [entry] = entries;
  if (!entry) return undefined;
  const { kind, value } = entry;
  if (!value?.trim()) throw new Error(`--${kind.replace("_", "-")} requires a value`);
  return { kind, value: value.trim() };
}

function parseOptionalAuthority(
  raw: string | undefined,
  flagName = "--option-proposal-authority",
): { kind: string } | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "none" && raw !== "operator" && raw !== "designated" && raw !== "any_participant") {
    throw new Error(`${flagName} must be one of: none, operator, designated, any_participant`);
  }
  return { kind: raw };
}

// Spec 126 (TS1-2b) — real config keys that are fixed at room creation. An
// agent reaching for them gets pointed at the create-time flag instead of the
// generic unknown-setting line.
const CREATE_TIME_SETTING_KEYS: Record<string, string> = {
  mechanism:
    "mechanism is chosen when the room is created and existing rooms keep theirs.\n" +
    "Create with one: grp create --mechanism=supermajority --quorum=2\n" +
    "Two-party mutual assent also works with the default mechanism: quorum 2 means only 2-0 can resolve.",
  visibility:
    "visibility is chosen when the room is created: grp create --visibility=public|unlisted|private. A password is an optional credential for a private room; existing rooms keep their access mode.",
  settle_window: "settle_window is host policy and is fixed when the room is created.",
};

function parseSettingsPatch(
  key: string,
  rawValue: string,
  flags: Record<string, string>,
): Record<string, unknown> {
  if (!MUTABLE_SETTING_KEYS.includes(key)) {
    const createTime = CREATE_TIME_SETTING_KEYS[key];
    if (createTime) throw new Error(createTime);
    throw new Error(
      `unknown room setting: ${key}\nAvailable settings: ${MUTABLE_SETTING_KEYS.join(", ")}`,
    );
  }
  if (AUTHORITY_SETTING_KEYS.has(key)) {
    return { [key]: parseAuthoritySetting(key, rawValue, flags) };
  }
  if (BOOLEAN_SETTING_KEYS.has(key)) {
    return { [key]: parseRequiredBool(rawValue) };
  }
  if (NUMBER_SETTING_KEYS.has(key)) {
    if (rawValue === "null" && NULLABLE_SETTING_KEYS.has(key)) return { [key]: null };
    return { [key]: parseRequiredInteger(rawValue) };
  }
  const allowed = STRING_SETTING_VALUES[key];
  if (allowed) {
    if (!allowed.includes(rawValue)) {
      throw new Error(`${key} must be one of: ${allowed.join(", ")}`);
    }
    return { [key]: rawValue };
  }
  throw new Error(
    `unknown room setting: ${key}\nAvailable settings: ${MUTABLE_SETTING_KEYS.join(", ")}`,
  );
}

function parseAuthoritySetting(
  key: string,
  value: string,
  flags: Record<string, string>,
): { kind: string; participant_ids?: string[] } {
  const allowed = ["none", "operator", "designated", "any_participant"];
  if (!allowed.includes(value)) {
    throw new Error(`${key} must be one of: ${allowed.join(", ")}`);
  }
  if (value !== "designated") return { kind: value };
  const ids = splitCsv(flags["participant-ids"] ?? "");
  if (ids.length === 0) {
    throw new Error(`${key}=designated requires --participant-ids=id1,id2`);
  }
  return { kind: value, participant_ids: ids };
}

function parseRequiredInteger(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`expected integer, got ${raw}`);
  return n;
}

function parseRequiredBool(raw: string): boolean {
  const parsed = parseOptionalBool(raw);
  if (parsed === undefined) throw new Error(`expected boolean, got ${raw}`);
  return parsed;
}

// Spec 106 — missing-text errors teach the usage form instead of naming an
// internal flag ("--choice is required" told the caller nothing about the
// natural `grp choose "<option>"` form).
const TEXT_FLAG_USAGE: Record<string, { command: string; usage: string }> = {
  choice: { command: "choose", usage: 'usage: grp choose "<option>" [room]' },
  option: { command: "propose", usage: 'usage: grp propose "<option>" [room]' },
  body: { command: "discuss", usage: 'usage: grp discuss "<message>" [room]' },
  question: { command: "ask", usage: 'usage: grp ask "<question>" [room]' },
  reason: { command: "abstain", usage: 'usage: grp abstain --reason="..." [room]' },
};

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) throw new Error(TEXT_FLAG_USAGE[name]?.usage ?? `--${name} is required`);
  return value;
}

function requireQuestion(flags: Record<string, string>): string {
  const value = flags.ask ?? flags.question;
  if (!value) {
    throw new Error('usage: grp ask "<question>" [room]');
  }
  return value;
}

function joinDisplayName(
  flags: Record<string, string>,
  env: Record<string, string | undefined>,
): string | undefined {
  return (
    flags.as ??
    flags.name ??
    flags["display-name"] ??
    env.GRP_DISPLAY_NAME ??
    readProviderConfig(env).profile?.displayName
  );
}

function requiredTarget(target: string | undefined): string {
  if (!target) throw new Error("room URL or slug is required");
  return target;
}

function targetAndTextArg(
  args: string[],
  flags: Record<string, string>,
  io: RoomCliIo,
  textFlag: "body" | "choice" | "option" | "question" | "statement",
): { target: string; flags: Record<string, string> } {
  const nextFlags = { ...flags };
  if (args.length > 2) {
    throw new Error(TEXT_FLAG_USAGE[textFlag]?.usage ?? `too many arguments for --${textFlag}`);
  }
  const [maybeTargetOrText, explicitTrailingRoom] = args;
  if (nextFlags[textFlag]) {
    if (explicitTrailingRoom) {
      throw new Error(TEXT_FLAG_USAGE[textFlag]?.usage ?? `too many arguments for --${textFlag}`);
    }
    return { target: targetOrCurrent(maybeTargetOrText, nextFlags, io), flags: nextFlags };
  }
  if (!maybeTargetOrText) {
    return { target: targetOrCurrent(undefined, nextFlags, io), flags: nextFlags };
  }

  // Spec 131 — the documented text-first explicit form is real. The parser
  // previously ignored this trailing room and silently wrote to current.
  if (explicitTrailingRoom) {
    // Live agents also naturally try the room-first shape used by many other
    // CLIs. Accept it when the first token is unambiguously a remembered room
    // (or a full URL); otherwise preserve the documented text-first form.
    if (
      (/^https?:\/\//i.test(maybeTargetOrText) || knownRoomSlug(maybeTargetOrText, io)) &&
      !looksLikeRoomRef(explicitTrailingRoom)
    ) {
      nextFlags[textFlag] = explicitTrailingRoom;
      return { target: maybeTargetOrText, flags: nextFlags };
    }
    nextFlags[textFlag] = maybeTargetOrText;
    return { target: explicitTrailingRoom, flags: nextFlags };
  }

  const current = resolveCurrentRoomRef(nextFlags, io.env);
  if (current && !looksLikeRoomRef(maybeTargetOrText)) {
    nextFlags[textFlag] = maybeTargetOrText;
    return { target: targetOrCurrent(undefined, nextFlags, io), flags: nextFlags };
  }
  if (!current && !looksLikeRoomRef(maybeTargetOrText)) {
    throw new Error(
      [
        "No current room.",
        `Run \`${grpCommand("enter <room-id>")}\` first, or pass a room URL/slug and the required text flag.`,
      ].join(" "),
    );
  }
  // Spec 106 — a room-ref-shaped single word swallows the positional (e.g.
  // `grp choose lasagna-forever`). When the command's text is required and the
  // token is not a room this session knows about, fail with the usage form and
  // suggest the token was probably the text.
  const usage = TEXT_FLAG_USAGE[textFlag];
  if (usage && !/^https?:\/\//i.test(maybeTargetOrText) && !knownRoomSlug(maybeTargetOrText, io)) {
    throw new Error(
      [usage.usage, `(did you mean: grp ${usage.command} "${maybeTargetOrText}"?)`].join("\n"),
    );
  }
  return { target: targetOrCurrent(maybeTargetOrText, nextFlags, io), flags: nextFlags };
}

/**
 * Spec 152 W2 — resolve the room destination for a map ballot
 * (--scores / --choices). The flag carries the whole ballot, so a positional
 * shaped like an option handle (bare number or #N) is a redundant
 * restatement, not a room. Accept it when it appears in the map; reject it
 * with the correct form when it doesn't; never hand it to the room resolver
 * (Stage A: `grp choose 1 --scores=…` failed as a room lookup 18 times in a
 * row and induced config destruction).
 */
function mapBallotTarget(
  args: string[],
  flags: Record<string, string>,
  io: RoomCliIo,
): { target: string; flags: Record<string, string> } {
  const handles = args.filter((arg) => /^#?\d+$/.test(arg));
  const rooms = args.filter((arg) => !/^#?\d+$/.test(arg));
  const usage =
    flags.scores !== undefined
      ? 'usage: grp choose --scores="1=5,2=0" [room]'
      : "usage: grp choose --choices=1,3 [room]";
  if (rooms.length > 1 || args.length > 2) throw new Error(usage);
  for (const handle of handles) {
    const n = handle.replace(/^#/, "");
    const inMap =
      flags.scores !== undefined
        ? new RegExp(`(^|,)\\s*${n}\\s*=`).test(flags.scores)
        : (flags.choices ?? "")
            .split(",")
            .map((entry) => entry.trim().replace(/^#/, ""))
            .includes(n);
    if (!inMap) {
      const flagName = flags.scores !== undefined ? "--scores" : "--choices";
      throw new Error(
        [
          `${flagName} is the whole ballot, and option ${n} isn't in it.`,
          flags.scores !== undefined
            ? `Add it (--scores="…,${n}=<score>") or drop the leading ${handle}: ${usage}`
            : `Add it (--choices=…,${n}) or drop the leading ${handle}: ${usage}`,
        ].join(" "),
      );
    }
  }
  return { target: targetOrCurrent(rooms[0], flags, io), flags };
}

/** True when the token matches the current room or a remembered joined room. */
function knownRoomSlug(value: string, io: RoomCliIo): boolean {
  const config = readProviderConfig(io.env);
  if (config.currentRoom?.slug === value) return true;
  return Object.values(config.rooms ?? {}).some((room) => room.slug === value);
}

function looksLikeRoomRef(value: string): boolean {
  if (/^https?:\/\//i.test(value)) return true;
  if (/\s/.test(value)) return false;
  return /^[a-z0-9][a-z0-9_-]{7,}$/i.test(value);
}

function missingDefaultHost(): never {
  throw new Error(
    [
      "No default host configured.",
      "Run `grp init local`, `grp init grp`, or pass `--host`/`--base`.",
    ].join(" "),
  );
}

function targetOrCurrent(
  target: string | undefined,
  flags: Record<string, string>,
  io: RoomCliIo,
): string {
  if (target) return target;
  const current = resolveCurrentRoomRef(flags, io.env);
  if (!current)
    throw new Error(
      `room URL or slug is required; or run \`${grpCommand("enter <room-url|slug>")}\``,
    );
  return `${current.baseUrl}/r/${encodeURIComponent(current.slug)}`;
}

async function httpError(response: Response, requestUrl?: URL): Promise<Error> {
  const text = await readBoundedResponseText(response);
  if (!text) return new CliHttpError(`HTTP ${response.status}`, response.status);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html") || looksLikeHtml(text)) {
    const from = response.url ? ` from ${response.url}` : "";
    return new CliHttpError(
      `HTTP ${response.status}${from}; expected a GRP JSON response but received an HTML page`,
      response.status,
    );
  }
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const error = payload.error;
    if (typeof error === "string") {
      // Legacy flat shape ({error: "<sentence>"} or {error: "<code>", message}).
      const message = typeof payload.message === "string" ? payload.message : error;
      return new CliHttpError(
        formatJsonError({ message, code: null }, response.status, requestUrl),
        response.status,
      );
    }
    if (error && typeof error === "object") {
      // Canonical envelope (spec 106): {error: {code, message, hint?}}.
      const nested = error as Record<string, unknown>;
      const code = typeof nested.code === "string" ? nested.code : null;
      const serverMessage = String(nested.message ?? nested.code ?? "request failed");
      const serverHint = typeof nested.hint === "string" ? nested.hint : undefined;
      const details = isRecord(nested.details) ? nested.details : null;
      if (code === "state.precondition_failed" && details) {
        const expected = stringOrNull(details.expected_state_revision);
        const current = stringOrNull(details.current_state_revision);
        if (expected && current) return new RoomStateChangedError(expected, current);
      }
      return new CliHttpError(
        formatJsonError(
          {
            message: serverMessage,
            code,
            ...(serverHint === undefined ? {} : { hint: serverHint }),
          },
          response.status,
          requestUrl,
        ),
        response.status,
        code ?? undefined,
        serverMessage,
        serverHint,
      );
    }
  } catch {
    // fall through
  }
  return new CliHttpError(
    `${summarizeResponseText(text)} (HTTP ${response.status})`,
    response.status,
  );
}

function formatJsonError(
  err: { message: string; code: string | null; hint?: string },
  status: number,
  requestUrl?: URL,
): string {
  const message = err.code ? `${err.message} [${err.code}]` : err.message;
  const joinRequired =
    err.code === "room.join_required" ||
    // String fallback for hosts still emitting the pre-106 flat shape.
    (status === 403 && /^join required\b/i.test(err.message));
  if (joinRequired) {
    const slug = roomSlugFromApiUrl(requestUrl);
    const join = grpCommand(slug ? `join ${slug}` : "join <room-id>");
    return [
      `${message} (HTTP ${status})`,
      "This room needs you to join before reading or acting.",
      `Run: ${join}`,
    ].join("\n");
  }
  const lines = [`${message} (HTTP ${status})`];
  if (err.hint) lines.push(err.hint);
  // Spec 106 — the server speaks protocol vocabulary (transport-neutral);
  // the CLI maps stable codes back to grp commands.
  const slug = roomSlugFromApiUrl(requestUrl);
  if (err.code === "decision.proposing") {
    lines.push(
      `When the option list is ready: ${grpCommand(`start choosing${slug ? ` ${slug}` : ""}`)}`,
    );
  } else if (err.code === "room.concluded") {
    lines.push(`Final record: ${grpCommand(`outcome${slug ? ` ${slug}` : ""}`)}`);
  } else if (err.code === "participant.token_superseded") {
    // Spec 139 (C3) — seats are single-session (spec 119): a rotated
    // credential means another session of the same principal holds the seat
    // NOW. The convention is stand down, not fight back — auto-re-joining is
    // how two sessions of one principal end up in a credential war.
    lines.push(
      "Another session of your principal holds this seat now. Stand down — do not re-join automatically; treat this room as handled elsewhere.",
      `To deliberately take the seat back: ${grpCommand(`join${slug ? ` ${slug}` : " <room-id>"} --invite <invite-token>`)}`,
    );
  }
  return lines.join("\n");
}

function roomSlugFromApiUrl(url: URL | undefined): string | null {
  if (!url) return null;
  const match = url.pathname.match(/\/api\/rooms\/([^/]+)/);
  const slug = match?.[1];
  return slug ? decodeURIComponent(slug) : null;
}

function looksLikeHtml(text: string): boolean {
  return /^\s*<(?:!doctype\s+html|html|head|body)\b/i.test(text);
}

function summarizeResponseText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 300 ? `${compact.slice(0, 300)}...` : compact;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isRoomEvent(value: unknown): value is RoomEvent {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as RoomEvent).seq === "number" &&
    typeof (value as RoomEvent).event_type === "string" &&
    typeof (value as RoomEvent).occurred_at === "string"
  );
}

function withoutUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(input) as Array<[keyof T, T[keyof T]]>) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function writeCurrentRoom(
  current: NonNullable<ReturnType<typeof readProviderConfig>["currentRoom"]>,
  flags: Record<string, string>,
  io: RoomCliIo,
): void {
  const out = {
    provider: current.provider ?? null,
    baseUrl: current.baseUrl ?? null,
    slug: current.slug,
    hasToken: Boolean(current.token),
    hasPassword: Boolean(current.password),
  };
  if (isJson(flags)) {
    io.stdout(renderJson(out));
    return;
  }
  const scope = current.provider ?? current.baseUrl ?? "default";
  io.stdout(`current room: ${scope}:${current.slug}\n`);
}

function rememberJoinedRoom(
  ref: RoomRef,
  response: unknown,
  flags: Record<string, string>,
  io: RoomCliIo,
): JoinedRoomState {
  if (!isRecord(response)) throw new Error("join response did not contain room credentials");
  const token =
    stringOrNull(response.participantToken) ??
    stringOrNull(response.participant_token) ??
    stringOrNull(response.token) ??
    ref.token;
  // Spec 109 (WR2-1) — remember the joined role so read guidance stays
  // role-aware even against hosts that do not echo the caller's role.
  const role = readRoleValue(response.role);
  // Spec 113 — remember our own participant id so watch can tell our events
  // from everyone else's (own events never wake).
  const participantId =
    stringOrNull(response.participant_id) ?? stringOrNull(response.participantId);
  const joinedRoom = {
    baseUrl: ref.baseUrl,
    slug: ref.slug,
    ...(token ? { token } : {}),
    ...(ref.password ? { password: ref.password } : {}),
    ...(role ? { role } : {}),
    ...(participantId ? { participantId } : {}),
  };
  const explicitlyEnter = flags.enter === "true";
  let state: JoinedRoomState | null = null;
  updateProviderConfig((current) => {
    const existingCurrent = current.currentRoom;
    const existingCurrentBase = roomContextBaseUrl(existingCurrent, io.env);
    const sameAsCurrent =
      existingCurrent?.slug === ref.slug &&
      !!existingCurrentBase &&
      normalizeUrlForCompare(existingCurrentBase) === normalizeUrlForCompare(ref.baseUrl);
    const remembered = rememberRoom(current, joinedRoom);
    const shouldEnter = !existingCurrent || sameAsCurrent || explicitlyEnter;
    const next = shouldEnter ? setCurrentRoom(remembered, joinedRoom) : remembered;
    state = {
      mode: !existingCurrent
        ? "set"
        : sameAsCurrent
          ? "unchanged"
          : explicitlyEnter
            ? "switched"
            : "kept",
      currentSlug: next.currentRoom?.slug ?? ref.slug,
    };
    return next;
  }, io.env);
  if (!state) throw new Error("failed to remember joined room");
  return state;
}

// Spec 112 (WR4-7) — per-command help is command-scoped: usage, what it does,
// its few relevant flags, one example. `grp room --help` keeps the full map.
interface CommandHelp {
  usage: string;
  summary: string;
  flags?: string[];
  example?: string;
}

const ROOM_COMMAND_HELP: Record<string, CommandHelp> = {
  create: {
    usage: "grp create [--about=TEXT] [--ask=TEXT] [room shape flags]",
    summary: "Create a room and remember it as current.",
    flags: [
      "--about=TEXT     what the room is for (durable context)",
      "--ask=TEXT       open the first question immediately",
      "--option=TEXT    seed one option; repeat for each option (commas stay literal)",
      "--host=NAME      create on a specific configured host",
      "",
      "Room shape (optional; defaults: private with generated password, simple_majority, early close on):",
      "--mechanism=NAME       simple_majority, supermajority, plurality, approval,",
      "                       ranked_choice, ranked_pairwise, score_vote, quadratic_vote",
      "--quorum=N             electorate floor: a decision cannot resolve with fewer",
      "                       than N choices in (two-party mutual assent: --quorum=2)",
      "--max-participants=N   cap the roster",
      "--voting-window=SECS   choice window length",
      "--settle-window=SECS   revision window after a provisional outcome",
      "--pace=async           size windows for seats that check in on a schedule",
      "                       (~3-day window, 5-minute settle); if a seat runs on a",
      "                       routine, keep the window longer than its cadence",
      "--early-close=false    wait out the full window even when the outcome is set",
      "--max-open-decisions=N let up to N decisions run at once (default 1)",
      "--creator-votes=false  create as a non-voting host",
      "--visibility=MODE      public, unlisted, or private; aliases: --public/--unlisted/--private",
      "--password=PW          allow password admission to a private room",
    ],
    example: 'grp create --about="Planning Friday dinner" --ask="Pick dinner"',
  },
  join: {
    usage: "grp join <room-url|slug>",
    summary:
      "Join and remember a room. The first room becomes current; later joins keep the existing current room unless --enter is passed.",
    flags: [
      "--invite=TOKEN   named invite token (it_...)",
      "--as=NAME        display name for an unnamed join (a named invite label wins)",
      "--password=PW    private-room password (an invite also admits)",
      "--enter          explicitly make this room current after joining",
    ],
    example: "grp join https://example.com/r/abc123 --invite it_...",
  },
  read: {
    usage: "grp read [room]",
    summary:
      "Read the room. Your first read is a fresh working-set snapshot; once a watch (or --since) stores your position, later reads return paged catch-up deltas.",
    flags: [
      "--full           fresh working-set snapshot; skips the delta (not full history or artifact bytes)",
      "--decision=N     one decision's thread — question, options, outcome, its discussion (never moves your position)",
      "--since=N        everything after event seq N (moves your position)",
      "--since=last     everything after your stored position",
      "--json           raw JSON (snapshot or delta)",
    ],
    example: "grp read",
  },
  enter: {
    usage: "grp enter <room-url|slug>",
    summary: "Set the current room without joining it.",
    flags: ["--token=TOKEN    participant token to remember for this room"],
    example: "grp enter abc123 --token=t_...",
  },
  current: {
    usage: "grp current",
    summary: "Print the current room.",
  },
  rooms: {
    usage: "grp rooms [--json]",
    summary: "List rooms remembered by this local session without printing credentials or content.",
  },
  forget: {
    usage: "grp forget <room> [--host=NAME|--base=URL]",
    summary:
      "Remove one room from this local session's memory. This never contacts or deletes the hosted room.",
  },
  inbox: {
    usage: "grp inbox [--json]",
    summary:
      "Check remembered rooms once for a needed choice or new activity without switching rooms or moving read positions.",
  },
  leave: {
    usage: "grp leave",
    summary: "Clear the current room.",
  },
  ask: {
    usage: 'grp ask "<question>" [room]',
    summary:
      "Open a decision when the group must choose. For exact shared work, the action's review loop can collect approval of one immutable artifact revision without turning the document into a chat proposal.",
    flags: [
      "--option=TEXT         seed one option; repeat for each option (commas stay literal)",
      "--options=A,B         legacy comma-separated option slate",
      "--collect-options     collect options first; choices open via start choosing",
      "--agreement           resolves only when every voter accepts the same option;",
      "                      disagreement keeps it open (grp accept N to accept)",
      "--eligible=A,B        limit who can choose on this question",
      "--post-anyway         deliberately bypass the read-before-write guard",
    ],
    example: 'grp ask "Choose one dinner plan"',
  },
  cancel: {
    usage: 'grp cancel <decision-number|id> --reason="..." [room]',
    summary:
      "End an open question without choosing an outcome. Requires room conclusion authority; the original question, options, choices, and abstentions remain recorded.",
    flags: [
      "--reason=TEXT    required explanation recorded in the signed cancellation receipt",
      "                  cancellation always requires a fresh read and has no --post-anyway bypass",
    ],
    example: 'grp cancel 1 --reason="The premise changed"',
  },
  options: {
    usage: "grp options [--full] [--decision=N] [room]",
    summary: "Show the numbered option slate (long options clipped; --full for whole text).",
    flags: [
      "--full           full option text",
      "--decision=N     show decision N (the seq in grp read); default: the oldest open decision",
      "--json           slate state as JSON",
    ],
    example: "grp options",
  },
  propose: {
    usage: 'grp propose "<option>" [room]',
    summary:
      'Add one candidate answer to an open decision. Put commentary in grp discuss "...". If a result is still being worked on, keep it in its action and complete that action when ready. Shell-sensitive text: --file=PATH, or `grp propose -` to read stdin.',
    flags: [
      "--file=PATH      propose the file's contents as the option text",
      "--decision=N     target decision N (the seq in grp read); default: the open decision",
      "--post-anyway    deliberately bypass the read-before-write guard",
    ],
    example: 'grp propose "Tamarind Table at 7:30"',
  },
  discuss: {
    usage: 'grp discuss "<message>" [room] | grp discuss --composing [room]',
    summary:
      "Exchange context with the room. Discussion creates no formal outcome.\n\nFor shell-sensitive discussion, use --file=PATH or stdin. For exact shared work that will be revised or approved, use an action with an artifact: grp act --help.",
    flags: [
      "--file=PATH      post the file's contents as the message",
      "--stance=KIND    agree, disagree, clarify, or extend",
      "--decision=N     attach to decision N (the seq in grp read); default: the open decision",
      "--as-discussion  confirm that substantial content intentionally belongs in chat",
      "--post-anyway    deliberately bypass the read-before-write guard",
      "--composing",
      "    Signal briefly that you are preparing a discussion message.",
      "    The signal expires automatically and clears when you post.",
      "    It does not create an action, reserve the room, or block anyone.",
    ],
    example: 'grp discuss "I prefer the earlier time" --stance=extend',
  },
  action: {
    usage:
      "grp act start|read|take|handoff|request-review|review|complete|resume|fail|cancel|takeover ...",
    summary:
      "Use an action when you are going to do something and the room should track who has it, what you report back, and what counts as complete.\n\nBy default, starting an action means you hold it and your completion report finishes it. Use --completion=group when the room must agree before GRP marks a single or handoff action complete. Use all when every required participant must report.\n\nThe action record lives in GRP. The work may happen elsewhere, or the holder may edit an optional native GRP artifact.",
    flags: [
      "Modes:",
      "  single   one holder works; peers may continue",
      "  handoff  one current holder; holder-scoped transitions require that holder",
      "  all      every required participant reports",
      "start [room] --title=TEXT [--mode=single|handoff|all] [--completion=holder|group] [--to=NAME] [--description=TEXT]",
      "  single and handoff default to holder completion; group completion requires room agreement",
      "  all defaults to the joined participant roster; --required=A,B freezes a named roster",
      "  initial native artifact: --artifact-name=TEXT --artifact-file=PATH",
      "read ID [room]",
      "take ID [room]  become holder of an available handoff action",
      "handoff ID [room] --to=NAME|ID|group [--note=TEXT]",
      "request-review ID [room]",
      "  for a group-completion action with an artifact: freeze its exact current revision",
      "  your approval is recorded; every other eligible participant reviews the same bytes",
      "review ID [room] [--approve | --request-changes --body=TEXT|--file=PATH]",
      "  with no disposition, read the exact frozen revision and the available responses",
      "  each required participant records approve or request-changes for the exact revision",
      "  all responses are collected; any requested changes return the action to its editor",
      "  unanimous exact-revision approval completes the action",
      "complete ID [room] [--result-text=TEXT]",
      "  holder: report done and complete the action",
      "  group without an artifact: freeze exact result text and ask whether to complete",
      "  group with an artifact: use request-review instead",
      "  all: complete only your required part; the last required report completes the action",
      "resume ID [room] --reason=TEXT",
      "  Retract your pending group-completion proposal so the action can be revised.",
      "  A terminal action never resumes.",
      "fail ID [room] [--result-text=TEXT] | cancel ID [room]",
      "takeover ID [room] --reason=TEXT [--override]  recover an expired holder; early override is recorded",
      "",
      "Examples:",
      '  grp act start --title="Check the release data" --mode=single',
      '  grp act complete ACTION_ID --result-text="Checked; no blocker found"',
      '  grp act start --title="Revise the shared plan" --mode=handoff --completion=group --artifact-name="Shared plan" --artifact-file=plan.md',
      "  grp artifact patch ARTIFACT_ID --action=ACTION_ID --file=changes.json",
      "  grp act request-review ACTION_ID",
      "  grp act review ACTION_ID --approve",
      '  grp act start --title="Consult our principals" --mode=all --required=Neon,Cobalt',
    ],
    example: 'grp act start --title="Check the release data" --mode=single',
  },
  "action:complete": {
    usage: "grp act complete <action-id> [room] [--result-text=TEXT]",
    summary:
      "Report that your action work is done.\n\nFor holder completion, GRP records your report and completes the action. For group completion without an artifact, provide exact --result-text; GRP asks the room whether to complete the action. For group completion with an artifact, use grp act request-review instead. For all-participant actions, this completes only your required part; the last required report completes the action.",
  },
  "action:request-review": {
    usage: "grp act request-review <action-id> [room]",
    summary:
      "Request a complete review set for the exact current revision of this action's artifact.\n\nThe current holder's approval is recorded immediately. The artifact cannot change while review is pending. Every other eligible participant receives one approve-or-request-changes obligation for the same bytes. Any requested changes return the action to its editor; unanimous approval completes it.",
  },
  "action:review": {
    usage:
      "grp act review <action-id> [room] [--approve | --request-changes --body=TEXT|--file=PATH]",
    summary:
      "Read and respond to one action's exact pending artifact revision. With no disposition, this prints the frozen bytes and available responses. Record approve or request-changes against those bytes. A response may be updated while the round remains open.",
  },
  "action:resume": {
    usage: "grp act resume <action-id> [room] --reason=TEXT",
    summary:
      "Resume your action when its group-completion proposal needs revision.\n\nOnly the current completion proposer may retract that unresolved proposal. GRP preserves the canceled decision, restores the same action with a fresh fencing epoch, and returns its artifact to the holder. Terminal actions never resume.",
  },
  artifact: {
    usage: "grp artifact create|read|patch|publish ...",
    summary:
      "An artifact is an optional versioned resource attached to an action. Reads label the blocks in one exact revision ¶1, ¶2, ¶3, ... . Only the current action holder may edit a native artifact. For group completion, request exact review from the owning action; unanimous approval of that revision completes it.",
    flags: [
      "create [room] --name=TEXT --action=ID [--kind=native] [--file=PATH|--content=TEXT]",
      "read ID [room] [--version=N]  native reads show ¶1, ¶2, ... blocks",
      "patch ID [room] --action=ID --file=changes.json  apply precise edits atomically",
      "publish ID [room] --action=ID --file=PATH  intentionally replace or synchronize the whole artifact",
      "External Git: --kind=external --external-provider=git --uri=HTTPS --path=PATH --provider-revision=COMMIT --sha256=HEX",
    ],
    example: 'grp artifact create --name="Joint draft" --action=ACTION_ID --file=resolution.md',
  },
  "artifact:patch": {
    usage: "grp artifact patch <artifact-id> [room] --action=ID --file=changes.json",
    summary:
      "Apply one or more precise edits to one exact native-artifact revision.\n\nFirst read the artifact. GRP labels the blocks in that revision ¶1, ¶2, ¶3, ... Use those numbers in a patch file.\n\nGRP checks that your base revision is still current, then applies every edit together or none. If the artifact changed, nothing is written and you are directed to read it again.",
    flags: [
      "Available edits:",
      "  replace        replace one block",
      "  delete         delete one block",
      "  insert-before  insert a block before another",
      "  insert-after   insert a block after another",
      "  replace-text   replace exact text a specified number of times",
      "",
      "Example changes.json:",
      "{",
      '  "base_revision": "rev_3",',
      '  "edits": [',
      '    { "op": "replace", "block": 12, "text": "The revised twelfth paragraph." },',
      '    { "op": "delete", "block": 19 },',
      '    { "op": "replace-text", "find": "Kestrel Labs", "replace": "Kestrel Signal", "expected": 3 }',
      "  ]",
      "}",
      "",
      "Block numbers refer to the named base revision. They may change after an insertion or deletion, so read the artifact again before another patch.",
      "Use artifact publish when you intentionally need to replace the whole artifact.",
    ],
  },
  start: {
    usage: "grp start choosing [room]",
    summary: "Open choices for a collect-first question.",
    example: "grp start choosing",
  },
  choose: {
    usage: 'grp choose <number> | "<option text>" [room]',
    summary:
      "Submit or revise your choice on the open question — by option number (from grp options) or exact text.",
    flags: [
      "--why=TEXT       short reason recorded with the choice",
      "--choices=A,B    explicit array choice for approval/ranked rooms (numbers work: --choices=1,3)",
      "--scores=1=5,2=0 score map for score/quadratic rooms (option number = score)",
      "--decision=N     target decision N (the seq in grp read); default: the open decision",
    ],
    example: 'grp choose "Tamarind Table at 7:30" --why="Best fit"',
  },
  abstain: {
    usage: 'grp abstain --reason="..." [room]',
    summary:
      "Formally participate without supporting any option. Replaces a prior choice and may be replaced while the decision remains open.",
    flags: [
      "--reason=TEXT    required reason recorded in the timeline and receipt",
      "--decision=N     target decision N (the seq in grp read); default: the open decision",
    ],
    example: 'grp abstain --reason="Conflict of interest"',
  },
  outcome: {
    usage: "grp outcome [room]",
    summary:
      "Show the latest outcome and locally verify its signed receipt chain when the host exposes portable JWS artifacts.",
    flags: ["--json           export the compact JWS chain and verification result"],
    example: "grp outcome",
  },
  close: {
    usage: 'grp close "<statement>" [room]',
    summary: "Close a resolved room with a final statement (operator).",
    example: 'grp close "Dinner is decided; see you Friday."',
  },
  timeline: {
    usage: "grp timeline [room]",
    summary: "Print the complete room event log.",
    flags: ["--jsonl          one JSON event per line", "--limit=N        stop after N events"],
    example: "grp timeline --limit=20",
  },
  watch: {
    usage: "grp watch [room]",
    summary:
      "Wait for relevant room activity, then exit with the reason. Scope to an action, artifact, or decision when waiting on that state. A decision waiting on YOUR choice always wakes you.",
    flags: [
      "--timeout=N      quiet-time bound in seconds (default 110; 0 waits indefinitely)",
      "--until=resolved|next-resolved  wait for current-or-future, or future-only resolution",
      "--until=needed   wait until the room needs your choice",
      "--action=ID      wake when assigned this action, it ends, or recovery is needed",
      "--artifact=ID    wake when this artifact advances",
      "--decision=N     wake when this decision resolves",
      "--jsonl          raw event stream (never moves your read position)",
    ],
    example: "grp watch",
  },
  invite: {
    usage: "grp invite --name NAME [room]",
    summary:
      "Create a named invite (no --name lists invites). Also: grp invite list, grp invite revoke CODE.",
    flags: [
      "--role=observer  watch-only seat",
      "--email=EMAIL    bind the invite to a host-verified email",
    ],
    example: "grp invite --name Alex",
  },
  members: {
    usage: "grp members [room]",
    summary:
      "List room members. Operators can change roles: grp members set-role NAME participant|observer.",
    example: "grp members",
  },
  settings: {
    usage: "grp settings [room]",
    summary: "Show room settings. Operators can update: grp settings set KEY VALUE.",
    flags: [
      "Settable keys: quorum, voting_window, max_participants, max_options,",
      "  early_close, creator_votes, read_receipts, choice_visibility, auth,",
      "  deliberation_mode, invite_authority, option_proposal_authority,",
      "  decision_opening_authority, conclusion_authority,",
      "  max_deliberation_messages_per_participant, max_total_deliberation_messages",
      "Fixed at create (grp create --mechanism=... etc.): mechanism, visibility,",
      "  password, settle_window",
    ],
    example: "grp settings set quorum 2",
  },
};

const ROOM_COMMAND_HELP_ALIASES: Record<string, string> = {
  use: "enter",
  pwd: "current",
  history: "timeline",
  accept: "choose",
  act: "action",
};

function printCommandHelp(command: string, write: (text: string) => void): void {
  const help = ROOM_COMMAND_HELP[ROOM_COMMAND_HELP_ALIASES[command] ?? command];
  if (!help) {
    printRoomHelp(write);
    return;
  }
  const lines = [`Usage: ${help.usage}`, "", help.summary];
  if (help.flags && help.flags.length > 0) {
    lines.push("", "Flags:", ...help.flags.map((flag) => `  ${flag}`));
  }
  if (help.example) lines.push("", `Example: ${help.example}`);
  write(`${lines.join("\n")}\n`);
}

function printRoomHelp(write: (text: string) => void): void {
  write(
    `${[
      "Usage: grp room <command> [room-url|slug] [options]",
      "",
      "Core room loop:",
      "  discuss        exchange context; creates no formal outcome",
      "  act            track work and what counts as complete",
      "  ask            record a group choice",
      "  read           catch up on shared state",
      "  watch          wait for relevant room activity",
      "",
      "Commands:",
      "  create         create a room",
      "  enter          set the current room context",
      "  current        print the current room context",
      "  rooms          list locally remembered rooms",
      "  forget         remove a room from local memory (never deletes it remotely)",
      "  inbox          check remembered rooms for attention",
      "  leave          clear the current room context",
      "  join           join and remember a room (use --enter to switch)",
      "  cancel         end an open question without selecting an outcome",
      "  options        show the current option slate",
      "  propose        propose an option",
      "  artifact       read or edit an optional action-owned shared artifact",
      "  start choosing open choices for a collect-first question",
      "  choose         submit or revise your choice",
      "  abstain        participate without supporting an option",
      "  outcome        show the latest decided outcome",
      "  history        print room timeline history",
      "  invite         create or list named room invites",
      "  members        list room members",
      "  members set-role update a member role",
      "  settings       show or update room settings",
      "",
      "Common options:",
      "  --base=URL       host base for slug-only refs [or GRP_BASE_URL]",
      "  --host=NAME      configured room host",
      "  --token=TOKEN    participant/restricted token [GRP_TOKEN]",
      "  --password=PW    private-room read/join credential [GRP_ROOM_PASSWORD]",
      "  --invite=TOKEN   invite token for joining a room",
      "  --role=ROLE      new-invite role: participant (default) or observer (watch-only)",
      "  --email=EMAIL    bind a new invite to a host-verified email",
      "  --principal=URI  bind a new invite to a GRP mandate principal",
      "  --as=NAME        room-specific display name for join",
      "  --mandate=JWS    mandate for mandate-aware REST calls",
      "  --bearer=TOKEN   bearer token for OAuth/restricted-key calls",
      "  --json           formatted JSON output",
      "  --full           fresh working-set snapshot on read (not full history or artifact bytes)",
      "  --since=N|last   read activity after an event seq / your stored position",
      "  --jsonl          one JSON event per line for timeline/watch",
      "  --timeout=N      bounded watch: exit 0 with 'nothing new' after N seconds",
      "  --quiet          print only the durable handle when available",
      "  --why=TEXT       preferred choice-reason flag for room choose",
      "  --choices=A,B    submit an explicit array choice for approval/ranked rooms",
      "  --scores=1=5,2=0 submit a score map for score/quadratic rooms",
      "  --stance=KIND    discussion stance: agree, disagree, clarify, or extend",
      "",
      "Examples:",
      "  grp enter abc123 --host=acme --token=t_...",
      "  grp read",
      "  grp read https://example.com/r/abc123",
      "  grp watch",
      "  grp watch https://example.com/r/abc123 --jsonl",
      "  grp create --host=acme --about='Planning Friday dinner'",
      "  grp create --host=acme --about='Planning Friday dinner' --ask='Pick dinner'",
      "  grp invite --name Alex",
      "  grp invite --name Scout --role observer",
      "  grp invite --name Alex --email alex@example.com",
      "  grp invite --name Alex --principal https://grp.app/p/123",
      "  grp invite list",
      "  grp join abc123 --invite it_...",
      "  grp members set-role Alex observer",
      "  grp settings set quorum 4",
      "  grp ask 'Choose one dinner plan'",
      "  grp propose 'Tamarind Table at 7:30'",
      "  grp start choosing",
      "  grp discuss 'I prefer the clearest option'",
      "  grp choose 'Tamarind Table at 7:30' --why='Best fit'",
    ].join("\n")}\n`,
  );
}

function explicitProviderBaseUrl(
  flags: Record<string, string>,
  env: Record<string, string | undefined>,
): string | undefined {
  const host = flags.host ?? flags.provider;
  return host ? resolveProviderBaseUrl(host, env) : undefined;
}

function defaultProviderBaseUrl(
  flags: Record<string, string>,
  env: Record<string, string | undefined>,
): string | undefined {
  return flags.host || flags.provider ? undefined : resolveProviderBaseUrl(undefined, env);
}
