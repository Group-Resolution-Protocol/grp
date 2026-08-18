import { readFileSync } from "node:fs";
import {
  publicKeyFromJwks,
  receiptKid,
  verifyAgreementReceiptSemantics,
  verifyCompactReceipt,
} from "../../agent-sdk/src/index.js";
import type { GrpAuth, RoomEvent } from "../../agent-sdk/src/index.js";
import {
  clearCurrentRoom,
  findRememberedRoom,
  listRememberedRooms,
  readProviderConfig,
  rememberRoom,
  renderPersonaIdentity,
  resolvePersonaContext,
  resolvePersonaSelection,
  resolveProviderBaseUrl,
  setCurrentRoom,
  setRoomLastSeenSeq,
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
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
  auth?: CliAuth;
  password?: string;
  accept?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

type CliAuth = GrpAuth | { kind: "hosted"; accessToken: string; mandate: string };

const CLI_REQUEST_TIMEOUT_MS = 60_000;
const MAX_CLI_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CLI_SSE_BUFFER_BYTES = 2 * 1024 * 1024;

class SseBufferLimitError extends Error {}

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
  | {
      kind: "needed";
      question: string | null;
      resolved?: boolean;
      votingEndsAt?: string | null;
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
  "creator-votes",
  "defer-first-decision",
  "dry-run",
  "early-close",
  "enter",
  "expected",
  "force",
  "full",
  "h",
  "help",
  "json",
  "jsonl",
  "private",
  "public",
  "quiet",
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
    printCommandHelp(command, resolvedIo.stdout);
    return 0;
  }

  try {
    assertOnlyRoomCommandFlags(parsed);
    assertNoIgnoredPositionals(parsed);
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
        const args = targetAndTextArg(
          parsed.positionals.slice(1),
          parsed.flags,
          resolvedIo,
          "body",
        );
        await roomDiscuss(args.target, args.flags, resolvedIo);
        return 0;
      }
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
    resolvedIo.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
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
  } else if (command === "start") max = 3;
  else if (command === "invite") max = subcommand === "revoke" ? 4 : subcommand === "list" ? 3 : 2;
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

function roomFlagSet(...groups: string[][]): ReadonlySet<string> {
  return new Set(groups.flat());
}

const ROOM_COMMAND_FLAG_KEYS: Record<string, ReadonlySet<string>> = {
  enter: roomFlagSet(ROOM_REFERENCE_FLAG_KEYS, ["json"]),
  current: roomFlagSet(["json"]),
  rooms: roomFlagSet(["json"]),
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
  ]),
  propose: roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, ROOM_ACTION_OUTPUT_FLAG_KEYS, [
    "option",
    "file",
    "decision",
  ]),
  discuss: roomFlagSet(ROOM_AUTHENTICATED_REFERENCE_FLAG_KEYS, ROOM_ACTION_OUTPUT_FLAG_KEYS, [
    "body",
    "file",
    "stance",
    "decision",
  ]),
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
};

function assertOnlyRoomCommandFlags(parsed: ParsedArgs): void {
  const [rawCommand, subcommand] = parsed.positionals;
  if (!rawCommand) return;
  const command = ROOM_COMMAND_FLAG_ALIASES[rawCommand] ?? rawCommand;
  const key =
    command === "invite"
      ? `invite:${subcommand === "list" || subcommand === "revoke" ? subcommand : "create"}`
      : command === "members" && subcommand === "set-role"
        ? "members:set-role"
        : command === "settings" && subcommand === "set"
          ? "settings:set"
          : command;
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
  if (!current) throw new Error("no current room; run `grp enter <room-url|slug>`");
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
    })
  | (RememberedRoomRow & { status: "question_resolved"; question: string | null })
  | (RememberedRoomRow & {
      status: "new_activity";
      eventType: string | null;
      who: string | null;
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
  if (row.status === "new_activity") return 2;
  if (row.status === "unavailable") return 3;
  return 4;
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
    io.stdout("No remembered rooms. Join one with: grp join <room>\n");
    return;
  }
  const lines = rows.map((row) => {
    const marker = row.current ? "CURRENT" : "       ";
    return `${marker}  ${row.slug.padEnd(14)}  ${row.host.padEnd(26)}  ${row.role ?? "unknown"}`;
  });
  io.stdout(`${lines.join("\n")}\n`);
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
      io.stdout("No remembered rooms. Join one with: grp join <room>\n");
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
      lines.push("Stay present now: grp watch");
    }
    lines.push("Or return later using your agent runtime's scheduling tools, then run grp inbox.");
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
      lines.push(
        `CHOICE NEEDED  ${row.slug}  ${row.question ? `"${clipInboxText(row.question)}"` : "open question"}${deadline ? ` — ${deadline}` : ""}${seqTag}`,
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
    } else {
      lines.push(`UNAVAILABLE    ${row.slug}  ${clipInboxText(row.error)}`);
    }
  }
  const first = visible.find((row) => row.status !== "unavailable");
  if (first) {
    const target = first.current ? "" : ` ${first.baseUrl}/r/${encodeURIComponent(first.slug)}`;
    lines.push("", "Open one:", `  grp read${target}`);
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
    renderRoomCreated(response, baseUrl, access, about ?? null, creatorDisplayName ?? null),
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
    // Spec 109 (WR2-2) — name the identity the room roster will show.
    ...(creatorName ? [`You: ${creatorName} (creator)`] : []),
    "Current room: set",
    "",
    "Room commands:",
    "  grp invite --name NAME",
    '  grp ask "..."',
    "  grp read",
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
    io.stdout(
      withPersonaReadHeader(
        renderRoomDelta(page.response, ref, io.env, { moreUnread: page.moreUnread }),
        io.env,
      ),
    );
    return;
  }
  // Spec 119 (WR11-1) — complete snapshots still advance the mark. The old
  // rule ("--full never touches the mark") left it parked at a pointer wake's
  // seq-1 and made the next watch re-fire. Spec 193 changes only paged human
  // deltas; full snapshots and old-host fallbacks keep this contract.
  const currentThrough = numberOrNull(response.current_through);
  if (currentThrough !== null) persistLastSeenSeq(ref, currentThrough, io.env);
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
          "no stored position for this room — run `grp watch` once, or `grp read --full`",
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
    lines.push("", `Act on it: grp choose <option> --decision=${seq}`);
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
  const shortCommand = `grp discuss "..."${suffix}`;
  const fileCommand = `grp discuss --file=PATH${suffix}`;
  const commandWidth = Math.max(shortCommand.length, fileCommand.length) + 2;
  lines.push(
    `  ${shortCommand.padEnd(commandWidth)}short, shell-safe message`,
    `  ${fileCommand.padEnd(commandWidth)}exact, multiline, or shell-sensitive text`,
  );
}

function appendIdleGuidance(
  lines: string[],
  response: Record<string, unknown>,
  room: string,
): void {
  lines.push(`  Wait for what's next: grp watch${room}`);
  appendDiscussGuidance(lines, room);
  if (hasRoomAction(response, "ask")) {
    lines.push(`  Or ask the next question: grp ask "..."${room}`);
  }
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
      `Nothing new since seq ${currentThrough ?? "?"}. Full picture: grp read --full${room}`,
    );
  } else {
    lines.push("", "New since your last read:");
    for (const entry of entries) lines.push(...renderDeltaEntry(entry, room));
  }

  lines.push("", "Next:");
  if (options.moreUnread) {
    lines.push(`  More unread activity remains: grp read${room}`);
    lines.push("", `Current through seq ${currentThrough ?? "?"}.`);
    return `${lines.join("\n")}\n`;
  }
  const roomStatus = String(response.status ?? "open");
  const isObserver = callerRole(response, ref, env) === "observer";
  if (roomStatus === "concluded" || roomStatus === "expired") {
    lines.push(`  Final record: grp outcome${room}`);
  } else if (isObserver) {
    lines.push("  You are an observer in this room: follow along; choosing is for participants.");
    lines.push(`  Wait for what's next: grp watch${room}`);
  } else if (yourStatus?.startsWith("you have not chosen")) {
    // Spec 112 (WR4-4b) — engagement, not speed: deliberate, then choose.
    lines.push(...choosingGuidance());
    if (hasDecisionTargetInStatus(yourStatus)) {
      // Spec 145 (F144-S2) — a plural delta is deliberately thin, so its
      // your_status is the feature-detection signal. Teach the focused read
      // and selector loop instead of silently pointing at the oldest ballot.
      lines.push(
        `  Review each owed thread: grp read --decision=N${room}`,
        `  See a slate: grp options --decision=N${room}`,
        `  Choose: grp choose "<option>" --decision=N${room}`,
      );
    } else {
      lines.push(`  Choose: grp choose "<option>"${room}`);
    }
    lines.push(`  Then wait for what's next: grp watch${room}`);
  } else if (state === "no question open") {
    appendIdleGuidance(lines, response, room);
  } else {
    lines.push(`  Wait for what's next: grp watch${room}`);
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
        text.length > 300 ? `${text.slice(0, 300)}… (full: grp options --full${room})` : text;
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
        rawWinner.length > 300 ? `${rawWinner.slice(0, 300)}… (full: grp outcome)` : rawWinner;
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
      "That looks like an invite token. Join with `grp join <room-id> --invite <invite-token>`.",
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
      `To switch: grp enter ${ref.baseUrl}/r/${encodeURIComponent(ref.slug)}`,
    );
  }
  if (role) lines.push(`Role: ${role}.`);
  const readTarget =
    state.mode === "kept" ? ` ${ref.baseUrl}/r/${encodeURIComponent(ref.slug)}` : "";
  lines.push("", "Run:", `  grp read${readTarget}`);
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
  const response = await actionRequest(ref, "/ask", flags, io, {
    question,
    context: flags.context,
    options: seedOptions(flags, repeatedOptions),
    eligible: eligible.length > 0 ? eligible : undefined,
    voting_window: parseOptionalNumber(flags["voting-window"]),
    proposal_window: collectOptionsWindow(flags),
    // Spec 128 — agreement question: resolves only on unanimous acceptance.
    agreement: flags.agreement !== undefined ? parseOptionalBool(flags.agreement) : undefined,
  });
  if (isJson(flags) || flags.quiet === "true") {
    writeStructured(response, flags, io);
    return;
  }
  io.stdout(renderQuestionOpened(response, ref, question, io.env));
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
  const response = await actionRequest(ref, "/options", flags, io, {
    option,
    decision: parseDecisionFlag(flags.decision),
  });
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
  // Spec 164 — discussion can be document-sized or shell-sensitive too.
  // Read one exact snapshot rather than forcing it through shell quoting.
  // This sends text to GRP; it is not an upload or a live file reference.
  let effective = flags;
  if (flags.file) {
    if (flags.body) throw new Error("pass either --file or message text, not both");
    effective = { ...flags, body: readFileSync(flags.file, "utf8") };
  } else if (flags.body === "-") {
    effective = { ...flags, body: await readAll(io.stdin) };
  }
  const response = await actionRequest(ref, "/discuss", flags, io, {
    body: requireFlag(effective, "body"),
    stance: parseStance(flags.stance),
    decision: parseDecisionFlag(flags.decision),
  });
  if (isJson(flags) || flags.quiet === "true") {
    writeStructured(response, flags, io, "id");
    return;
  }
  io.stdout(renderDiscussionPosted(ref, io.env));
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
      throw new Error(`${error.message}\nTry: grp choose --scores="1=5,2=0" [room]`);
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
        `  Wait for what's next: grp watch${room}`,
        `  Check again: grp outcome${room}`,
        "",
        "Available actions:",
        `  grp read${room}`,
        `  grp options${room}`,
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
      `Details: grp outcome --json — standalone verifier: ${ref.baseUrl}/receipt`,
    );
  }
  // Spec 112 (WR4-6) — while the room stays open, the loop continues past
  // this outcome. Feature-detected; unknown status stays silent.
  if (String(response.status ?? "") === "open") {
    const room = roomHintArg(String(response.slug ?? ref.slug), ref, io.env);
    lines.push(
      "",
      `Room is still open. Next: grp read${room} — a new question may follow; stay with the room.`,
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
  io.stdout(renderCreatedInvite(response, ref));
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

/** Spec 113 — the substantive event types that wake a bare `grp watch`.
 * decision.voting_phase_started folds into the decision-opened wake. */
const WAKE_EVENT_TYPES = new Set([
  "discussion.posted",
  "option.proposed",
  "choice.abstained",
  "decision.opened",
  "decision.voting_phase_started",
  "decision.completed",
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
  if (auth) racers.push(needsMeWakePoll(ref, flags, io, auth, controller.signal));
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
    // Spec 125 (WR12-3) \u2014 a state-blind timeout is a lullaby: Run 12's idle
    // boundary had every seat re-arming "keep waiting" while no question was
    // open and any of them could have asked the next one. One light read at
    // timeout (timeouts are minutes apart) makes it a decision point.
    // Best-effort: any fetch problem falls back to the generic line.
    const watchPhase = await roomWatchPhase(
      ref,
      flags,
      io,
      state.lastSeenSeq ?? mark ?? headSeq ?? 0,
    );
    const tail = watchTimeoutTail(room, watchPhase.closesInSeconds);
    if (watchPhase.phase === "no_question") {
      io.stdout(
        `Nothing new after ${wake.seconds}s \u2014 no question is open; anyone may grp ask "..."${room} \u2014 or ${tail}.\n`,
      );
      return;
    }
    if (watchPhase.phase === "agreement") {
      io.stdout(
        `Nothing new after ${wake.seconds}s \u2014 an agreement question is open: grp accept N${room} when an option works, or propose/discuss to move it \u2014 ${tail}.\n`,
      );
      return;
    }
    io.stdout(`Nothing new after ${wake.seconds}s \u2014 ${tail}.\n`);
    return;
  }
  if (wake.kind === "needed") {
    io.stdout(renderNeedsYouWake(wake.question, room, wake.resolved, wake.votingEndsAt));
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
      };
    }
    // Anything but an explicit long-poll timeout means this host does not
    // speak next-action the way we expect; retire instead of spinning.
    if (!isRecord(response) || response.status !== "timeout") return neverSettles();
    // Timeout — re-poll immediately and silently; waiting is the action.
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
): string {
  // Spec 125 (WR12-1) — the opener-seal wake: the caller's own question
  // resolved with nothing else open; the next move is theirs, not a choice.
  if (resolved) {
    return [
      `Your question resolved: "${question ?? "the decision you opened"}"`,
      "",
      "Next:",
      `  grp read${room}`,
      `  grp ask "..."${room} — or grp outcome${room}`,
      "",
    ].join("\n");
  }
  // Spec 139 (C1) — the wake names its deadline so a caller that cannot act
  // immediately knows how long the door stays open.
  const deadline = describeTimeUntil(votingEndsAt, Date.now());
  return [
    `The room needs you: "${question ?? "a decision needs your choice"}"${deadline ? ` — ${deadline}` : ""}`,
    "",
    "Next:",
    `  grp read${room}`,
    `  grp choose "<option>"${room}`,
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
    return `Room concluded.\n\nNext:\n  grp outcome${room}\n`;
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
  }
  return `${reason}\n\nNext:\n  grp read${room}\n`;
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
      "Waiting for the room needs your room credentials. Join first: grp join <room-id>",
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
        info.phase === "no_question"
          ? `Nothing new after ${timeoutSeconds}s — no question is open; anyone may grp ask "..."${room} — or ${tail}.\n`
          : info.phase === "agreement"
            ? `Nothing new after ${timeoutSeconds}s — an agreement question is open: grp accept N${room} when an option works, or propose/discuss to move it — ${tail}.\n`
            : `Nothing new after ${timeoutSeconds}s — ${tail}.\n`,
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
    if (!isRecord(response)) return { phase: "other", closesInSeconds: null };
    const closesInSeconds = soonestOpenDeadlineSeconds(response);
    const decision = isRecord(response.decision) ? response.decision : null;
    if (!decision) return { phase: "no_question", closesInSeconds };
    if (decision.agreement === true) return { phase: "agreement", closesInSeconds };
    return { phase: "other", closesInSeconds };
  } catch {
    return { phase: "other", closesInSeconds: null };
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
  const returnLater =
    "or return later using your agent runtime's scheduling tools, then run grp inbox";
  if (closesInSeconds !== null) {
    const timeout = Math.max(60, Math.ceil(closesInSeconds / 60) * 60);
    const human =
      closesInSeconds < 120
        ? `${closesInSeconds}s`
        : closesInSeconds < 7200
          ? `${Math.round(closesInSeconds / 60)}m`
          : `${Math.round(closesInSeconds / 3600)}h`;
    return `the open question closes in ~${human} — grp watch --timeout=${timeout}${room} covers it; ${returnLater}`;
  }
  return `stay armed through quiet stretches with grp watch --timeout=N${room} (seconds), or run grp watch${room} again; ${returnLater}`;
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
): Promise<unknown> {
  const auth = authFromFlags(flags, ref, io.env);
  const options: RequestOptions = {
    method: "POST",
    body: withoutUndefined(body),
  };
  if (auth) options.auth = auth;
  return requestJson(ref.baseUrl, `/api/rooms/${encodeURIComponent(ref.slug)}${path}`, io, options);
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
  if (options.body) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(options.body);
  }

  const response = await io.fetch(url, init);
  if (!response.ok) throw await httpError(response, url);
  const text = await readBoundedResponseText(response);
  return (text ? JSON.parse(text) : null) as T;
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
  const stopOnResolved =
    until === "resolved" ||
    until === "complete" ||
    until === "decision.completed" ||
    until === "closed" ||
    until === "room.concluded";
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
    const lines = ["No active question yet.", "", "Next:"];
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
    lines.push("", `Long options clipped — full text: grp options --full${decision}${room}`);
  }
  lines.push("", "Available actions:");
  const phase = String(state.phase ?? "unknown");
  if (phase === "resolved") {
    lines.push(`  grp read${decision}${room}`, `  grp outcome${room}`);
    return `${lines.join("\n")}\n`;
  }
  if (state.proposal_status === "open") lines.push(`  grp propose "..."${decision}${room}`);
  // start-choosing still selects by decision UUID on the wire. Do not emit a
  // targetless command from a seq-focused slate; the proposal timer remains
  // the safe backstop until that separate selector surface is ruled.
  if (state.can_start_choosing === true && focusedSeq === undefined) {
    lines.push(`  grp start choosing${room}`);
  }
  if (phase !== "proposing") {
    lines.push(`  ${choiceCommand(state.choice_mode, decision, room)}`);
    const focused = isRecord(response.decision) ? response.decision : activeDecision(response);
    if (focused?.agreement !== true) {
      lines.push(`  grp abstain --reason="..."${decision}${room}`);
    }
  }
  appendDiscussGuidance(lines, `${decision}${room}`);
  if (state.proposal_status === "open") {
    lines.push(
      "",
      `Note: propose an option's full text; commentary goes in grp discuss "..."${decision}${room}.`,
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
  return `Updated ${name}: ${role}.\n\nRun:\n  grp members${room}\n`;
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
      'Agreement questions: supported — grp ask --agreement "..." resolves only when every eligible voter accepts the same option (grp accept N to accept).',
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

function renderCreatedInvite(response: Record<string, unknown>, ref: RoomRef): string {
  const invite = isRecord(response.invite) ? response.invite : {};
  const about = stringOrNull(response.about);
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
    buildInvitePasteBlock(about, ref.baseUrl, joinCommand, label, role);
  const lines = [`Invite created for ${label}`, `Code: ${code}`, `Role: ${role} (${expected})`];
  // Spec 111 (WR3-1) — observer stays an operator-level concept: the one
  // prominence surface is right here, where the admin just picked a role.
  if (role === "participant") {
    lines.push("Watch-only seat? Re-create with --role observer.");
  }
  lines.push(`Binding: ${binding}`);
  lines.push(
    "Credential warning: this invite can recover its named seat even after acceptance.",
    "Keep it out of recordings, screenshots, transcripts, logs, and browser URLs.",
    `If exposed, revoke it with: grp invite revoke ${code}`,
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
  about: string | null,
  baseUrl: string,
  joinCommand: string,
  label: string,
  role: string,
): string {
  const lines = [
    "You’re invited to join a GRP room. GRP (Group Resolution Protocol) is an open protocol for shared deliberation and decisions.",
    "",
  ];
  if (about) lines.push(`Room purpose: ${inviteAboutLine(about)}`, "");
  lines.push(`This invite is for ${inviteAboutLine(label)} (${inviteAboutLine(role)}).`, "");
  lines.push(`Room service: ${baseUrl.replace(/\/+$/, "")}.`, "");
  lines.push(
    "If needed, install the open-source GRP CLI:",
    "npm install -g @grp-protocol/cli",
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
    lines.push(`  grp invite --name <name>${room}`);
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
  if (typeof response.brief === "string" && response.brief.trim().length > 0) {
    lines.push(response.brief.trim());
  }
  // Spec 109 (WR2-1) — role-aware guidance: observers get watch/read
  // guidance, never choose/propose/discuss/ask affordances. Unknown role
  // (old servers, no saved join role) keeps the participant rendering.
  const isObserver = callerRole(response, ref, env) === "observer";
  const decision = activeDecision(response);
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
    lines.push("", "No active question yet.", "", "Next:");
    const room = roomHintArg(String(response.slug ?? ref.slug), ref, env);
    if (isObserver) {
      lines.push(`  Watch for the next question: grp watch${room}`);
    } else {
      appendIdleGuidance(lines, response, room);
    }
  }
  lines.push("", "Available actions:");
  // Spec 106 — closed rooms must not advertise dead actions: a concluded
  // (or expired) room is read-only forever, so only read-side actions apply.
  const roomStatus = String(response.status ?? "open");
  const room = roomHintArg(String(response.slug ?? ref.slug), ref, env);
  if (roomStatus === "concluded" || roomStatus === "expired") {
    lines.push(`  grp outcome${room}`, `  grp members${room}`);
  } else if (isObserver) {
    lines.push(
      `  grp read${room}`,
      `  grp watch${room}`,
      `  grp outcome${room}`,
      `  grp members${room}`,
    );
  } else {
    lines.push(`  grp invite${room}`, `  grp members${room}`, `  grp settings${room}`);
    if (state.question) {
      const phase = String(state.phase ?? "unknown");
      const multiOpen =
        Array.isArray(response.decisions_open) && response.decisions_open.length > 1;
      const decisionArg = multiOpen ? " --decision=N" : "";
      if (multiOpen) lines.push(`  grp read --decision=N${room}`);
      if (state.proposal_status === "open") lines.push(`  grp propose "..."${decisionArg}${room}`);
      if (state.can_start_choosing === true && !multiOpen)
        lines.push(`  grp start choosing${room}`);
      if (phase !== "proposing") {
        lines.push(`  ${choiceCommand(state.choice_mode, decisionArg, room)}`);
        if (decision?.agreement !== true) {
          lines.push(`  grp abstain --reason="..."${decisionArg}${room}`);
        }
      }
      lines.push(`  grp options${decisionArg}${room}`);
      appendDiscussGuidance(lines, `${decisionArg}${room}`);
    } else {
      lines.push(`  grp watch${room}`);
      appendDiscussGuidance(lines, room);
      if (hasRoomAction(response, "ask")) lines.push(`  grp ask "..."${room}`);
    }
  }
  return `${lines.join("\n")}\n`;
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
  if (earlier !== null && earlier > 0) lines.push(`  (+${earlier} earlier — grp timeline)`);
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
  lines.push(`  Wait for what's next: grp watch${room}`);
  lines.push(`  Check the result: grp outcome${room}`);
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
  if (multiOpen) {
    // Spec 145 (F144-S2) — the projection is the oldest open decision, but
    // the obligations are plural. Keep every act explicitly thread-scoped.
    lines.push(
      `  Review each open thread: grp read --decision=N${room}`,
      `  See its slate: grp options --decision=N${room}`,
      `  Act in that thread using the ballot form shown by grp options --decision=N${room}; discussion and proposals stay thread-scoped too.`,
      `  Then wait for what's next: grp watch${room}`,
    );
    return;
  }
  if (phase === "proposing") {
    lines.push("  Build the option slate through the room.");
    lines.push("  Propose the full option text; keep commentary in the room discussion.");
    lines.push(`  Propose next: grp propose "..."${room}`);
    appendDiscussGuidance(lines, room);
    if (state.can_start_choosing === true) {
      lines.push(`  When the slate is ready: grp start choosing${room}`);
    }
    return;
  }
  if (progress.waitingForChoices) {
    // Spec 112 (WR4-4b) — room mechanics, never agent duties: engagement,
    // not speed. Deliberation before choosing is the product's core value.
    lines.push(...choosingGuidance());
    if (phase !== "proposing") {
      lines.push(`  If you have not responded yet: ${choiceCommand(state.choice_mode, "", room)}`);
      const active = activeDecision(response);
      if (active?.agreement !== true) {
        lines.push(`  Or formally abstain: grp abstain --reason="..."${room}`);
      }
    }
    if (state.proposal_status === "open") {
      lines.push(
        "  If context or options are drifting, add to the discussion or propose another option:",
      );
      appendDiscussGuidance(lines, room);
      lines.push(`  grp propose "..."${room}`);
    }
    // Spec 113 — ONE wait: watch wakes on any activity by others, and always
    // when the room needs your choice. No resolved/needed split to pick.
    lines.push(`  Wait for what's next: grp watch${room}`);
    return;
  }
  if (!progress.hasProgress) {
    lines.push("  Continue through the room until an outcome exists.");
    lines.push(`  Wait for what's next: grp watch${room}`);
    lines.push(`  Check the result: grp outcome${room}`);
    return;
  }
  lines.push("  Choices are in or the room is still updating.");
  lines.push(`  Wait for what's next: grp watch${room}`);
  lines.push(`  Check the result: grp outcome${room}`);
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
      return "score map (grp choose --scores=1=5,2=0)";
    case "quadratic_vote":
      return "quadratic credits (grp choose --scores=1=4,2=1)";
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
    return `grp choose --scores=1=5,2=0${decision}${room}`;
  }
  if (label.startsWith("quadratic credits")) {
    return `grp choose --scores=1=4,2=1${decision}${room}`;
  }
  if (label.startsWith("approval")) {
    return `grp choose --choices=1,3${decision}${room}`;
  }
  if (label.startsWith("ranked")) {
    return `grp choose --choices=2,1,3${decision}${room}`;
  }
  if (label === "single choice") {
    return `grp choose 2${decision}${room}`;
  }
  return `grp options --full${decision}${room}  # host did not report the ballot shape`;
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
      `It resolves only when every voter accepts the same option — disagreement never ends it early. Propose, discuss, revise; grp accept N${room} when an option works.`,
    );
  }
  if (stringOrNull(decision.status) === "proposing") {
    lines.push("Collecting options first: propose options, then start choosing.");
  }
  lines.push(
    "",
    "Next:",
    `  Read the room: grp read${room}`,
    `  Wait for what's next: grp watch${room}`,
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
      `  See the slate: grp options${room}`,
      `  Choices are open — cast or revise yours: grp choose N${room}`,
    );
  } else {
    // Spec 116 (WR8-5) — during the slate phase the gate is start choosing,
    // not choose: dangling the choose verb early cost run 8 four premature
    // 400s ("you can't choose yet").
    lines.push(
      "",
      "Next:",
      `  See the slate: grp options${room}`,
      `  When the slate is ready: grp start choosing${room}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderDiscussionPosted(ref: RoomRef, env: Record<string, string | undefined>): string {
  const room = roomHintArg(ref.slug, ref, env);
  const destination = room ? ` Room: ${ref.slug}.` : "";
  return `Discussion posted.${destination}\n\nNext:\n  Read the room: grp read${room}\n  If more work may follow: grp watch${room}\n`;
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
    `  Submit your choice: grp choose "<option>"${room}`,
    `  See the options: grp options${room}`,
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
      "The question resolves when every voter accepts the same option; grp read shows where others stand. You can revise until it seals.",
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
      `  See the outcome: grp outcome${room}`,
      `  Then wait for what's next: grp watch${room}`,
    );
  } else {
    // Spec 113 — the loop is watch → read → act → watch: one wait, no modes.
    lines.push("", "Next:", `  Wait for what's next: grp watch${room}`);
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
  return `Room closed.${destination}\n\nNext:\n  Final record: grp outcome${room}\n`;
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
        `--scores entry "${pair}" must be option-number=score (numbers only, e.g. 1=5); run grp options to see the numbered slate`,
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
        "Run `grp enter <room-id>` first, or pass a room URL/slug and the required text flag.",
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
  if (!current) throw new Error("room URL or slug is required; or run `grp enter <room-url|slug>`");
  return `${current.baseUrl}/r/${encodeURIComponent(current.slug)}`;
}

async function httpError(response: Response, requestUrl?: URL): Promise<Error> {
  const text = await readBoundedResponseText(response);
  if (!text) return new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html") || looksLikeHtml(text)) {
    const from = response.url ? ` from ${response.url}` : "";
    return new Error(
      `HTTP ${response.status}${from}; expected a GRP JSON response but received an HTML page`,
    );
  }
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const error = payload.error;
    if (typeof error === "string") {
      // Legacy flat shape ({error: "<sentence>"} or {error: "<code>", message}).
      const message = typeof payload.message === "string" ? payload.message : error;
      return new Error(formatJsonError({ message, code: null }, response.status, requestUrl));
    }
    if (error && typeof error === "object") {
      // Canonical envelope (spec 106): {error: {code, message, hint?}}.
      const nested = error as Record<string, unknown>;
      return new Error(
        formatJsonError(
          {
            message: String(nested.message ?? nested.code ?? "request failed"),
            code: typeof nested.code === "string" ? nested.code : null,
            ...(typeof nested.hint === "string" ? { hint: nested.hint } : {}),
          },
          response.status,
          requestUrl,
        ),
      );
    }
  } catch {
    // fall through
  }
  return new Error(`${summarizeResponseText(text)} (HTTP ${response.status})`);
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
    const join = slug ? `grp join ${slug}` : "grp join <room-id>";
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
    lines.push(`When the option list is ready: grp start choosing${slug ? ` ${slug}` : ""}`);
  } else if (err.code === "room.concluded") {
    lines.push(`Final record: grp outcome${slug ? ` ${slug}` : ""}`);
  } else if (err.code === "participant.token_superseded") {
    // Spec 139 (C3) — seats are single-session (spec 119): a rotated
    // credential means another session of the same principal holds the seat
    // NOW. The convention is stand down, not fight back — auto-re-joining is
    // how two sessions of one principal end up in a credential war.
    lines.push(
      "Another session of your principal holds this seat now. Stand down — do not re-join automatically; treat this room as handled elsewhere.",
      `To deliberately take the seat back: grp join${slug ? ` ${slug}` : " <room-id>"} --invite <invite-token>`,
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
      "Read the room. Your first read is the full snapshot; once a watch (or --since) stores your position, later reads show what happened since it, in full.",
    flags: [
      "--full           full room snapshot",
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
    summary: "Open a question in the room.",
    flags: [
      "--option=TEXT         seed one option; repeat for each option (commas stay literal)",
      "--options=A,B         legacy comma-separated option slate",
      "--collect-options     collect options first; choices open via start choosing",
      "--agreement           resolves only when every voter accepts the same option;",
      "                      disagreement keeps it open (grp accept N to accept)",
      "--eligible=A,B        limit who can choose on this question",
    ],
    example: 'grp ask "Choose one dinner plan"',
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
      'Add an option to the slate. Propose the option\'s full text — reads show it clipped and agents choose it by number; put commentary in grp discuss "...". Long documents skip shell quoting: --file=PATH, or `grp propose -` to read stdin.',
    flags: [
      "--file=PATH      propose the file's contents as the option text",
      "--decision=N     target decision N (the seq in grp read); default: the open decision",
    ],
    example: 'grp propose "Tamarind Table at 7:30"',
  },
  discuss: {
    usage: 'grp discuss "<message>" [room]',
    summary:
      "Post to the room discussion. Long or shell-sensitive messages: --file=PATH, or `grp discuss -` to read stdin.",
    flags: [
      "--file=PATH      post the file's contents as the message",
      "--stance=KIND    agree, disagree, clarify, or extend",
      "--decision=N     attach to decision N (the seq in grp read); default: the open decision",
    ],
    example: 'grp discuss "I prefer the earlier time" --stance=extend',
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
    example: 'grp choose 2 --why="Best fit"',
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
      "Block until something happens: any activity by others, or the room needing your choice — then exit with the reason. An open decision waiting on YOUR choice always wakes you, whatever filter is set.",
    flags: [
      "--timeout=N      quiet-time bound in seconds (default 110; 0 waits indefinitely)",

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
      "Commands:",
      "  create         create a room",
      "  enter          set the current room context",
      "  current        print the current room context",
      "  rooms          list locally remembered rooms",
      "  inbox          check remembered rooms for attention",
      "  leave          clear the current room context",
      "  read           read the room (new activity since your last read)",
      "  join           join and remember a room (use --enter to switch)",
      "  ask            open a question in the room",
      "  options        show the current option slate",
      "  propose        propose an option",
      "  discuss        post a room discussion message",
      "  start choosing open choices for a collect-first question",
      "  choose         submit or revise your choice",
      "  abstain        participate without supporting an option",
      "  outcome        show the latest decided outcome",
      "  history        print room timeline history",
      "  watch          wait until the room has something for you",
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
      "  --full           full room snapshot on read (skip the delta)",
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
