import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve as pathResolve, relative } from "node:path";
import { parseDocument } from "yaml";
import { normalizeDisplayName, normalizeSessionName } from "./provider-config.js";

/**
 * Spec 174 (B-5) — the mechanism vocabulary this CLI build knows about.
 * NOT authoritative: the target host's discovery document
 * (`mechanisms_supported` in /.well-known/grp.json) is the real policy, and
 * `grp org validate --host=URL` checks against it live. Offline validation
 * treats an unknown mechanism as a warning, never a hard error — a hardcoded
 * client list must not reject a host that supports more than we shipped
 * knowing about (this was the third hand-synced copy of the list).
 */
export const KNOWN_MECHANISMS = new Set([
  "simple_majority",
  "supermajority",
  "plurality",
  "approval",
  "ranked_choice",
  "ranked_pairwise",
  "score_vote",
  "quadratic_vote",
]);
const AUTHORITIES = new Set(["none", "operator", "designated", "any_participant"]);
const ROLES = new Set(["participant", "observer"]);
const SETTING_KEYS = new Set([
  "auth",
  "quorum",
  "voting_window",
  "settle_window",
  "max_participants",
  "max_options",
  "max_open_decisions",
  "early_close",
  "creator_votes",
  "read_receipts",
  "choice_visibility",
  "deliberation_mode",
  "max_deliberation_messages_per_participant",
  "max_total_deliberation_messages",
  "invite_authority",
  "option_proposal_authority",
  "decision_opening_authority",
  "conclusion_authority",
]);

export interface OrganizationRuntime {
  command: string;
  args: string[];
  prompt?: "first_day";
}

export interface OrganizationPersona {
  id: string;
  displayName: string;
  instructions?: string;
  firstDay?: string;
  runtime?: OrganizationRuntime;
}

export interface OrganizationWorkspace {
  repository: string;
  clone: "per_persona";
}

export interface OrganizationRoomMember {
  persona: string;
  role: "participant" | "observer";
}

export interface OrganizationRoom {
  id: string;
  creator: string;
  about: string;
  type: "ephemeral" | "persistent";
  mechanism: string;
  visibility?: "public" | "unlisted" | "private";
  settings: Record<string, string | number | boolean | null>;
  members: OrganizationRoomMember[];
}

export interface OrganizationManifest {
  version: 1;
  name: string;
  host?: string;
  baseUrl?: string;
  workspace?: OrganizationWorkspace;
  personas: OrganizationPersona[];
  rooms: OrganizationRoom[];
}

export interface LoadedOrganizationManifest {
  path: string;
  directory: string;
  source: string;
  manifest: OrganizationManifest;
  manifestHash: string;
  topologyHash: string;
}

export function loadOrganizationManifest(
  rawPath: string,
  cwd = process.cwd(),
): LoadedOrganizationManifest {
  const path = pathResolve(cwd, rawPath);
  const source = readRegularFile(path, "organization manifest");
  const manifest = parseOrganizationManifest(source, path);
  validateSourceFiles(manifest, dirname(path));
  return {
    path,
    directory: dirname(path),
    source,
    manifest,
    manifestHash: sha256(stableJson(manifest)),
    topologyHash: sha256(stableJson(topologyValue(manifest))),
  };
}

export function parseOrganizationManifest(
  source: string,
  label = "organization manifest",
): OrganizationManifest {
  const document = parseDocument(source, {
    prettyErrors: false,
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(`${label}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = strictRecord(raw, label, [
    "version",
    "name",
    "host",
    "base_url",
    "workspace",
    "personas",
    "rooms",
  ]);
  if (root.version !== 1) throw new Error(`${label}: version must be integer 1`);
  const name = normalizedName(root.name, `${label}.name`);
  const host = optionalString(root.host, `${label}.host`);
  const baseUrl = optionalString(root.base_url, `${label}.base_url`);
  if (host && baseUrl) throw new Error(`${label}: use only one of host or base_url`);
  if (baseUrl) validateBaseUrl(baseUrl, `${label}.base_url`);

  const rawPersonas = requiredArray(root.personas, `${label}.personas`);
  if (rawPersonas.length === 0) throw new Error(`${label}.personas must not be empty`);
  const personas = rawPersonas.map((value, index) =>
    parsePersona(value, `${label}.personas[${index}]`),
  );
  assertUnique(
    personas.map((persona) => persona.id),
    `${label}.personas`,
  );

  const rawRooms = root.rooms === undefined ? [] : requiredArray(root.rooms, `${label}.rooms`);
  const rooms = rawRooms.map((value, index) => parseRoom(value, `${label}.rooms[${index}]`));
  assertUnique(
    rooms.map((room) => room.id),
    `${label}.rooms`,
  );
  const personaIds = new Set(personas.map((persona) => persona.id));
  for (const room of rooms) {
    if (!personaIds.has(room.creator)) {
      throw new Error(
        `${label}.rooms.${room.id}.creator references unknown persona "${room.creator}"`,
      );
    }
    for (const member of room.members) {
      if (!personaIds.has(member.persona)) {
        throw new Error(
          `${label}.rooms.${room.id}.members references unknown persona "${member.persona}"`,
        );
      }
    }
    const creator = room.members.find((member) => member.persona === room.creator);
    if (!creator) {
      throw new Error(`${label}.rooms.${room.id}: creator must appear in members`);
    }
    if (creator.role !== "participant") {
      throw new Error(`${label}.rooms.${room.id}: creator must have role participant`);
    }
  }

  return {
    version: 1,
    name,
    ...(host ? { host } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(root.workspace === undefined
      ? {}
      : { workspace: parseWorkspace(root.workspace, `${label}.workspace`) }),
    personas,
    rooms,
  };
}

function parsePersona(raw: unknown, label: string): OrganizationPersona {
  const value = strictRecord(raw, label, [
    "id",
    "display_name",
    "instructions",
    "first_day",
    "runtime",
  ]);
  const id = normalizedName(value.id, `${label}.id`);
  const displayName =
    value.display_name === undefined
      ? humanizeName(id)
      : normalizeDisplayName(requiredString(value.display_name, `${label}.display_name`));
  const instructions = optionalRelativePath(value.instructions, `${label}.instructions`);
  const firstDay = optionalRelativePath(value.first_day, `${label}.first_day`);
  const runtime =
    value.runtime === undefined ? undefined : parseRuntime(value.runtime, `${label}.runtime`);
  if (runtime?.prompt === "first_day" && !firstDay) {
    throw new Error(`${label}.runtime.prompt is first_day but ${label}.first_day is not declared`);
  }
  return {
    id,
    displayName,
    ...(instructions ? { instructions } : {}),
    ...(firstDay ? { firstDay } : {}),
    ...(runtime ? { runtime } : {}),
  };
}

function parseRuntime(raw: unknown, label: string): OrganizationRuntime {
  const value = strictRecord(raw, label, ["command", "args", "prompt"]);
  const command = requiredString(value.command, `${label}.command`);
  assertSafeLiteral(command, `${label}.command`);
  const args =
    value.args === undefined
      ? []
      : requiredArray(value.args, `${label}.args`).map((arg, index) => {
          const parsed = requiredString(arg, `${label}.args[${index}]`, true);
          assertSafeLiteral(parsed, `${label}.args[${index}]`);
          return parsed;
        });
  let prompt: "first_day" | undefined;
  if (value.prompt !== undefined) {
    if (value.prompt !== "first_day") {
      throw new Error(`${label}.prompt must be "first_day"`);
    }
    prompt = "first_day";
  }
  return { command, args, ...(prompt ? { prompt } : {}) };
}

function parseWorkspace(raw: unknown, label: string): OrganizationWorkspace {
  const value = strictRecord(raw, label, ["repository", "clone"]);
  const repository = requiredString(value.repository, `${label}.repository`);
  if (hasUrlCredentials(repository)) {
    throw new Error(`${label}.repository must not contain URL credentials`);
  }
  if (repository.includes("\0") || repository.includes("\n") || repository.includes("\r")) {
    throw new Error(`${label}.repository contains unsafe control characters`);
  }
  if (value.clone !== "per_persona") {
    throw new Error(`${label}.clone must be "per_persona"`);
  }
  return { repository, clone: "per_persona" };
}

function parseRoom(raw: unknown, label: string): OrganizationRoom {
  const value = strictRecord(raw, label, [
    "id",
    "creator",
    "about",
    "type",
    "mechanism",
    "visibility",
    "settings",
    "members",
  ]);
  const id = normalizedName(value.id, `${label}.id`);
  const creator = normalizedName(value.creator, `${label}.creator`);
  const about = requiredString(value.about, `${label}.about`);
  const type = value.type ?? "persistent";
  if (type !== "ephemeral" && type !== "persistent") {
    throw new Error(`${label}.type must be "ephemeral" or "persistent"`);
  }
  // Spec 174 — structural check only; support is the host's call (see
  // KNOWN_MECHANISMS above). Unknown-but-well-formed slugs surface as
  // warnings via manifestMechanismWarnings, and hard-fail only against a
  // live discovery document.
  const mechanism = value.mechanism ?? "simple_majority";
  if (typeof mechanism !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(mechanism)) {
    throw new Error(`${label}.mechanism must be a lowercase mechanism slug (e.g. simple_majority)`);
  }
  let visibility: "public" | "unlisted" | "private" | undefined;
  if (value.visibility !== undefined) {
    if (
      value.visibility !== "public" &&
      value.visibility !== "unlisted" &&
      value.visibility !== "private"
    ) {
      throw new Error(`${label}.visibility must be "public", "unlisted", or "private"`);
    }
    visibility = value.visibility;
  }
  const rawMembers = requiredArray(value.members, `${label}.members`);
  if (rawMembers.length === 0) throw new Error(`${label}.members must not be empty`);
  const members = rawMembers.map((member, index) =>
    parseMember(member, `${label}.members[${index}]`),
  );
  assertUnique(
    members.map((member) => member.persona),
    `${label}.members`,
  );
  const settings =
    value.settings === undefined ? {} : parseSettings(value.settings, `${label}.settings`);
  return {
    id,
    creator,
    about,
    type,
    mechanism,
    ...(visibility ? { visibility } : {}),
    settings,
    members,
  };
}

function parseMember(raw: unknown, label: string): OrganizationRoomMember {
  const value =
    typeof raw === "string" ? { persona: raw } : strictRecord(raw, label, ["persona", "role"]);
  const persona = normalizedName(value.persona, `${label}.persona`);
  const role = value.role ?? "participant";
  if (typeof role !== "string" || !ROLES.has(role)) {
    throw new Error(`${label}.role must be "participant" or "observer"`);
  }
  return { persona, role: role as "participant" | "observer" };
}

function parseSettings(
  raw: unknown,
  label: string,
): Record<string, string | number | boolean | null> {
  const value = strictRecord(raw, label, [...SETTING_KEYS]);
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, setting] of Object.entries(value)) {
    if (key.endsWith("_authority")) {
      if (typeof setting !== "string" || !AUTHORITIES.has(setting)) {
        throw new Error(`${label}.${key} is not a supported authority`);
      }
    } else if (["early_close", "creator_votes", "read_receipts"].includes(key)) {
      if (typeof setting !== "boolean") throw new Error(`${label}.${key} must be boolean`);
    } else if (key === "auth") {
      if (!["token_only", "mandate_required", "either"].includes(String(setting))) {
        throw new Error(`${label}.auth is not supported`);
      }
    } else if (key === "choice_visibility") {
      if (!["after_decided", "live", "never"].includes(String(setting))) {
        throw new Error(`${label}.choice_visibility is not supported`);
      }
    } else if (key === "deliberation_mode") {
      if (!["optional", "disabled"].includes(String(setting))) {
        throw new Error(`${label}.deliberation_mode is not supported`);
      }
    } else if (setting !== null && (typeof setting !== "number" || !Number.isInteger(setting))) {
      throw new Error(`${label}.${key} must be an integer${key === "quorum" ? " or null" : ""}`);
    }
    if (setting === null && key !== "quorum" && key !== "max_participants") {
      throw new Error(`${label}.${key} must not be null`);
    }
    validateNumericSetting(key, setting, `${label}.${key}`);
    out[key] = setting as string | number | boolean | null;
  }
  return out;
}

function validateNumericSetting(key: string, value: unknown, label: string): void {
  if (typeof value !== "number") return;
  const ranges: Record<string, [number, number | null]> = {
    quorum: [1, null],
    voting_window: [60, 1_209_600],
    settle_window: [0, 3_600],
    max_participants: [1, null],
    max_options: [2, 500],
    max_open_decisions: [1, 5],
    max_deliberation_messages_per_participant: [1, 500],
    max_total_deliberation_messages: [1, 5_000],
  };
  const range = ranges[key];
  if (!range) return;
  const [minimum, maximum] = range;
  if (value < minimum || (maximum !== null && value > maximum)) {
    throw new Error(
      `${label} must be an integer ${maximum === null ? `of at least ${minimum}` : `between ${minimum} and ${maximum}`}`,
    );
  }
}

function validateSourceFiles(manifest: OrganizationManifest, manifestDirectory: string): void {
  const canonicalDirectory = realpathSync(manifestDirectory);
  for (const persona of manifest.personas) {
    for (const [kind, rawPath] of [
      ["instructions", persona.instructions],
      ["first_day", persona.firstDay],
    ] as const) {
      if (!rawPath) continue;
      const resolved = pathResolve(manifestDirectory, rawPath);
      assertWithin(pathResolve(manifestDirectory), resolved, `${persona.id}.${kind}`);
      readRegularFile(resolved, `${persona.id}.${kind}`);
      assertWithin(canonicalDirectory, realpathSync(resolved), `${persona.id}.${kind}`);
    }
  }
}

export function resolveManifestFile(loaded: LoadedOrganizationManifest, rawPath: string): string {
  return pathResolve(loaded.directory, rawPath);
}

function topologyValue(manifest: OrganizationManifest): unknown {
  return {
    version: manifest.version,
    name: manifest.name,
    host: manifest.host ?? null,
    baseUrl: manifest.baseUrl ?? null,
    workspace: manifest.workspace ?? null,
    personas: manifest.personas.map(({ id, displayName, runtime }) => ({
      id,
      displayName,
      runtime: runtime ?? null,
    })),
    rooms: manifest.rooms,
  };
}

function strictRecord(raw: unknown, label: string, allowedKeys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`);
  }
  const value = raw as Record<string, unknown>;
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) throw new Error(`${label}: unknown field "${unknown[0]}"`);
  return value;
}

function requiredArray(raw: unknown, label: string): unknown[] {
  if (!Array.isArray(raw)) throw new Error(`${label} must be an array`);
  return raw;
}

function requiredString(raw: unknown, label: string, allowEmpty = false): string {
  if (typeof raw !== "string" || (!allowEmpty && raw.trim().length === 0)) {
    throw new Error(`${label} must be a${allowEmpty ? "" : " non-empty"} string`);
  }
  return raw;
}

function optionalString(raw: unknown, label: string): string | undefined {
  return raw === undefined ? undefined : requiredString(raw, label);
}

function normalizedName(raw: unknown, label: string): string {
  try {
    return normalizeSessionName(requiredString(raw, label));
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function optionalRelativePath(raw: unknown, label: string): string | undefined {
  if (raw === undefined) return undefined;
  const value = requiredString(raw, label);
  if (isAbsolute(value)) throw new Error(`${label} must be relative to the manifest`);
  if (value.includes("\0")) throw new Error(`${label} contains an unsafe null byte`);
  return value;
}

function validateBaseUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${label} must be an absolute credential-free http(s) URL`);
  }
}

function assertSafeLiteral(value: string, label: string): void {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`${label} contains unsafe control characters`);
  }
  if (hasUrlCredentials(value)) throw new Error(`${label} must not contain URL credentials`);
}

function hasUrlCredentials(value: string): boolean {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return /https?:\/\/[^/\s@]+:[^/\s@]+@/i.test(value);
  }
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label}: duplicate identifier "${value}"`);
    seen.add(value);
  }
}

function assertWithin(root: string, path: string, label: string): void {
  const offset = relative(root, path);
  if (offset === ".." || offset.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`${label} escapes the manifest directory`);
  }
}

function readRegularFile(path: string, label: string): string {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} is not readable at ${path}: ${errorText(error)}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  }
  return readFileSync(path, "utf8");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function humanizeName(name: string): string {
  return name
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Spec 174 — offline mechanism lint. Returns one warning line per room whose
 * mechanism is outside this build's KNOWN_MECHANISMS set. Not an error: the
 * target host's discovery document is authoritative
 * (`grp org validate --host=URL` enforces it).
 */
export function manifestMechanismWarnings(manifest: OrganizationManifest): string[] {
  const warnings: string[] = [];
  for (const room of manifest.rooms) {
    if (!KNOWN_MECHANISMS.has(room.mechanism)) {
      warnings.push(
        `room "${room.id}": mechanism "${room.mechanism}" is not in this CLI's known set — the target host's discovery document decides support; check live with \`grp org validate <manifest> --host=URL\``,
      );
    }
  }
  return warnings;
}

/**
 * Spec 174 — discovery-driven mechanism policy. Validates every room's
 * mechanism against a host's advertised `mechanisms_supported`. Returns the
 * offending room/mechanism pairs (empty = all supported).
 */
export function unsupportedMechanisms(
  manifest: OrganizationManifest,
  mechanismsSupported: string[],
): Array<{ roomId: string; mechanism: string }> {
  const supported = new Set(mechanismsSupported);
  return manifest.rooms
    .filter((room) => !supported.has(room.mechanism))
    .map((room) => ({ roomId: room.id, mechanism: room.mechanism }));
}
