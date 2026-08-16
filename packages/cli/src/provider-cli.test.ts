import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { describe, expect, it } from "vitest";
import { runProviderCli } from "./provider-cli.js";

describe("provider CLI", () => {
  it("adds, lists, and defaults provider profiles", async () => {
    const env = tempEnv();
    let stdout = "";

    const addCode = await runProviderCli(
      ["add", "acme", "--base=https://grp.internal.acme.com", "--default", "--json"],
      {
        env,
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
      },
    );

    expect(addCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      name: "acme",
      baseUrl: "https://grp.internal.acme.com",
      default: true,
    });

    const configPath = env.GRP_CONFIG;
    if (!configPath) throw new Error("test env missing GRP_CONFIG");
    const stored = JSON.parse(readFileSync(configPath, "utf8"));
    expect(stored.defaultProvider).toBe("acme");
    expect(stored.providers.acme.baseUrl).toBe("https://grp.internal.acme.com");

    stdout = "";
    const listCode = await runProviderCli(["list", "--json"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(listCode).toBe(0);
    const listed = JSON.parse(stdout);
    expect(listed.providers).toContainEqual({
      name: "acme",
      baseUrl: "https://grp.internal.acme.com",
      default: true,
    });
    expect(listed.providers).toHaveLength(1);
  });

  it("sets a built-in provider as default", async () => {
    const env = tempEnv();
    let stdout = "";
    const code = await runProviderCli(["use", "local", "--json"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      name: "local",
      baseUrl: "http://127.0.0.1:3001",
      default: true,
    });

    stdout = "";
    const listCode = await runProviderCli(["list", "--json"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(listCode).toBe(0);
    expect(JSON.parse(stdout).providers).toEqual([
      {
        name: "local",
        baseUrl: "http://127.0.0.1:3001",
        default: true,
      },
    ]);
  });

  it("does not show built-in presets as configured hosts", async () => {
    const env = tempEnv();
    let stdout = "";

    const code = await runProviderCli(["list"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(stdout).toContain("no host configured");
    expect(stdout).not.toContain("127.0.0.1:3001");
  });

  it("removes a custom default without erasing credentials, rooms, or personas", async () => {
    const env = tempEnv();
    const configPath = env.GRP_CONFIG;
    if (!configPath) throw new Error("test env missing GRP_CONFIG");
    const preserved = {
      setupMode: "join_only",
      defaultProvider: "acme",
      providers: { acme: { name: "acme", baseUrl: "https://grp.acme.test" } },
      profile: { displayName: "Global" },
      currentRoom: { slug: "global-room", baseUrl: "https://grp.acme.test", token: "g" },
      auth: {
        baseUrl: "https://accounts.example.test",
        accessToken: "account-token",
        mandate: "test",
        savedAt: "2026-07-21T00:00:00.000Z",
      },
      sessions: {
        silica: {
          profile: { displayName: "Silica" },
          currentRoom: { slug: "drafting", baseUrl: "https://rooms.example.test", token: "s" },
        },
      },
    };
    writeFileSync(configPath, `${JSON.stringify(preserved)}\n`, { mode: 0o600 });

    const code = await runProviderCli(["remove", "acme", "--json"], {
      env,
      stdout: () => {},
      stderr: () => {},
    });

    expect(code).toBe(0);
    const stored = JSON.parse(readFileSync(configPath, "utf8"));
    expect(stored.defaultProvider).toBeUndefined();
    expect(stored.providers).toEqual({});
    expect(stored).toMatchObject({
      setupMode: "join_only",
      profile: preserved.profile,
      currentRoom: preserved.currentRoom,
      auth: preserved.auth,
      sessions: preserved.sessions,
    });
  });

  it("treats --help on subcommands as help, not an error (WR-1)", async () => {
    const env = tempEnv();
    let stdout = "";
    const code = await runProviderCli(["add", "--help"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdout).not.toContain("host name is required");
  });
});

function tempEnv(): Record<string, string | undefined> {
  const dir = mkdtempSync(pathJoin(tmpdir(), "grp-provider-test-"));
  return { GRP_CONFIG: pathJoin(dir, "config.json") };
}
