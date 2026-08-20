import { emitKeypressEvents } from "node:readline";
import { runAuthCli } from "./auth-cli.js";
import {
  type PersonaContext,
  type ProviderConfig,
  type ProviderProfile,
  type RoomContext,
  addProvider,
  providerConfigPath,
  readProviderConfig,
  renderPersonaIdentity,
  resolvePersonaContext,
  resolvePersonaSelection,
  resolveProvider,
  setDefaultProvider,
  setJoinOnlyMode,
  setProfileDisplayName,
  updateProviderConfig,
} from "./provider-config.js";
import { parseRoomArgs, renderJson } from "./room-cli.js";

export interface OnboardingCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdin: NodeJS.ReadableStream;
  isInteractive: boolean;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

export interface CliStatus {
  initialized: boolean;
  setupMode: "hosted" | "join_only" | "unset";
  defaultProvider: ProviderProfile | null;
  currentRoom: RoomContext | null;
  displayName: string | null;
  loggedInHost: string | null;
  configPath: string;
  issues: string[];
}

interface RenderOptions {
  color?: boolean;
  includeSetupChoices?: boolean;
}

interface MenuOption {
  value: string;
  label: string;
  description?: string;
  aliases?: string[];
}

interface MenuSettings {
  defaultIndex?: number;
  intro?: string[];
  replaceScreen?: boolean;
  screen?: SetupScreenState;
}

const MENU_DESCRIPTION_INDENT = "     ";

interface SetupScreenState {
  renderedLines: number;
}

export async function runGrpFrontDoor(io: Partial<OnboardingCliIo> = {}): Promise<number> {
  const resolvedIo = pinWorkspacePersona(resolveIo(io));
  const config = readProviderConfig(resolvedIo.env);
  const status = buildStatus(config, resolvedIo.env);
  const persona = resolvePersonaContext(resolvedIo.env);
  if (status.initialized) {
    // Spec 106 — when a current room is saved, the front door leads with it
    // (`grp read` first) instead of the create CTA: the resume path is the
    // F27 anti-affordance, and an agent waking mid-room must not be steered
    // toward creating a second room.
    resolvedIo.stdout(
      renderReadyStatus(status, {
        color: shouldUseColor(resolvedIo),
        includeCurrentRoom: true,
        persona,
      }),
    );
    return 0;
  }
  if (!resolvedIo.isInteractive) {
    resolvedIo.stdout(
      persona ? `${renderPersonaIdentity(persona)}\n\n${renderWelcome()}` : renderWelcome(),
    );
    return 0;
  }
  if (persona) resolvedIo.stdout(`${renderPersonaIdentity(persona)}\n`);
  return runInteractiveSetup(config, resolvedIo);
}

export async function runOnboardingCli(
  command: "init" | "status" | "doctor",
  argv: string[],
  io: Partial<OnboardingCliIo> = {},
): Promise<number> {
  const resolvedIo = pinWorkspacePersona(resolveIo(io));
  const parsed = parseRoomArgs(argv);

  try {
    switch (command) {
      case "init":
        return await runInit(parsed.positionals, parsed.flags, resolvedIo);
      case "status":
        return runStatus(parsed.flags, resolvedIo);
      case "doctor":
        return runDoctor(parsed.flags, resolvedIo);
    }
  } catch (err) {
    resolvedIo.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

export function renderWelcome(options: RenderOptions = {}): string {
  const color = makeColors(Boolean(options.color));
  const includeSetupChoices = options.includeSetupChoices ?? true;
  const lines = renderWelcomeHeader(color);

  if (!includeSetupChoices) return `${lines.join("\n")}\n`;

  return `${[
    ...lines,
    "Run `grp` to set up interactively.",
    "",
    "Main choices:",
    "",
    "  1. Create and join rooms (recommended)",
    "     Choose where rooms you create should live.",
    "",
    "  2. Skip for now",
    "     You can join rooms by invite or URL with no setup; choose or add a",
    "     host later with `grp init` (including a custom/company host).",
    "",
    "For scripted setup, run one of:",
    "  grp init join-only",
    "  grp init grp",
    "  grp init grp --login",
    "  grp init custom --name=acme --base=https://grp.acme.internal",
    "  grp init local",
  ].join("\n")}\n`;
}

export function renderInitUsage(): string {
  return `${[
    "Usage: grp init <mode>",
    "",
    "Modes:",
    "  grp init join-only        Skip host setup; join rooms by invite or URL",
    "  grp init grp              Use GRP Server Cloud (grp.app) as your default host",
    "  grp init grp --login      Also sign in for durable, account-backed rooms",
    "  grp init custom --name=acme --base=https://grp.acme.internal",
    "                            Use your own or a third-party GRP host",
    "  grp init local            Use a GRP server running on this computer",
  ].join("\n")}\n`;
}

function renderWelcomeHeader(
  color: ReturnType<typeof makeColors>,
  persona: PersonaContext | null = null,
): string[] {
  return [
    ...(persona ? [color.bold(renderPersonaIdentity(persona)), ""] : []),
    color.blue("      o"),
    color.blue("     / \\"),
    color.blue("  o-- + --o"),
    color.blue("     \\ /"),
    color.blue("      o"),
    "",
    `${color.orange("Welcome to GRP")} ${color.dim("v0.1")}`,
    color.dim("Group Resolution Protocol"),
    "",
    "GRP lets agents coordinate and do work together in shared rooms.",
    color.dim(
      "Discussion works through an issue. A decision records the outcome the group can rely on later.",
    ),
    color.dim("Examples: triage bugs, plan trips, resolve shared work."),
    "",
  ];
}

export function renderReadyStatus(
  status: CliStatus,
  options: { color?: boolean; includeCurrentRoom?: boolean; persona?: PersonaContext | null } = {},
): string {
  const color = makeColors(Boolean(options.color));
  const lines = [
    ...(options.persona ? [color.bold(renderPersonaIdentity(options.persona)), ""] : []),
    ...renderReadyHeader(status, color),
    readyStatusRow("Host:", formatProvider(status.defaultProvider), color),
    readyStatusRow("Name:", status.displayName ?? "none", color),
  ];
  const account = formatAccount(status);
  if (account) lines.push(readyStatusRow("Account:", account, color));
  lines.push("");
  // Spec 106 — a saved current room leads the ready screen: reading the room
  // you are in comes before any create/join CTA.
  if ((options.includeCurrentRoom ?? false) && status.currentRoom) {
    lines.push(color.bold(`Current room: ${status.currentRoom.slug}`));
    lines.push(`  ${color.cyan("grp read")}`);
    lines.push("");
  }
  if (status.setupMode === "join_only") {
    lines.push(color.bold("Join a room"));
    lines.push(`  ${color.cyan("grp join https://example.com/r/abc123")}`);
    lines.push("");
    lines.push(color.dim("Choose a host later to create rooms or use short room IDs."));
    lines.push(`  ${color.cyan("grp init")}`);
  } else {
    lines.push(color.bold("Create a room"));
    lines.push(`  ${color.cyan("grp create")}`);
    lines.push("");
    lines.push(color.dim("Have an invite or room link?"));
    lines.push(`  ${color.cyan("grp join <room-id>")}`);
    lines.push("");
    lines.push(color.dim("Want the command map?"));
    lines.push(`  ${color.cyan("grp help")}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderReadyHeader(status: CliStatus, color: ReturnType<typeof makeColors>): string[] {
  const title =
    status.setupMode === "join_only"
      ? color.green("GRP is ready to join rooms")
      : color.green("GRP is ready");
  return [
    color.blue("      o"),
    color.blue("     / \\"),
    color.blue("  o-- + --o"),
    color.blue("     \\ /"),
    color.blue("      o"),
    "",
    `${title} ${color.dim("v0.1")}`,
    color.dim("Group Resolution Protocol"),
    "",
  ];
}

function readyStatusRow(
  label: string,
  value: string,
  color: ReturnType<typeof makeColors>,
): string {
  return `${color.dim(`${label} `)}${value}`;
}

async function runInteractiveSetup(config: ProviderConfig, io: OnboardingCliIo): Promise<number> {
  const input = createLineReader(io.stdin);
  const screen: SetupScreenState = { renderedLines: 0 };
  try {
    const intent = await chooseMenu(
      input,
      io,
      "What do you want to do?",
      [
        {
          value: "create",
          label: "Create and join rooms (recommended)",
          description: "Create rooms for your team, or join rooms others send you.",
          aliases: ["create", "rooms", "1"],
        },
        // Spec 111 (spec 110 item 1) — the honest escape hatch: joining needs
        // zero setup since invites carry full URLs, so this reads as "skip",
        // not a mode. Same config state as ever (setJoinOnlyMode); copy only.
        {
          value: "join-only",
          label: "Skip for now",
          description:
            "You can join rooms by invite or URL with no setup; choose or add a host later with `grp init` (including a custom/company host).",
          aliases: ["skip", "join", "existing", "2"],
        },
      ],
      { defaultIndex: 0, replaceScreen: true, screen },
    );
    let next: ProviderConfig;
    let commitBaseline = config;

    if (intent === "join-only") {
      next = setJoinOnlyMode(config);
      next = await maybeAddDisplayName(next, input, io, screen);
    } else {
      const hosting = await chooseMenu(
        input,
        io,
        "Where should rooms you create live?",
        [
          {
            value: "known",
            label: "Known room provider (recommended)",
            description: "A provider keeps rooms online so agents can work across devices.",
            aliases: ["known", "provider", "hosted", "1"],
          },
          {
            value: "custom",
            label: "Custom / self-hosted",
            description: "Use your company server, a staging host, or a local test server.",
            aliases: ["self-hosted", "selfhosted", "2"],
          },
        ],
        { defaultIndex: 0, replaceScreen: true, screen },
      );

      if (hosting === "known") {
        next = await chooseKnownProvider(config, input, io, screen);
        const loginResult = await maybeLoginToHostedProvider(next, config, input, io, screen);
        next = loginResult.config;
        commitBaseline = loginResult.baseline;
      } else if (hosting === "custom") {
        next = await chooseCustomHost(config, input, io, screen);
      } else {
        io.stderr("Choose one of: 1 or 2.\n");
        return 1;
      }
      next = await maybeAddDisplayName(next, input, io, screen);
    }

    next = commitSetupConfig(next, commitBaseline, io.env);
    const status = buildStatus(next, io.env);
    writeReadyScreen(io, status, screen);
    return 0;
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function chooseKnownProvider(
  config: ProviderConfig,
  input: LineReader,
  io: OnboardingCliIo,
  screen: SetupScreenState,
): Promise<ProviderConfig> {
  await chooseMenu(
    input,
    io,
    "Choose a room provider",
    [
      {
        value: "grp",
        label: "GRP Server Cloud",
        description:
          "Hosted GRP rooms at grp.app, operated by Malacan, Inc. — for teams, collaborators, and agents.",
        aliases: ["1"],
      },
    ],
    {
      defaultIndex: 0,
      intro: [
        "Known providers are GRP room hosts listed by the protocol project.",
        "Third-party host listings open after the beta; interested operators",
        "can write to hosts@grp.dev. Any host works today via `grp host add`.",
      ],
      replaceScreen: true,
      screen,
    },
  );
  return setDefaultProvider(config, "grp");
}

async function maybeLoginToHostedProvider(
  config: ProviderConfig,
  baseline: ProviderConfig,
  input: LineReader,
  io: OnboardingCliIo,
  screen: SetupScreenState,
): Promise<{ config: ProviderConfig; baseline: ProviderConfig }> {
  const provider = config.defaultProvider ? resolveProvider(config, config.defaultProvider) : null;
  if (!provider) return { config, baseline };

  const mode = await chooseMenu(
    input,
    io,
    "Use this host with an account?",
    [
      {
        value: "login",
        label: "Sign in for durable rooms (recommended)",
        description: "Use browser login for recovery and identity-bound invites.",
        aliases: ["login", "sign-in", "signin", "durable", "account", "1"],
      },
      {
        value: "quick",
        label: "Continue without an account",
        description: "Create quick rooms now. You can sign in later with `grp login`.",
        aliases: ["quick", "skip", "no", "2"],
      },
    ],
    {
      defaultIndex: 0,
      intro: [
        "Accounts are optional. Quick rooms work without one.",
        "Sign in when you want rooms tied to a host identity.",
      ],
      replaceScreen: true,
      screen,
    },
  );
  if (mode !== "login") return { config, baseline };

  commitSetupConfig(config, baseline, io.env);
  writeSetupFrame(io, screen, [
    makeColors(shouldUseColor(io)).bold("Sign in to this host"),
    "",
    "Your browser will handle account creation or login.",
    makeColors(shouldUseColor(io)).dim("The CLI will wait here until authorization finishes."),
    "",
  ]);
  screen.renderedLines = 0;

  const code = await runAuthCli("login", loginArgsForProvider(provider), {
    env: io.env,
    stdout: io.stdout,
    stderr: io.stderr,
    fetch: io.fetch,
    sleep: io.sleep,
  });
  if (code !== 0) {
    throw new Error("Host sign-in did not finish. You can run `grp login` later.");
  }
  const latest = readProviderConfig(io.env);
  // The provider choice is already committed and auth writes through its own
  // transaction. Treat this post-login snapshot as the baseline for the
  // remaining display-name prompt so concurrent fields are not misclassified
  // as setup-owned intent by the final commit.
  return { config: latest, baseline: latest };
}

/**
 * Commit only the setup choices the interactive flow owns, against the latest
 * config. Prompts and browser login happen outside the config lock, so an old
 * snapshot must never replace room/session updates made while the user waits.
 */
function commitSetupConfig(
  desired: ProviderConfig,
  baseline: ProviderConfig,
  env: Record<string, string | undefined>,
): ProviderConfig {
  return updateProviderConfig((latest) => {
    const providers = { ...latest.providers };
    for (const name of new Set([
      ...Object.keys(baseline.providers),
      ...Object.keys(desired.providers),
    ])) {
      const before = baseline.providers[name];
      const after = desired.providers[name];
      if (sameProvider(before, after)) continue;
      if (after) providers[name] = after;
      else Reflect.deleteProperty(providers, name);
    }
    let next: ProviderConfig = { ...latest, providers };
    if (
      desired.setupMode !== baseline.setupMode ||
      desired.defaultProvider !== baseline.defaultProvider
    ) {
      if (desired.setupMode === "join_only") {
        const { defaultProvider: _defaultProvider, ...rest } = next;
        next = { ...rest, setupMode: "join_only" };
      } else if (desired.defaultProvider) {
        const { setupMode: _setupMode, ...rest } = next;
        next = { ...rest, defaultProvider: desired.defaultProvider };
      }
    }
    if (desired.profile?.displayName !== baseline.profile?.displayName) {
      if (desired.profile) next = { ...next, profile: desired.profile };
      else {
        const { profile: _profile, ...rest } = next;
        next = rest;
      }
    }
    return next;
  }, env);
}

function sameProvider(
  left: ProviderProfile | undefined,
  right: ProviderProfile | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.name === right.name && left.baseUrl === right.baseUrl;
}

async function chooseCustomHost(
  config: ProviderConfig,
  input: LineReader,
  io: OnboardingCliIo,
  screen: SetupScreenState,
): Promise<ProviderConfig> {
  writeSetupFrame(io, screen, [
    makeColors(shouldUseColor(io)).bold("Custom / self-hosted setup"),
    "",
    "Use the GRP server your company or project team provides.",
    "",
  ]);
  const name = await askRequired(input, io, "Host name: ", screen);
  const base = await askRequired(input, io, "Base URL: ", screen);
  return addProvider(config, name, base, true);
}

async function maybeAddDisplayName(
  config: ProviderConfig,
  input: LineReader,
  io: OnboardingCliIo,
  screen: SetupScreenState,
): Promise<ProviderConfig> {
  writeSetupFrame(io, screen, [
    makeColors(shouldUseColor(io)).bold("Display name"),
    "",
    "This is what other people and agents see when you join a room.",
    makeColors(shouldUseColor(io)).dim("Press Enter to skip."),
    "",
  ]);
  const answer = await ask(input, io, "Display name (optional): ", screen);
  return answer.trim() ? setProfileDisplayName(config, answer) : config;
}

async function ask(
  input: LineReader,
  io: OnboardingCliIo,
  prompt: string,
  screen?: SetupScreenState,
): Promise<string> {
  io.stdout(prompt);
  const answer = await input.nextLine();
  if (screen) screen.renderedLines += 1;
  return answer;
}

async function askRequired(
  input: LineReader,
  io: OnboardingCliIo,
  prompt: string,
  screen?: SetupScreenState,
): Promise<string> {
  const answer = (await ask(input, io, prompt, screen)).trim();
  if (!answer) throw new Error(`${prompt.replace(/:\s*$/, "")} is required`);
  return answer;
}

interface LineReader {
  nextLine: () => Promise<string>;
}

function createLineReader(input: NodeJS.ReadableStream): LineReader {
  const iterator = input[Symbol.asyncIterator]();
  const lines: string[] = [];
  let remainder = "";
  return {
    async nextLine(): Promise<string> {
      while (lines.length === 0) {
        const next = await iterator.next();
        if (next.done) {
          if (remainder.length > 0) {
            const line = remainder;
            remainder = "";
            return line;
          }
          throw new Error("input closed");
        }
        const chunk =
          typeof next.value === "string" ? next.value : Buffer.from(next.value).toString("utf8");
        const parts = `${remainder}${chunk}`.split(/\r?\n/);
        remainder = parts.pop() ?? "";
        lines.push(...parts);
      }
      return lines.shift() ?? "";
    },
  };
}

function writeSetupFrame(io: OnboardingCliIo, screen: SetupScreenState, body: string[]): void {
  if (canUseArrowMenu(io)) {
    renderSetupFrame(io, screen, [
      ...renderWelcomeHeader(makeColors(shouldUseColor(io)), resolvePersonaContext(io.env)),
      ...body,
    ]);
    return;
  }
  io.stdout(`\n${body.join("\n")}`);
}

function writeReadyScreen(io: OnboardingCliIo, status: CliStatus, screen?: SetupScreenState): void {
  const persona = resolvePersonaContext(io.env);
  if (canUseArrowMenu(io)) {
    renderSetupFrame(
      io,
      screen ?? { renderedLines: 0 },
      renderReadyStatus(status, { color: shouldUseColor(io), persona })
        .trimEnd()
        .split("\n"),
    );
    return;
  }
  io.stdout("\n");
  io.stdout(renderReadyStatus(status, { color: shouldUseColor(io), persona }));
}

function clearScreen(io: OnboardingCliIo): void {
  io.stdout("\x1b[H\x1b[2J\x1b[3J");
}

function renderSetupFrame(io: OnboardingCliIo, screen: SetupScreenState, lines: string[]): void {
  if (screen.renderedLines > 0) {
    io.stdout(`\x1b[${screen.renderedLines}F\x1b[J`);
  } else {
    clearScreen(io);
  }
  screen.renderedLines = lines.length;
  io.stdout(`${lines.join("\n")}\n`);
}

async function chooseMenu(
  input: LineReader,
  io: OnboardingCliIo,
  title: string,
  options: MenuOption[],
  settings: MenuSettings = {},
): Promise<string> {
  if (options.length === 0) throw new Error("menu must include at least one option");
  if (canUseArrowMenu(io)) {
    return chooseMenuWithArrows(io, title, options, settings);
  }

  io.stdout(renderPlainMenu(title, options, shouldUseColor(io), settings.intro));
  const answer = normalizeChoice(await ask(input, io, `Select an option [1-${options.length}]: `));
  return matchMenuChoice(answer, options, settings.defaultIndex ?? 0);
}

function renderPlainMenu(
  title: string,
  options: MenuOption[],
  useColor: boolean,
  intro: string[] = [],
): string {
  const color = makeColors(useColor);
  const lines = ["", color.bold(title), ""];
  if (intro.length > 0) {
    lines.push(...intro, "");
  }
  options.forEach((option, index) => {
    lines.push(`  ${index + 1}. ${option.label}`);
    if (option.description)
      lines.push(`${MENU_DESCRIPTION_INDENT}${color.dim(option.description)}`);
    lines.push("");
  });
  return lines.join("\n");
}

async function chooseMenuWithArrows(
  io: OnboardingCliIo,
  title: string,
  options: MenuOption[],
  settings: MenuSettings,
): Promise<string> {
  const input = io.stdin as TtyReadable;
  const color = makeColors(shouldUseColor(io));
  const defaultIndex = settings.defaultIndex ?? 0;
  let selected = Math.min(Math.max(defaultIndex, 0), options.length - 1);
  const screen = settings.screen ?? { renderedLines: 0 };
  const rawWasEnabled = Boolean(input.isRaw);

  emitKeypressEvents(input);
  input.setRawMode?.(true);
  input.resume();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode?.(rawWasEnabled);
      if (!settings.replaceScreen) io.stdout("\n");
    };

    const render = () => {
      const lines = settings.replaceScreen
        ? renderWelcomeHeader(color, resolvePersonaContext(io.env))
        : [""];
      lines.push(color.bold(title), "");
      if (settings.intro && settings.intro.length > 0) {
        lines.push(...settings.intro.map((line) => color.dim(line)), "");
      }
      options.forEach((option, index) => {
        const active = index === selected;
        const marker = active ? color.blue(">") : " ";
        const label = active ? color.blue(color.bold(option.label)) : option.label;
        lines.push(`${marker} ${index + 1}. ${label}`);
        if (option.description)
          lines.push(`${MENU_DESCRIPTION_INDENT}${color.dim(option.description)}`);
      });
      lines.push("", color.dim("Use Up/Down and Enter. Type a number as a shortcut."));
      if (settings.replaceScreen) {
        renderSetupFrame(io, screen, lines);
      } else {
        io.stdout(`${lines.join("\n")}\n`);
      }
    };

    function onKeypress(str: string, key: { name?: string; ctrl?: boolean }) {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("setup cancelled"));
        return;
      }
      if (key.name === "up") {
        selected = (selected - 1 + options.length) % options.length;
        render();
        return;
      }
      if (key.name === "down") {
        selected = (selected + 1) % options.length;
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(options[selected]?.value ?? fallbackMenuValue(options));
        return;
      }
      if (/^[1-9]$/.test(str)) {
        const index = Number(str) - 1;
        if (index >= 0 && index < options.length) {
          cleanup();
          resolve(options[index]?.value ?? fallbackMenuValue(options));
        }
      }
    }

    input.on("keypress", onKeypress);
    render();
  });
}

type TtyReadable = NodeJS.ReadableStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
  resume: () => void;
  on: (
    event: "keypress",
    listener: (str: string, key: { name?: string; ctrl?: boolean }) => void,
  ) => TtyReadable;
  off: (
    event: "keypress",
    listener: (str: string, key: { name?: string; ctrl?: boolean }) => void,
  ) => TtyReadable;
};

function canUseArrowMenu(io: OnboardingCliIo): boolean {
  const input = io.stdin as TtyReadable;
  return Boolean(
    input.isTTY &&
      typeof input.setRawMode === "function" &&
      process.stdout.isTTY &&
      io.env.CI !== "true" &&
      io.env.GRP_PLAIN_PROMPTS !== "1",
  );
}

function matchMenuChoice(raw: string, options: MenuOption[], defaultIndex: number): string {
  if (!raw) return options[defaultIndex]?.value ?? fallbackMenuValue(options);
  const numeric = Number(raw);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
    return options[numeric - 1]?.value ?? fallbackMenuValue(options);
  }
  const match = options.find((option) => {
    if (option.value === raw) return true;
    return option.aliases?.includes(raw) ?? false;
  });
  if (!match) {
    throw new Error(
      `Choose one of: ${options.map((option, index) => `${index + 1} (${option.value})`).join(", ")}.`,
    );
  }
  return match.value;
}

function fallbackMenuValue(options: MenuOption[]): string {
  const first = options[0];
  if (!first) throw new Error("menu must include at least one option");
  return first.value;
}

function normalizeChoice(raw: string): string {
  return raw.trim().toLowerCase();
}

function shouldUseColor(io: OnboardingCliIo): boolean {
  if (io.env.NO_COLOR) return false;
  if (io.env.FORCE_COLOR && io.env.FORCE_COLOR !== "0") return true;
  if (io.env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
}

function makeColors(enabled: boolean) {
  const wrap = (open: string, close: string) => (text: string) =>
    enabled ? `${open}${text}${close}` : text;
  return {
    blue: wrap("\x1b[94m", "\x1b[39m"),
    bold: wrap("\x1b[1m", "\x1b[22m"),
    cyan: wrap("\x1b[36m", "\x1b[39m"),
    dim: wrap("\x1b[2m", "\x1b[22m"),
    green: wrap("\x1b[32m", "\x1b[39m"),
    orange: wrap("\x1b[38;5;208m", "\x1b[39m"),
  };
}

async function runInit(
  positionals: string[],
  flags: Record<string, string>,
  io: OnboardingCliIo,
): Promise<number> {
  const [mode, customName] = positionals;
  // Spec 116 (WR8-7) — any help spelling gets init USAGE, not the first-run
  // welcome dump: `grp init --help` parses the flag away, leaving no mode,
  // and used to fall into the welcome branch (run 8's Iridium got the full
  // banner when it asked a scoped question).
  if (
    flags.help === "true" ||
    positionals.includes("-h") ||
    mode === "help" ||
    mode === "--help" ||
    mode === "-h"
  ) {
    io.stdout(renderInitUsage());
    return 0;
  }
  if (!mode) {
    io.stdout(renderWelcome());
    return 0;
  }

  const normalized = mode.toLowerCase();
  const config = readProviderConfig(io.env);
  let next: ProviderConfig;
  let note: string | undefined;

  if (normalized === "join" || normalized === "join-only" || normalized === "join_only") {
    next = setJoinOnlyMode(config);
    note = "You can join full room URLs now. Choose a host later with `grp init`.";
  } else if (normalized === "local") {
    next = setDefaultProvider(config, "local");
    note = "Local mode uses a GRP server on this computer.";
  } else if (normalized === "grp" || normalized === "grp.app" || normalized === "hosted") {
    next = setDefaultProvider(config, "grp");
    note =
      "GRP Server Cloud (grp.app, operated by Malacan, Inc.) is your default host for creating rooms.";
  } else if (
    normalized === "custom" ||
    normalized === "self-hosted" ||
    normalized === "selfhosted"
  ) {
    const name = flags.name ?? flags.host ?? customName;
    if (!name)
      throw new Error("custom host name is required: grp init custom --name=acme --base=URL");
    const base = flags.base;
    if (!base) throw new Error("--base is required for custom hosts");
    next = addProvider(config, name, base, true);
    note = "Custom host saved as your default.";
  } else {
    throw new Error("init target must be one of: join-only, grp, custom, local");
  }

  next = commitSetupConfig(next, config, io.env);
  if (flags.login === "true") {
    const provider = next.defaultProvider ? resolveProvider(next, next.defaultProvider) : null;
    if (!provider) throw new Error("login requires a default host");
    const code = await runAuthCli("login", loginArgsForProvider(provider, flags), {
      env: io.env,
      stdout: io.stdout,
      stderr: io.stderr,
      fetch: io.fetch,
      sleep: io.sleep,
    });
    if (code !== 0) return code;
    next = readProviderConfig(io.env);
    note = "Signed in. This host identity will be used when rooms ask for it.";
  }
  const status = buildStatus(next, io.env);

  if (flags.json === "true") {
    io.stdout(renderJson(status));
    return 0;
  }

  io.stdout(
    `${renderReadyStatus(status, { persona: resolvePersonaContext(io.env) })}${note ? `\n${note}\n` : ""}`,
  );
  return 0;
}

function loginArgsForProvider(
  provider: ProviderProfile,
  flags: Record<string, string> = {},
): string[] {
  const args = ["--base", provider.baseUrl];
  for (const key of ["client-id", "agent", "scope", "resource", "poll-interval"]) {
    const value = flags[key];
    if (value !== undefined) args.push(`--${key}=${value}`);
  }
  return args;
}

function runStatus(flags: Record<string, string>, io: OnboardingCliIo): number {
  const status = buildStatus(readProviderConfig(io.env), io.env);
  if (flags.json === "true") {
    io.stdout(renderJson(status));
    return 0;
  }
  // Spec 115 (WR7-3) — the footer nag only when there is genuinely nothing
  // configured; a joined room is a working configuration (renderStatus says
  // what a default host is for).
  if (!status.initialized && !status.currentRoom) {
    io.stdout(
      `${renderStatus(status, resolvePersonaContext(io.env))}\nRun \`grp init\` to choose a default host.\n`,
    );
    return 0;
  }
  io.stdout(renderStatus(status, resolvePersonaContext(io.env)));
  return 0;
}

function runDoctor(flags: Record<string, string>, io: OnboardingCliIo): number {
  const status = buildStatus(readProviderConfig(io.env), io.env);
  if (flags.json === "true") {
    io.stdout(renderJson(status));
    return status.issues.length === 0 ? 0 : 1;
  }

  const persona = resolvePersonaContext(io.env);
  const lines = [...(persona ? [renderPersonaIdentity(persona), ""] : []), "GRP doctor", ""];
  lines.push(`Config: ${status.configPath}`);
  lines.push(`Mode: ${formatSetupMode(status.setupMode)}`);
  lines.push(`Host: ${formatProvider(status.defaultProvider)}`);
  lines.push(`Current room: ${formatCurrentRoom(status.currentRoom)}`);
  lines.push(`Account: ${formatAccount(status) ?? "not connected"}`);
  lines.push("");
  if (status.issues.length === 0) {
    lines.push("No setup issues.");
  } else {
    lines.push(`${status.issues.length} setup issue${status.issues.length === 1 ? "" : "s"}:`);
    for (const issue of status.issues) lines.push(`- ${issue}`);
  }
  io.stdout(`${lines.join("\n")}\n`);
  return status.issues.length === 0 ? 0 : 1;
}

function renderStatus(status: CliStatus, persona: PersonaContext | null = null): string {
  const lines = [
    ...(persona ? [renderPersonaIdentity(persona), ""] : []),
    "GRP status",
    "",
    `Mode: ${formatSetupMode(status.setupMode)}`,
    `Host: ${formatProvider(status.defaultProvider)}`,
    `Name: ${status.displayName ?? "none"}`,
    `Account: ${formatAccount(status) ?? "not connected"}`,
    `Current room: ${formatCurrentRoom(status.currentRoom)}`,
    `Config: ${status.configPath}`,
  ];
  // Spec 115 (WR7-3) — a joiner with a working room is not misconfigured;
  // say what a default host is FOR instead of implying something is broken.
  if (!status.defaultProvider && status.currentRoom) {
    lines.push(
      "",
      "Room access works via your joined room. To create rooms, add a default host: grp init.",
    );
  }
  return `${lines.join("\n")}\n`;
}

function buildStatus(config: ProviderConfig, env: Record<string, string | undefined>): CliStatus {
  const defaultProvider = config.defaultProvider
    ? resolveProvider(config, config.defaultProvider)
    : null;
  const setupMode: CliStatus["setupMode"] = defaultProvider
    ? "hosted"
    : config.setupMode === "join_only"
      ? "join_only"
      : "unset";
  const issues: string[] = [];
  // Spec 115 (WR7-3) — don't cry wolf at joiners: an agent with a working
  // current room is healthy. A default host is only needed to CREATE rooms;
  // without a room or a host there is genuinely nothing configured.
  if (!defaultProvider && setupMode !== "join_only" && !config.currentRoom) {
    issues.push("No default host configured. Run `grp init`.");
  }
  const providersByBaseUrl = new Map<string, string[]>();
  for (const provider of Object.values(config.providers)) {
    const names = providersByBaseUrl.get(provider.baseUrl) ?? [];
    names.push(provider.name);
    providersByBaseUrl.set(provider.baseUrl, names);
  }
  for (const [baseUrl, names] of providersByBaseUrl) {
    if (names.length < 2) continue;
    issues.push(
      `Duplicate host URL ${baseUrl} is configured as: ${names.sort().join(", ")}. Remove the obsolete alias after checking which name your rooms use.`,
    );
  }
  return {
    initialized: Boolean(defaultProvider) || setupMode === "join_only",
    setupMode,
    defaultProvider: defaultProvider ?? null,
    currentRoom: config.currentRoom ?? null,
    displayName: config.profile?.displayName ?? null,
    loggedInHost: config.auth?.baseUrl ?? null,
    configPath: providerConfigPath(env),
    issues,
  };
}

function formatProvider(provider: ProviderProfile | null): string {
  return provider ? `${formatProviderName(provider)} - ${provider.baseUrl}` : "none";
}

function formatProviderName(provider: ProviderProfile): string {
  if (provider.name === "grp" && provider.baseUrl.includes("staging.grp.app")) {
    return "GRP Server Cloud (staging)";
  }
  if (provider.name === "grp") return "GRP Server Cloud";
  return provider.name;
}

function formatAccount(status: CliStatus): string | null {
  if (status.loggedInHost) return `signed in to ${status.loggedInHost}`;
  if (status.setupMode === "join_only") return null;
  if (status.defaultProvider?.name === "grp") return "not needed for quick rooms";
  return null;
}

function formatSetupMode(mode: CliStatus["setupMode"]): string {
  if (mode === "hosted") return "default host";
  if (mode === "join_only") return "join-only";
  return "not set";
}

function formatCurrentRoom(room: RoomContext | null): string {
  if (!room) return "none";
  const host = room.provider ?? room.baseUrl ?? "default host";
  return `${room.slug} (${host})`;
}

function resolveIo(io: Partial<OnboardingCliIo>): OnboardingCliIo {
  const stdin = io.stdin ?? process.stdin;
  const env = io.env ?? process.env;
  const stdinIsTty = Boolean((stdin as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY);
  const stdoutIsTty = Boolean(process.stdout.isTTY);
  return {
    stdout: io.stdout ?? ((text) => process.stdout.write(text)),
    stderr: io.stderr ?? ((text) => process.stderr.write(text)),
    stdin,
    isInteractive: io.isInteractive ?? (stdinIsTty && stdoutIsTty && env.GRP_NO_INPUT !== "1"),
    env,
    fetch: io.fetch ?? fetch,
    sleep: io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

function pinWorkspacePersona(io: OnboardingCliIo): OnboardingCliIo {
  const selection = resolvePersonaSelection(io.env);
  return selection?.source === "workspace"
    ? { ...io, env: { ...io.env, GRP_SESSION: selection.name } }
    : io;
}
