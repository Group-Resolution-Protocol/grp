import {
  clearProfileDisplayName,
  readProviderConfig,
  setProfileDisplayName,
  updateProviderConfig,
} from "./provider-config.js";

export interface ProfileCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
}

export async function runProfileCli(
  argv: string[],
  io: Partial<ProfileCliIo> = {},
): Promise<number> {
  const resolvedIo = resolveIo(io);
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  try {
    switch (command ?? "show") {
      case "show":
        profileShow(flags, resolvedIo);
        return 0;
      case "set-name":
        profileSetName(
          rest.filter((arg) => !arg.startsWith("--")),
          flags,
          resolvedIo,
        );
        return 0;
      case "clear-name":
        profileClearName(flags, resolvedIo);
        return 0;
      case "help":
      case "--help":
      case "-h":
        printProfileHelp(resolvedIo.stdout);
        return 0;
      default:
        resolvedIo.stderr(`unknown profile command: ${command}\n`);
        return 2;
    }
  } catch (err) {
    resolvedIo.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function resolveIo(io: Partial<ProfileCliIo>): ProfileCliIo {
  return {
    stdout: io.stdout ?? ((text) => process.stdout.write(text)),
    stderr: io.stderr ?? ((text) => process.stderr.write(text)),
    env: io.env ?? process.env,
  };
}

function profileShow(flags: Record<string, string>, io: ProfileCliIo): void {
  const config = readProviderConfig(io.env);
  const displayName = config.profile?.displayName ?? null;
  if (isJson(flags)) {
    io.stdout(`${JSON.stringify({ display_name: displayName }, null, 2)}\n`);
    return;
  }
  io.stdout(displayName ? `Display name: ${displayName}\n` : "No default display name set.\n");
}

function profileSetName(
  positionals: string[],
  flags: Record<string, string>,
  io: ProfileCliIo,
): void {
  const displayName = flags.name ?? flags.as ?? positionals.join(" ");
  if (!displayName) throw new Error("display name is required");
  const next = updateProviderConfig(
    (current) => setProfileDisplayName(current, displayName),
    io.env,
  );
  if (isJson(flags)) {
    io.stdout(`${JSON.stringify({ display_name: next.profile?.displayName ?? null }, null, 2)}\n`);
    return;
  }
  io.stdout(`Display name: ${next.profile?.displayName}\n`);
}

function profileClearName(flags: Record<string, string>, io: ProfileCliIo): void {
  const next = updateProviderConfig((current) => clearProfileDisplayName(current), io.env);
  if (isJson(flags)) {
    io.stdout(`${JSON.stringify({ display_name: null }, null, 2)}\n`);
    return;
  }
  io.stdout("Default display name cleared.\n");
}

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw) continue;
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq !== -1) {
      flags[raw.slice(2, eq)] = raw.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[raw.slice(2)] = next;
      i++;
    } else {
      flags[raw.slice(2)] = "true";
    }
  }
  return flags;
}

function isJson(flags: Record<string, string>): boolean {
  return flags.json === "true";
}

function printProfileHelp(write: (text: string) => void): void {
  write(
    `${[
      "Usage: grp profile <command>",
      "",
      "Commands:",
      "  show                 show default display name",
      "  set-name NAME        set default display name for room joins",
      "  clear-name           clear default display name",
      "",
      "Examples:",
      '  grp profile set-name "Alex\'s agent"',
      "  grp join abc123",
      '  grp join abc123 --as "Friday dinner bot"',
    ].join("\n")}\n`,
  );
}
