import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  readProviderConfig,
  resolveLocalSession,
  updateProviderConfig,
} from "./provider-config.js";
import { renderDefaultsHelp, runQuickstartCli } from "./quickstart-cli.js";

describe("GRP CLI quickstart", () => {
  it("creates a room, saves display name, and remembers current room", async () => {
    const env = tempEnv({ defaultProvider: "local", providers: {} });
    const bodies: unknown[] = [];
    let stdout = "";

    const code = await runQuickstartCli(
      ["--about=Planning Friday dinner", "--name=Alex's agent", "--ask=Choose one dinner plan"],
      {
        env,
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return jsonResponse({
            slug: "abc123",
            creator_token: "t_creator",
            about: "Planning Friday dinner",
            voting_ends_at: "2026-06-18T21:00:00.000Z",
          });
        },
      },
    );

    expect(code).toBe(0);
    expect(bodies[0]).toMatchObject({
      about: "Planning Friday dinner",
      question: "Choose one dinner plan",
      options: [],
      // Spec 109 (WR2-2) — the saved display name becomes the creator's
      // participant display name.
      display_name: "Alex's agent",
      config: { visibility: "private", early_close: true },
    });
    const password = (bodies[0] as { password: string }).password;
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(readProviderConfig(env).profile).toEqual({ displayName: "Alex's agent" });
    expect(readProviderConfig(env).currentRoom).toEqual({
      provider: "local",
      slug: "abc123",
      token: "t_creator",
      password,
    });
    expect(stdout).toContain("GRP quickstart complete");
    expect(stdout).toContain("Room access: Private — valid invite or room password required");
    expect(stdout).toContain(`Room password: ${password}`);
    expect(stdout.split(password)).toHaveLength(2);
    expect(stdout).toContain("keep it out of URLs, recordings, screenshots, transcripts, and logs");
    expect(stdout).toContain("URL: http://127.0.0.1:3001/r/abc123");
    expect(stdout).toContain("Room commands:");
    expect(stdout).not.toContain("Next:");
  });

  it("creates a room shell from about without opening a decision", async () => {
    const env = tempEnv({ defaultProvider: "local", providers: {} });
    const bodies: unknown[] = [];
    let stdout = "";

    const code = await runQuickstartCli(["--about=Company agent chatroom"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          slug: "room123",
          creator_token: "t_creator",
          about: "Company agent chatroom",
          voting_ends_at: null,
        });
      },
    });

    expect(code).toBe(0);
    expect(bodies[0]).toMatchObject({
      about: "Company agent chatroom",
      config: { visibility: "private", early_close: true },
    });
    expect((bodies[0] as { password: string }).password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(stdout).toContain("Room: room123");
    expect(stdout).toContain("About: Company agent chatroom");
  });

  it("prompts for the room purpose when quickstart is run bare in a terminal", async () => {
    const env = tempEnv({ defaultProvider: "local", providers: {} });
    const bodies: unknown[] = [];
    let stdout = "";

    const code = await runQuickstartCli([], {
      env,
      isInteractive: true,
      stdin: Readable.from(["Planning Friday dinner\n"]),
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          slug: "dinner1",
          creator_token: "t_creator",
          about: "Planning Friday dinner",
          voting_ends_at: null,
        });
      },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Create your first GRP room");
    expect(bodies[0]).toMatchObject({
      about: "Planning Friday dinner",
      config: { visibility: "private", early_close: true },
    });
    expect((bodies[0] as { password: string }).password).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("pins its workspace persona while room creation is in flight", async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), "grp-quickstart-persona-pin-"));
    const cwd = pathJoin(root, "workspace");
    const markerPath = pathJoin(cwd, ".grp", "persona");
    const env = { XDG_CONFIG_HOME: pathJoin(root, "xdg") };
    mkdirSync(pathJoin(cwd, ".grp"), { recursive: true });
    writeFileSync(markerPath, "alpha\n", "utf8");
    updateProviderConfig(
      () => ({
        defaultProvider: "local",
        providers: {},
        sessions: {
          alpha: { profile: { displayName: "Alpha" } },
          beta: { profile: { displayName: "Beta" } },
        },
      }),
      env,
      { scope: "global" },
    );

    const code = await runQuickstartCli(["--about=Pinned creation"], {
      cwd,
      env,
      stdout: () => {},
      stderr: () => {},
      fetch: async () => {
        writeFileSync(markerPath, "beta\n", "utf8");
        return jsonResponse({
          slug: "pinned-room",
          creator_token: "t_alpha_creator",
          about: "Pinned creation",
        });
      },
    });

    expect(code).toBe(0);
    const config = readProviderConfig(env, { scope: "global" });
    expect(resolveLocalSession(config, "alpha")?.currentRoom).toMatchObject({
      slug: "pinned-room",
      token: "t_alpha_creator",
    });
    expect(resolveLocalSession(config, "beta")?.currentRoom).toBeUndefined();
    expect(readFileSync(markerPath, "utf8")).toBe("beta\n");
  });

  it("documents default room settings", () => {
    expect(renderDefaultsHelp()).toContain("CLI default: Private with a generated password");
    expect(renderDefaultsHelp()).toContain("Quick hosted rooms do not require an account");
    expect(renderDefaultsHelp()).toContain("Durable hosted rooms use a host account");
    expect(renderDefaultsHelp()).toContain("simple majority");
    expect(renderDefaultsHelp()).toContain("Default early close: on");
    expect(renderDefaultsHelp()).toContain("Default option flow: fluid");
    expect(renderDefaultsHelp()).toContain("grp ask ... --collect-options");
  });

  it("creates private invite-only and password-enabled rooms explicitly", async () => {
    const bodies: Record<string, unknown>[] = [];
    for (const args of [
      ["--about=Invite room", "--private"],
      ["--about=Password room", "--password=correct-horse-battery"],
    ]) {
      const code = await runQuickstartCli(args, {
        env: tempEnv({ defaultProvider: "local", providers: {} }),
        stdout: () => {},
        stderr: () => {},
        fetch: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return jsonResponse({ slug: `room-${bodies.length}`, creator_token: "t_creator" });
        },
      });
      expect(code).toBe(0);
    }
    expect(bodies[0]).toMatchObject({ config: { visibility: "private" } });
    expect(bodies[1]).toMatchObject({
      password: "correct-horse-battery",
      config: { visibility: "private" },
    });
  });
});

function tempEnv(config: unknown): Record<string, string | undefined> {
  const dir = mkdtempSync(pathJoin(tmpdir(), "grp-quickstart-test-"));
  const path = pathJoin(dir, "config.json");
  writeFileSync(path, `${JSON.stringify(config)}\n`, "utf8");
  return { GRP_CONFIG: path };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
