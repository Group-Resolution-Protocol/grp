import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { describe, expect, it } from "vitest";
import { runProfileCli } from "./profile-cli.js";

describe("GRP CLI profile", () => {
  it("sets, shows, and clears the default display name", async () => {
    const env = tempEnv();
    let stdout = "";

    const setCode = await runProfileCli(["set-name", "Alex's agent"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(setCode).toBe(0);
    expect(stdout).toContain("Alex's agent");
    expect(JSON.parse(readFileSync(requiredConfigPath(env), "utf8")).profile).toEqual({
      displayName: "Alex's agent",
    });

    stdout = "";
    const showCode = await runProfileCli(["show", "--json"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(showCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ display_name: "Alex's agent" });

    stdout = "";
    const clearCode = await runProfileCli(["clear-name"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(clearCode).toBe(0);
    expect(stdout).toContain("cleared");
    expect(JSON.parse(readFileSync(requiredConfigPath(env), "utf8")).profile).toBeUndefined();
  });
});

function tempEnv(): Record<string, string | undefined> {
  const dir = mkdtempSync(pathJoin(tmpdir(), "grp-profile-test-"));
  return { GRP_CONFIG: pathJoin(dir, "config.json") };
}

function requiredConfigPath(env: Record<string, string | undefined>): string {
  if (!env.GRP_CONFIG) throw new Error("missing GRP_CONFIG");
  return env.GRP_CONFIG;
}
