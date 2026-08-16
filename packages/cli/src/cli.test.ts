import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFlags, runCli } from "./cli.js";

describe("parseFlags", () => {
  it("parses --key=value and bare --flag", () => {
    expect(parseFlags(["--players=5", "--deliberation=on", "--verbose"])).toEqual({
      players: "5",
      deliberation: "on",
      verbose: "true",
    });
  });
  it("ignores positional args", () => {
    expect(parseFlags(["foo", "--a=1", "bar"])).toEqual({ a: "1" });
  });
});

describe("top-level help", () => {
  it("shows the public GRP surface without operator or lab commands", async () => {
    const stdout = await captureStdout(() => runCli(["--help"]));

    expect(stdout).toContain("GRP lets agents coordinate and do work together");
    expect(stdout).toContain(
      "Discussion works through an issue. A decision records the outcome the group can rely on later.",
    );
    expect(stdout).toContain("host list");
    expect(stdout).not.toContain("quickstart");
    expect(stdout).toContain("ask TEXT");
    expect(stdout).toContain("start choosing");
    expect(stdout).toContain("choose N|TEXT");
    expect(stdout).toContain("invite [ROOM]");
    expect(stdout).toContain("members [ROOM]");
    expect(stdout).toContain("settings [ROOM]");
    expect(stdout).toContain("rooms                 list rooms remembered");
    expect(stdout).toContain("inbox                 check remembered rooms");
    // Specs 154/158 — sticky identity and one-command team setup are public concepts.
    expect(stdout).toContain("persona setup ROOT");
    expect(stdout).toContain("persona init NAME");
    expect(stdout).toContain("org create");
    expect(stdout.indexOf("org create")).toBeLessThan(stdout.indexOf("persona setup ROOT"));
    expect(stdout.indexOf("persona setup ROOT")).toBeLessThan(stdout.indexOf("persona init NAME"));
    expect(stdout.indexOf("persona init NAME")).toBeLessThan(stdout.indexOf("Hosts:"));
    // Spec 112 — operator maneuvers live in advanced help only.
    expect(stdout).not.toContain("Local Sessions");
    expect(stdout).not.toContain("session create");
    expect(stdout).not.toContain("as NAME");
    expect(stdout).not.toContain("enter ROOM");
    expect(stdout).not.toContain("settings set");
    expect(stdout).not.toContain("arena-setup");
    expect(stdout).not.toContain("run-matrix");
  });

  it("keeps operator commands in advanced help without any experiment surface", async () => {
    const stdout = await captureStdout(() => runCli(["help", "advanced"]));

    // Specs 154/158 keep the workspace surface visible while retaining the
    // lower-level spec-093 session escape hatch for scripts and operators.
    expect(stdout).toContain("persona setup ROOT");
    expect(stdout).toContain("persona init NAME");
    expect(stdout).toContain("session create NAME");
    expect(stdout).toContain("as NAME <command>");
    expect(stdout.indexOf("persona setup ROOT")).toBeLessThan(stdout.indexOf("persona init NAME"));
    expect(stdout.indexOf("persona init NAME")).toBeLessThan(stdout.indexOf("session create NAME"));
    expect(stdout).toContain("enter ROOM");
    expect(stdout).toContain("settings set KEY VALUE");
    expect(stdout).toContain("members set-role");
    expect(stdout).toContain("timeline");
    expect(stdout).toContain("quickstart");
    // Spec 112 — the chess rig and dogfood tooling appear in NO help surface.
    for (const leaked of [
      "test-setup",
      "arena-setup",
      "arena-agents",
      "persistent-agents",
      "autonomous-agents",
      "chess-host",
      "annotate-trial",
      "run-matrix",
      "dogfood",
      "Stockfish",
      "stockfish",
      "CHESS_ADMIN_SECRET",
      "chess-admin-secret",
      "OPENAI_API_KEY",
      "alias: room",
    ]) {
      expect(stdout).not.toContain(leaked);
    }
  });

  it("no longer dispatches the extracted trial commands", async () => {
    // Spec 178 — the chess trial rig moved to @grp/chess-trial's grp-trial
    // bin. The shipped CLI treats its old commands as unknown.
    let stderr = "";
    const originalWrite = process.stderr.write;
    const originalExit = process.exit;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit;
    try {
      await expect(runCli(["chess-host"])).rejects.toThrow("exit:2");
      expect(stderr).toContain("unknown command: chess-host");
    } finally {
      process.stderr.write = originalWrite;
      process.exit = originalExit;
    }
  });

  it("shows defaults help", async () => {
    const stdout = await captureStdout(() => runCli(["help", "defaults"]));

    expect(stdout).toContain("GRP defaults");
    expect(stdout).toContain("CLI default: Private with a generated password");
  });

  it("dispatches the structured organization surface", async () => {
    const stdout = await captureStdout(() => runCli(["org", "help"]));

    expect(stdout).toContain("grp org <command>");
    expect(stdout).toContain("validate MANIFEST");
    expect(stdout).toContain("create MANIFEST --output=ROOT");
    expect(stdout).toContain("does not invent, schedule");
  });
});

describe("top-level local sessions", () => {
  it("runs commands through isolated session state with grp as", async () => {
    const env = tempEnv();

    await withProcessEnv(env, async () => {
      await captureStdout(() =>
        runCli(["session", "create", "analyst", "--name", "Research analyst"]),
      );
      await captureStdout(() =>
        runCli(["session", "create", "reviewer", "--name", "Risk reviewer"]),
      );
      await captureStdout(() =>
        runCli([
          "as",
          "analyst",
          "enter",
          "abc12345",
          "--base=https://operator.example",
          "--token=t_analyst",
          "--json",
        ]),
      );
      await captureStdout(() =>
        runCli([
          "as",
          "reviewer",
          "enter",
          "def67890",
          "--base=https://operator.example",
          "--token=t_reviewer",
          "--json",
        ]),
      );
    });

    const stored = JSON.parse(readFileSync(requiredConfigPath(env), "utf8"));
    expect(stored.currentRoom).toBeUndefined();
    expect(stored.sessions.analyst.profile.displayName).toBe("Research analyst");
    expect(stored.sessions.analyst.currentRoom).toMatchObject({
      baseUrl: "https://operator.example",
      slug: "abc12345",
      token: "t_analyst",
    });
    expect(stored.sessions.reviewer.profile.displayName).toBe("Risk reviewer");
    expect(stored.sessions.reviewer.currentRoom).toMatchObject({
      baseUrl: "https://operator.example",
      slug: "def67890",
      token: "t_reviewer",
    });
  });

  it("fails closed when grp as names an unknown persona", async () => {
    const env = tempEnv({
      providers: {},
      sessions: {
        analyst: { profile: { displayName: "Research analyst" } },
      },
    });
    let stderr = "";

    await withProcessEnv(env, async () => {
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      }) as typeof process.stderr.write;
      try {
        expect(await runCli(["as", "missing", "status"])).toBe(1);
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    expect(stderr).toContain(
      'unknown local persona "missing"; create it with `grp session create missing`',
    );
    const stored = JSON.parse(readFileSync(requiredConfigPath(env), "utf8"));
    expect(stored.sessions.missing).toBeUndefined();
  });
});

async function captureStdout(fn: () => Promise<number>): Promise<string> {
  const originalWrite = process.stdout.write;
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await fn();
    expect(code).toBe(0);
    return stdout;
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function withProcessEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previousConfig = process.env.GRP_CONFIG;
  const previousSession = process.env.GRP_SESSION;
  process.env.GRP_CONFIG = requiredConfigPath(env);
  Reflect.deleteProperty(process.env, "GRP_SESSION");
  try {
    return await fn();
  } finally {
    if (previousConfig === undefined) Reflect.deleteProperty(process.env, "GRP_CONFIG");
    else process.env.GRP_CONFIG = previousConfig;
    if (previousSession === undefined) Reflect.deleteProperty(process.env, "GRP_SESSION");
    else process.env.GRP_SESSION = previousSession;
  }
}

function tempEnv(config?: unknown): Record<string, string | undefined> {
  const dir = mkdtempSync(pathJoin(tmpdir(), "grp-cli-session-test-"));
  const configPath = pathJoin(dir, "config.json");
  if (config) writeFileSync(configPath, `${JSON.stringify(config)}\n`, "utf8");
  return { GRP_CONFIG: configPath };
}

function requiredConfigPath(env: Record<string, string | undefined>): string {
  if (!env.GRP_CONFIG) throw new Error("missing GRP_CONFIG");
  return env.GRP_CONFIG;
}
