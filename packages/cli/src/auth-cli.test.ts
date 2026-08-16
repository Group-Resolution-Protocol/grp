import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { describe, expect, it } from "vitest";
import { runAuthCli } from "./auth-cli.js";

describe("GRP CLI auth", () => {
  it("prints help for login/logout without touching the network (WR6-7)", async () => {
    for (const command of ["login", "logout"] as const) {
      let stdout = "";
      let fetched = 0;
      const code = await runAuthCli(command, ["--help"], {
        env: tempEnv({ providers: {} }),
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () => {
          fetched += 1;
          return new Response("{}");
        },
      });
      expect(code).toBe(0);
      expect(fetched).toBe(0);
      expect(stdout).toContain(`Usage: grp ${command}`);
    }
  });

  it("runs device login, stores the host-scoped bearer and mandate, and logs out", async () => {
    const env = tempEnv({
      defaultProvider: "grp",
      providers: {},
    });
    const requests: Request[] = [];
    let stdout = "";

    const code = await runAuthCli("login", ["--poll-interval=0"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      sleep: async () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (new URL(request.url).pathname === "/oauth/device_authorization") {
          return jsonResponse({
            device_code: "dc_123",
            user_code: "ABCD-1234",
            verification_uri: "https://grp.app/connect/grp-cli",
            verification_uri_complete: "https://grp.app/connect/grp-cli?code=ABCD-1234",
            expires_in: 600,
            interval: 0,
          });
        }
        return jsonResponse({
          access_token: "rk_test_secret",
          public_id: "rk_test_public",
          token_type: "Bearer",
          scope: "decision:read decision:write",
          resource: null,
          mandate: "mandate.jws",
        });
      },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Logged in");
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/oauth/device_authorization",
      "/oauth/token",
    ]);
    expect(JSON.parse(readFileSync(requiredConfigPath(env), "utf8")).auth).toMatchObject({
      baseUrl: "https://grp.app",
      accessToken: "rk_test_secret",
      publicId: "rk_test_public",
      mandate: "mandate.jws",
    });

    stdout = "";
    const logout = await runAuthCli("logout", [], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });
    expect(logout).toBe(0);
    expect(stdout).toContain("Logged out");
    expect(JSON.parse(readFileSync(requiredConfigPath(env), "utf8")).auth).toBeUndefined();
  });

  it("prints a device flow without storing credentials when --no-wait is set", async () => {
    const env = tempEnv({ defaultProvider: "grp", providers: {} });
    let stdout = "";

    const code = await runAuthCli("login", ["--no-wait", "--json"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          device_code: "dc_123",
          user_code: "ABCD-1234",
          verification_uri: "https://grp.app/connect/grp-cli",
          verification_uri_complete: "https://grp.app/connect/grp-cli?code=ABCD-1234",
          expires_in: 600,
          interval: 5,
        }),
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      host: "https://grp.app",
      device_code: "dc_123",
      user_code: "ABCD-1234",
    });
    expect(JSON.parse(readFileSync(requiredConfigPath(env), "utf8")).auth).toBeUndefined();
  });
});

function tempEnv(config: unknown): Record<string, string | undefined> {
  const dir = mkdtempSync(pathJoin(tmpdir(), "grp-auth-test-"));
  const path = pathJoin(dir, "config.json");
  writeFileSync(path, `${JSON.stringify(config)}\n`, "utf8");
  return { GRP_CONFIG: path };
}

function requiredConfigPath(env: Record<string, string | undefined>): string {
  if (!env.GRP_CONFIG) throw new Error("missing GRP_CONFIG");
  return env.GRP_CONFIG;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
