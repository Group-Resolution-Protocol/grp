import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join as pathJoin } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findWorkspacePersona,
  listRememberedRooms,
  readProviderConfig,
  resolvePersonaContext,
  resolvePersonaSelection,
  setCurrentRoom,
  setRoomLastSeenSeq,
  updateProviderConfig,
} from "./provider-config.js";

const PROVIDER_CONFIG_MODULE_URL = new URL("./provider-config.ts", import.meta.url).href;
const TEST_BASE_URL = "https://rooms.example.test";

describe("provider config persona resolution", () => {
  it("discovers the nearest marker and applies the frozen precedence order", () => {
    const fixture = configFixture();
    const workspace = pathJoin(fixture.root, "company");
    const nestedWorkspace = pathJoin(workspace, "titles", "salt-ledger");
    const nestedChild = pathJoin(nestedWorkspace, "drafts", "chapter-1");
    const plainDirectory = pathJoin(fixture.root, "plain");
    mkdirSync(pathJoin(workspace, ".grp"), { recursive: true });
    mkdirSync(pathJoin(nestedWorkspace, ".grp"), { recursive: true });
    mkdirSync(nestedChild, { recursive: true });
    mkdirSync(plainDirectory, { recursive: true });
    writeFileSync(pathJoin(workspace, ".grp", "persona"), "alpha\n", "utf8");
    writeFileSync(pathJoin(nestedWorkspace, ".grp", "persona"), "beta\n", "utf8");

    seedPersonas(fixture.env);

    expect(findWorkspacePersona(nestedChild)).toEqual({
      name: "beta",
      path: pathJoin(nestedWorkspace, ".grp", "persona"),
    });
    expect(findWorkspacePersona(pathJoin(workspace, "notes"))).toEqual({
      name: "alpha",
      path: pathJoin(workspace, ".grp", "persona"),
    });
    expect(resolvePersonaSelection(fixture.env, { cwd: nestedChild })).toEqual({
      name: "beta",
      source: "workspace",
      markerPath: pathJoin(nestedWorkspace, ".grp", "persona"),
    });
    expect(readProviderConfig(fixture.env, { cwd: nestedChild }).profile).toEqual({
      displayName: "Beta Person",
    });
    expect(resolvePersonaContext(fixture.env, { cwd: nestedChild })).toMatchObject({
      name: "beta",
      source: "workspace",
      displayName: "Beta Person",
      currentRoom: { slug: "beta-room" },
    });

    expect(
      resolvePersonaSelection({ ...fixture.env, GRP_SESSION: "beta" }, { cwd: workspace }),
    ).toEqual({ name: "beta", source: "GRP_SESSION" });

    const globalFromNoMarker = readProviderConfig(fixture.env, { cwd: plainDirectory });
    const globalByScope = readProviderConfig(
      { ...fixture.env, GRP_SESSION: "beta" },
      { cwd: nestedChild, scope: "global" },
    );
    expect(globalFromNoMarker).toEqual(globalByScope);
    expect(globalByScope.profile).toEqual({ displayName: "Global Person" });
    expect(
      resolvePersonaSelection({ ...fixture.env, GRP_SESSION: "beta" }, { scope: "global" }),
    ).toBeNull();

    expect(
      resolvePersonaSelection({ GRP_CONFIG: fixture.configPath }, { cwd: nestedChild }),
    ).toBeNull();
    expect(
      readProviderConfig({ GRP_CONFIG: fixture.configPath }, { cwd: nestedChild }).profile,
    ).toEqual({ displayName: "Global Person" });
  });

  it("fails closed for malformed and unknown selections without falling back", () => {
    const fixture = configFixture();
    const workspace = pathJoin(fixture.root, "workspace");
    const markerDirectory = pathJoin(workspace, ".grp");
    const markerPath = pathJoin(markerDirectory, "persona");
    mkdirSync(markerDirectory, { recursive: true });
    seedPersonas(fixture.env);

    writeFileSync(markerPath, "missing\n", "utf8");
    expect(() => readProviderConfig(fixture.env, { cwd: workspace })).toThrow(
      /workspace persona "missing".*does not exist.*grp persona init missing/,
    );
    expect(() => resolvePersonaContext(fixture.env, { cwd: workspace })).toThrow(
      /workspace persona "missing"/,
    );

    writeFileSync(markerPath, "not a name\n", "utf8");
    expect(() => findWorkspacePersona(workspace)).toThrow(
      new RegExp(`invalid workspace persona marker at ${escapeRegex(markerPath)}`),
    );

    writeFileSync(markerPath, "\n", "utf8");
    expect(() => findWorkspacePersona(workspace)).toThrow(
      new RegExp(`invalid workspace persona marker at ${escapeRegex(markerPath)}: marker is empty`),
    );

    rmSync(markerPath);
    mkdirSync(markerPath);
    expect(() => findWorkspacePersona(workspace)).toThrow(
      new RegExp(
        `invalid workspace persona marker at ${escapeRegex(markerPath)}: marker is not a regular file`,
      ),
    );

    expect(() =>
      readProviderConfig({ ...fixture.env, GRP_SESSION: "missing" }, { cwd: workspace }),
    ).toThrow(/unknown local persona "missing" selected by GRP_SESSION/);

    // Both escape hatches are deliberate management scopes and must not even
    // inspect the bad ambient marker.
    expect(readProviderConfig(fixture.env, { cwd: workspace, scope: "global" }).profile).toEqual({
      displayName: "Global Person",
    });
    expect(
      readProviderConfig({ GRP_CONFIG: fixture.configPath }, { cwd: workspace }).profile,
    ).toEqual({ displayName: "Global Person" });
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "fails closed on an unreadable nearest marker with a repair command",
    () => {
      const fixture = configFixture();
      const workspace = pathJoin(fixture.root, "workspace");
      const markerDirectory = pathJoin(workspace, ".grp");
      const markerPath = pathJoin(markerDirectory, "persona");
      mkdirSync(markerDirectory, { recursive: true });
      writeFileSync(markerPath, "alpha\n", "utf8");
      chmodSync(markerPath, 0o000);
      try {
        expect(() => findWorkspacePersona(workspace)).toThrow(
          new RegExp(`${escapeRegex(markerPath)}.*unreadable.*grp persona init NAME --force`),
        );
      } finally {
        chmodSync(markerPath, 0o600);
      }
    },
  );

  it("keeps no-marker config resolution byte-identical to explicit global scope", () => {
    const fixture = configFixture();
    const plainDirectory = pathJoin(fixture.root, "plain", "nested");
    mkdirSync(plainDirectory, { recursive: true });
    seedPersonas(fixture.env);

    expect(JSON.stringify(readProviderConfig(fixture.env, { cwd: plainDirectory }))).toBe(
      JSON.stringify(readProviderConfig(fixture.env, { scope: "global" })),
    );
  });

  it("selects a named persona inside an explicit config bundle", () => {
    const fixture = configFixture();
    seedPersonas(fixture.env);
    const explicit = { GRP_CONFIG: fixture.configPath, GRP_SESSION: "beta" };

    expect(resolvePersonaSelection(explicit)).toEqual({
      name: "beta",
      source: "GRP_SESSION",
    });
    expect(readProviderConfig(explicit).profile).toEqual({ displayName: "Beta Person" });
  });
});

describe("provider config transactions", () => {
  it("never moves a remembered or current-room high-water mark backwards", () => {
    const fixture = configFixture();
    const env = { GRP_CONFIG: fixture.configPath };

    updateProviderConfig(
      () =>
        setCurrentRoom(
          { providers: {} },
          { slug: "newsroom", baseUrl: TEST_BASE_URL, token: "room-token", lastSeenSeq: 7 },
        ),
      env,
    );
    updateProviderConfig(
      (current) => setRoomLastSeenSeq(current, "newsroom", TEST_BASE_URL, 31),
      env,
    );
    updateProviderConfig(
      (current) => setRoomLastSeenSeq(current, "newsroom", TEST_BASE_URL, 12),
      env,
    );

    const stored = readProviderConfig(env);
    expect(stored.currentRoom?.lastSeenSeq).toBe(31);
    expect(listRememberedRooms(stored)).toContainEqual(
      expect.objectContaining({ slug: "newsroom", token: "room-token", lastSeenSeq: 31 }),
    );
  });

  it("atomically writes private parseable files and cleans transaction artifacts", () => {
    const fixture = configFixture();
    const env = { GRP_CONFIG: fixture.configPath };

    updateProviderConfig(
      () => ({
        providers: {},
        profile: { displayName: "Private Config" },
      }),
      env,
    );

    expect(statSync(fixture.configPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(fixture.configPath, "utf8"))).toMatchObject({
      profile: { displayName: "Private Config" },
    });
    expect(
      readdirSync(dirname(fixture.configPath)).filter(
        (name) => name.startsWith("config.json.") && name.endsWith(".tmp"),
      ),
    ).toEqual([]);
    expect(existsSync(`${fixture.configPath}.lock`)).toBe(false);
  });

  it("leaves the file byte-for-byte unchanged when the mutator throws", () => {
    const fixture = configFixture();
    const env = { GRP_CONFIG: fixture.configPath };
    updateProviderConfig(() => ({ providers: {}, profile: { displayName: "Before" } }), env);
    const before = readFileSync(fixture.configPath, "utf8");

    expect(() =>
      updateProviderConfig(() => {
        throw new Error("deliberate mutation failure");
      }, env),
    ).toThrow("deliberate mutation failure");

    expect(readFileSync(fixture.configPath, "utf8")).toBe(before);
    expect(existsSync(`${fixture.configPath}.lock`)).toBe(false);
  });

  it("recovers a verified dead owner but never steals live or malformed locks", () => {
    const fixture = configFixture();
    const env = { GRP_CONFIG: fixture.configPath };
    const lockPath = `${fixture.configPath}.lock`;
    updateProviderConfig(() => ({ providers: {} }), env);

    writeLockOwner(lockPath, 2_147_483_647, randomUUID());
    updateProviderConfig(
      (current) => ({ ...current, profile: { displayName: "Dead lock recovered" } }),
      env,
      { lockTimeoutMs: 100 },
    );
    expect(readProviderConfig(env).profile?.displayName).toBe("Dead lock recovered");
    expect(existsSync(lockPath)).toBe(false);

    const before = readFileSync(fixture.configPath, "utf8");
    writeLockOwner(
      lockPath,
      process.pid,
      randomUUID(),
      new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
    );
    try {
      expect(() =>
        updateProviderConfig(
          (current) => ({ ...current, profile: { displayName: "Must not land" } }),
          env,
          { lockTimeoutMs: 25 },
        ),
      ).toThrow(/resource is busy: timed out waiting for/);
      expect(readFileSync(fixture.configPath, "utf8")).toBe(before);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      rmSync(lockPath, { force: true });
    }

    writeLockOwner(
      lockPath,
      2_147_483_647,
      randomUUID(),
      new Date().toISOString(),
      "another-host.example",
    );
    try {
      expect(() =>
        updateProviderConfig((current) => ({ ...current, profile: { displayName: "No" } }), env, {
          lockTimeoutMs: 25,
        }),
      ).toThrow(/resource is busy: timed out waiting for/);
      expect(readFileSync(fixture.configPath, "utf8")).toBe(before);
    } finally {
      rmSync(lockPath, { force: true });
    }

    writeFileSync(lockPath, "incomplete owner record", { mode: 0o600 });
    try {
      expect(() =>
        updateProviderConfig((current) => ({ ...current, profile: { displayName: "No" } }), env, {
          lockTimeoutMs: 25,
        }),
      ).toThrow(/resource is busy: timed out waiting for/);
      expect(readFileSync(fixture.configPath, "utf8")).toBe(before);
      expect(readFileSync(lockPath, "utf8")).toBe("incomplete owner record");
    } finally {
      rmSync(lockPath, { force: true });
    }

    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: 2_147_483_647,
        hostname: hostname(),
        nonce: "",
        createdAt: "not-a-date",
      })}\n`,
      { mode: 0o600 },
    );
    try {
      expect(() =>
        updateProviderConfig((current) => ({ ...current, profile: { displayName: "No" } }), env, {
          lockTimeoutMs: 25,
        }),
      ).toThrow(/resource is busy: timed out waiting for/);
      expect(readFileSync(fixture.configPath, "utf8")).toBe(before);
    } finally {
      rmSync(lockPath, { force: true });
    }
  });

  it("elects one reclaimer when many processes encounter the same dead owner", async () => {
    const fixture = configFixture();
    const env = { GRP_CONFIG: fixture.configPath };
    updateProviderConfig(() => ({ providers: {} }), env);
    const lockPath = `${fixture.configPath}.lock`;
    writeLockOwner(lockPath, 2_147_483_647, randomUUID());
    const workers = 24;
    const startAt = Date.now() + 1_500;
    const source = `
      const mod = await import(process.env.PROVIDER_CONFIG_MODULE_URL);
      const waitMs = Number(process.env.TEST_START_AT) - Date.now();
      if (waitMs > 0) {
        const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
        Atomics.wait(signal, 0, 0, waitMs);
      }
      const index = process.env.TEST_INDEX;
      mod.updateProviderConfig(
        (current) => mod.setLocalSession(current, \`recovered-\${index}\`, {
          profile: { displayName: \`Recovered \${index}\` },
        }),
        { GRP_CONFIG: process.env.TEST_CONFIG_PATH },
        { scope: "global", lockTimeoutMs: 30000 },
      );
    `;

    await Promise.all(
      Array.from({ length: workers }, (_, index) =>
        runWorkerProcess(source, {
          TEST_CONFIG_PATH: fixture.configPath,
          TEST_START_AT: String(startAt),
          TEST_INDEX: String(index),
        }),
      ),
    );

    const config = readProviderConfig(env, { scope: "global" });
    for (let index = 0; index < workers; index += 1) {
      expect(config.sessions?.[`recovered-${index}`]?.profile?.displayName).toBe(
        `Recovered ${index}`,
      );
    }
    expect(existsSync(lockPath)).toBe(false);
    expect(
      readdirSync(dirname(fixture.configPath)).filter((name) =>
        name.startsWith("config.json.lock"),
      ),
    ).toEqual([]);
  }, 30_000);

  it("treats whitespace-only config overrides as absent", () => {
    const fixture = configFixture();
    const workspace = pathJoin(fixture.root, "workspace");
    mkdirSync(pathJoin(workspace, ".grp"), { recursive: true });
    writeFileSync(pathJoin(workspace, ".grp", "persona"), "alpha\n", "utf8");
    seedPersonas(fixture.env);

    expect(
      readProviderConfig({ ...fixture.env, GRP_CONFIG: "   " }, { cwd: workspace }).profile,
    ).toEqual({ displayName: "Alpha Person" });
  });

  it("preserves both personas, every room, maximum marks, and valid JSON under real process contention", async () => {
    const fixture = configFixture();
    const env = { GRP_CONFIG: fixture.configPath };
    seedPersonas(env);

    const workers = [
      { session: "alpha", room: "alpha-a", markBase: 1_000 },
      { session: "alpha", room: "alpha-b", markBase: 2_000 },
      { session: "alpha", room: "alpha-c", markBase: 3_000 },
      { session: "beta", room: "beta-a", markBase: 4_000 },
      { session: "beta", room: "beta-b", markBase: 5_000 },
      { session: "beta", room: "beta-c", markBase: 6_000 },
    ];
    const iterations = 24;
    const parseFailures: string[] = [];
    let parseReads = 0;
    const poll = setInterval(() => {
      try {
        JSON.parse(readFileSync(fixture.configPath, "utf8"));
        parseReads += 1;
      } catch (err) {
        parseFailures.push(err instanceof Error ? err.message : String(err));
      }
    }, 1);

    try {
      await Promise.all(
        workers.map((worker) =>
          runContentionWorker({
            configPath: fixture.configPath,
            session: worker.session,
            room: worker.room,
            markBase: worker.markBase,
            iterations,
          }),
        ),
      );
    } finally {
      clearInterval(poll);
    }

    expect(parseReads).toBeGreaterThan(0);
    expect(parseFailures).toEqual([]);
    expect(() => JSON.parse(readFileSync(fixture.configPath, "utf8"))).not.toThrow();

    for (const session of ["alpha", "beta"]) {
      const personaConfig = readProviderConfig({ ...env, GRP_SESSION: session });
      const rooms = listRememberedRooms(personaConfig);
      const expectedWorkers = workers.filter((worker) => worker.session === session);
      for (const worker of expectedWorkers) {
        expect(rooms).toContainEqual(
          expect.objectContaining({
            slug: worker.room,
            token: `${worker.session}-${worker.room}-${iterations - 1}`,
            lastSeenSeq: worker.markBase + iterations - 1,
          }),
        );
      }
      const expectedSharedMark =
        Math.max(...expectedWorkers.map((worker) => worker.markBase)) + iterations - 1;
      expect(rooms).toContainEqual(
        expect.objectContaining({
          slug: `shared-${session}`,
          lastSeenSeq: expectedSharedMark,
        }),
      );
      expect(personaConfig.currentRoom?.slug.startsWith(`${session}-`)).toBe(true);
    }

    const globalConfig = readProviderConfig(env, { scope: "global" });
    expect(Object.keys(globalConfig.sessions ?? {}).sort()).toEqual(["alpha", "beta"]);
    expect(existsSync(`${fixture.configPath}.lock`)).toBe(false);
    expect(
      readdirSync(dirname(fixture.configPath)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  }, 30_000);

  it("preserves concurrent global registry creation and persona room updates", async () => {
    const fixture = configFixture();
    const env = { GRP_CONFIG: fixture.configPath };
    seedPersonas(env);
    const iterations = 20;

    await Promise.all([
      runContentionWorker({
        configPath: fixture.configPath,
        session: "alpha",
        room: "alpha-runtime",
        markBase: 7_000,
        iterations,
      }),
      runRegistryWorker(fixture.configPath, iterations),
      runRegistryWorker(fixture.configPath, iterations, "parallel"),
    ]);

    const alpha = readProviderConfig({ ...env, GRP_SESSION: "alpha" });
    expect(listRememberedRooms(alpha)).toContainEqual(
      expect.objectContaining({
        slug: "alpha-runtime",
        lastSeenSeq: 7_000 + iterations - 1,
      }),
    );
    const global = readProviderConfig(env, { scope: "global" });
    for (let index = 0; index < iterations; index += 1) {
      expect(global.sessions?.[`created-${index}`]?.profile?.displayName).toBe(`Created ${index}`);
      expect(global.sessions?.[`parallel-${index}`]?.profile?.displayName).toBe(
        `Parallel ${index}`,
      );
    }
    expect(global.sessions?.beta?.profile?.displayName).toBe("Beta Person");
  }, 30_000);
});

interface ConfigFixture {
  root: string;
  configPath: string;
  env: Record<string, string | undefined>;
}

function configFixture(): ConfigFixture {
  const root = mkdtempSync(pathJoin(tmpdir(), "grp-provider-config-test-"));
  const xdg = pathJoin(root, "xdg");
  return {
    root,
    configPath: pathJoin(xdg, "grp", "config.json"),
    env: { XDG_CONFIG_HOME: xdg },
  };
}

function seedPersonas(env: Record<string, string | undefined>): void {
  updateProviderConfig(
    () => ({
      providers: {},
      profile: { displayName: "Global Person" },
      sessions: {
        alpha: {
          profile: { displayName: "Alpha Person" },
          currentRoom: { slug: "alpha-room", baseUrl: TEST_BASE_URL },
          rooms: {
            alpha: { slug: "alpha-room", baseUrl: TEST_BASE_URL },
          },
        },
        beta: {
          profile: { displayName: "Beta Person" },
          currentRoom: { slug: "beta-room", baseUrl: TEST_BASE_URL },
          rooms: {
            beta: { slug: "beta-room", baseUrl: TEST_BASE_URL },
          },
        },
      },
    }),
    env,
    { scope: "global" },
  );
}

function writeLockOwner(
  lockPath: string,
  pid: number,
  nonce: string,
  createdAt = new Date().toISOString(),
  ownerHostname = hostname(),
): void {
  writeFileSync(
    lockPath,
    `${JSON.stringify({
      pid,
      hostname: ownerHostname,
      nonce,
      createdAt,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

interface ContentionWorkerOptions {
  configPath: string;
  session: string;
  room: string;
  markBase: number;
  iterations: number;
}

async function runContentionWorker(options: ContentionWorkerOptions): Promise<void> {
  const source = `
    const mod = await import(process.env.PROVIDER_CONFIG_MODULE_URL);
    const env = {
      GRP_CONFIG: process.env.TEST_CONFIG_PATH,
      GRP_SESSION: process.env.TEST_SESSION,
    };
    const iterations = Number(process.env.TEST_ITERATIONS);
    const markBase = Number(process.env.TEST_MARK_BASE);
    const room = process.env.TEST_ROOM;
    const session = process.env.TEST_SESSION;
    for (let index = 0; index < iterations; index += 1) {
      mod.updateProviderConfig(
        (current) => {
          let next = mod.setCurrentRoom(current, {
            slug: room,
            baseUrl: ${JSON.stringify(TEST_BASE_URL)},
            token: session + "-" + room + "-" + index,
          });
          next = mod.setRoomLastSeenSeq(
            next,
            room,
            ${JSON.stringify(TEST_BASE_URL)},
            markBase + index,
          );
          next = mod.setRoomLastSeenSeq(
            next,
            \`shared-\${session}\`,
            ${JSON.stringify(TEST_BASE_URL)},
            markBase + index,
          );
          return next;
        },
        env,
        { lockTimeoutMs: 30000 },
      );
    }
  `;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PROVIDER_CONFIG_MODULE_URL,
          TEST_CONFIG_PATH: options.configPath,
          TEST_SESSION: options.session,
          TEST_ROOM: options.room,
          TEST_MARK_BASE: String(options.markBase),
          TEST_ITERATIONS: String(options.iterations),
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
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `contention worker ${options.session}/${options.room} failed (${code ?? signal})\n${stdout}${stderr}`,
        ),
      );
    });
  });
}

async function runRegistryWorker(
  configPath: string,
  iterations: number,
  prefix = "created",
): Promise<void> {
  const source = `
    const mod = await import(process.env.PROVIDER_CONFIG_MODULE_URL);
    const env = { GRP_CONFIG: process.env.TEST_CONFIG_PATH };
    const iterations = Number(process.env.TEST_ITERATIONS);
    for (let index = 0; index < iterations; index += 1) {
      mod.updateProviderConfig(
        (current) => mod.setLocalSession(current, \`\${process.env.TEST_PREFIX}-\${index}\`, {
          profile: { displayName: \`\${process.env.TEST_DISPLAY} \${index}\` },
        }),
        env,
        { scope: "global", lockTimeoutMs: 30000 },
      );
    }
  `;

  await runWorkerProcess(source, {
    TEST_CONFIG_PATH: configPath,
    TEST_ITERATIONS: String(iterations),
    TEST_PREFIX: prefix,
    TEST_DISPLAY: prefix === "created" ? "Created" : "Parallel",
  });
}

async function runWorkerProcess(source: string, extraEnv: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        cwd: process.cwd(),
        env: { ...process.env, PROVIDER_CONFIG_MODULE_URL, ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`worker failed (${code ?? signal})\n${output}`));
    });
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
