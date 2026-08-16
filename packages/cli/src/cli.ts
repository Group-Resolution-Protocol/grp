// GRP CLI subcommand dispatch.
//
// The chess trial rig that seeded this dispatch (spec 013) moved to
// @grp/chess-trial's `grp-trial` bin in spec 178 — the shipped CLI carries
// only the protocol surface.

import { runAuthCli } from "./auth-cli.js";
import { banner } from "./index.js";
import { runGrpFrontDoor, runOnboardingCli } from "./onboarding-cli.js";
import { runOrganizationCli } from "./organization-cli.js";
import { runPersonaCli } from "./persona-cli.js";
import { runProfileCli } from "./profile-cli.js";
import { runProviderCli } from "./provider-cli.js";
import {
  normalizeSessionName,
  readProviderConfig,
  resolveLocalSession,
} from "./provider-config.js";
import { renderDefaultsHelp, runQuickstartCli } from "./quickstart-cli.js";
import { runRoomCli } from "./room-cli.js";
import { runSessionCli } from "./session-cli.js";

export function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq === -1) flags[raw.slice(2)] = "true";
    else flags[raw.slice(2, eq)] = raw.slice(eq + 1);
  }
  return flags;
}

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

export interface RunCliOptions {
  programName?: string;
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const programName = options.programName ?? "grp";
  const [command, ...rest] = argv;

  if (!command) {
    return runGrpFrontDoor();
  }
  if (command === "--help" || command === "-h") {
    printHelp(programName);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${banner()}\n`);
    return 0;
  }

  if (command === "help") {
    if (rest[0] === "defaults") process.stdout.write(renderDefaultsHelp());
    else if (rest[0] === "advanced" || rest[0] === "dev") printAdvancedHelp(programName);
    else printHelp(programName);
    return 0;
  }

  if (command === "as") {
    return runAsSession(rest, options);
  }

  if (command === "session") {
    return runSessionCli(rest);
  }

  if (command === "persona") {
    return runPersonaCli(rest);
  }

  if (command === "org") {
    return runOrganizationCli(rest);
  }

  if (command === "room") {
    return runRoomCli(rest);
  }

  if (command === "host") {
    return runProviderCli(rest);
  }

  if (command === "profile") {
    return runProfileCli(rest);
  }

  if (command === "quickstart") {
    return runQuickstartCli(rest);
  }

  if (command === "login" || command === "logout") {
    return runAuthCli(command, rest);
  }

  if (command === "init" || command === "status" || command === "doctor") {
    return runOnboardingCli(command, rest);
  }

  if (command === "start" && rest[0] === "choosing") {
    return runRoomCli(["start", ...rest]);
  }

  if (
    [
      "read",
      "create",
      "join",
      "enter",
      "current",
      "rooms",
      "inbox",
      "leave",
      "ask",
      "options",
      "timeline",
      "history",
      "watch",
      "invite",
      "members",
      "settings",
      "propose",
      "discuss",
      "choose",
      "accept",
      "abstain",
      "outcome",
      "close",
    ].includes(command)
  ) {
    return runRoomCli([command, ...rest]);
  }

  fail(`unknown command: ${command}\nrun \`${programName} --help\` for usage.`);
}

function printHelp(programName: string): void {
  const out = [
    banner(),
    "",
    `Usage: ${programName} <command> [options]`,
    "",
    "GRP lets agents coordinate and do work together in shared rooms.",
    "Discussion works through an issue. A decision records the outcome the group can rely on later.",
    "",
    "Start:",
    "  grp                   show setup status or first-run setup",
    "  init                  choose how this terminal starts using GRP",
    "  login                 sign in to the current host when rooms ask for identity",
    "  logout                clear the saved host identity",
    "  status                show default host and current room",
    "  doctor                diagnose local CLI setup",
    "  org create …          instantiate a structured local organization",
    "  persona setup ROOT…   create persona workspaces for a local team",
    "  persona init NAME     add or repair one workspace identity",
    "  profile               set or show your default display name",
    "",
    "Hosts:",
    "  host list             list configured room hosts",
    "  host use NAME         set the default host",
    "  host add NAME --base=URL",
    "  profile set-name NAME",
    "",
    "Rooms:",
    "  create                create a room",
    "  join ROOM             join and remember a room (first room becomes current)",
    "  read [ROOM]           read the room (new activity since your last read)",
    "  watch [ROOM]          wait until the room has something for you",
    "  rooms                 list rooms remembered by this local session",
    "  inbox                 check remembered rooms for attention",
    "  invite [ROOM]         create or list invites (--role observer for watch-only seats)",
    "  members [ROOM]        list room members",
    "  settings [ROOM]       show room settings",
    "",
    "Decisions:",
    "  ask TEXT              open a question in the current room",
    "  options [ROOM]        show the current option slate",
    "  propose TEXT          add an option",
    "  discuss TEXT          post discussion",
    "  start choosing [ROOM] open choices for a collect-first question",
    "  choose N|TEXT         choose by option number or exact text",
    "  abstain --reason=TEXT formally participate without supporting an option",
    "  outcome [ROOM]        show the latest outcome",
    "",
    "Advanced:",
    "  help advanced         show operator and multi-session commands",
    "  help defaults         show default room settings",
    "  room help             show room command details",
    "  host help             show host command details",
  ];
  process.stdout.write(`${out.join("\n")}\n`);
}

function printAsHelp(programName: string): void {
  process.stdout.write(
    `${[
      banner(),
      "",
      `Usage: ${programName} as <session> <command> [options]`,
      "",
      "Run a GRP command with a local session's display name and current room.",
      "Default host and hosted login stay shared; room state is isolated.",
      "",
      "Examples:",
      "  grp as analyst join abc123 --invite it_...",
      "  grp as analyst read",
      '  grp as reviewer discuss "I see the same risk."',
      "",
    ].join("\n")}\n`,
  );
}

async function runAsSession(rest: string[], options: RunCliOptions): Promise<number> {
  const [rawSession, ...sessionArgv] = rest;
  if (!rawSession || rawSession === "--help" || rawSession === "-h" || rawSession === "help") {
    printAsHelp(options.programName ?? "grp");
    return 0;
  }
  if (sessionArgv.length === 0) {
    process.stderr.write("usage: grp as <session> <command> [options]\n");
    return 2;
  }
  const sessionName = normalizeSessionName(rawSession);
  if (!resolveLocalSession(readProviderConfig(process.env, { scope: "global" }), sessionName)) {
    process.stderr.write(
      `unknown local persona "${sessionName}"; create it with \`grp session create ${sessionName}\`\n`,
    );
    return 1;
  }
  const previous = process.env.GRP_SESSION;
  const previousAsActive = process.env.GRP_AS_ACTIVE;
  process.env.GRP_SESSION = sessionName;
  process.env.GRP_AS_ACTIVE = "1";
  try {
    return await runCli(sessionArgv, options);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "GRP_SESSION");
    else process.env.GRP_SESSION = previous;
    if (previousAsActive === undefined) Reflect.deleteProperty(process.env, "GRP_AS_ACTIVE");
    else process.env.GRP_AS_ACTIVE = previousAsActive;
  }
}

function printAdvancedHelp(programName: string): void {
  const out = [
    banner(),
    "",
    `Usage: ${programName} <command> [options]`,
    "",
    "Advanced commands (everyday commands: grp help):",
    "  enter ROOM              set the current room without joining it",
    "  timeline [ROOM]         print the room event log (alias: history)",
    "  settings set KEY VALUE  update a room setting (operator)",
    "  members set-role NAME participant|observer",
    "                          change a member's role (operator)",
    "  persona setup ROOT…     create persona workspaces for a local team",
    "  persona init NAME       add or repair one workspace identity",
    "  session create NAME     manage the lower-level local identity registry",
    "  session list            list local sessions",
    "  as NAME <command>       run a command with that session's room state",
    "  quickstart              create a first room and remember it as current",
    "  close [ROOM]            permanently close a room (irreversible; operator)",
    "  help defaults           show default room settings",
    "",
    "Script filters for watch (pipelines and drivers, NOT participant seats —",
    "they stay silent at decision boundaries where a participant should act;",
    "an open decision waiting on YOUR choice always wakes you regardless):",
    "  watch --until=resolved  exit only on a completed decision or room close",
    "  watch --until=needed    exit only when the room needs your choice",
  ];
  process.stdout.write(`${out.join("\n")}\n`);
}
