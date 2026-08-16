import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { describe, expect, it } from "vitest";
import { readProviderConfig } from "./provider-config.js";
import { runSessionCli } from "./session-cli.js";

describe("GRP CLI local sessions", () => {
  it("creates, lists, shows, and removes local sessions", async () => {
    const env = tempEnv();
    let stdout = "";

    const createCode = await runSessionCli(
      ["create", "Analyst", "--name", "Research analyst", "--json"],
      {
        env,
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
      },
    );

    expect(createCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      name: "analyst",
      display_name: "Research analyst",
      current_room: null,
    });

    stdout = "";
    const listCode = await runSessionCli(["list", "--json"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(listCode).toBe(0);
    expect(JSON.parse(stdout).sessions).toEqual([
      { name: "analyst", display_name: "Research analyst", current_room: null },
    ]);

    stdout = "";
    const showCode = await runSessionCli(["show", "analyst", "--json"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(showCode).toBe(0);
    expect(JSON.parse(stdout).display_name).toBe("Research analyst");

    const removeCode = await runSessionCli(["remove", "analyst"], {
      env,
      stdout: () => {},
      stderr: () => {},
    });

    expect(removeCode).toBe(0);
    expect(readProviderConfig(env).sessions).toBeUndefined();
  });

  it("keeps session profile state separate from global profile state", async () => {
    const env = tempEnv();

    await runSessionCli(["create", "reviewer", "--name", "Risk reviewer"], {
      env,
      stdout: () => {},
      stderr: () => {},
    });

    expect(readProviderConfig(env).profile).toBeUndefined();
    expect(readProviderConfig({ ...env, GRP_SESSION: "reviewer" }).profile).toEqual({
      displayName: "Risk reviewer",
    });
    expect(
      JSON.parse(readFileSync(requiredConfigPath(env), "utf8")).sessions.reviewer.profile,
    ).toEqual({ displayName: "Risk reviewer" });
  });

  it("manages the session registry even when GRP_SESSION is set", async () => {
    const env = { ...tempEnv(), GRP_SESSION: "analyst" };

    const code = await runSessionCli(["create", "reviewer", "--name", "Risk reviewer"], {
      env,
      stdout: () => {},
      stderr: () => {},
    });

    expect(code).toBe(0);
    const stored = JSON.parse(readFileSync(requiredConfigPath(env), "utf8"));
    expect(stored.sessions.reviewer.profile.displayName).toBe("Risk reviewer");
    expect(stored.sessions.analyst).toBeUndefined();
  });
});

function tempEnv(): Record<string, string | undefined> {
  const dir = mkdtempSync(pathJoin(tmpdir(), "grp-session-test-"));
  return { GRP_CONFIG: pathJoin(dir, "config.json") };
}

function requiredConfigPath(env: Record<string, string | undefined>): string {
  if (!env.GRP_CONFIG) throw new Error("missing GRP_CONFIG");
  return env.GRP_CONFIG;
}
