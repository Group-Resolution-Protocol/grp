import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { describe, expect, it } from "vitest";
import { runPersonaCli } from "./persona-cli.js";
import {
  readProviderConfig,
  resolveLocalSession,
  setLocalSession,
  updateProviderConfig,
} from "./provider-config.js";
import { runSessionCli } from "./session-cli.js";

const PERSONA_CLI_MODULE_URL = new URL("./persona-cli.ts", import.meta.url).href;

describe("GRP CLI workspace personas", () => {
  it("sets up a local team with one command and resolves each nested identity", async () => {
    const harness = tempHarness();
    const teamRoot = pathJoin(harness.root, "company");

    const result = await runPersona(
      ["setup", teamRoot, "silica=Editorial Director", "cobalt=Finance Lead", "research-analyst"],
      harness,
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Persona workspaces ready: ${teamRoot}`);
    expect(result.stdout).toContain("Editorial Director (silica)");
    expect(result.stdout).toContain("Finance Lead (cobalt)");
    expect(result.stdout).toContain("Research Analyst (research-analyst)");

    const expected = [
      ["silica", "Editorial Director"],
      ["cobalt", "Finance Lead"],
      ["research-analyst", "Research Analyst"],
    ] as const;
    const config = readProviderConfig(harness.env, { scope: "global" });
    for (const [name, displayName] of expected) {
      const workspace = pathJoin(teamRoot, name);
      expect(readFileSync(pathJoin(workspace, ".grp", "persona"), "utf8")).toBe(`${name}\n`);
      expect(resolveLocalSession(config, name)?.profile?.displayName).toBe(displayName);

      const child = pathJoin(workspace, "projects", "current");
      mkdirSync(child, { recursive: true });
      const shown = await runPersona(["show", "--json"], harness, { cwd: child });
      expect(shown.code).toBe(0);
      expect(JSON.parse(shown.stdout)).toMatchObject({
        persona: name,
        display_name: displayName,
        source: "workspace",
        marker_path: pathJoin(workspace, ".grp", "persona"),
      });
    }
  });

  it("renders stable setup JSON for scripts", async () => {
    const harness = tempHarness();
    const teamRoot = pathJoin(harness.root, "company");

    const result = await runPersona(
      ["setup", teamRoot, "silica=Editorial Director", "cobalt", "--json"],
      harness,
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      root: teamRoot,
      config_path: harness.configPath,
      personas: [
        {
          persona: "silica",
          display_name: "Editorial Director",
          workspace: pathJoin(teamRoot, "silica"),
          marker_path: pathJoin(teamRoot, "silica", ".grp", "persona"),
        },
        {
          persona: "cobalt",
          display_name: "Cobalt",
          workspace: pathJoin(teamRoot, "cobalt"),
          marker_path: pathJoin(teamRoot, "cobalt", ".grp", "persona"),
        },
      ],
    });
  });

  it("reconciles an identical setup without losing existing persona state", async () => {
    const harness = tempHarness();
    const teamRoot = pathJoin(harness.root, "company");
    expect(
      (
        await runPersona(
          ["setup", teamRoot, "silica=Editorial Director", "cobalt=Finance Lead"],
          harness,
        )
      ).code,
    ).toBe(0);

    updateProviderConfig(
      (config) =>
        setLocalSession(config, "silica", {
          ...(resolveLocalSession(config, "silica") ?? {}),
          currentRoom: {
            provider: "acme",
            slug: "commissioning",
            token: "commissioning-token",
            lastSeenSeq: 41,
          },
          rooms: {
            commissioning: {
              provider: "acme",
              slug: "commissioning",
              token: "commissioning-token",
              lastSeenSeq: 41,
            },
          },
        }),
      harness.env,
      { scope: "global" },
    );

    const rerun = await runPersona(
      ["setup", teamRoot, "silica=Editor in Chief", "cobalt=Finance Lead"],
      harness,
    );

    expect(rerun.code).toBe(0);
    const silica = resolveLocalSession(
      readProviderConfig(harness.env, { scope: "global" }),
      "silica",
    );
    expect(silica?.profile?.displayName).toBe("Editor in Chief");
    expect(silica?.currentRoom).toMatchObject({
      slug: "commissioning",
      token: "commissioning-token",
      lastSeenSeq: 41,
    });
    expect(Object.values(silica?.rooms ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          token: "commissioning-token",
          lastSeenSeq: 41,
        }),
      ]),
    );
  });

  it("rejects duplicate normalized names before creating the setup root", async () => {
    const harness = tempHarness();
    const teamRoot = pathJoin(harness.root, "company");

    const result = await runPersona(["setup", teamRoot, "Silica", "silica"], harness);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('duplicate persona in setup: "silica"');
    expect(existsSync(teamRoot)).toBe(false);
  });

  it("fails a batch safely when an existing workspace marker conflicts", async () => {
    const harness = tempHarness();
    const teamRoot = pathJoin(harness.root, "company");
    const silicaMarker = pathJoin(teamRoot, "silica", ".grp", "persona");
    mkdirSync(pathJoin(teamRoot, "silica", ".grp"), { recursive: true });
    writeFileSync(silicaMarker, "cobalt\n", "utf8");

    const result = await runPersona(["setup", teamRoot, "silica", "reviewer"], harness);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('already bound to persona "cobalt"');
    const config = readProviderConfig(harness.env, { scope: "global" });
    expect(resolveLocalSession(config, "silica")).toBeUndefined();
    expect(resolveLocalSession(config, "reviewer")).toBeUndefined();
    expect(existsSync(pathJoin(teamRoot, "reviewer", ".grp", "persona"))).toBe(false);
  });

  it("fails a batch safely when a marker is malformed", async () => {
    const harness = tempHarness();
    const teamRoot = pathJoin(harness.root, "company");
    const silicaMarker = pathJoin(teamRoot, "silica", ".grp", "persona");
    mkdirSync(pathJoin(teamRoot, "silica", ".grp"), { recursive: true });
    writeFileSync(silicaMarker, "not a persona name\n", "utf8");

    const result = await runPersona(["setup", teamRoot, "silica", "reviewer"], harness);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`invalid workspace persona marker at ${silicaMarker}`);
    const config = readProviderConfig(harness.env, { scope: "global" });
    expect(resolveLocalSession(config, "silica")).toBeUndefined();
    expect(resolveLocalSession(config, "reviewer")).toBeUndefined();
  });

  it("fails a batch safely when a persona marker is already tracked by Git", async () => {
    const harness = tempHarness();
    const teamRoot = pathJoin(harness.cwd, "company");
    const marker = pathJoin(teamRoot, "silica", ".grp", "persona");
    execFileSync("git", ["init", "--quiet", harness.cwd]);
    mkdirSync(pathJoin(teamRoot, "silica", ".grp"), { recursive: true });
    writeFileSync(marker, "silica\n", "utf8");
    execFileSync("git", ["-C", harness.cwd, "add", "company/silica/.grp/persona"]);

    const result = await runPersona(["setup", teamRoot, "silica", "reviewer"], harness);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("already tracked by Git");
    const config = readProviderConfig(harness.env, { scope: "global" });
    expect(resolveLocalSession(config, "silica")).toBeUndefined();
    expect(resolveLocalSession(config, "reviewer")).toBeUndefined();
  });

  it.each([
    ["GRP_SESSION", "operator"],
    ["GRP_CONFIG", "explicit-config.json"],
  ] as const)("refuses setup while %s overrides workspace personas", async (key, value) => {
    const harness = tempHarness();
    const teamRoot = pathJoin(harness.root, "company");
    const env = {
      ...harness.env,
      [key]: key === "GRP_CONFIG" ? pathJoin(harness.root, value) : value,
    };

    const result = await runPersona(["setup", teamRoot, "silica"], harness, { env });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${key} overrides workspace personas`);
    expect(existsSync(teamRoot)).toBe(false);
  });

  it("rejects non-directory setup roots and persona workspaces", async () => {
    const harness = tempHarness();
    const rootFile = pathJoin(harness.root, "company-file");
    writeFileSync(rootFile, "occupied\n", "utf8");

    const badRoot = await runPersona(["setup", rootFile, "silica"], harness);
    expect(badRoot.code).toBe(1);
    expect(badRoot.stderr).toContain("persona workspace path is not a regular directory");

    const teamRoot = pathJoin(harness.root, "company");
    mkdirSync(teamRoot);
    writeFileSync(pathJoin(teamRoot, "silica"), "occupied\n", "utf8");
    const badWorkspace = await runPersona(["setup", teamRoot, "silica"], harness);
    expect(badWorkspace.code).toBe(1);
    expect(badWorkspace.stderr).toContain("persona workspace path is not a regular directory");
  });

  it("initializes a marker and its backing local session", async () => {
    const harness = tempHarness();
    const result = await runPersona(["init", "Silica", "--name", "Silica", "--json"], harness);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      persona: "silica",
      display_name: "Silica",
      marker_path: harness.markerPath,
      config_path: harness.configPath,
    });
    expect(readFileSync(harness.markerPath, "utf8")).toBe("silica\n");
    expect(
      resolveLocalSession(readProviderConfig(harness.env, { scope: "global" }), "silica"),
    ).toEqual({ profile: { displayName: "Silica" } });
  });

  it("keeps the machine-local marker out of Git commits", async () => {
    const harness = tempHarness();
    execFileSync("git", ["init", "--quiet", harness.cwd]);

    const result = await runPersona(["init", "silica", "--name", "Silica"], harness);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(readFileSync(pathJoin(harness.cwd, ".git", "info", "exclude"), "utf8")).toContain(
      "**/.grp/persona",
    );
    const untracked = execFileSync(
      "git",
      ["-C", harness.cwd, "status", "--short", "--untracked-files=all"],
      { encoding: "utf8" },
    );
    expect(untracked).not.toContain(".grp/persona");
  });

  it("creates Git's local info/exclude path when the repository does not have one", async () => {
    const harness = tempHarness();
    execFileSync("git", ["init", "--quiet", harness.cwd]);
    const excludePath = pathJoin(harness.cwd, ".git", "info", "exclude");
    rmSync(pathJoin(harness.cwd, ".git", "info"), { recursive: true, force: true });

    const result = await runPersona(["init", "silica"], harness);

    expect(result.code).toBe(0);
    expect(readFileSync(excludePath, "utf8")).toContain("**/.grp/persona");
  });

  it("refuses to initialize when the marker is already tracked by Git", async () => {
    const harness = tempHarness();
    execFileSync("git", ["init", "--quiet", harness.cwd]);
    mkdirSync(pathJoin(harness.cwd, ".grp"), { recursive: true });
    writeFileSync(harness.markerPath, "silica\n", "utf8");
    execFileSync("git", ["-C", harness.cwd, "add", ".grp/persona"]);

    const result = await runPersona(["init", "silica", "--name", "Silica"], harness);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("already tracked by Git");
    expect(result.stderr).toContain("git rm --cached");
    expect(
      resolveLocalSession(readProviderConfig(harness.env, { scope: "global" }), "silica"),
    ).toBeUndefined();
  });

  it("serializes concurrent initialization so only one different binding succeeds", async () => {
    const harness = tempHarness();
    const [silica, cobalt] = await Promise.all([
      runPersonaProcess("silica", harness),
      runPersonaProcess("cobalt", harness),
    ]);

    expect([silica.code, cobalt.code].sort()).toEqual([0, 1]);
    const winner = readFileSync(harness.markerPath, "utf8").trim();
    expect(["silica", "cobalt"]).toContain(winner);
    const loser = winner === "silica" ? "cobalt" : "silica";
    const config = readProviderConfig(harness.env, { scope: "global" });
    expect(resolveLocalSession(config, winner)).toBeDefined();
    expect(resolveLocalSession(config, loser)).toBeUndefined();
    expect(`${silica.stderr}${cobalt.stderr}`).toContain("already bound to persona");
  });

  it("reuses an existing persona without losing rooms, credentials, or read marks", async () => {
    const harness = tempHarness();
    expect((await runPersona(["init", "silica", "--name", "Silica"], harness)).code).toBe(0);

    updateProviderConfig(
      (config) =>
        setLocalSession(config, "silica", {
          profile: { displayName: "Silica" },
          currentRoom: {
            provider: "acme",
            slug: "commissioning",
            token: "commissioning-token",
            lastSeenSeq: 41,
          },
          rooms: {
            commissioning: {
              provider: "acme",
              slug: "commissioning",
              token: "commissioning-token",
              lastSeenSeq: 41,
            },
            drafting: {
              provider: "acme",
              slug: "drafting",
              token: "drafting-token",
              lastSeenSeq: 17,
            },
          },
        }),
      harness.env,
      { scope: "global" },
    );

    const result = await runPersona(["init", "silica"], harness);
    expect(result.code).toBe(0);

    const session = resolveLocalSession(
      readProviderConfig(harness.env, { scope: "global" }),
      "silica",
    );
    expect(session?.profile).toEqual({ displayName: "Silica" });
    expect(session?.currentRoom).toMatchObject({
      slug: "commissioning",
      token: "commissioning-token",
      lastSeenSeq: 41,
    });
    expect(Object.values(session?.rooms ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: "commissioning",
          token: "commissioning-token",
          lastSeenSeq: 41,
        }),
        expect.objectContaining({
          slug: "drafting",
          token: "drafting-token",
          lastSeenSeq: 17,
        }),
      ]),
    );
    expect(readFileSync(harness.markerPath, "utf8")).toBe("silica\n");
  });

  it("guards an existing binding and only rebinds it with --force", async () => {
    const harness = tempHarness();
    expect((await runPersona(["init", "silica", "--name", "Silica"], harness)).code).toBe(0);

    const refused = await runPersona(["init", "cobalt", "--name", "Cobalt"], harness);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('already bound to persona "silica"');
    expect(refused.stderr).toContain("--force");
    expect(readFileSync(harness.markerPath, "utf8")).toBe("silica\n");
    expect(
      resolveLocalSession(readProviderConfig(harness.env, { scope: "global" }), "cobalt"),
    ).toBeUndefined();

    const forced = await runPersona(["init", "cobalt", "--name", "Cobalt", "--force"], harness);
    expect(forced.code).toBe(0);
    expect(readFileSync(harness.markerPath, "utf8")).toBe("cobalt\n");
    const config = readProviderConfig(harness.env, { scope: "global" });
    expect(resolveLocalSession(config, "silica")?.profile?.displayName).toBe("Silica");
    expect(resolveLocalSession(config, "cobalt")?.profile?.displayName).toBe("Cobalt");
  });

  it("parses --force before the persona name without consuming it", async () => {
    const harness = tempHarness();
    expect((await runPersona(["init", "silica"], harness)).code).toBe(0);

    const rebound = await runPersona(["init", "--force", "cobalt"], harness);

    expect(rebound.code).toBe(0);
    expect(readFileSync(harness.markerPath, "utf8")).toBe("cobalt\n");
  });

  it.each([
    ["GRP_SESSION", "operator"],
    ["GRP_CONFIG", "explicit-config.json"],
  ] as const)("refuses initialization while %s overrides marker selection", async (key, value) => {
    const harness = tempHarness();
    const env = {
      ...harness.env,
      [key]: key === "GRP_CONFIG" ? pathJoin(harness.root, value) : value,
    };

    const result = await runPersona(["init", "silica"], { ...harness, env });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${key} overrides workspace personas`);
    expect(result.stderr).toContain("unset it");
    expect(existsSync(harness.markerPath)).toBe(false);
  });

  it("shows the nearest workspace persona in human and JSON forms", async () => {
    const harness = tempHarness();
    expect((await runPersona(["init", "silica", "--name", "Silica"], harness)).code).toBe(0);
    updateProviderConfig(
      (config) =>
        setLocalSession(config, "silica", {
          ...(resolveLocalSession(config, "silica") ?? {}),
          currentRoom: { provider: "acme", slug: "drafting" },
        }),
      harness.env,
      { scope: "global" },
    );
    const child = pathJoin(harness.cwd, "titles", "salt-ledger");
    mkdirSync(child, { recursive: true });

    const human = await runPersona(["show"], { ...harness, cwd: child });
    expect(human.code).toBe(0);
    expect(human.stdout.startsWith("You are Silica here (persona: silica).\n")).toBe(true);
    expect(human.stdout).toContain(`Source: workspace marker ${harness.markerPath}`);
    expect(human.stdout).toContain("Current room: drafting");
    expect(human.stdout).toContain(`Config: ${harness.configPath}`);

    const json = await runPersona(["show", "--json"], { ...harness, cwd: child });
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      persona: "silica",
      display_name: "Silica",
      source: "workspace",
      marker_path: harness.markerPath,
      current_room: "drafting",
      config_path: harness.configPath,
    });
  });

  it("fails closed on a malformed nearest marker", async () => {
    const harness = tempHarness();
    mkdirSync(pathJoin(harness.cwd, ".grp"), { recursive: true });
    writeFileSync(harness.markerPath, "not a persona name\n", "utf8");

    const result = await runPersona(["show"], harness);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`invalid workspace persona marker at ${harness.markerPath}`);
    expect(result.stderr).toContain("session name must be");
    expect(result.stderr).toContain("grp persona init NAME --force");
  });

  it("repairs a malformed regular marker only when init uses --force", async () => {
    const harness = tempHarness();
    mkdirSync(pathJoin(harness.cwd, ".grp"), { recursive: true });
    writeFileSync(harness.markerPath, "not a persona name\n", "utf8");

    const refused = await runPersona(["init", "silica"], harness);
    expect(refused.code).toBe(1);
    expect(readFileSync(harness.markerPath, "utf8")).toBe("not a persona name\n");

    const repaired = await runPersona(["init", "silica", "--force"], harness);
    expect(repaired.code).toBe(0);
    expect(readFileSync(harness.markerPath, "utf8")).toBe("silica\n");
    expect(
      resolveLocalSession(readProviderConfig(harness.env, { scope: "global" }), "silica"),
    ).toBeDefined();
  });

  it("fails closed when a marker names an unknown local session", async () => {
    const harness = tempHarness();
    mkdirSync(pathJoin(harness.cwd, ".grp"), { recursive: true });
    writeFileSync(harness.markerPath, "ghost\n", "utf8");

    const result = await runPersona(["show"], harness);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      `workspace persona "ghost" from ${harness.markerPath} does not exist`,
    );
    expect(result.stderr).toContain("grp persona init ghost");
  });

  it("keeps session-registry administration global inside a persona workspace", async () => {
    const harness = tempHarness();
    expect((await runPersona(["init", "silica", "--name", "Silica"], harness)).code).toBe(0);
    const child = pathJoin(harness.cwd, "company");
    mkdirSync(child, { recursive: true });
    const originalCwd = process.cwd();
    let stdout = "";

    try {
      process.chdir(child);
      const code = await runSessionCli(["create", "cobalt", "--name", "Cobalt", "--json"], {
        env: { ...harness.env, GRP_SESSION: "silica" },
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
      });
      expect(code).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    expect(JSON.parse(stdout)).toEqual({
      name: "cobalt",
      display_name: "Cobalt",
      current_room: null,
    });
    const config = readProviderConfig(harness.env, { scope: "global" });
    expect(resolveLocalSession(config, "silica")?.profile?.displayName).toBe("Silica");
    expect(resolveLocalSession(config, "cobalt")?.profile?.displayName).toBe("Cobalt");
    expect(readFileSync(harness.markerPath, "utf8")).toBe("silica\n");
  });
});

interface PersonaHarness {
  root: string;
  cwd: string;
  markerPath: string;
  configPath: string;
  env: Record<string, string | undefined>;
}

async function runPersonaProcess(
  name: string,
  harness: PersonaHarness,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const source = `
    const mod = await import(process.env.PERSONA_CLI_MODULE_URL);
    const code = await mod.runPersonaCli(
      ["init", process.env.TEST_PERSONA, "--name", process.env.TEST_PERSONA],
      {
        cwd: process.env.TEST_CWD,
        env: { XDG_CONFIG_HOME: process.env.TEST_XDG_CONFIG_HOME },
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
      },
    );
    process.exitCode = code;
  `;
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PERSONA_CLI_MODULE_URL,
          TEST_PERSONA: name,
          TEST_CWD: harness.cwd,
          TEST_XDG_CONFIG_HOME: pathJoin(harness.root, "xdg"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (typeof code === "number") resolve({ code, stdout, stderr });
      else reject(new Error(`persona worker exited by signal ${signal}`));
    });
  });
}

function tempHarness(): PersonaHarness {
  const root = mkdtempSync(pathJoin(tmpdir(), "grp-persona-test-"));
  const cwd = pathJoin(root, "workspace");
  const xdgConfigHome = pathJoin(root, "xdg");
  mkdirSync(cwd, { recursive: true });
  return {
    root,
    cwd,
    markerPath: pathJoin(cwd, ".grp", "persona"),
    configPath: pathJoin(xdgConfigHome, "grp", "config.json"),
    env: { XDG_CONFIG_HOME: xdgConfigHome },
  };
}

async function runPersona(
  argv: string[],
  harness: PersonaHarness,
  overrides: {
    cwd?: string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runPersonaCli(argv, {
    env: overrides.env ?? harness.env,
    cwd: overrides.cwd ?? harness.cwd,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}
