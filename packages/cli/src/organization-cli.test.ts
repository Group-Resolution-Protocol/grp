import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type OrganizationCliIo, runOrganizationCli } from "./organization-cli.js";
import { readProviderConfig, updateProviderConfig } from "./provider-config.js";
import type { runRoomCli } from "./room-cli.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: { repository?: string; rooms?: boolean } = {}): {
  root: string;
  manifest: string;
  output: string;
  env: Record<string, string>;
} {
  const root = mkdtempSync(pathJoin(tmpdir(), "grp-org-cli-"));
  roots.push(root);
  mkdirSync(pathJoin(root, "packets"));
  writeFileSync(pathJoin(root, "packets", "mara.md"), "Publish wisely.\n");
  writeFileSync(pathJoin(root, "packets", "mara-first.md"), "Commission a story.\n");
  writeFileSync(pathJoin(root, "packets", "cobalt.md"), "Mind the budget.\n");
  const manifest = pathJoin(root, "organization.yaml");
  writeFileSync(
    manifest,
    [
      "version: 1",
      "name: tiny-house",
      "base_url: https://grp.example",
      ...(options.repository
        ? [
            "workspace:",
            `  repository: ${JSON.stringify(options.repository)}`,
            "  clone: per_persona",
          ]
        : []),
      "personas:",
      "  - id: mara",
      "    instructions: packets/mara.md",
      "    first_day: packets/mara-first.md",
      "    runtime:",
      "      command: claude",
      "      args: [--model, opus]",
      "      prompt: first_day",
      "  - id: cobalt",
      "    display_name: Cobalt Finance",
      "    instructions: packets/cobalt.md",
      "    runtime:",
      "      command: codex",
      "      args: [--model, gpt-5]",
      ...(options.rooms === false
        ? []
        : [
            "rooms:",
            "  - id: greenlight",
            "    creator: mara",
            "    about: Choose a project",
            "    mechanism: score_vote",
            "    settings:",
            "      creator_votes: false",
            "      settle_window: 60",
            "    members:",
            "      - mara",
            "      - persona: cobalt",
            "        role: observer",
          ]),
      "",
    ].join("\n"),
  );
  return {
    root,
    manifest,
    output: pathJoin(root, "company"),
    env: {
      XDG_CONFIG_HOME: pathJoin(root, "config"),
      GRP_NO_INPUT: "1",
    },
  };
}

function roomRunner(calls: string[][], failJoin = { value: false }): typeof runRoomCli {
  return async (argv, io = {}) => {
    calls.push(argv);
    if (argv[0] === "create") {
      io.stdout?.(
        `${JSON.stringify({
          slug: "green123",
          creator_token: "t_creator_secret",
          participant_id: "p_mara",
        })}\n`,
      );
      return 0;
    }
    if (argv[0] === "invite") {
      io.stdout?.(
        `${JSON.stringify({
          invite_token: "it_transient_secret",
          join_url: "https://grp.example/r/green123?invite=it_transient_secret",
        })}\n`,
      );
      return 0;
    }
    if (argv[0] === "join") {
      if (failJoin.value) {
        io.stderr?.("temporary join failure\n");
        return 1;
      }
      io.stdout?.(
        `${JSON.stringify({
          participant_token: "t_joiner_secret",
          participant_id: "p_cobalt",
          role: "observer",
        })}\n`,
      );
      return 0;
    }
    throw new Error(`unexpected room command: ${argv.join(" ")}`);
  };
}

function captureIo(
  fixtureValue: ReturnType<typeof fixture>,
  overrides: Partial<OrganizationCliIo> = {},
): {
  io: Partial<OrganizationCliIo>;
  stdout: () => string;
  stderr: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      cwd: fixtureValue.root,
      env: fixtureValue.env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      ...overrides,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("grp org", () => {
  it("validates a manifest without creating its output root", async () => {
    const value = fixture();
    const capture = captureIo(value);

    const code = await runOrganizationCli(["validate", value.manifest, "--json"], capture.io);

    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout())).toMatchObject({
      valid: true,
      organization: "tiny-house",
      personas: ["mara", "cobalt"],
      rooms: ["greenlight"],
    });
    expect(existsSync(value.output)).toBe(false);
  });

  // Spec 174 — discovery-driven mechanism policy: --host makes the target
  // host's advertised mechanisms_supported authoritative.
  it("validate --host passes when the host supports every manifest mechanism", async () => {
    const value = fixture();
    const capture = captureIo(value, {
      fetch: (async (url: string | URL | Request) => {
        expect(String(url)).toBe("https://host.example/.well-known/grp.json");
        return new Response(
          JSON.stringify({ mechanisms_supported: ["simple_majority", "score_vote"] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });

    const code = await runOrganizationCli(
      ["validate", value.manifest, "--host=https://host.example", "--json"],
      capture.io,
    );

    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout())).toMatchObject({
      valid: true,
      mechanisms_checked_against: "https://host.example",
    });
  });

  it("validate --host fails when the host does not advertise a manifest mechanism", async () => {
    const value = fixture();
    const capture = captureIo(value, {
      fetch: (async () =>
        new Response(JSON.stringify({ mechanisms_supported: ["ranked_choice"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    const code = await runOrganizationCli(
      ["validate", value.manifest, "--host=https://host.example"],
      capture.io,
    );

    expect(code).toBe(1);
    expect(capture.stderr()).toContain("does not support");
    expect(capture.stderr()).toContain("score_vote");
  });

  it("plans a complete create with no config, Git, room, or filesystem mutation", async () => {
    const value = fixture({ repository: "git@github.com:owner/private-company.git" });
    let personaCalls = 0;
    let roomCalls = 0;
    let gitCalls = 0;
    const capture = captureIo(value, {
      runPersona: async () => {
        personaCalls += 1;
        return 0;
      },
      runRoom: async () => {
        roomCalls += 1;
        return 0;
      },
      execFile: () => {
        gitCalls += 1;
        return "";
      },
    });

    const code = await runOrganizationCli(
      ["create", value.manifest, `--output=${value.output}`, "--dry-run", "--json"],
      capture.io,
    );

    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout())).toMatchObject({
      mode: "dry_run",
      organization: "tiny-house",
      mutates: false,
      launches: false,
    });
    expect({ personaCalls, roomCalls, gitCalls }).toEqual({
      personaCalls: 0,
      roomCalls: 0,
      gitCalls: 0,
    });
    expect(existsSync(value.output)).toBe(false);
  });

  it("creates private personas, packets, room topology, state, and launchers", async () => {
    const value = fixture();
    const calls: string[][] = [];
    const capture = captureIo(value, {
      runRoom: roomRunner(calls),
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    });

    const code = await runOrganizationCli(
      ["create", value.manifest, `--output=${value.output}`, "--json"],
      capture.io,
    );

    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout())).toMatchObject({
      organization: "tiny-house",
      ready: true,
      rooms: [{ id: "greenlight", slug: "green123", joined: 2, expected: 2 }],
    });
    expect(readFileSync(pathJoin(value.output, "mara", ".grp", "persona"), "utf8")).toBe("mara\n");
    expect(
      readFileSync(
        pathJoin(value.output, "mara", ".grp", "organization", "instructions.md"),
        "utf8",
      ),
    ).toBe("Publish wisely.\n");
    const launcher = readFileSync(pathJoin(value.output, ".grp", "launch", "mara.command"), "utf8");
    expect(launcher).toContain("unset GRP_SESSION GRP_CONFIG GRP_AS_ACTIVE");
    const organizationConfigHome = pathJoin(value.output, ".grp", "config");
    expect(launcher).toContain(`export XDG_CONFIG_HOME='${organizationConfigHome}'`);
    expect(launcher).toContain("'claude' '--model' 'opus'");
    expect(launcher).toContain("You are Mara (GRP persona mara).");
    expect(launcher).toContain("Read your private instructions at ");
    expect(launcher).toContain("instructions.md.");
    expect(launcher).toContain("Read your first-day brief at ");
    expect(launcher).toContain("first-day.md.");
    expect(launcher).toContain("Use the installed grp command-line client for GRP rooms");
    expect(launcher).toContain("keep using grp read and grp watch until your first-day brief");
    expect(launcher).toContain("Your final response terminates this one-shot process permanently");
    expect(launcher).toContain("Never use Monitor, TaskCreate, TaskUpdate, run_in_background");
    expect(launcher).toContain("stop it and continue here before returning a final response");
    expect(statSync(value.output).mode & 0o777).toBe(0o700);
    expect(statSync(pathJoin(value.output, ".grp", "organization.json")).mode & 0o777).toBe(0o600);
    expect(statSync(pathJoin(organizationConfigHome, "grp", "config.json")).mode & 0o777).toBe(
      0o600,
    );
    expect(statSync(pathJoin(value.output, ".grp", "launch", "mara.command")).mode & 0o777).toBe(
      0o700,
    );
    const state = readFileSync(pathJoin(value.output, ".grp", "organization.json"), "utf8");
    expect(state).not.toContain("t_creator_secret");
    expect(state).not.toContain("it_transient_secret");
    expect(state).not.toContain("t_joiner_secret");
    expect(calls.map((argv) => argv[0])).toEqual(["create", "invite", "join"]);
    expect(calls[0]).toContain("--type=persistent");
    expect(calls[0]).toContain("--visibility=private");
    expect(calls[0]).toContain("--mechanism=score_vote");
    expect(calls[0]).toContain("--creator-votes=false");
    expect(calls[0]).toContain("--settle-window=60");
    expect(calls[1]).toContain("--role=observer");
  });

  it("isolates repeated persona ids and room credentials between organization roots", async () => {
    const value = fixture();
    const firstOutput = pathJoin(value.root, "company-one");
    const secondOutput = pathJoin(value.root, "company-two");
    updateProviderConfig(
      () => ({
        defaultProvider: "acme",
        providers: {
          acme: { name: "acme", baseUrl: "https://grp.acme.example" },
        },
        auth: {
          baseUrl: "https://grp.acme.example",
          accessToken: "old-global-access-token",
          mandate: "old-global-mandate",
          savedAt: "2026-08-15T00:00:00.000Z",
        },
        sessions: {
          mara: {
            currentRoom: {
              provider: "acme",
              slug: "old-global-room",
              token: "old-global-room-token",
            },
          },
        },
      }),
      value.env,
      { scope: "global" },
    );
    let roomNumber = 0;
    let activeRoom = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/rooms") {
        roomNumber += 1;
        activeRoom = roomNumber;
        return Response.json({
          slug: `green-${roomNumber}`,
          creator_token: `creator-${roomNumber}`,
          participant_id: `mara-${roomNumber}`,
        });
      }
      if (request.method === "POST" && url.pathname === `/api/rooms/green-${activeRoom}/invites`) {
        return Response.json({
          invite_token: `invite-${activeRoom}`,
          join_url: `https://grp.example/r/green-${activeRoom}?invite=invite-${activeRoom}`,
        });
      }
      if (request.method === "POST" && url.pathname === `/api/rooms/green-${activeRoom}/join`) {
        return Response.json({
          participant_token: `joiner-${activeRoom}`,
          participant_id: `cobalt-${activeRoom}`,
          role: "observer",
        });
      }
      throw new Error(`unexpected room request: ${request.method} ${request.url}`);
    };

    for (const output of [firstOutput, secondOutput]) {
      const capture = captureIo(value, { fetch });
      const code = await runOrganizationCli(
        ["create", value.manifest, `--output=${output}`, "--json"],
        capture.io,
      );
      if (code !== 0) throw new Error(capture.stderr());
      expect(code).toBe(0);
    }

    const firstConfig = readProviderConfig(
      { XDG_CONFIG_HOME: pathJoin(firstOutput, ".grp", "config") },
      { scope: "global" },
    );
    const secondConfig = readProviderConfig(
      { XDG_CONFIG_HOME: pathJoin(secondOutput, ".grp", "config") },
      { scope: "global" },
    );
    const globalConfig = readProviderConfig(value.env, { scope: "global" });

    expect(Object.values(firstConfig.sessions?.mara?.rooms ?? {}).map((room) => room.slug)).toEqual(
      ["green-1"],
    );
    expect(
      Object.values(secondConfig.sessions?.mara?.rooms ?? {}).map((room) => room.slug),
    ).toEqual(["green-2"]);
    expect(firstConfig.defaultProvider).toBe("acme");
    expect(firstConfig.providers).toEqual({
      acme: { name: "acme", baseUrl: "https://grp.acme.example" },
    });
    expect(firstConfig.auth).toBeUndefined();
    expect(secondConfig.auth).toBeUndefined();
    expect(JSON.stringify(firstConfig)).not.toContain("old-global");
    expect(JSON.stringify(secondConfig)).not.toContain("old-global");
    expect(globalConfig.sessions?.mara?.currentRoom?.slug).toBe("old-global-room");
    expect(globalConfig.auth?.accessToken).toBe("old-global-access-token");
    expect(readFileSync(pathJoin(firstOutput, "mara", ".grp", "persona"), "utf8")).toBe("mara\n");
    expect(readFileSync(pathJoin(secondOutput, "mara", ".grp", "persona"), "utf8")).toBe("mara\n");
  });

  it("resumes after a transient join failure without creating a replacement room", async () => {
    const value = fixture();
    const calls: string[][] = [];
    const failJoin = { value: true };
    const capture1 = captureIo(value, { runRoom: roomRunner(calls, failJoin) });

    const first = await runOrganizationCli(
      ["create", value.manifest, `--output=${value.output}`],
      capture1.io,
    );
    expect(first).toBe(1);
    expect(capture1.stderr()).toContain("temporary join failure");
    const failedState = readFileSync(pathJoin(value.output, ".grp", "organization.json"), "utf8");
    expect(failedState).not.toContain("it_transient_secret");

    failJoin.value = false;
    const capture2 = captureIo(value, { runRoom: roomRunner(calls, failJoin) });
    const second = await runOrganizationCli(
      ["create", value.manifest, `--output=${value.output}`, "--json"],
      capture2.io,
    );

    expect(second).toBe(0);
    expect(calls.filter((argv) => argv[0] === "create")).toHaveLength(1);
    expect(calls.filter((argv) => argv[0] === "invite")).toHaveLength(2);
    expect(calls.filter((argv) => argv[0] === "join")).toHaveLength(2);
  });

  it("reconciles an identical create without repeating completed remote work", async () => {
    const value = fixture();
    const calls: string[][] = [];
    const runner = roomRunner(calls);
    const firstCapture = captureIo(value, { runRoom: runner });
    expect(
      await runOrganizationCli(
        ["create", value.manifest, `--output=${value.output}`],
        firstCapture.io,
      ),
    ).toBe(0);

    const secondCapture = captureIo(value, { runRoom: runner });
    expect(
      await runOrganizationCli(
        ["create", value.manifest, `--output=${value.output}`],
        secondCapture.io,
      ),
    ).toBe(0);

    expect(calls.map((argv) => argv[0])).toEqual(["create", "invite", "join"]);
  });

  it("clones a caller-supplied local repository once per persona", async () => {
    const value = fixture({ rooms: false });
    const bare = pathJoin(value.root, "private-company.git");
    execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
    writeFileSync(
      value.manifest,
      readFileSync(value.manifest, "utf8").replace(
        "base_url: https://grp.example",
        `base_url: https://grp.example\nworkspace:\n  repository: ${JSON.stringify(bare)}\n  clone: per_persona`,
      ),
    );
    const capture = captureIo(value);

    const code = await runOrganizationCli(
      ["create", value.manifest, `--output=${value.output}`],
      capture.io,
    );

    expect(code).toBe(0);
    expect(existsSync(pathJoin(value.output, "mara", "company", ".git"))).toBe(true);
    expect(existsSync(pathJoin(value.output, "cobalt", "company", ".git"))).toBe(true);
  });

  it("reports status without claiming process or work state", async () => {
    const value = fixture({ rooms: false });
    const createCapture = captureIo(value);
    expect(
      await runOrganizationCli(
        ["create", value.manifest, `--output=${value.output}`],
        createCapture.io,
      ),
    ).toBe(0);
    const statusCapture = captureIo(value);

    const code = await runOrganizationCli(["status", value.output], statusCapture.io);

    expect(code).toBe(0);
    expect(statusCapture.stdout()).toContain("State: ready");
    expect(statusCapture.stdout()).not.toMatch(/alive|idle|complete work|correct/i);
  });

  it("dry-runs or opens visible launch scripts once without supervision", async () => {
    const value = fixture({ rooms: false });
    const createCapture = captureIo(value);
    expect(
      await runOrganizationCli(
        ["create", value.manifest, `--output=${value.output}`],
        createCapture.io,
      ),
    ).toBe(0);

    const opened: string[] = [];
    const dryCapture = captureIo(value, {
      platform: "darwin",
      openTerminal: (path) => opened.push(path),
    });
    expect(
      await runOrganizationCli(["launch", value.output, "--dry-run", "--json"], dryCapture.io),
    ).toBe(0);
    expect(opened).toEqual([]);
    expect(JSON.parse(dryCapture.stdout())).toMatchObject({
      mode: "dry_run",
      supervised: false,
    });

    const liveCapture = captureIo(value, {
      platform: "darwin",
      openTerminal: (path) => opened.push(path),
    });
    expect(await runOrganizationCli(["launch", value.output], liveCapture.io)).toBe(0);
    expect(opened).toHaveLength(2);
    expect(liveCapture.stdout()).toContain("not monitoring, scheduling, or restarting");
  });
});
