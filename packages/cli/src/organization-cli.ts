import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join as pathJoin, resolve as pathResolve } from "node:path";
import {
  type LoadedOrganizationManifest,
  type OrganizationManifest,
  type OrganizationPersona,
  type OrganizationRoom,
  loadOrganizationManifest,
  manifestMechanismWarnings,
  resolveManifestFile,
  unsupportedMechanisms,
} from "./organization-manifest.js";
import { runPersonaCli } from "./persona-cli.js";
import { readProviderConfig, updateProviderConfig } from "./provider-config.js";
import { parseRoomArgs, renderJson, runRoomCli } from "./room-cli.js";

interface OrganizationMemberState {
  role: "participant" | "observer";
  joined: boolean;
  participantId?: string;
}

interface OrganizationRoomState {
  id: string;
  slug?: string;
  members: Record<string, OrganizationMemberState>;
}

interface OrganizationState {
  schemaVersion: 1;
  organization: string;
  root: string;
  manifestPath: string;
  manifestHash: string;
  topologyHash: string;
  createdAt: string;
  updatedAt: string;
  phases: {
    personas: boolean;
    packets: boolean;
    repositories: boolean;
    rooms: boolean;
    launchers: boolean;
  };
  personas: string[];
  rooms: Record<string, OrganizationRoomState>;
}

type ExecFile = (
  command: string,
  args: string[],
  options: { cwd?: string; encoding: "utf8"; stdio: ["ignore", "pipe", "pipe"] },
) => string;

export interface OrganizationCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  platform: NodeJS.Platform;
  fetch: typeof fetch;
  now: () => Date;
  execFile: ExecFile;
  openTerminal: (scriptPath: string) => void;
  runPersona: typeof runPersonaCli;
  runRoom: typeof runRoomCli;
}

export async function runOrganizationCli(
  argv: string[],
  io: Partial<OrganizationCliIo> = {},
): Promise<number> {
  const resolvedIo = resolveIo(io);
  const parsed = parseRoomArgs(argv);
  const [command, target] = parsed.positionals;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp(resolvedIo.stdout);
    return 0;
  }
  if (parsed.positionals.length > 2) {
    resolvedIo.stderr(`too many arguments for grp org ${command}\n`);
    return 2;
  }

  try {
    switch (command) {
      case "validate":
        assertOnlyFlags(parsed.flags, new Set(["json", "host"]), "grp org validate");
        await validateCommand(requiredTarget(target, "manifest"), parsed.flags, resolvedIo);
        return 0;
      case "create":
        assertOnlyFlags(parsed.flags, new Set(["output", "dry-run", "json"]), "grp org create");
        await createCommand(
          requiredTarget(target, "manifest"),
          requiredFlag(parsed.flags.output, "--output"),
          parsed.flags,
          resolvedIo,
        );
        return 0;
      case "status":
        assertOnlyFlags(parsed.flags, new Set(["json"]), "grp org status");
        statusCommand(requiredTarget(target, "organization root"), parsed.flags, resolvedIo);
        return 0;
      case "launch":
        assertOnlyFlags(parsed.flags, new Set(["dry-run", "json"]), "grp org launch");
        launchCommand(requiredTarget(target, "organization root"), parsed.flags, resolvedIo);
        return 0;
      default:
        resolvedIo.stderr(`unknown org command: ${command}\n`);
        return 2;
    }
  } catch (error) {
    resolvedIo.stderr(`${errorText(error)}\n`);
    return 1;
  }
}

async function validateCommand(
  manifestPath: string,
  flags: Record<string, string>,
  io: OrganizationCliIo,
): Promise<void> {
  const loaded = loadOrganizationManifest(manifestPath, io.cwd);
  const warnings = manifestMechanismWarnings(loaded.manifest);

  // Spec 174 — discovery-driven mechanism policy. With --host, the host's
  // advertised mechanisms_supported is authoritative and a mismatch is a
  // hard error; offline, unknown mechanisms are warnings only.
  let hostChecked: string | null = null;
  if (flags.host) {
    const base = flags.host.replace(/\/+$/, "");
    const res = await io.fetch(`${base}/.well-known/grp.json`);
    if (!res.ok) {
      throw new Error(`could not read ${base}/.well-known/grp.json (HTTP ${res.status})`);
    }
    const doc = (await res.json()) as { mechanisms_supported?: unknown };
    const supported = Array.isArray(doc.mechanisms_supported)
      ? doc.mechanisms_supported.filter((m): m is string => typeof m === "string")
      : [];
    if (supported.length === 0) {
      throw new Error(
        `${base} discovery document does not advertise mechanisms_supported; cannot verify mechanism support`,
      );
    }
    const offenders = unsupportedMechanisms(loaded.manifest, supported);
    if (offenders.length > 0) {
      throw new Error(
        [
          `host ${base} does not support ${offenders.length} manifest mechanism${offenders.length === 1 ? "" : "s"}:`,
          ...offenders.map((o) => `  room "${o.roomId}": ${o.mechanism}`),
          `supported there: ${supported.join(", ")}`,
        ].join("\n"),
      );
    }
    hostChecked = base;
  }

  const result = {
    ...manifestSummary(loaded),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(hostChecked ? { mechanisms_checked_against: hostChecked } : {}),
  };
  if (flags.json === "true") {
    io.stdout(renderJson(result));
    return;
  }
  io.stdout(
    `${[
      `Organization manifest is valid: ${loaded.manifest.name}`,
      `Personas: ${loaded.manifest.personas.length}`,
      `Rooms: ${loaded.manifest.rooms.length}`,
      `Manifest: ${loaded.path}`,
      ...(hostChecked ? [`Mechanisms: all supported by ${hostChecked}`] : []),
      ...warnings.map((w) => `Warning: ${w}`),
      "",
    ].join("\n")}`,
  );
}

async function createCommand(
  manifestPath: string,
  rawRoot: string,
  flags: Record<string, string>,
  io: OrganizationCliIo,
): Promise<void> {
  assertBooleanFlag(flags["dry-run"], "--dry-run");
  const loaded = loadOrganizationManifest(manifestPath, io.cwd);
  const root = pathResolve(io.cwd, rawRoot);
  const existingState = readStateIfPresent(root);
  assertCreateCompatibility(loaded, root, existingState);
  preflightCreatePaths(loaded, root, existingState !== null);

  if (flags["dry-run"] === "true") {
    const plan = createPlan(loaded, root, existingState);
    if (flags.json === "true") io.stdout(renderJson(plan));
    else io.stdout(renderCreatePlan(plan));
    return;
  }

  ensurePrivateDirectory(root);
  const organizationIo: OrganizationCliIo = {
    ...io,
    env: organizationEnvironment(io.env, root),
  };
  initializeOrganizationProviderConfig(io, organizationIo);

  const personaArgs = [
    "setup",
    root,
    ...loaded.manifest.personas.map((persona) => `${persona.id}=${persona.displayName}`),
    "--json",
  ];
  const personaResult = await captureCommand((stdout, stderr) =>
    organizationIo.runPersona(personaArgs, {
      cwd: organizationIo.cwd,
      env: organizationIo.env,
      stdout,
      stderr,
    }),
  );
  if (personaResult.code !== 0) throw new Error(`persona setup failed: ${personaResult.stderr}`);

  const state = existingState ?? newState(loaded, root, organizationIo.now().toISOString());
  state.phases.personas = true;
  updateStateManifest(state, loaded, organizationIo);
  writeState(root, state);

  writePersonaPackets(loaded, root, existingState !== null);
  state.phases.packets = true;
  updateAndWriteState(root, state, loaded, organizationIo);

  reconcileRepositories(loaded, root, organizationIo);
  state.phases.repositories = true;
  updateAndWriteState(root, state, loaded, organizationIo);

  await reconcileRooms(loaded, root, state, organizationIo);
  state.phases.rooms = true;
  updateAndWriteState(root, state, loaded, organizationIo);

  writeLaunchers(loaded, root, existingState !== null, organizationIo);
  state.phases.launchers = true;
  updateAndWriteState(root, state, loaded, organizationIo);

  const result = stateSummary(state);
  if (flags.json === "true") {
    io.stdout(renderJson(result));
    return;
  }
  io.stdout(
    `${[
      `Organization ready: ${state.organization}`,
      `Root: ${root}`,
      `Personas: ${loaded.manifest.personas.length}`,
      `Rooms: ${loaded.manifest.rooms.length}`,
      "",
      `Inspect: grp org status ${shellQuote(root)}`,
      `Launch once: grp org launch ${shellQuote(root)}`,
      "GRP opens the declared sessions once and exits; it does not supervise them.",
      "",
    ].join("\n")}`,
  );
}

function organizationEnvironment(
  env: Record<string, string | undefined>,
  root: string,
): Record<string, string | undefined> {
  return {
    ...env,
    XDG_CONFIG_HOME: pathJoin(root, ".grp", "config"),
    GRP_SESSION: undefined,
    GRP_CONFIG: undefined,
    GRP_AS_ACTIVE: undefined,
  };
}

function initializeOrganizationProviderConfig(
  sourceIo: OrganizationCliIo,
  organizationIo: OrganizationCliIo,
): void {
  const source = readProviderConfig(sourceIo.env, {
    cwd: sourceIo.cwd,
    scope: "global",
  });
  updateProviderConfig(
    (current) => ({
      ...current,
      ...(!current.defaultProvider && source.defaultProvider
        ? { defaultProvider: source.defaultProvider }
        : {}),
      providers: Object.keys(current.providers).length > 0 ? current.providers : source.providers,
    }),
    organizationIo.env,
    { cwd: organizationIo.cwd, scope: "global" },
  );
}

function statusCommand(
  rawRoot: string,
  flags: Record<string, string>,
  io: OrganizationCliIo,
): void {
  const root = pathResolve(io.cwd, rawRoot);
  const state = readState(root);
  const result = stateSummary(state);
  if (flags.json === "true") {
    io.stdout(renderJson(result));
    return;
  }
  const completed = Object.entries(state.phases)
    .filter(([, done]) => done)
    .map(([phase]) => phase);
  const pending = Object.entries(state.phases)
    .filter(([, done]) => !done)
    .map(([phase]) => phase);
  io.stdout(
    `${[
      `Organization: ${state.organization}`,
      `Root: ${state.root}`,
      `State: ${pending.length === 0 ? "ready" : "incomplete"}`,
      `Completed: ${completed.join(", ") || "none"}`,
      `Pending: ${pending.join(", ") || "none"}`,
      ...Object.values(state.rooms).map(
        (room) =>
          `Room ${room.id}: ${room.slug ?? "not created"}; ${Object.values(room.members).filter((member) => member.joined).length}/${Object.keys(room.members).length} joined`,
      ),
      "",
    ].join("\n")}`,
  );
}

function launchCommand(
  rawRoot: string,
  flags: Record<string, string>,
  io: OrganizationCliIo,
): void {
  assertBooleanFlag(flags["dry-run"], "--dry-run");
  const root = pathResolve(io.cwd, rawRoot);
  const state = readState(root);
  if (!state.phases.launchers) {
    throw new Error("organization launchers are incomplete; rerun grp org create first");
  }
  const launcherDirectory = pathJoin(root, ".grp", "launch");
  const scripts = listLauncherPaths(state, launcherDirectory).filter(isRegularFile);
  if (scripts.length === 0) throw new Error("this organization declares no runtime commands");

  const dryRun = flags["dry-run"] === "true";
  if (!dryRun && io.platform !== "darwin") {
    throw new Error(
      "visible automatic launch currently supports macOS Terminal; use --dry-run and open the listed scripts manually",
    );
  }
  if (!dryRun) {
    for (const script of scripts) io.openTerminal(script);
  }
  const result = {
    organization: state.organization,
    root,
    mode: dryRun ? "dry_run" : "opened_once",
    scripts,
    supervised: false,
  };
  if (flags.json === "true") {
    io.stdout(renderJson(result));
    return;
  }
  io.stdout(
    `${[
      dryRun ? "Would open these visible sessions once:" : "Opened these visible sessions once:",
      ...scripts.map((script) => `  ${script}`),
      "",
      "The launcher has exited. GRP is not monitoring, scheduling, or restarting them.",
      "",
    ].join("\n")}`,
  );
}

function writePersonaPackets(
  loaded: LoadedOrganizationManifest,
  root: string,
  reconciling: boolean,
): void {
  for (const persona of loaded.manifest.personas) {
    const directory = pathJoin(root, persona.id, ".grp", "organization");
    ensurePrivateDirectory(directory);
    for (const [source, destination] of [
      [persona.instructions, "instructions.md"],
      [persona.firstDay, "first-day.md"],
    ] as const) {
      const destinationPath = pathJoin(directory, destination);
      if (!source) {
        if (isRegularFile(destinationPath)) {
          throw new Error(
            `generated packet remains at ${destinationPath} but the manifest no longer declares it; use a new organization root for this change`,
          );
        }
        continue;
      }
      if (!reconciling && pathExists(destinationPath)) {
        throw new Error(`refusing to overwrite existing file: ${destinationPath}`);
      }
      const sourcePath = resolveManifestFile(loaded, source);
      writePrivateAtomic(destinationPath, readFileSync(sourcePath));
    }
  }
}

function reconcileRepositories(
  loaded: LoadedOrganizationManifest,
  root: string,
  io: OrganizationCliIo,
): void {
  const workspace = loaded.manifest.workspace;
  if (!workspace) return;
  const repository = resolveRepository(loaded, workspace.repository);
  for (const persona of loaded.manifest.personas) {
    const destination = pathJoin(root, persona.id, "company");
    if (!pathExists(destination)) {
      io.execFile("git", ["clone", "--", repository, destination], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      continue;
    }
    assertDirectory(destination, `repository destination ${destination}`);
    const gitPath = pathJoin(destination, ".git");
    if (!pathExists(gitPath)) {
      throw new Error(`existing repository destination is not a Git clone: ${destination}`);
    }
    const origin = io
      .execFile("git", ["-C", destination, "remote", "get-url", "origin"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
      .trim();
    if (origin !== repository && origin !== workspace.repository) {
      throw new Error(
        `existing clone has a different origin: ${destination} (${origin} != ${workspace.repository})`,
      );
    }
  }
}

async function reconcileRooms(
  loaded: LoadedOrganizationManifest,
  root: string,
  state: OrganizationState,
  io: OrganizationCliIo,
): Promise<void> {
  for (const room of loaded.manifest.rooms) {
    const roomState = state.rooms[room.id] ?? makeRoomState(room);
    state.rooms[room.id] = roomState;
    const creatorWorkspace = pathJoin(root, room.creator);
    if (!roomState.slug) {
      const create = await runStructuredRoom(
        buildRoomCreateArgs(loaded.manifest, room),
        creatorWorkspace,
        io,
      );
      const slug = stringField(create, "slug");
      if (!slug) throw new Error(`room ${room.id} create response did not include a slug`);
      roomState.slug = slug;
      const creator = roomState.members[room.creator];
      if (creator) {
        creator.joined = true;
        const participantId = stringField(create, "participant_id", "participantId");
        if (participantId) creator.participantId = participantId;
      }
      updateAndWriteState(root, state, loaded, io);
    }

    for (const member of room.members) {
      if (member.persona === room.creator) continue;
      const memberState = roomState.members[member.persona];
      if (!memberState || memberState.joined) continue;
      const persona = loaded.manifest.personas.find((entry) => entry.id === member.persona);
      if (!persona) throw new Error(`unknown persona while joining room: ${member.persona}`);
      const invite = await runStructuredRoom(
        [
          "invite",
          roomState.slug,
          ...organizationHostArgs(loaded.manifest),
          `--name=${persona.displayName}`,
          `--role=${member.role}`,
          "--expected=true",
          "--json",
        ],
        creatorWorkspace,
        io,
      );
      const joinUrl = stringField(invite, "join_url", "joinUrl");
      const inviteToken = stringField(invite, "invite_token", "inviteToken");
      if (!joinUrl || !inviteToken) {
        throw new Error(`room ${room.id} invite response omitted its transient join material`);
      }
      const cleanJoinUrl = withoutUrlInvite(joinUrl);
      const joined = await runStructuredRoom(
        ["join", cleanJoinUrl, `--invite=${inviteToken}`, "--json"],
        pathJoin(root, member.persona),
        io,
      );
      memberState.joined = true;
      const participantId = stringField(joined, "participant_id", "participantId");
      if (participantId) memberState.participantId = participantId;
      updateAndWriteState(root, state, loaded, io);
    }
  }
}

function writeLaunchers(
  loaded: LoadedOrganizationManifest,
  root: string,
  reconciling: boolean,
  io: OrganizationCliIo,
): void {
  const directory = pathJoin(root, ".grp", "launch");
  ensurePrivateDirectory(directory);
  for (const persona of loaded.manifest.personas) {
    const path = pathJoin(directory, `${persona.id}.command`);
    if (!persona.runtime) {
      if (isRegularFile(path)) {
        throw new Error(
          `launcher remains at ${path} but the manifest no longer declares a runtime; use a new organization root for this change`,
        );
      }
      continue;
    }
    if (!reconciling && pathExists(path)) throw new Error(`refusing to overwrite ${path}`);
    const cwd = loaded.manifest.workspace
      ? pathJoin(root, persona.id, "company")
      : pathJoin(root, persona.id);
    const args = [...persona.runtime.args];
    if (persona.runtime.prompt === "first_day") {
      if (!persona.firstDay) {
        throw new Error(`persona ${persona.id} uses prompt: first_day but declares no first_day`);
      }
      const firstDay = pathJoin(root, persona.id, ".grp", "organization", "first-day.md");
      const instructions = persona.instructions
        ? pathJoin(root, persona.id, ".grp", "organization", "instructions.md")
        : null;
      args.push(
        [
          `You are ${persona.displayName} (GRP persona ${persona.id}).`,
          ...(instructions ? [`Read your private instructions at ${instructions}.`] : []),
          `Read your first-day brief at ${firstDay}.`,
          "Use the installed grp command-line client for GRP rooms, and begin.",
          "Do not stop merely because the room is quiet or a watch call returns; keep using grp read and grp watch until your first-day brief's stated stop condition is satisfied. Only then return your final response.",
          "Your final response terminates this one-shot process permanently; a monitor, task, background command, notification, or promised future check cannot resume it.",
          "Never use Monitor, TaskCreate, TaskUpdate, run_in_background, background shell commands, or scheduled tasks to defer work. Keep waiting and acting in this same foreground response with grp read and grp watch. If you started background work, stop it and continue here before returning a final response.",
        ].join(" "),
      );
    }
    const script = [
      "#!/bin/sh",
      "set -eu",
      "unset GRP_SESSION GRP_CONFIG GRP_AS_ACTIVE",
      ...(io.env.XDG_CONFIG_HOME
        ? [`export XDG_CONFIG_HOME=${shellQuote(io.env.XDG_CONFIG_HOME)}`]
        : []),
      `cd ${shellQuote(cwd)}`,
      `exec ${[persona.runtime.command, ...args].map(shellQuote).join(" ")}`,
      "",
    ].join("\n");
    writePrivateAtomic(path, Buffer.from(script), 0o700);
  }
}

function buildRoomCreateArgs(manifest: OrganizationManifest, room: OrganizationRoom): string[] {
  const args = [
    "create",
    `--about=${room.about}`,
    `--type=${room.type}`,
    `--mechanism=${room.mechanism}`,
    "--json",
    ...organizationHostArgs(manifest),
  ];
  // An organization manifest declares a closed seat roster and the creator
  // provisions a named invite for every member. Default those rooms to true
  // Private admission; authors can still opt into Public or Unlisted.
  args.push(`--visibility=${room.visibility ?? "private"}`);
  for (const [key, value] of Object.entries(room.settings)) {
    if (value === null) continue;
    args.push(`--${key.replaceAll("_", "-")}=${String(value)}`);
  }
  return args;
}

function organizationHostArgs(manifest: OrganizationManifest): string[] {
  if (manifest.host) return [`--host=${manifest.host}`];
  if (manifest.baseUrl) return [`--base=${manifest.baseUrl}`];
  return [];
}

async function runStructuredRoom(
  argv: string[],
  cwd: string,
  io: OrganizationCliIo,
): Promise<Record<string, unknown>> {
  const result = await captureCommand((stdout, stderr) =>
    io.runRoom(argv, {
      cwd,
      env: { ...io.env, GRP_NO_INPUT: "1" },
      fetch: io.fetch,
      isInteractive: false,
      stdout,
      stderr,
    }),
  );
  if (result.code !== 0) {
    throw new Error(`grp ${argv[0]} failed: ${result.stderr || result.stdout}`.trim());
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`grp ${argv[0]} returned invalid structured output`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`grp ${argv[0]} returned non-object structured output`);
  }
  return parsed as Record<string, unknown>;
}

async function captureCommand(
  run: (stdout: (text: string) => void, stderr: (text: string) => void) => Promise<number>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await run(
    (text) => {
      stdout += text;
    },
    (text) => {
      stderr += text;
    },
  );
  return { code, stdout, stderr };
}

function newState(
  loaded: LoadedOrganizationManifest,
  root: string,
  now: string,
): OrganizationState {
  return {
    schemaVersion: 1,
    organization: loaded.manifest.name,
    root,
    manifestPath: loaded.path,
    manifestHash: loaded.manifestHash,
    topologyHash: loaded.topologyHash,
    createdAt: now,
    updatedAt: now,
    phases: {
      personas: false,
      packets: false,
      repositories: false,
      rooms: false,
      launchers: false,
    },
    personas: loaded.manifest.personas.map((persona) => persona.id),
    rooms: Object.fromEntries(loaded.manifest.rooms.map((room) => [room.id, makeRoomState(room)])),
  };
}

function makeRoomState(room: OrganizationRoom): OrganizationRoomState {
  return {
    id: room.id,
    members: Object.fromEntries(
      room.members.map((member) => [
        member.persona,
        {
          role: member.role,
          joined: false,
        },
      ]),
    ),
  };
}

function updateStateManifest(
  state: OrganizationState,
  loaded: LoadedOrganizationManifest,
  io: OrganizationCliIo,
): void {
  state.manifestPath = loaded.path;
  state.manifestHash = loaded.manifestHash;
  state.updatedAt = io.now().toISOString();
}

function updateAndWriteState(
  root: string,
  state: OrganizationState,
  loaded: LoadedOrganizationManifest,
  io: OrganizationCliIo,
): void {
  updateStateManifest(state, loaded, io);
  writeState(root, state);
}

function writeState(root: string, state: OrganizationState): void {
  const directory = pathJoin(root, ".grp");
  ensurePrivateDirectory(directory);
  writePrivateAtomic(
    pathJoin(directory, "organization.json"),
    Buffer.from(`${JSON.stringify(state, null, 2)}\n`),
  );
}

function readStateIfPresent(root: string): OrganizationState | null {
  const path = pathJoin(root, ".grp", "organization.json");
  if (!pathExists(path)) return null;
  return readState(root);
}

function readState(root: string): OrganizationState {
  const path = pathJoin(root, ".grp", "organization.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read organization state at ${path}: ${errorText(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`organization state is malformed at ${path}`);
  }
  const state = parsed as OrganizationState;
  if (
    state.schemaVersion !== 1 ||
    typeof state.topologyHash !== "string" ||
    !Array.isArray(state.personas)
  ) {
    throw new Error(`organization state has an unsupported schema at ${path}`);
  }
  return state;
}

function assertCreateCompatibility(
  loaded: LoadedOrganizationManifest,
  root: string,
  state: OrganizationState | null,
): void {
  if (!state) return;
  if (state.root !== root) throw new Error("organization state belongs to a different root");
  if (state.organization !== loaded.manifest.name) {
    throw new Error(
      `organization root belongs to "${state.organization}", not "${loaded.manifest.name}"`,
    );
  }
  if (state.topologyHash !== loaded.topologyHash) {
    throw new Error(
      "organization topology changed after creation; use a new --output root for the changed manifest",
    );
  }
}

function preflightCreatePaths(
  loaded: LoadedOrganizationManifest,
  root: string,
  reconciling: boolean,
): void {
  if (pathExists(root)) assertDirectory(root, `organization root ${root}`);
  for (const persona of loaded.manifest.personas) {
    const workspace = pathJoin(root, persona.id);
    if (pathExists(workspace)) assertDirectory(workspace, `persona workspace ${workspace}`);
    const generated = pathJoin(workspace, ".grp", "organization");
    if (pathExists(generated))
      assertDirectory(generated, `generated packet directory ${generated}`);
    if (!reconciling) {
      for (const name of ["instructions.md", "first-day.md"]) {
        const generatedFile = pathJoin(generated, name);
        if (pathExists(generatedFile)) {
          throw new Error(`refusing to overwrite existing file: ${generatedFile}`);
        }
      }
      const launcher = pathJoin(root, ".grp", "launch", `${persona.id}.command`);
      if (pathExists(launcher)) throw new Error(`refusing to overwrite ${launcher}`);
    }
    if (loaded.manifest.workspace) {
      const repository = pathJoin(workspace, "company");
      if (pathExists(repository))
        assertDirectory(repository, `repository destination ${repository}`);
      if (!reconciling && pathExists(repository)) {
        throw new Error(
          `repository destination already exists without organization state: ${repository}`,
        );
      }
    }
  }
  const metadata = pathJoin(root, ".grp");
  if (pathExists(metadata)) assertDirectory(metadata, `organization metadata ${metadata}`);
  const statePath = pathJoin(metadata, "organization.json");
  if (!reconciling && pathExists(statePath)) {
    throw new Error(`organization state already exists: ${statePath}`);
  }
}

function createPlan(
  loaded: LoadedOrganizationManifest,
  root: string,
  state: OrganizationState | null,
): Record<string, unknown> {
  return {
    mode: "dry_run",
    organization: loaded.manifest.name,
    manifest: loaded.path,
    root,
    reconcile: state !== null,
    personas: loaded.manifest.personas.map((persona) => ({
      id: persona.id,
      workspace: pathJoin(root, persona.id),
      repository: loaded.manifest.workspace ? pathJoin(root, persona.id, "company") : null,
      launcher: persona.runtime ? pathJoin(root, ".grp", "launch", `${persona.id}.command`) : null,
    })),
    rooms: loaded.manifest.rooms.map((room) => ({
      id: room.id,
      creator: room.creator,
      members: room.members,
    })),
    mutates: false,
    launches: false,
  };
}

function renderCreatePlan(plan: Record<string, unknown>): string {
  const personas = Array.isArray(plan.personas) ? plan.personas : [];
  const rooms = Array.isArray(plan.rooms) ? plan.rooms : [];
  return `${[
    `Organization plan is valid: ${String(plan.organization)}`,
    `Root: ${String(plan.root)}`,
    `Personas: ${personas.length}`,
    `Rooms: ${rooms.length}`,
    "",
    "Dry run only: no files, config, Git repository, room, or runtime was changed.",
    "",
  ].join("\n")}`;
}

function manifestSummary(loaded: LoadedOrganizationManifest): Record<string, unknown> {
  return {
    valid: true,
    version: loaded.manifest.version,
    organization: loaded.manifest.name,
    manifest: loaded.path,
    manifest_sha256: loaded.manifestHash,
    topology_sha256: loaded.topologyHash,
    personas: loaded.manifest.personas.map((persona) => persona.id),
    rooms: loaded.manifest.rooms.map((room) => room.id),
  };
}

function stateSummary(state: OrganizationState): Record<string, unknown> {
  const rooms = Object.values(state.rooms).map((room) => ({
    id: room.id,
    slug: room.slug ?? null,
    joined: Object.values(room.members).filter((member) => member.joined).length,
    expected: Object.keys(room.members).length,
  }));
  return {
    organization: state.organization,
    root: state.root,
    ready: Object.values(state.phases).every(Boolean),
    phases: state.phases,
    rooms,
    manifest_sha256: state.manifestHash,
    topology_sha256: state.topologyHash,
    updated_at: state.updatedAt,
  };
}

function resolveRepository(loaded: LoadedOrganizationManifest, repository: string): string {
  if (repository.startsWith("./") || repository.startsWith("../") || repository.startsWith("/")) {
    return pathResolve(loaded.directory, repository);
  }
  return repository;
}

function withoutUrlInvite(raw: string): string {
  const url = new URL(raw);
  url.searchParams.delete("invite");
  return url.toString();
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return null;
}

function listLauncherPaths(state: OrganizationState, directory: string): string[] {
  return [...state.personas].sort().map((name) => pathJoin(directory, `${name}.command`));
}

function ensurePrivateDirectory(path: string): void {
  if (pathExists(path)) {
    assertDirectory(path, `private directory ${path}`);
    chmodSync(path, 0o700);
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writePrivateAtomic(path: string, content: Buffer, mode = 0o600): void {
  ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode });
    renameSync(temporary, path);
    chmodSync(path, mode);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function assertDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink directory`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function assertOnlyFlags(
  flags: Record<string, string>,
  allowed: Set<string>,
  command: string,
): void {
  const unknown = Object.keys(flags).filter((flag) => !allowed.has(flag));
  if (unknown.length > 0) throw new Error(`${command}: unknown flag --${unknown[0]}`);
}

function assertBooleanFlag(raw: string | undefined, flag: string): void {
  if (raw !== undefined && raw !== "true" && raw !== "false") {
    throw new Error(`${flag} must be true or false`);
  }
}

function requiredTarget(raw: string | undefined, label: string): string {
  if (!raw) throw new Error(`${label} is required`);
  return raw;
}

function requiredFlag(raw: string | undefined, flag: string): string {
  if (!raw || raw === "true") throw new Error(`${flag} requires a value`);
  return raw;
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === code,
  );
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const candidate = error as { message?: unknown; stderr?: unknown };
  const stderr =
    typeof candidate.stderr === "string"
      ? candidate.stderr
      : Buffer.isBuffer(candidate.stderr)
        ? candidate.stderr.toString("utf8")
        : "";
  return (
    stderr || (typeof candidate.message === "string" ? candidate.message : String(error))
  ).trim();
}

function printHelp(write: (text: string) => void): void {
  write(
    `${[
      "Usage: grp org <command> [options]",
      "",
      "Create a local multi-persona organization from a structured manifest.",
      "",
      "Commands:",
      "  validate MANIFEST [--host=URL] validate YAML or JSON without mutation; with --host,",
      "                                 check mechanisms against the host's discovery document",
      "  create MANIFEST --output=ROOT  create or resume personas, rooms, and launchers",
      "  status ROOT                    show deterministic local create state",
      "  launch ROOT                    open each declared visible session once",
      "",
      "Flags:",
      "  --dry-run   plan create or launch without mutation",
      "  --json      structured output",
      "",
      "GRP instantiates the structure you declare. It does not invent, schedule,",
      "supervise, coach, restart, or grade the organization.",
      "",
    ].join("\n")}`,
  );
}

function resolveIo(io: Partial<OrganizationCliIo>): OrganizationCliIo {
  return {
    stdout: io.stdout ?? ((text) => process.stdout.write(text)),
    stderr: io.stderr ?? ((text) => process.stderr.write(text)),
    env: io.env ?? process.env,
    cwd: pathResolve(io.cwd ?? process.cwd()),
    platform: io.platform ?? process.platform,
    fetch: io.fetch ?? fetch,
    now: io.now ?? (() => new Date()),
    execFile:
      io.execFile ??
      ((command, args, options) =>
        execFileSync(command, args, {
          cwd: options.cwd,
          encoding: options.encoding,
          stdio: options.stdio,
        })),
    openTerminal:
      io.openTerminal ??
      ((scriptPath) => {
        execFileSync("open", ["-a", "Terminal", scriptPath], {
          stdio: ["ignore", "ignore", "pipe"],
        });
      }),
    runPersona: io.runPersona ?? runPersonaCli,
    runRoom: io.runRoom ?? runRoomCli,
  };
}
