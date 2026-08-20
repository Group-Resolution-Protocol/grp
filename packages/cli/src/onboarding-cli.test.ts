import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runGrpFrontDoor, runOnboardingCli } from "./onboarding-cli.js";
import { addProvider, setProfileDisplayName, updateProviderConfig } from "./provider-config.js";

describe("GRP CLI onboarding", () => {
  it("shows the first-run welcome when no host is configured", async () => {
    const env = tempEnv();
    let stdout = "";

    const code = await runGrpFrontDoor({
      env,
      stdout: (text) => {
        stdout += text;
      },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Welcome to GRP");
    expect(stdout).toContain("Group Resolution Protocol");
    expect(stdout).toContain("GRP lets agents coordinate and do work together");
    expect(stdout).toContain(
      "Discussion works through an issue. A decision records the outcome the group can rely on later.",
    );
    expect(stdout).toContain("Examples: triage bugs, plan trips, resolve shared work");
    expect(stdout).toContain("Create and join rooms (recommended)");
    // Spec 111 — join-only is presented as the honest "skip" escape hatch;
    // the command name stays `grp init join-only`.
    expect(stdout).toContain("Skip for now");
    expect(stdout).toContain("You can join rooms by invite or URL with no setup");
    expect(stdout).not.toContain("Join an existing room only");
    expect(stdout).toContain("grp init join-only");
    expect(stdout).toContain("grp init local");
  });

  it("treats `init custom --help` as help, not an error (WR-1)", async () => {
    const env = tempEnv();
    let stdout = "";
    const code = await runOnboardingCli("init", ["custom", "--help"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: grp init <mode>");
    expect(stdout).toContain("--base=");
    expect(stdout).not.toContain("custom host name is required");
    const configPath = env.GRP_CONFIG;
    if (!configPath) throw new Error("missing test config path");
    expect(existsSync(configPath)).toBe(false);
  });

  it("initializes local mode and then shows the ready state", async () => {
    const env = tempEnv();
    let stdout = "";

    const initCode = await runOnboardingCli("init", ["local"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(initCode).toBe(0);
    expect(stdout).toContain("GRP is ready");
    expect(stdout).toContain("Host: local - http://127.0.0.1:3001");

    const configPath = env.GRP_CONFIG;
    if (!configPath) throw new Error("missing test config path");
    expect(JSON.parse(readFileSync(configPath, "utf8")).defaultProvider).toBe("local");

    stdout = "";
    const frontDoorCode = await runGrpFrontDoor({
      env,
      stdout: (text) => {
        stdout += text;
      },
    });

    expect(frontDoorCode).toBe(0);
    expect(stdout).toContain("GRP is ready");
    expect(stdout).not.toContain("Let's get set up");
  });

  it("leads with the current room on the ready screen when one is saved", async () => {
    // Spec 106 — an agent waking mid-room must be steered back into the room
    // (grp read), not toward creating a second room.
    const env = tempEnv({
      defaultProvider: "local",
      currentRoom: { baseUrl: "http://127.0.0.1:3001", slug: "abc123", token: "t_1" },
    });
    let stdout = "";

    const code = await runGrpFrontDoor({
      env,
      stdout: (text) => {
        stdout += text;
      },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Current room: abc123");
    const currentRoomIndex = stdout.indexOf("Current room: abc123");
    const readIndex = stdout.indexOf("grp read");
    const createIndex = stdout.indexOf("grp create");
    expect(readIndex).toBeGreaterThan(currentRoomIndex);
    expect(createIndex).toBeGreaterThan(readIndex);
  });

  it("leads bare, status, and doctor output with the active persona identity", async () => {
    const env = {
      ...tempEnv({
        defaultProvider: "local",
        providers: {},
        sessions: {
          silica: {
            profile: { displayName: "Silica Editor" },
            currentRoom: {
              baseUrl: "https://operator.example",
              slug: "drafting-room",
              token: "t_silica",
            },
          },
        },
      }),
      GRP_SESSION: "silica",
    };
    const identity = "You are Silica Editor here (persona: silica).";

    let bare = "";
    expect(
      await runGrpFrontDoor({
        env,
        stdout: (text) => {
          bare += text;
        },
      }),
    ).toBe(0);

    let status = "";
    expect(
      await runOnboardingCli("status", [], {
        env,
        stdout: (text) => {
          status += text;
        },
        stderr: () => {},
      }),
    ).toBe(0);

    let doctor = "";
    expect(
      await runOnboardingCli("doctor", [], {
        env,
        stdout: (text) => {
          doctor += text;
        },
        stderr: () => {},
      }),
    ).toBe(0);

    expect(bare.startsWith(`${identity}\n\n`)).toBe(true);
    expect(bare).toContain("GRP is ready");
    expect(status.startsWith(`${identity}\n\nGRP status`)).toBe(true);
    expect(doctor.startsWith(`${identity}\n\nGRP doctor`)).toBe(true);
  });

  it("keeps local setup out of the first-run hosting menu", async () => {
    const env = tempEnv();
    let stdout = "";

    const code = await runGrpFrontDoor({
      env,
      isInteractive: true,
      stdin: Readable.from(["1\n2\nlocal\nhttp://127.0.0.1:3001\nAlex's agent\n"]),
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Select an option [1-2]");
    expect(stdout).not.toContain("This device only");
    expect(stdout).toContain("Host: local - http://127.0.0.1:3001");
    expect(stdout).toContain("Name: Alex's agent");

    const configPath = env.GRP_CONFIG;
    if (!configPath) throw new Error("missing test config path");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
      defaultProvider: "local",
      profile: { displayName: "Alex's agent" },
    });
  });

  it("runs interactive registered-host setup without requiring account login", async () => {
    const env = tempEnv();
    let stdout = "";

    const code = await runGrpFrontDoor({
      env,
      isInteractive: true,
      stdin: Readable.from(["1\n1\n1\n2\n\n"]),
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Where should rooms you create live?");
    expect(stdout).toContain("Choose a room provider");
    expect(stdout).toContain("Known providers are GRP room hosts");
    expect(stdout).toContain("Use this host with an account?");
    expect(stdout).toContain("Sign in for durable rooms");
    expect(stdout).toContain("Continue without an account");
    expect(stdout).not.toContain("Creation mode");
    expect(stdout).toContain("Host: GRP Server Cloud - https://grp.app");
    expect(stdout).toContain("Account: not needed for quick rooms");

    const configPath = env.GRP_CONFIG;
    if (!configPath) throw new Error("missing test config path");
    expect(JSON.parse(readFileSync(configPath, "utf8")).defaultProvider).toBe("grp");
  });

  it("runs interactive registered-host setup with hosted account login", async () => {
    const env = tempEnv();
    const requests: Request[] = [];
    let stdout = "";

    const code = await runGrpFrontDoor({
      env,
      isInteractive: true,
      stdin: Readable.from(["1\n1\n1\n1\n\n"]),
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
            device_code: "dc_onboarding",
            user_code: "GRP-1234",
            verification_uri: "https://grp.app/connect/grp-cli",
            verification_uri_complete: "https://grp.app/connect/grp-cli?code=GRP-1234",
            expires_in: 600,
            interval: 0,
          });
        }
        return jsonResponse({
          access_token: "rk_onboarding_secret",
          public_id: "rk_onboarding_public",
          token_type: "Bearer",
          scope: "decision:read decision:write",
          resource: null,
          mandate: "mandate.onboarding",
        });
      },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Sign in to this host");
    expect(stdout).toContain("Open: https://grp.app/connect/grp-cli?code=GRP-1234");
    expect(stdout).toContain("Logged in");
    expect(stdout).toContain("Account: signed in to https://grp.app");
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/oauth/device_authorization",
      "/oauth/token",
    ]);
    expect(JSON.parse(readFileSync(env.GRP_CONFIG ?? "", "utf8")).auth).toMatchObject({
      baseUrl: "https://grp.app",
      accessToken: "rk_onboarding_secret",
      publicId: "rk_onboarding_public",
      mandate: "mandate.onboarding",
    });
  });

  it("does not turn post-login snapshots into stale setup intent", async () => {
    const env = tempEnv({
      providers: {
        legacy: { name: "legacy", baseUrl: "https://before.example.test" },
      },
      profile: { displayName: "Before login" },
    });
    const input = new PassThrough();
    let stdout = "";
    const running = runGrpFrontDoor({
      env,
      isInteractive: true,
      stdin: input,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      sleep: async () => {},
      fetch: async (requestInput, init) => {
        const request = new Request(requestInput, init);
        if (new URL(request.url).pathname === "/oauth/device_authorization") {
          return jsonResponse({
            device_code: "dc_concurrent",
            user_code: "GRP-9999",
            verification_uri: "https://grp.app/connect/grp-cli",
            verification_uri_complete: "https://grp.app/connect/grp-cli?code=GRP-9999",
            expires_in: 600,
            interval: 0,
          });
        }
        updateProviderConfig(
          (current) => {
            const next = addProvider(current, "legacy", "https://seen-after-login.example.test");
            return setProfileDisplayName(next, "Seen after login");
          },
          env,
          { scope: "global" },
        );
        return jsonResponse({
          access_token: "rk_concurrent_secret",
          public_id: "rk_concurrent_public",
          token_type: "Bearer",
          mandate: "mandate.concurrent",
        });
      },
    });
    input.write("1\n1\n1\n1\n");
    await waitForOutput(() => stdout.includes("Display name"));
    updateProviderConfig(
      (current) => {
        let next = addProvider(current, "legacy", "https://newest.example.test");
        next = addProvider(next, "parallel", "https://parallel.example.test");
        return setProfileDisplayName(next, "Newest concurrent profile");
      },
      env,
      { scope: "global" },
    );
    input.end("\n");

    expect(await running).toBe(0);
    expect(JSON.parse(readFileSync(env.GRP_CONFIG ?? "", "utf8"))).toMatchObject({
      defaultProvider: "grp",
      providers: {
        legacy: { name: "legacy", baseUrl: "https://newest.example.test" },
        parallel: { name: "parallel", baseUrl: "https://parallel.example.test" },
      },
      profile: { displayName: "Newest concurrent profile" },
      auth: { accessToken: "rk_concurrent_secret" },
    });
  });

  it("uses the staging grp provider override when the installer seeded it", async () => {
    const env = tempEnv({
      providers: { grp: { name: "grp", baseUrl: "https://staging.grp.app" } },
    });
    let stdout = "";

    const code = await runGrpFrontDoor({
      env,
      isInteractive: true,
      stdin: Readable.from(["1\n1\n1\n2\n\n"]),
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Host: GRP Server Cloud (staging) - https://staging.grp.app");
    expect(JSON.parse(readFileSync(env.GRP_CONFIG ?? "", "utf8"))).toMatchObject({
      defaultProvider: "grp",
      providers: { grp: { name: "grp", baseUrl: "https://staging.grp.app" } },
    });
  });

  it("repaints one TTY setup frame across setup steps", async () => {
    const env = tempEnv();
    let stdout = "";
    const stdin = makeTtyInput();
    const restoreStdoutTty = forceStdoutTty();

    try {
      const run = runGrpFrontDoor({
        isInteractive: true,
        stdin,
        env: { ...env, FORCE_COLOR: "1" },
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
      });

      queueInput(stdin, ["\r", "\r", "\r", "2", "\n"]);

      expect(await run).toBe(0);
    } finally {
      restoreStdoutTty();
    }

    const fullClearCount = countOccurrences(stdout, "\u001b[2J");
    const scrollbackClearCount = countOccurrences(stdout, "\u001b[3J");
    const boundedRepaintCount = countOccurrences(stdout, "F\u001b[J");
    expect(fullClearCount).toBe(1);
    expect(scrollbackClearCount).toBe(1);
    expect(boundedRepaintCount).toBeGreaterThanOrEqual(3);
    expect(stdout).toContain("Where should rooms you create live?");
    expect(stdout).toContain("Choose a room provider");
    expect(stdout).toContain("GRP is ready");
  });

  it("runs interactive custom-host setup for staging-style hosts", async () => {
    const env = tempEnv();
    let stdout = "";

    const code = await runGrpFrontDoor({
      env,
      isInteractive: true,
      stdin: Readable.from(["1\n2\nstaging\nhttps://staging.example.com\nStaging agent\n"]),
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Custom / self-hosted setup");
    expect(stdout).toContain("Host: staging - https://staging.example.com");

    const configPath = env.GRP_CONFIG;
    if (!configPath) throw new Error("missing test config path");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
      defaultProvider: "staging",
      providers: { staging: { name: "staging", baseUrl: "https://staging.example.com" } },
      profile: { displayName: "Staging agent" },
    });
  });

  it("commits only prompt-owned setup changes over concurrent config updates", async () => {
    const env = tempEnv({
      providers: {
        legacy: { name: "legacy", baseUrl: "https://old.example.test" },
      },
      profile: { displayName: "Before prompts" },
    });
    const input = new PassThrough();
    queueInput(input, ["1\n", "2\n", "staging\n", "https://staging.example.test\n", "\n"]);

    const running = runGrpFrontDoor({
      env,
      isInteractive: true,
      stdin: input,
      stdout: () => {},
      stderr: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    updateProviderConfig(
      (current) => {
        let next = addProvider(current, "legacy", "https://new.example.test");
        next = addProvider(next, "parallel", "https://parallel.example.test");
        return setProfileDisplayName(next, "Concurrent profile");
      },
      env,
      { scope: "global" },
    );

    expect(await running).toBe(0);
    const configPath = env.GRP_CONFIG;
    if (!configPath) throw new Error("missing test config path");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
      defaultProvider: "staging",
      providers: {
        legacy: { name: "legacy", baseUrl: "https://new.example.test" },
        parallel: { name: "parallel", baseUrl: "https://parallel.example.test" },
        staging: { name: "staging", baseUrl: "https://staging.example.test" },
      },
      profile: { displayName: "Concurrent profile" },
    });
  });

  it("initializes a custom host", async () => {
    const env = tempEnv();
    let stdout = "";

    const code = await runOnboardingCli(
      "init",
      ["custom", "--name=acme", "--base=https://grp.acme.internal", "--json"],
      {
        env,
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
      },
    );

    expect(code).toBe(0);
    const body = JSON.parse(stdout);
    expect(body.initialized).toBe(true);
    expect(body.defaultProvider).toEqual({
      name: "acme",
      baseUrl: "https://grp.acme.internal",
    });
  });

  it("initializes join-only mode without a default host", async () => {
    const env = tempEnv();
    let stdout = "";

    const initCode = await runOnboardingCli("init", ["join-only"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(initCode).toBe(0);
    expect(stdout).toContain("GRP is ready to join rooms");
    expect(stdout).toContain("Host: none");

    stdout = "";
    const doctorCode = await runOnboardingCli("doctor", [], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(doctorCode).toBe(0);
    expect(stdout).toContain("Mode: join-only");
    expect(stdout).toContain("No setup issues");
  });

  it("initializes the registered host without requiring account login", async () => {
    const env = tempEnv();
    let stdout = "";

    const initCode = await runOnboardingCli("init", ["grp"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(initCode).toBe(0);
    expect(stdout).toContain("Host: GRP Server Cloud - https://grp.app");
    expect(stdout).toContain(
      "GRP Server Cloud (grp.app, operated by Malacan, Inc.) is your default host for creating rooms",
    );
  });

  it("can initialize the registered host and log in from one scripted command", async () => {
    const env = tempEnv();
    let stdout = "";

    const initCode = await runOnboardingCli("init", ["grp", "--login", "--poll-interval=0"], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      sleep: async () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === "/oauth/device_authorization") {
          return jsonResponse({
            device_code: "dc_scripted",
            user_code: "GRP-5678",
            verification_uri: "https://grp.app/connect/grp-cli",
            verification_uri_complete: "https://grp.app/connect/grp-cli?code=GRP-5678",
            expires_in: 600,
            interval: 0,
          });
        }
        return jsonResponse({
          access_token: "rk_scripted_secret",
          public_id: "rk_scripted_public",
          token_type: "Bearer",
          scope: "decision:read decision:write",
          resource: null,
          mandate: "mandate.scripted",
        });
      },
    });

    expect(initCode).toBe(0);
    expect(stdout).toContain("Logged in");
    expect(stdout).toContain("Account: signed in to https://grp.app");
    expect(JSON.parse(readFileSync(env.GRP_CONFIG ?? "", "utf8")).auth).toMatchObject({
      baseUrl: "https://grp.app",
      accessToken: "rk_scripted_secret",
      mandate: "mandate.scripted",
    });
  });

  it("reports setup issues through doctor when setup is unset", async () => {
    const env = tempEnv();
    let stdout = "";

    const code = await runOnboardingCli("doctor", [], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(code).toBe(1);
    expect(stdout).toContain("No default host configured");
  });

  it("reports duplicate configured names for one canonical host URL", async () => {
    const env = tempEnv({
      defaultProvider: "staging",
      providers: {
        staging: { name: "staging", baseUrl: "https://staging.grp.app/" },
        legacy: { name: "legacy", baseUrl: "https://staging.grp.app" },
      },
    });
    let stdout = "";

    const code = await runOnboardingCli("doctor", [], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(code).toBe(1);
    expect(stdout).toContain(
      "Duplicate host URL https://staging.grp.app is configured as: legacy, staging.",
    );
    expect(stdout).toContain("Remove the obsolete alias after checking which name your rooms use");
  });
});

function tempEnv(config?: unknown): Record<string, string | undefined> {
  const dir = mkdtempSync(pathJoin(tmpdir(), "grp-onboarding-test-"));
  const configPath = pathJoin(dir, "config.json");
  if (config) writeFileSync(configPath, `${JSON.stringify(config)}\n`, "utf8");
  return { GRP_CONFIG: configPath };
}

function makeTtyInput(): PassThrough & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: (mode: boolean) => void;
} {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode: (mode: boolean) => void;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode: boolean) => {
    input.isRaw = mode;
  };
  return input;
}

function forceStdoutTty(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(process.stdout, "isTTY", descriptor);
    } else {
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: undefined,
      });
    }
  };
}

function queueInput(input: PassThrough, chunks: string[]): void {
  chunks.forEach((chunk, index) => {
    setTimeout(
      () => {
        input.write(chunk);
        if (index === chunks.length - 1) input.end();
      },
      (index + 1) * 20,
    );
  });
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function waitForOutput(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for onboarding output");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
