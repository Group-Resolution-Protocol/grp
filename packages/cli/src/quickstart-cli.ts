import {
  resolvePersonaSelection,
  setProfileDisplayName,
  updateProviderConfig,
} from "./provider-config.js";
import { resolveCliCreateAccess } from "./room-access.js";
import { runRoomCli } from "./room-cli.js";

export interface QuickstartCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdin: NodeJS.ReadableStream;
  isInteractive: boolean;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  /** Test/embedding override; normal CLI use resolves from process.cwd(). */
  cwd?: string;
}

export async function runQuickstartCli(
  argv: string[],
  io: Partial<QuickstartCliIo> = {},
): Promise<number> {
  const initialIo = resolveIo(io);
  const selection = resolvePersonaSelection(initialIo.env, {
    cwd: initialIo.cwd ?? process.cwd(),
  });
  const resolvedIo =
    selection?.source === "workspace"
      ? { ...initialIo, env: { ...initialIo.env, GRP_SESSION: selection.name } }
      : initialIo;
  const flags = parseFlags(argv);

  try {
    if (flags.help === "true" || flags.h === "true") {
      resolvedIo.stdout(renderQuickstartHelp());
      return 0;
    }

    const access = resolveCliCreateAccess(flags);
    const displayName = flags.name ?? flags.as ?? flags["display-name"];
    if (displayName) {
      updateProviderConfig(
        (current) => setProfileDisplayName(current, displayName),
        resolvedIo.env,
      );
    }

    const about = await resolveAbout(flags, resolvedIo);
    const createArgs = ["create", `--about=${about}`, "--json"];
    const ask = flags.ask ?? flags.question;
    if (ask) createArgs.push(`--ask=${ask}`);
    createArgs.push(`--visibility=${access.visibility}`);
    if (access.password) createArgs.push(`--password=${access.password}`);
    if (flags.host) createArgs.push(`--host=${flags.host}`);
    if (flags.base) createArgs.push(`--base=${flags.base}`);

    let createStdout = "";
    const code = await runRoomCli(createArgs, {
      ...resolvedIo,
      stdout: (text) => {
        createStdout += text;
      },
    });
    if (code !== 0) return code;

    const created = JSON.parse(createStdout) as {
      slug: string;
      creator_token?: string;
      creatorToken?: string;
      about?: string | null;
      url?: string;
    };
    if (!created.slug) throw new Error("host did not return a room slug");

    if (isJson(flags)) {
      resolvedIo.stdout(
        `${JSON.stringify(
          {
            slug: created.slug,
            ...(created.url ? { url: created.url } : {}),
            about: created.about ?? about,
            current_room: created.slug,
            access: access.label,
            ...(access.passwordGenerated ? { room_password: access.password } : {}),
            next: ask ? "grp options" : 'grp ask "..."',
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    resolvedIo.stdout(
      renderQuickstartDone(
        created.slug,
        created.url,
        created.about ?? about,
        access.label,
        ask,
        access.passwordGenerated ? access.password : undefined,
      ),
    );
    return 0;
  } catch (err) {
    resolvedIo.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

export function renderDefaultsHelp(): string {
  return `${[
    "GRP defaults",
    "",
    "Rooms:",
    "  - `grp create --about ...` creates a persistent room with no open question.",
    "  - `grp create --about ... --ask ...` creates a room and opens the first question.",
    "",
    "Creation modes:",
    "  - Quick hosted rooms do not require an account; share the room link, invite,",
    "    or private-room password with the agents that should join.",
    "  - Durable hosted rooms use a host account for identity, recovery, and",
    "    managed access when the host supports it.",
    "  - Local rooms are for testing or same-device coordination.",
    "",
    "Access:",
    "  - CLI default: Private with a generated password. The URL alone is not admission.",
    "  - `--public`: anyone with the link can read and join.",
    "  - `--unlisted`: anyone with the link can join; contents stay hidden before join.",
    "  - `--private`: only valid invitees can join.",
    "  - `--password=...`: Private room; a valid invite or password admits.",
    "",
    "Authority:",
    "  - Default invite management: operator-only.",
    "  - Participants may propose options and ask the next question unless the",
    "    room operator changes those settings.",
    "",
    "Identity:",
    "  - `grp profile set-name NAME` sets the default display name for joins.",
    "  - `grp join ROOM --as NAME` overrides it for one room.",
    "",
    "Choices:",
    "  - Default mechanism: simple majority. Others (supermajority, approval,",
    "    ranked, score, quadratic) are chosen at create: grp create --mechanism=...",
    "  - An explicit quorum is an electorate floor: a decision cannot resolve",
    "    with fewer choices in. Two-party mutual assent: `grp create --quorum=2`",
    "    (only 2-0 can pass; a split cannot).",
    "  - Default early close: on. Once the outcome is determined, the room",
    "    resolves instead of waiting for the full choice window.",
    "  - Default option flow: fluid. Participants may propose options while",
    "    choices are open and may revise choices until the outcome is locked.",
    "  - Commas in `grp choose --choice=...` are preserved as exact option text.",
    "    Use `--choices=A,B` for explicit array choices.",
    "  - Use `grp ask ... --collect-options` when a question needs a frozen",
    "    option list before choices open.",
    "  - Use `grp ask ... --agreement` when a question should resolve only when",
    "    every voter accepts the same option (negotiations, contract-style",
    "    sign-offs): disagreement keeps it open, and `grp accept N` is the verb.",
  ].join("\n")}\n`;
}

function resolveIo(io: Partial<QuickstartCliIo>): QuickstartCliIo {
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

async function resolveAbout(flags: Record<string, string>, io: QuickstartCliIo): Promise<string> {
  const explicit = flags.about?.trim();
  if (explicit) return explicit;
  if (!io.isInteractive || isJson(flags)) return "New GRP room";

  io.stdout(
    [
      "Create your first GRP room",
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

function renderQuickstartDone(
  slug: string,
  url: string | undefined,
  about: string,
  access: string,
  firstQuestion: string | undefined,
  generatedPassword?: string,
): string {
  const next = firstQuestion
    ? ["Room commands:", "  grp read", "  grp options", '  grp propose "..."', '  grp choose "..."']
    : ["Room commands:", "  grp read", '  grp ask "..."'];
  return `${[
    "GRP quickstart complete",
    "",
    `Room: ${slug}`,
    ...(url ? [`URL: ${url}`] : []),
    `About: ${about}`,
    `Room access: ${access}`,
    ...(generatedPassword
      ? [
          `Room password: ${generatedPassword}`,
          "Saved in your owner-only GRP config. Share it separately and keep it out of URLs, recordings, screenshots, transcripts, and logs.",
        ]
      : []),
    "Current room: set",
    "",
    ...next,
  ].join("\n")}\n`;
}

function renderQuickstartHelp(): string {
  return `${[
    "Usage: grp quickstart [options]",
    "",
    "Create a first room, remember it as current, and print useful room commands.",
    "",
    "Options:",
    "  --about=TEXT          room description",
    "  --name=NAME           save default display name before joining later",
    "  --ask=TEXT            open the first question immediately",
    "  Default               private room with a generated password",
    "  --unlisted            unlisted room (link holders may join)",
    "  --public              public room",
    "  --private             private invite-only room",
    "  --password=VALUE      private room admitting invite or password",
    "",
    "Examples:",
    "  grp quickstart",
    '  grp quickstart --about="Planning Friday dinner"',
    '  grp quickstart --name="Alex\'s agent" --about="Bug triage" --ask="Pick P0"',
  ].join("\n")}\n`;
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
