import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  join as pathJoin,
  relative as pathRelative,
  resolve as pathResolve,
} from "node:path";
import {
  type ExclusiveFileLockLease,
  assertExclusiveFileLock,
  withExclusiveFileLock,
} from "./exclusive-file-lock.js";
import {
  type LocalSession,
  normalizeDisplayName,
  normalizeSessionName,
  providerConfigPath,
  readProviderConfig,
  renderPersonaIdentity,
  resolveLocalSession,
  resolvePersonaContext,
  setLocalSession,
  updateProviderConfig,
} from "./provider-config.js";
import { parseRoomArgs, renderJson } from "./room-cli.js";

export interface PersonaCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
}

interface PersonaBinding {
  name: string;
  requestedDisplayName: string | undefined;
  defaultDisplayName: string;
  workspace: string;
  markerPath: string;
}

interface GitMarkerProtection {
  markerPath: string;
  excludePath: string;
}

export async function runPersonaCli(
  argv: string[],
  io: Partial<PersonaCliIo> = {},
): Promise<number> {
  const resolvedIo = resolveIo(io);
  const parsed = parseRoomArgs(argv);
  const [command, ...positionals] = parsed.positionals;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printPersonaHelp(resolvedIo.stdout);
    return 0;
  }

  try {
    switch (command) {
      case "init":
        if (parsed.flags.help === "true" || parsed.flags.h === "true") {
          printPersonaHelp(resolvedIo.stdout);
          return 0;
        }
        personaInit(positionals[0], parsed.flags, resolvedIo);
        return 0;
      case "setup":
        if (parsed.flags.help === "true" || parsed.flags.h === "true") {
          printPersonaSetupHelp(resolvedIo.stdout);
          return 0;
        }
        personaSetup(positionals, parsed.flags, resolvedIo);
        return 0;
      case "show":
        personaShow(parsed.flags, resolvedIo);
        return 0;
      default:
        resolvedIo.stderr(`unknown persona command: ${command}\n`);
        return 2;
    }
  } catch (err) {
    resolvedIo.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function personaInit(
  rawName: string | undefined,
  flags: Record<string, string>,
  io: PersonaCliIo,
): void {
  if (!rawName) throw new Error("persona name is required");
  assertNoPersonaOverride(io.env);
  const name = normalizeSessionName(rawName);
  const markerPath = pathJoin(io.cwd, ".grp", "persona");
  const binding = {
    name,
    requestedDisplayName: flags.name ? normalizeDisplayName(flags.name) : undefined,
    defaultDisplayName: normalizeDisplayName(name),
    workspace: io.cwd,
    markerPath,
  };
  const config = initializePersonaBindings([binding], flags.force === "true", io);
  const session = resolveLocalSession(config, name);
  const resolvedDisplayName = session?.profile?.displayName ?? name;

  if (flags.json === "true") {
    io.stdout(
      renderJson({
        persona: name,
        display_name: resolvedDisplayName,
        marker_path: markerPath,
        config_path: providerConfigPath(io.env),
      }),
    );
  } else {
    io.stdout(
      `${[
        `You are ${resolvedDisplayName} here (persona: ${name}).`,
        `Marker: ${markerPath}`,
        `Config: ${providerConfigPath(io.env)}`,
        "",
      ].join("\n")}`,
    );
  }
}

function personaSetup(
  positionals: string[],
  flags: Record<string, string>,
  io: PersonaCliIo,
): void {
  assertOnlyFlags(flags, new Set(["json"]), "grp persona setup");
  assertNoPersonaOverride(io.env);
  const [rawRoot, ...rawMembers] = positionals;
  if (!rawRoot) {
    throw new Error("workspace root is required: grp persona setup ROOT PERSONA...");
  }
  if (rawMembers.length === 0) {
    throw new Error("at least one persona is required: grp persona setup ROOT PERSONA...");
  }

  const root = pathResolve(io.cwd, rawRoot);
  const members = parsePersonaSetupMembers(rawMembers, root);
  ensureWorkspaceDirectory(root);
  for (const member of members) ensureWorkspaceDirectory(member.workspace);

  const config = initializePersonaBindings(members, false, io);
  const personas = members.map((member) => ({
    persona: member.name,
    display_name:
      resolveLocalSession(config, member.name)?.profile?.displayName ??
      member.requestedDisplayName ??
      member.defaultDisplayName,
    workspace: member.workspace,
    marker_path: member.markerPath,
  }));

  if (flags.json === "true") {
    io.stdout(
      renderJson({
        root,
        config_path: providerConfigPath(io.env),
        personas,
      }),
    );
    return;
  }

  io.stdout(
    `${[
      `Persona workspaces ready: ${root}`,
      "",
      ...personas.map(
        (persona) => `  ${persona.display_name} (${persona.persona}) — ${persona.workspace}`,
      ),
      "",
      "Open one terminal in each workspace and start your interactive agent there.",
      "The directory selects the identity; GRP does not launch or supervise it.",
      "",
    ].join("\n")}`,
  );
}

function parsePersonaSetupMembers(rawMembers: string[], root: string): PersonaBinding[] {
  const seen = new Set<string>();
  return rawMembers.map((rawMember) => {
    const separator = rawMember.indexOf("=");
    const rawName = separator === -1 ? rawMember : rawMember.slice(0, separator);
    const name = normalizeSessionName(rawName);
    if (seen.has(name)) throw new Error(`duplicate persona in setup: "${name}"`);
    seen.add(name);
    const requestedDisplayName =
      separator === -1
        ? humanizePersonaName(name)
        : normalizeDisplayName(rawMember.slice(separator + 1));
    const workspace = pathJoin(root, name);
    return {
      name,
      requestedDisplayName,
      defaultDisplayName: requestedDisplayName,
      workspace,
      markerPath: pathJoin(workspace, ".grp", "persona"),
    };
  });
}

function humanizePersonaName(name: string): string {
  return name
    .split(/[._-]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function initializePersonaBindings(
  bindings: PersonaBinding[],
  force: boolean,
  io: PersonaCliIo,
): ReturnType<typeof updateProviderConfig> {
  for (const binding of bindings) ensurePersonaDirectory(binding.markerPath);
  const lockOrder = [...bindings].sort((a, b) => a.markerPath.localeCompare(b.markerPath));
  return withPersonaMarkerLocks(lockOrder, (leases) => {
    for (const binding of bindings) {
      let existingMarker: string | null;
      try {
        existingMarker = readLocalMarker(binding.markerPath);
      } catch (err) {
        if (force && isRegularFile(binding.markerPath)) existingMarker = null;
        else throw err;
      }
      if (existingMarker && existingMarker !== binding.name && !force) {
        if (bindings.length === 1) {
          throw new Error(
            `this directory is already bound to persona "${existingMarker}"; rerun with --force to bind it to "${binding.name}"`,
          );
        }
        throw new Error(
          `workspace ${binding.workspace} is already bound to persona "${existingMarker}"; repair that workspace explicitly with \`grp persona init ${binding.name} --force\` before rerunning setup`,
        );
      }
    }

    const gitProtections = bindings
      .map((binding) => inspectGitMarkerProtection(binding.workspace, binding.markerPath))
      .filter((protection): protection is GitMarkerProtection => protection !== null);
    for (const protection of gitProtections) applyGitMarkerProtection(protection);

    const config = updateProviderConfig(
      (current) => {
        let updated = current;
        for (const binding of bindings) {
          const existing = resolveLocalSession(updated, binding.name);
          const displayName =
            binding.requestedDisplayName ??
            existing?.profile?.displayName ??
            binding.defaultDisplayName;
          const session: LocalSession = {
            ...(existing ?? {}),
            profile: { displayName },
          };
          updated = setLocalSession(updated, binding.name, session);
        }
        return updated;
      },
      io.env,
      { cwd: io.cwd, scope: "global" },
    );
    for (const lease of leases) assertExclusiveFileLock(lease);
    for (const binding of bindings) writePersonaMarker(binding.markerPath, binding.name);
    return config;
  });
}

function withPersonaMarkerLocks<T>(
  bindings: PersonaBinding[],
  action: (leases: ExclusiveFileLockLease[]) => T,
  index = 0,
  leases: ExclusiveFileLockLease[] = [],
): T {
  const binding = bindings[index];
  if (!binding) return action(leases);
  return withExclusiveFileLock(`${binding.markerPath}.lock`, {}, (lease) =>
    withPersonaMarkerLocks(bindings, action, index + 1, [...leases, lease]),
  );
}

function personaShow(flags: Record<string, string>, io: PersonaCliIo): void {
  const context = resolvePersonaContext(io.env, { cwd: io.cwd });
  const config = readProviderConfig(io.env, { cwd: io.cwd });
  const source = context?.source ?? (nonEmpty(io.env.GRP_CONFIG) ? "GRP_CONFIG" : "global");
  const displayName = context?.displayName ?? config.profile?.displayName ?? null;
  const currentRoom = context?.currentRoom ?? config.currentRoom ?? null;
  const rendered = {
    persona: context?.name ?? null,
    display_name: displayName,
    source,
    marker_path: context?.markerPath ?? null,
    current_room: currentRoom?.slug ?? null,
    config_path: providerConfigPath(io.env),
  };

  if (flags.json === "true") {
    io.stdout(renderJson(rendered));
    return;
  }
  const lines = context
    ? [
        renderPersonaIdentity(context),
        `Source: ${formatSource(context.source, context.markerPath)}`,
        `Current room: ${currentRoom?.slug ?? "none"}`,
        `Config: ${rendered.config_path}`,
      ]
    : [
        "No named persona is active here.",
        `Source: ${source === "GRP_CONFIG" ? "explicit GRP_CONFIG bundle" : "global config"}`,
        `Display name: ${displayName ?? "none"}`,
        `Current room: ${currentRoom?.slug ?? "none"}`,
        `Config: ${rendered.config_path}`,
        "",
        "Create a sticky workspace identity with: grp persona init NAME",
      ];
  io.stdout(`${lines.join("\n")}\n`);
}

function assertNoPersonaOverride(env: Record<string, string | undefined>): void {
  for (const key of ["GRP_SESSION", "GRP_CONFIG"] as const) {
    if (nonEmpty(env[key])) {
      throw new Error(
        `${key} overrides workspace personas; unset it before running \`grp persona init\``,
      );
    }
  }
}

function readLocalMarker(markerPath: string): string | null {
  try {
    const stat = lstatSync(markerPath);
    if (!stat.isFile()) throw personaMarkerError(markerPath, "marker is not a regular file");
    const contents = readFileSync(markerPath, "utf8");
    const raw = contents.trim();
    if (!raw) throw personaMarkerError(markerPath, "marker is empty");
    let name: string;
    try {
      name = normalizeSessionName(raw);
    } catch (err) {
      throw personaMarkerError(
        markerPath,
        `marker is invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (contents !== `${name}\n`) {
      throw personaMarkerError(markerPath, `marker is invalid: expected exactly "${name}\\n"`);
    }
    return name;
  } catch (err) {
    if (hasErrorCode(err, "ENOENT") || hasErrorCode(err, "ENOTDIR")) return null;
    throw err;
  }
}

function personaMarkerError(markerPath: string, reason: string): Error {
  return new Error(
    `invalid workspace persona marker at ${markerPath}: ${reason}. Repair with \`grp persona init NAME --force\``,
  );
}

function writePersonaMarker(markerPath: string, name: string): void {
  ensurePersonaDirectory(markerPath);
  const tempPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${name}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(tempPath, markerPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function ensurePersonaDirectory(markerPath: string): void {
  const directory = dirname(markerPath);
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`workspace persona directory is not a regular directory: ${directory}`);
    }
  } catch (err) {
    if (!hasErrorCode(err, "ENOENT")) throw err;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

function ensureWorkspaceDirectory(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`persona workspace path is not a regular directory: ${path}`);
    }
  } catch (err) {
    if (!hasErrorCode(err, "ENOENT")) throw err;
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Validate the local Git boundary before any persona config or marker commit. */
function inspectGitMarkerProtection(cwd: string, markerPath: string): GitMarkerProtection | null {
  let repoRoot: string;
  try {
    repoRoot = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    if (commandErrorText(err).includes("not a git repository")) return null;
    throw new Error(
      `cannot verify Git-local protection for ${markerPath}: ${commandErrorText(err)}`,
    );
  }

  repoRoot = realpathSync(repoRoot);
  const canonicalMarker = pathJoin(realpathSync(dirname(markerPath)), basename(markerPath));
  const relativeMarker = pathRelative(repoRoot, canonicalMarker);
  const tracked = execFileSync("git", ["-C", repoRoot, "ls-files", "--", relativeMarker], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (tracked) {
    throw new Error(
      `workspace persona marker is already tracked by Git: ${markerPath}; remove it from the index before initializing (git rm --cached ${relativeMarker})`,
    );
  }

  const rawExcludePath = execFileSync(
    "git",
    ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  if (!rawExcludePath) {
    throw new Error(`cannot locate Git's local exclude file for ${markerPath}`);
  }
  const excludePath = pathResolve(repoRoot, rawExcludePath);
  return { markerPath, excludePath };
}

/** Keep a machine-local binding out of commits without changing tracked files. */
function applyGitMarkerProtection(protection: GitMarkerProtection): void {
  const { markerPath, excludePath } = protection;
  mkdirSync(dirname(excludePath), { recursive: true, mode: 0o700 });
  const pattern = "**/.grp/persona";
  try {
    let existing = "";
    try {
      existing = readFileSync(excludePath, "utf8");
    } catch (err) {
      if (!hasErrorCode(err, "ENOENT")) throw err;
    }
    if (existing.split(/\r?\n/).includes(pattern)) return;
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(excludePath, `${separator}${pattern}\n`, "utf8");
  } catch (err) {
    throw new Error(
      `cannot protect workspace persona marker in Git's local exclude file ${excludePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function commandErrorText(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const candidate = err as { message?: unknown; stderr?: unknown };
  const stderr =
    typeof candidate.stderr === "string"
      ? candidate.stderr
      : Buffer.isBuffer(candidate.stderr)
        ? candidate.stderr.toString("utf8")
        : "";
  return (
    stderr || (typeof candidate.message === "string" ? candidate.message : String(err))
  ).trim();
}

function formatSource(source: string, markerPath?: string): string {
  if (source === "workspace") return `workspace marker ${markerPath ?? ""}`.trim();
  return source;
}

function resolveIo(io: Partial<PersonaCliIo>): PersonaCliIo {
  return {
    stdout: io.stdout ?? ((text) => process.stdout.write(text)),
    stderr: io.stderr ?? ((text) => process.stderr.write(text)),
    env: io.env ?? process.env,
    cwd: pathResolve(io.cwd ?? process.cwd()),
  };
}

function nonEmpty(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

function assertOnlyFlags(
  flags: Record<string, string>,
  allowed: Set<string>,
  command: string,
): void {
  const unknown = Object.keys(flags).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`unknown ${command} option: --${unknown}`);
}

function hasErrorCode(err: unknown, code: string): boolean {
  return !!err && typeof err === "object" && "code" in err && err.code === code;
}

function printPersonaHelp(write: (text: string) => void): void {
  write(
    `${[
      "Usage: grp persona <command>",
      "",
      "Bind one local GRP identity to this directory and every directory below it.",
      "",
      "Commands:",
      "  init NAME [--name DISPLAY] [--force]  create/reuse and bind a persona here",
      "  setup ROOT PERSONA[=DISPLAY]...       create a local team of workspaces",
      "  show [--json]                         show the identity resolved here",
      "",
      "Explicit cross-persona command:",
      "  grp as NAME <command>",
      "",
      'Example: grp persona init silica --name "Silica"',
      '         grp persona setup ./company "silica=Editorial Director" cobalt',
      "",
      "Personas prevent accidental mix-ups; they are not a security boundary between mutually distrustful processes sharing one OS user.",
      "",
    ].join("\n")}`,
  );
}

function printPersonaSetupHelp(write: (text: string) => void): void {
  write(
    `${[
      "Usage: grp persona setup ROOT PERSONA[=DISPLAY_NAME]... [--json]",
      "",
      "Create one workspace per persona and register them in the ordinary shared GRP config.",
      "",
      "Example:",
      '  grp persona setup ./company "silica=Editorial Director" "cobalt=Finance Lead"',
      "",
      "Open one terminal in each resulting directory and start your interactive agent there.",
      "GRP creates identities and workspaces; it does not launch or supervise agents.",
      "",
    ].join("\n")}`,
  );
}
