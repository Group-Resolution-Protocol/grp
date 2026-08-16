import {
  listLocalSessions,
  normalizeDisplayName,
  normalizeSessionName,
  readProviderConfig,
  removeLocalSession,
  resolveLocalSession,
  setLocalSession,
  updateProviderConfig,
} from "./provider-config.js";
import { parseRoomArgs, renderJson } from "./room-cli.js";

export interface SessionCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
}

export async function runSessionCli(
  argv: string[],
  io: Partial<SessionCliIo> = {},
): Promise<number> {
  const resolvedIo = resolveIo(io);
  const parsed = parseRoomArgs(argv);
  const [command, name] = parsed.positionals;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printSessionHelp(resolvedIo.stdout);
    return 0;
  }

  try {
    switch (command) {
      case "create":
        sessionCreate(name, parsed.flags, resolvedIo);
        return 0;
      case "list":
        sessionList(parsed.flags, resolvedIo);
        return 0;
      case "show":
        sessionShow(name, parsed.flags, resolvedIo);
        return 0;
      case "remove":
      case "delete":
        sessionRemove(name, parsed.flags, resolvedIo);
        return 0;
      default:
        resolvedIo.stderr(`unknown session command: ${command}\n`);
        return 2;
    }
  } catch (err) {
    resolvedIo.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function sessionCreate(
  rawName: string | undefined,
  flags: Record<string, string>,
  io: SessionCliIo,
): void {
  if (!rawName) throw new Error("session name is required");
  const name = normalizeSessionName(rawName);
  const displayName = normalizeDisplayName(flags.name ?? flags.as ?? flags["display-name"] ?? name);
  const config = updateProviderConfig(
    (current) =>
      setLocalSession(current, name, {
        profile: { displayName },
      }),
    io.env,
    { scope: "global" },
  );
  const session = resolveLocalSession(config, name);
  if (isJson(flags)) {
    io.stdout(renderJson(renderSession(name, session)));
    return;
  }
  io.stdout(
    [
      `session ${name} created`,
      `Display name: ${displayName}`,
      "",
      "Use:",
      `  grp as ${name} <command>`,
      "",
    ].join("\n"),
  );
}

function sessionList(flags: Record<string, string>, io: SessionCliIo): void {
  const sessions = listLocalSessions(readProviderConfig(io.env, { scope: "global" })).map(
    (session) => renderSession(session.name, session),
  );
  if (isJson(flags)) {
    io.stdout(renderJson({ sessions }));
    return;
  }
  if (sessions.length === 0) {
    io.stdout(
      ["No local sessions yet.", "", "Create one:", "  grp session create analyst", ""].join("\n"),
    );
    return;
  }
  for (const session of sessions) {
    const room = session.current_room ? `\troom ${session.current_room.slug}` : "";
    io.stdout(`${session.name}\t${session.display_name ?? "no display name"}${room}\n`);
  }
}

function sessionShow(
  rawName: string | undefined,
  flags: Record<string, string>,
  io: SessionCliIo,
): void {
  if (!rawName) throw new Error("session name is required");
  const name = normalizeSessionName(rawName);
  const session = resolveLocalSession(readProviderConfig(io.env, { scope: "global" }), name);
  if (!session) throw new Error(`unknown session: ${name}`);
  const rendered = renderSession(name, session);
  if (isJson(flags)) {
    io.stdout(renderJson(rendered));
    return;
  }
  io.stdout(
    [
      `Session: ${name}`,
      `Display name: ${rendered.display_name ?? "not set"}`,
      `Current room: ${rendered.current_room ? rendered.current_room.slug : "none"}`,
      "",
    ].join("\n"),
  );
}

function sessionRemove(
  rawName: string | undefined,
  flags: Record<string, string>,
  io: SessionCliIo,
): void {
  if (!rawName) throw new Error("session name is required");
  const name = normalizeSessionName(rawName);
  const config = readProviderConfig(io.env, { scope: "global" });
  if (!resolveLocalSession(config, name)) throw new Error(`unknown session: ${name}`);
  updateProviderConfig((current) => removeLocalSession(current, name), io.env, {
    scope: "global",
  });
  if (isJson(flags)) {
    io.stdout(renderJson({ removed: name }));
    return;
  }
  io.stdout(`removed session ${name}\n`);
}

function renderSession(
  name: string,
  session: ReturnType<typeof resolveLocalSession>,
): {
  name: string;
  display_name: string | null;
  current_room: { provider: string | null; baseUrl: string | null; slug: string } | null;
} {
  return {
    name,
    display_name: session?.profile?.displayName ?? null,
    current_room: session?.currentRoom
      ? {
          provider: session.currentRoom.provider ?? null,
          baseUrl: session.currentRoom.baseUrl ?? null,
          slug: session.currentRoom.slug,
        }
      : null,
  };
}

function resolveIo(io: Partial<SessionCliIo>): SessionCliIo {
  return {
    stdout: io.stdout ?? ((text) => process.stdout.write(text)),
    stderr: io.stderr ?? ((text) => process.stderr.write(text)),
    env: io.env ?? process.env,
  };
}

function isJson(flags: Record<string, string>): boolean {
  return flags.json === "true";
}

function printSessionHelp(write: (text: string) => void): void {
  write(
    `${[
      "Usage: grp session <command>",
      "",
      "Local sessions let multiple agents on one computer keep separate room state.",
      "Hosts and login stay global; display name and current room are per session.",
      "",
      "Commands:",
      "  create NAME [--name DISPLAY]  create or update a local session",
      "  list                          list local sessions",
      "  show NAME                     show one local session",
      "  remove NAME                   remove a local session",
      "",
      "Examples:",
      '  grp session create analyst --name "Research analyst"',
      "  grp as analyst join abc123 --invite it_...",
      "  grp as analyst read",
      "",
    ].join("\n")}\n`,
  );
}
