import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join as pathJoin, resolve as pathResolve } from "node:path";
import {
  type ExclusiveFileLockLease,
  assertExclusiveFileLock,
  withExclusiveFileLock,
} from "./exclusive-file-lock.js";

export interface ProviderProfile {
  name: string;
  baseUrl: string;
}

export interface RoomContext {
  provider?: string;
  baseUrl?: string;
  slug: string;
  token?: string;
  password?: string;
  /** Spec 109 (WR2-1) — the caller's room role from the join response, so
   * read guidance can stay role-aware against hosts that do not echo the
   * caller's role back on reads. */
  role?: "participant" | "observer";
  /** Spec 113 — the caller's own participant id from the join response, so
   * watch can tell its own events from everyone else's. */
  participantId?: string;
  /** Spec 113 — the per-room high-water mark: the highest event seq this
   * session has already read. Absent = no mark (first contact reads the full
   * snapshot). Advanced by delta reads, explicit --since reads, and the
   * FOREGROUND wake-mode watch — NEVER by `grp watch --jsonl` (a background
   * flight recorder must not eat the foreground's delta; that would be the
   * client-side version of the shared-cursor bug spec 113 refused to build
   * server-side). */
  lastSeenSeq?: number;
}

export interface CliProfile {
  displayName?: string;
}

export interface LocalSession {
  currentRoom?: RoomContext;
  rooms?: Record<string, RoomContext>;
  profile?: CliProfile;
}

export interface HostedCredential {
  baseUrl: string;
  accessToken: string;
  mandate: string;
  publicId?: string;
  scope?: string;
  resource?: string | null;
  savedAt: string;
}

export interface ProviderConfig {
  setupMode?: "join_only";
  defaultProvider?: string;
  currentRoom?: RoomContext;
  rooms?: Record<string, RoomContext>;
  profile?: CliProfile;
  auth?: HostedCredential;
  sessions?: Record<string, LocalSession>;
  providers: Record<string, ProviderProfile>;
}

export interface ProviderConfigAccessOptions {
  cwd?: string;
  scope?: "resolved" | "global";
  /** Test/diagnostic override. Production uses the bounded default. */
  lockTimeoutMs?: number;
}

export interface PersonaSelection {
  name: string;
  source: "grp as" | "GRP_SESSION" | "workspace";
  markerPath?: string;
}

export interface PersonaContext extends PersonaSelection {
  displayName: string | null;
  currentRoom: RoomContext | null;
}

export interface WorkspacePersonaMarker {
  name: string;
  path: string;
}

export const BUILTIN_PROVIDERS: Record<string, ProviderProfile> = {
  local: { name: "local", baseUrl: "http://127.0.0.1:3001" },
  grp: { name: "grp", baseUrl: "https://grp.app" },
};

export function providerConfigPath(env: Record<string, string | undefined> = process.env): string {
  const explicit = nonEmpty(env.GRP_CONFIG);
  if (explicit) return explicit;
  const xdgConfigHome = nonEmpty(env.XDG_CONFIG_HOME);
  if (xdgConfigHome) return pathJoin(xdgConfigHome, "grp", "config.json");
  return pathJoin(homedir(), ".config", "grp", "config.json");
}

export function emptyProviderConfig(): ProviderConfig {
  return { providers: {} };
}

export function readProviderConfig(
  env: Record<string, string | undefined> = process.env,
  options: ProviderConfigAccessOptions = {},
): ProviderConfig {
  const path = providerConfigPath(env);
  const stored = readProviderConfigFile(path);
  const selection = resolvePersonaSelection(env, options);
  assertSelectedPersona(stored, selection, path);
  return withLocalSession(stored, selection?.name);
}

export function updateProviderConfig(
  update: (current: ProviderConfig) => ProviderConfig,
  env: Record<string, string | undefined> = process.env,
  options: ProviderConfigAccessOptions = {},
): ProviderConfig {
  const path = providerConfigPath(env);
  ensurePrivateConfigDirectory(path);
  return withProviderConfigLock(path, options, (lease) => {
    const stored = readProviderConfigFile(path);
    const selection = resolvePersonaSelection(env, options);
    // Revalidate under the same lock as the mutation. A concurrently removed
    // persona must fail closed, never be resurrected by a stale command.
    assertSelectedPersona(stored, selection, path);
    const current = withLocalSession(stored, selection?.name);
    const updated = normalizeProviderConfig(update(current));
    const toWrite = selection ? mergeLocalSessionConfig(stored, updated, selection.name) : updated;
    assertExclusiveFileLock(lease);
    writeProviderConfigFileAtomic(path, toWrite);
    return withLocalSession(toWrite, selection?.name);
  });
}

export function resolvePersonaContext(
  env: Record<string, string | undefined> = process.env,
  options: ProviderConfigAccessOptions = {},
): PersonaContext | null {
  const selection = resolvePersonaSelection(env, options);
  if (!selection) return null;
  const path = providerConfigPath(env);
  const stored = readProviderConfigFile(path);
  assertSelectedPersona(stored, selection, path);
  const session = stored.sessions?.[selection.name];
  return {
    ...selection,
    displayName: session?.profile?.displayName ?? null,
    currentRoom: session?.currentRoom ?? null,
  };
}

export function resolvePersonaSelection(
  env: Record<string, string | undefined> = process.env,
  options: ProviderConfigAccessOptions = {},
): PersonaSelection | null {
  if (options.scope === "global") return null;
  const grpSession = nonEmpty(env.GRP_SESSION);
  if (grpSession) {
    return {
      name: normalizeSessionName(grpSession),
      source: env.GRP_AS_ACTIVE === "1" ? "grp as" : "GRP_SESSION",
    };
  }
  // An explicitly selected config bundle is already a complete identity
  // boundary. Ambient workspace markers must not reach into it.
  if (nonEmpty(env.GRP_CONFIG)) return null;
  const marker = findWorkspacePersona(options.cwd ?? process.cwd());
  return marker ? { name: marker.name, source: "workspace", markerPath: marker.path } : null;
}

export function findWorkspacePersona(
  startDir: string = process.cwd(),
): WorkspacePersonaMarker | null {
  let directory = pathResolve(startDir);
  while (true) {
    const markerDirectory = pathJoin(directory, ".grp");
    const markerPath = pathJoin(markerDirectory, "persona");
    try {
      const directoryStat = lstatSync(markerDirectory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw workspaceMarkerError(markerPath, `${markerDirectory} is not a regular directory`);
      }
      const markerStat = lstatSync(markerPath);
      if (!markerStat.isFile()) {
        throw workspaceMarkerError(markerPath, "marker is not a regular file");
      }
      let contents: string;
      try {
        contents = readFileSync(markerPath, "utf8");
      } catch (err) {
        throw workspaceMarkerError(
          markerPath,
          `marker is unreadable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const raw = contents.trim();
      if (!raw) throw workspaceMarkerError(markerPath, "marker is empty");
      let name: string;
      try {
        name = normalizeSessionName(raw);
      } catch (err) {
        throw workspaceMarkerError(
          markerPath,
          `marker is invalid: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (contents !== `${name}\n`) {
        throw workspaceMarkerError(markerPath, `marker is invalid: expected exactly "${name}\\n"`);
      }
      return { name, path: markerPath };
    } catch (err) {
      if (!hasErrorCode(err, "ENOENT")) throw err;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function workspaceMarkerError(markerPath: string, reason: string): Error {
  return new Error(
    `invalid workspace persona marker at ${markerPath}: ${reason}. Repair from that directory with \`grp persona init NAME --force\``,
  );
}

export function renderPersonaIdentity(context: PersonaContext): string {
  const displayName = context.displayName ?? context.name;
  return `You are ${displayName} here (persona: ${context.name}).`;
}

export function addProvider(
  config: ProviderConfig,
  name: string,
  baseUrl: string,
  setDefault = false,
): ProviderConfig {
  const provider = { name: normalizeProviderName(name), baseUrl: normalizeBaseUrl(baseUrl) };
  const next = normalizeProviderConfig(config);
  next.providers[provider.name] = provider;
  if (setDefault || !next.defaultProvider) {
    const { setupMode: _setupMode, ...rest } = next;
    return { ...rest, defaultProvider: provider.name };
  }
  return next;
}

export function setDefaultProvider(config: ProviderConfig, name: string): ProviderConfig {
  const normalized = normalizeProviderName(name);
  const next = normalizeProviderConfig(config);
  if (!resolveProvider(next, normalized)) {
    throw new Error(`unknown provider: ${normalized}`);
  }
  const { setupMode: _setupMode, ...rest } = next;
  return { ...rest, defaultProvider: normalized };
}

export function setJoinOnlyMode(config: ProviderConfig): ProviderConfig {
  const next = normalizeProviderConfig(config);
  const { defaultProvider: _defaultProvider, ...rest } = next;
  return { ...rest, setupMode: "join_only" };
}

export function removeProvider(config: ProviderConfig, name: string): ProviderConfig {
  const normalized = normalizeProviderName(name);
  if (BUILTIN_PROVIDERS[normalized]) {
    throw new Error(`cannot remove built-in provider: ${normalized}`);
  }
  const next = normalizeProviderConfig(config);
  const providers = Object.fromEntries(
    Object.entries(next.providers).filter(([key]) => key !== normalized),
  );
  if (next.defaultProvider === normalized) {
    const { defaultProvider: _defaultProvider, ...rest } = next;
    return { ...rest, providers };
  }
  return { ...next, providers };
}

export function setCurrentRoom(config: ProviderConfig, room: RoomContext): ProviderConfig {
  const next = rememberRoom(config, room);
  const incoming = normalizeRoomContext(room);
  const incomingBaseUrl =
    incoming.baseUrl ??
    (incoming.provider ? resolveProvider(next, incoming.provider)?.baseUrl : undefined);
  // The explicit incoming context is the newest credential-bearing write.
  // A stale duplicate in currentRoom must not overwrite a freshly rotated
  // token from the rooms map when we make this room current again.
  const current = mergeRoomContexts(
    findRememberedRoom(next, incoming.slug, incomingBaseUrl),
    incoming,
  );
  return { ...next, currentRoom: current };
}

/**
 * Spec 131 — remember credentials/cursor metadata without changing the
 * current-room pointer. Joining another room uses this path unless the caller
 * explicitly asks to enter it.
 */
export function rememberRoom(config: ProviderConfig, room: RoomContext): ProviderConfig {
  const next = normalizeProviderConfig(config);
  const incoming = normalizeRoomContext(room);
  const incomingBaseUrl =
    incoming.baseUrl ??
    (incoming.provider ? resolveProvider(next, incoming.provider)?.baseUrl : undefined);
  const remembered = findRememberedRoom(next, incoming.slug, incomingBaseUrl);
  const merged = mergeRoomContexts(remembered, incoming);
  const rooms = Object.fromEntries(
    Object.entries(next.rooms ?? {}).filter(
      ([, candidate]) => !roomMatches(next, candidate, incoming.slug, incomingBaseUrl),
    ),
  );
  rooms[roomContextKey(merged)] = merged;
  return { ...next, rooms };
}

export function clearCurrentRoom(config: ProviderConfig): ProviderConfig {
  const next = normalizeProviderConfig(config);
  const { currentRoom: _currentRoom, ...rest } = next;
  return rest;
}

/** Remove one exact host+slug room from local memory, including current. */
export function forgetRoom(config: ProviderConfig, slug: string, baseUrl: string): ProviderConfig {
  const next = normalizeProviderConfig(config);
  const targetBase = normalizeBaseUrl(baseUrl);
  const rooms = Object.fromEntries(
    Object.entries(next.rooms ?? {}).filter(
      ([, room]) => !roomMatches(next, room, slug, targetBase),
    ),
  );
  const currentRoom =
    next.currentRoom && roomMatches(next, next.currentRoom, slug, targetBase)
      ? undefined
      : next.currentRoom;
  const { currentRoom: _currentRoom, rooms: _rooms, ...rest } = next;
  return {
    ...rest,
    ...(currentRoom ? { currentRoom } : {}),
    ...(Object.keys(rooms).length > 0 ? { rooms } : {}),
  };
}

export function findRememberedRoom(
  config: ProviderConfig,
  slug: string,
  baseUrl?: string,
): RoomContext | undefined {
  const normalized = normalizeProviderConfig(config);
  const targetBase = baseUrl ? normalizeBaseUrl(baseUrl) : undefined;
  let found: RoomContext | undefined;
  for (const room of [
    ...Object.values(normalized.rooms ?? {}),
    ...(normalized.currentRoom ? [normalized.currentRoom] : []),
  ]) {
    if (!roomMatches(normalized, room, slug, targetBase)) continue;
    found = mergeRoomContexts(found, room);
  }
  return found;
}

/** Spec 131 — one deduplicated, credential-bearing local row per host+slug. */
export function listRememberedRooms(config: ProviderConfig): RoomContext[] {
  const normalized = normalizeProviderConfig(config);
  const rooms = new Map<string, RoomContext>();
  for (const room of [
    ...Object.values(normalized.rooms ?? {}),
    ...(normalized.currentRoom ? [normalized.currentRoom] : []),
  ]) {
    const baseUrl =
      room.baseUrl ??
      (room.provider ? resolveProvider(normalized, room.provider)?.baseUrl : undefined);
    const key = `${baseUrl ?? `provider:${room.provider ?? "unknown"}`}|${room.slug}`;
    rooms.set(key, mergeRoomContexts(rooms.get(key), room));
  }
  return [...rooms.values()];
}

/**
 * Spec 113 — persist a room's read high-water mark without changing which
 * room is current. Updates every remembered context that matches the room
 * (rooms map + currentRoom); when the room was never remembered, creates a
 * minimal rooms-map entry so the mark survives (credentials are not stored
 * from this path).
 */
export function setRoomLastSeenSeq(
  config: ProviderConfig,
  slug: string,
  baseUrl: string | undefined,
  lastSeenSeq: number,
): ProviderConfig {
  const next = normalizeProviderConfig(config);
  const targetBase = baseUrl ? normalizeBaseUrl(baseUrl) : undefined;
  const rooms = { ...(next.rooms ?? {}) };
  let touched = false;
  for (const [key, room] of Object.entries(rooms)) {
    if (!roomMatches(next, room, slug, targetBase)) continue;
    rooms[key] = normalizeRoomContext({
      ...room,
      lastSeenSeq: Math.max(room.lastSeenSeq ?? 0, lastSeenSeq),
    });
    touched = true;
  }
  let currentRoom = next.currentRoom;
  if (currentRoom && roomMatches(next, currentRoom, slug, targetBase)) {
    currentRoom = normalizeRoomContext({
      ...currentRoom,
      lastSeenSeq: Math.max(currentRoom.lastSeenSeq ?? 0, lastSeenSeq),
    });
    touched = true;
  }
  if (!touched) {
    const room = normalizeRoomContext({
      slug,
      ...(baseUrl ? { baseUrl } : {}),
      lastSeenSeq,
    });
    rooms[roomContextKey(room)] = room;
  }
  return {
    ...next,
    ...(currentRoom ? { currentRoom } : {}),
    ...(Object.keys(rooms).length > 0 ? { rooms } : {}),
  };
}

export function setProfileDisplayName(config: ProviderConfig, displayName: string): ProviderConfig {
  const next = normalizeProviderConfig(config);
  return { ...next, profile: { displayName: normalizeDisplayName(displayName) } };
}

export function clearProfileDisplayName(config: ProviderConfig): ProviderConfig {
  const next = normalizeProviderConfig(config);
  const { profile: _profile, ...rest } = next;
  return rest;
}

export function setHostedCredential(
  config: ProviderConfig,
  credential: HostedCredential,
): ProviderConfig {
  const next = normalizeProviderConfig(config);
  return { ...next, auth: normalizeHostedCredential(credential) };
}

export function clearHostedCredential(config: ProviderConfig): ProviderConfig {
  const next = normalizeProviderConfig(config);
  const { auth: _auth, ...rest } = next;
  return rest;
}

export function resolveProvider(config: ProviderConfig, name: string): ProviderProfile | undefined {
  const normalized = normalizeProviderName(name);
  return config.providers[normalized] ?? BUILTIN_PROVIDERS[normalized];
}

export function resolveProviderBaseUrl(
  providerName: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const config = readProviderConfig(env);
  const name = providerName ?? env.GRP_HOST ?? env.GRP_PROVIDER ?? config.defaultProvider;
  if (!name) return undefined;
  const provider = resolveProvider(config, name);
  if (!provider) throw new Error(`unknown provider: ${name}`);
  return provider.baseUrl;
}

export function listProviders(config: ProviderConfig): ProviderProfile[] {
  const normalized = normalizeProviderConfig(config);
  const merged = { ...normalized.providers };
  if (normalized.defaultProvider && !merged[normalized.defaultProvider]) {
    const defaultProvider = resolveProvider(normalized, normalized.defaultProvider);
    if (defaultProvider) merged[defaultProvider.name] = defaultProvider;
  }
  return Object.values(merged).sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteProviderConfig(env: Record<string, string | undefined> = process.env): void {
  const path = providerConfigPath(env);
  ensurePrivateConfigDirectory(path);
  withProviderConfigLock(path, {}, (lease) => {
    assertExclusiveFileLock(lease);
    rmSync(path, { force: true });
    fsyncParentDirectory(path);
  });
}

export function listLocalSessions(config: ProviderConfig): Array<{ name: string } & LocalSession> {
  const normalized = normalizeProviderConfig(config);
  return Object.entries(normalized.sessions ?? {})
    .map(([name, session]) => ({ name, ...session }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveLocalSession(
  config: ProviderConfig,
  name: string,
): LocalSession | undefined {
  const normalized = normalizeProviderConfig(config);
  return normalized.sessions?.[normalizeSessionName(name)];
}

export function setLocalSession(
  config: ProviderConfig,
  name: string,
  session: LocalSession,
): ProviderConfig {
  const normalized = normalizeProviderConfig(config);
  const sessionName = normalizeSessionName(name);
  const sessions = { ...(normalized.sessions ?? {}) };
  sessions[sessionName] = normalizeLocalSession(session);
  return { ...normalized, sessions };
}

export function removeLocalSession(config: ProviderConfig, name: string): ProviderConfig {
  const normalized = normalizeProviderConfig(config);
  const sessionName = normalizeSessionName(name);
  const sessions = Object.fromEntries(
    Object.entries(normalized.sessions ?? {}).filter(([key]) => key !== sessionName),
  );
  return Object.keys(sessions).length > 0
    ? { ...normalized, sessions }
    : withoutKey(normalized, "sessions");
}

export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("--base must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--base must be an absolute http(s) URL");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function normalizeProviderConfig(raw: unknown): ProviderConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyProviderConfig();
  const input = raw as Partial<ProviderConfig>;
  const providers: Record<string, ProviderProfile> = {};
  if (input.providers && typeof input.providers === "object" && !Array.isArray(input.providers)) {
    for (const [name, value] of Object.entries(input.providers)) {
      if (!value || typeof value !== "object") continue;
      const provider = value as Partial<ProviderProfile>;
      if (typeof provider.baseUrl !== "string") continue;
      const normalizedName = normalizeProviderName(provider.name ?? name);
      providers[normalizedName] = {
        name: normalizedName,
        baseUrl: normalizeBaseUrl(provider.baseUrl),
      };
    }
  }
  const defaultProvider =
    typeof input.defaultProvider === "string"
      ? normalizeProviderName(input.defaultProvider)
      : undefined;
  const setupMode = input.setupMode === "join_only" ? "join_only" : undefined;
  const rooms = normalizeRooms(input.rooms);
  const sessions = normalizeLocalSessions(input.sessions);
  return {
    ...(setupMode ? { setupMode } : {}),
    ...(defaultProvider ? { defaultProvider } : {}),
    ...(normalizeRoomContextOrUndefined(input.currentRoom) ?? {}),
    ...(Object.keys(rooms).length > 0 ? { rooms } : {}),
    ...(normalizeProfileOrUndefined(input.profile) ?? {}),
    ...(normalizeHostedCredentialOrUndefined(input.auth) ?? {}),
    ...(Object.keys(sessions).length > 0 ? { sessions } : {}),
    providers,
  };
}

function readProviderConfigFile(path: string): ProviderConfig {
  try {
    return normalizeProviderConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return emptyProviderConfig();
    }
    throw err;
  }
}

function assertSelectedPersona(
  config: ProviderConfig,
  selection: PersonaSelection | null,
  configPath: string,
): void {
  if (!selection || config.sessions?.[selection.name]) return;
  if (selection.source === "workspace") {
    throw new Error(
      `workspace persona "${selection.name}" from ${selection.markerPath} does not exist in ${configPath}; run \`grp persona init ${selection.name}\` from that workspace`,
    );
  }
  throw new Error(
    `unknown local persona "${selection.name}" selected by ${selection.source}; create it with \`grp session create ${selection.name}\``,
  );
}

function withLocalSession(config: ProviderConfig, sessionName: string | undefined): ProviderConfig {
  if (!sessionName) return config;
  const session = config.sessions?.[sessionName];
  const { currentRoom: _currentRoom, rooms: _rooms, profile: _profile, ...rest } = config;
  return {
    ...rest,
    ...(session?.currentRoom ? { currentRoom: session.currentRoom } : {}),
    ...(session?.rooms ? { rooms: session.rooms } : {}),
    ...(session?.profile ? { profile: session.profile } : {}),
  };
}

function mergeLocalSessionConfig(
  existing: ProviderConfig,
  overlay: ProviderConfig,
  sessionName: string,
): ProviderConfig {
  const session = normalizeLocalSession({
    ...(overlay.currentRoom ? { currentRoom: overlay.currentRoom } : {}),
    ...(overlay.rooms ? { rooms: overlay.rooms } : {}),
    ...(overlay.profile ? { profile: overlay.profile } : {}),
  });
  const sessions = { ...(existing.sessions ?? {}) };
  sessions[sessionName] = session;
  const {
    setupMode: _existingSetupMode,
    defaultProvider: _existingDefaultProvider,
    auth: _existingAuth,
    ...existingRest
  } = existing;

  const merged: ProviderConfig = {
    ...existingRest,
    providers: overlay.providers,
    ...(overlay.setupMode ? { setupMode: overlay.setupMode } : {}),
    ...(overlay.defaultProvider ? { defaultProvider: overlay.defaultProvider } : {}),
    ...(overlay.auth ? { auth: overlay.auth } : {}),
    sessions,
  };
  return normalizeProviderConfig(merged);
}

function ensurePrivateConfigDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

function withProviderConfigLock<T>(
  configPath: string,
  options: ProviderConfigAccessOptions,
  action: (lease: ExclusiveFileLockLease) => T,
): T {
  return withExclusiveFileLock(
    `${configPath}.lock`,
    options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs },
    action,
  );
}

function writeProviderConfigFileAtomic(path: string, config: ProviderConfig): void {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, path);
    fsyncParentDirectory(path);
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(tempPath, { force: true });
  }
}

function fsyncParentDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dirname(path), "r");
    fsyncSync(fd);
  } catch (err) {
    // Some non-POSIX filesystems do not support syncing a directory handle.
    // The atomic rename and private file mode still apply there.
    if (
      !hasErrorCode(err, "EINVAL") &&
      !hasErrorCode(err, "EISDIR") &&
      !hasErrorCode(err, "EPERM") &&
      !hasErrorCode(err, "ENOTSUP")
    ) {
      throw err;
    }
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function hasErrorCode(err: unknown, code: string): boolean {
  return !!err && typeof err === "object" && "code" in err && err.code === code;
}

function nonEmpty(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

function normalizeLocalSessions(raw: unknown): Record<string, LocalSession> {
  const sessions: Record<string, LocalSession> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return sessions;
  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const normalizedName = normalizeSessionName(name);
    sessions[normalizedName] = normalizeLocalSession(value as Partial<LocalSession>);
  }
  return sessions;
}

function normalizeLocalSession(raw: Partial<LocalSession>): LocalSession {
  const rooms = normalizeRooms(raw.rooms);
  return {
    ...(normalizeRoomContextOrUndefined(raw.currentRoom) ?? {}),
    ...(Object.keys(rooms).length > 0 ? { rooms } : {}),
    ...(normalizeProfileOrUndefined(raw.profile) ?? {}),
  };
}

function normalizeRooms(raw: unknown): Record<string, RoomContext> {
  const rooms: Record<string, RoomContext> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return rooms;
  for (const value of Object.values(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const room = normalizeRoomContext(value as Partial<RoomContext>);
    rooms[roomContextKey(room)] = room;
  }
  return rooms;
}

function normalizeRoomContextOrUndefined(raw: unknown): Pick<ProviderConfig, "currentRoom"> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return { currentRoom: normalizeRoomContext(raw as Partial<RoomContext>) };
}

function normalizeRoomContext(raw: Partial<RoomContext>): RoomContext {
  if (typeof raw.slug !== "string" || raw.slug.trim().length === 0) {
    throw new Error("room context slug is required");
  }
  const provider =
    typeof raw.provider === "string" && raw.provider.trim().length > 0
      ? normalizeProviderName(raw.provider)
      : undefined;
  const baseUrl =
    typeof raw.baseUrl === "string" && raw.baseUrl.trim().length > 0
      ? normalizeBaseUrl(raw.baseUrl)
      : undefined;
  return {
    ...(provider ? { provider } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    slug: raw.slug.trim(),
    ...(typeof raw.token === "string" && raw.token.length > 0 ? { token: raw.token } : {}),
    ...(typeof raw.password === "string" && raw.password.length > 0
      ? { password: raw.password }
      : {}),
    ...(raw.role === "participant" || raw.role === "observer" ? { role: raw.role } : {}),
    ...(typeof raw.participantId === "string" && raw.participantId.trim().length > 0
      ? { participantId: raw.participantId.trim() }
      : {}),
    ...(typeof raw.lastSeenSeq === "number" &&
    Number.isInteger(raw.lastSeenSeq) &&
    raw.lastSeenSeq >= 0
      ? { lastSeenSeq: raw.lastSeenSeq }
      : {}),
  };
}

function roomContextKey(room: RoomContext): string {
  if (room.baseUrl) return `base:${room.baseUrl}|${room.slug}`;
  if (room.provider) return `provider:${room.provider}|${room.slug}`;
  return `room:${room.slug}`;
}

function roomMatches(
  config: ProviderConfig,
  room: RoomContext,
  slug: string,
  baseUrl: string | undefined,
): boolean {
  if (room.slug !== slug) return false;
  if (!baseUrl) return true;
  const roomBaseUrl =
    room.baseUrl ?? (room.provider ? resolveProvider(config, room.provider)?.baseUrl : undefined);
  return !!roomBaseUrl && normalizeBaseUrl(roomBaseUrl) === baseUrl;
}

function mergeRoomContexts(
  remembered: RoomContext | undefined,
  incoming: RoomContext,
): RoomContext {
  if (!remembered) return incoming;
  const merged: Partial<RoomContext> = {
    ...remembered,
    ...incoming,
  };
  const token = incoming.token ?? remembered.token;
  const password = incoming.password ?? remembered.password;
  const baseUrl = incoming.baseUrl ?? remembered.baseUrl;
  const provider = incoming.provider ?? remembered.provider;
  const role = incoming.role ?? remembered.role;
  const participantId = incoming.participantId ?? remembered.participantId;
  // Spec 113 — a read mark only ever moves forward across duplicate contexts.
  const lastSeenSeq =
    incoming.lastSeenSeq !== undefined && remembered.lastSeenSeq !== undefined
      ? Math.max(incoming.lastSeenSeq, remembered.lastSeenSeq)
      : (incoming.lastSeenSeq ?? remembered.lastSeenSeq);
  if (token) merged.token = token;
  if (password) merged.password = password;
  if (baseUrl) merged.baseUrl = baseUrl;
  if (provider) merged.provider = provider;
  if (role) merged.role = role;
  if (participantId) merged.participantId = participantId;
  if (lastSeenSeq !== undefined) merged.lastSeenSeq = lastSeenSeq;
  return normalizeRoomContext(merged);
}

function normalizeProfileOrUndefined(raw: unknown): Pick<ProviderConfig, "profile"> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Partial<CliProfile>;
  if (typeof input.displayName !== "string" || input.displayName.trim().length === 0) return null;
  return { profile: { displayName: normalizeDisplayName(input.displayName) } };
}

function normalizeHostedCredentialOrUndefined(raw: unknown): Pick<ProviderConfig, "auth"> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return { auth: normalizeHostedCredential(raw as Partial<HostedCredential>) };
}

function normalizeHostedCredential(raw: Partial<HostedCredential>): HostedCredential {
  if (typeof raw.baseUrl !== "string" || raw.baseUrl.trim().length === 0) {
    throw new Error("hosted credential baseUrl is required");
  }
  if (typeof raw.accessToken !== "string" || raw.accessToken.trim().length === 0) {
    throw new Error("hosted credential accessToken is required");
  }
  if (typeof raw.mandate !== "string" || raw.mandate.trim().length === 0) {
    throw new Error("hosted credential mandate is required");
  }
  return {
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    accessToken: raw.accessToken.trim(),
    mandate: raw.mandate.trim(),
    ...(typeof raw.publicId === "string" && raw.publicId.trim().length > 0
      ? { publicId: raw.publicId.trim() }
      : {}),
    ...(typeof raw.scope === "string" && raw.scope.trim().length > 0
      ? { scope: raw.scope.trim() }
      : {}),
    ...(raw.resource === null || typeof raw.resource === "string"
      ? { resource: raw.resource }
      : {}),
    savedAt:
      typeof raw.savedAt === "string" && raw.savedAt.trim().length > 0
        ? raw.savedAt
        : new Date().toISOString(),
  };
}

export function normalizeDisplayName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) throw new Error("display name cannot be empty");
  if (name.length > 80) throw new Error("display name must be at most 80 characters");
  return name;
}

export function normalizeSessionName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(name)) {
    throw new Error(
      "session name must be 1-63 chars: lowercase letters, numbers, dots, dashes, or underscores",
    );
  }
  return name;
}

function normalizeProviderName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(name)) {
    throw new Error(
      "provider name must be 1-63 chars: lowercase letters, numbers, dots, dashes, or underscores",
    );
  }
  return name;
}

function withoutKey<T extends object, K extends keyof T>(input: T, key: K): Omit<T, K> {
  const { [key]: _removed, ...rest } = input;
  return rest;
}
