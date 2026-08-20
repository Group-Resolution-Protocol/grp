import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { Readable } from "node:stream";
import * as ed25519 from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import { computeJwsReceiptHash, signCompactJws } from "../../audit/src/jws.js";
import {
  readProviderConfig,
  resolveLocalSession,
  updateProviderConfig,
} from "./provider-config.js";
import {
  DEFAULT_FOREGROUND_WATCH_TIMEOUT_SECONDS,
  parseRoomArgs,
  parseSseMessage,
  parseWatchTimeout,
  renderEventLine,
  resolveRoomRef,
  runRoomCli,
} from "./room-cli.js";

describe("foreground watch timeout", () => {
  it("bounds a bare watch by default while preserving explicit overrides", () => {
    expect(parseWatchTimeout(undefined, DEFAULT_FOREGROUND_WATCH_TIMEOUT_SECONDS)).toBe(110);
    expect(parseWatchTimeout("45", DEFAULT_FOREGROUND_WATCH_TIMEOUT_SECONDS)).toBe(45);
    expect(parseWatchTimeout("0", DEFAULT_FOREGROUND_WATCH_TIMEOUT_SECONDS)).toBeNull();
    expect(parseWatchTimeout(undefined)).toBeNull();
  });
});

describe("room CLI argument parsing", () => {
  it("parses flags with equals, flags with values, and positionals", () => {
    expect(parseRoomArgs(["read", "abc123", "--token", "t_1", "--json"])).toEqual({
      flags: { token: "t_1", json: "true" },
      positionals: ["read", "abc123"],
    });
    expect(parseRoomArgs(["choose", "abc123", "--choice=approve"])).toEqual({
      flags: { choice: "approve" },
      positionals: ["choose", "abc123"],
    });
    expect(
      parseRoomArgs(["ask", "Pick a route", "--option=Fast, risky", "--option", "Slow, safe"]),
    ).toEqual({
      flags: { option: "Slow, safe" },
      positionals: ["ask", "Pick a route"],
      multiFlags: { option: ["Fast, risky", "Slow, safe"] },
    });
  });

  it("keeps a room positional after bare boolean flags (spec 147 F146-S1)", () => {
    for (const flag of [
      "agreement",
      "creator-votes",
      "defer-first-decision",
      "early-close",
      "enter",
      "expected",
      "full",
      "h",
      "help",
      "json",
      "jsonl",
      "quiet",
    ]) {
      expect(parseRoomArgs(["read", `--${flag}`, "other-room"])).toEqual({
        flags: { [flag]: "true" },
        positionals: ["read", "other-room"],
      });
    }
  });

  it("preserves explicit booleans and unambiguous optional numeric values", () => {
    expect(parseRoomArgs(["create", "--early-close", "false"])).toEqual({
      flags: { "early-close": "false" },
      positionals: ["create"],
    });
    expect(parseRoomArgs(["join", "--enter", "no", "other-room"])).toEqual({
      flags: { enter: "false" },
      positionals: ["join", "other-room"],
    });
    expect(parseRoomArgs(["watch", "--timeout", "45", "other-room"])).toEqual({
      flags: { timeout: "45" },
      positionals: ["watch", "other-room"],
    });
    expect(parseRoomArgs(["watch", "--timeout", "-1", "other-room"])).toEqual({
      flags: { timeout: "-1" },
      positionals: ["watch", "other-room"],
    });
    expect(parseRoomArgs(["watch", "--timeout", "other-room"])).toEqual({
      flags: { timeout: "true" },
      positionals: ["watch", "other-room"],
    });
    expect(parseRoomArgs(["ask", "--collect-options", "60", "Question", "other-room"])).toEqual({
      flags: { "collect-options": "60" },
      positionals: ["ask", "Question", "other-room"],
    });
    expect(parseRoomArgs(["ask", "--collect-options", "1.5", "Question", "other-room"])).toEqual({
      flags: { "collect-options": "1.5" },
      positionals: ["ask", "Question", "other-room"],
    });
    expect(parseRoomArgs(["read", "--token", "t_1", "other-room"])).toEqual({
      flags: { token: "t_1" },
      positionals: ["read", "other-room"],
    });
  });

  it("resolves room URLs without creating a new protocol concept", () => {
    expect(
      resolveRoomRef("https://grp.app/r/abc123?token=url-token&password=pw", {
        token: "flag-token",
      }),
    ).toEqual({
      baseUrl: "https://grp.app",
      slug: "abc123",
      token: "flag-token",
      password: "pw",
    });

    expect(resolveRoomRef("abc123", {}, { GRP_BASE_URL: "https://operator.example/" })).toEqual({
      baseUrl: "https://operator.example",
      slug: "abc123",
    });

    expect(
      resolveRoomRef("https://grp.app/r/abc123?token=url-token", {}, { GRP_TOKEN: "env-token" }),
    ).toEqual({
      baseUrl: "https://grp.app",
      slug: "abc123",
      token: "url-token",
    });

    expect(() => resolveRoomRef("abc123", {}, providerEnv({ providers: {} }))).toThrow(
      "Short room IDs need a default host",
    );

    const env = providerEnv({
      defaultProvider: "acme",
      providers: {
        acme: { name: "acme", baseUrl: "https://grp.internal.acme.com" },
        legal: { name: "legal", baseUrl: "https://grp.legal.acme.com" },
      },
    });
    expect(resolveRoomRef("abc123", { provider: "legal" }, env)).toEqual({
      baseUrl: "https://grp.legal.acme.com",
      slug: "abc123",
    });
    expect(resolveRoomRef("abc123", {}, env)).toEqual({
      baseUrl: "https://grp.internal.acme.com",
      slug: "abc123",
    });
    expect(
      resolveRoomRef("abc123", {}, { ...env, GRP_BASE_URL: "https://explicit.example" }),
    ).toEqual({
      baseUrl: "https://explicit.example",
      slug: "abc123",
    });
    expect(resolveRoomRef("abc123", {}, { ...env, GRP_PROVIDER: "legal" })).toEqual({
      baseUrl: "https://grp.legal.acme.com",
      slug: "abc123",
    });
  });

  it("reuses saved current-room credentials when an explicit ref matches", () => {
    const env = providerEnv({
      defaultProvider: "acme",
      providers: {
        acme: { name: "acme", baseUrl: "https://grp.internal.acme.com" },
        legal: { name: "legal", baseUrl: "https://grp.legal.acme.com" },
      },
      currentRoom: {
        provider: "acme",
        slug: "abc123",
        token: "saved-token",
        password: "saved-password",
      },
    });

    expect(resolveRoomRef("abc123", {}, env)).toEqual({
      baseUrl: "https://grp.internal.acme.com",
      slug: "abc123",
      token: "saved-token",
      password: "saved-password",
    });
    expect(resolveRoomRef("https://grp.internal.acme.com/r/abc123", {}, env)).toEqual({
      baseUrl: "https://grp.internal.acme.com",
      slug: "abc123",
      token: "saved-token",
      password: "saved-password",
    });
    expect(resolveRoomRef("abc123", { token: "flag-token" }, env)).toEqual({
      baseUrl: "https://grp.internal.acme.com",
      slug: "abc123",
      token: "flag-token",
      password: "saved-password",
    });
    expect(resolveRoomRef("abc123", { provider: "legal" }, env)).toEqual({
      baseUrl: "https://grp.legal.acme.com",
      slug: "abc123",
    });
  });

  it("reuses remembered room credentials even when another room is current", () => {
    const env = providerEnv({
      defaultProvider: "acme",
      providers: {
        acme: { name: "acme", baseUrl: "https://grp.internal.acme.com" },
        legal: { name: "legal", baseUrl: "https://grp.legal.acme.com" },
      },
      currentRoom: {
        provider: "acme",
        slug: "night",
        token: "night-token",
      },
      rooms: {
        day: {
          baseUrl: "https://grp.internal.acme.com",
          slug: "day",
          token: "day-token",
          password: "day-password",
        },
        "legal-day": {
          baseUrl: "https://grp.legal.acme.com",
          slug: "day",
          token: "legal-token",
        },
      },
    });

    expect(resolveRoomRef("day", {}, env)).toEqual({
      baseUrl: "https://grp.internal.acme.com",
      slug: "day",
      token: "day-token",
      password: "day-password",
    });
    expect(resolveRoomRef("day", { provider: "legal" }, env)).toEqual({
      baseUrl: "https://grp.legal.acme.com",
      slug: "day",
      token: "legal-token",
    });
  });

  // Spec 106 — cold-machine host fallback: with no default host, short refs
  // matching saved rooms resolve to that room's host (and then spec 091/098
  // credential reuse applies).
  it("resolves a short ref to the current room's host when no default host exists", () => {
    const env = providerEnv({
      providers: {},
      currentRoom: {
        baseUrl: "https://operator.example",
        slug: "abc123",
        token: "saved-token",
      },
    });

    expect(resolveRoomRef("abc123", {}, env)).toEqual({
      baseUrl: "https://operator.example",
      slug: "abc123",
      token: "saved-token",
    });
  });

  it("resolves a short ref to any remembered joined room's host when no default host exists", () => {
    const env = providerEnv({
      providers: {},
      currentRoom: {
        baseUrl: "https://operator.example",
        slug: "night",
        token: "night-token",
      },
      rooms: {
        day: {
          baseUrl: "https://grp.legal.acme.com",
          slug: "day",
          token: "day-token",
          password: "day-password",
        },
      },
    });

    expect(resolveRoomRef("day", {}, env)).toEqual({
      baseUrl: "https://grp.legal.acme.com",
      slug: "day",
      token: "day-token",
      password: "day-password",
    });
  });

  it("still requires a default host for short refs this session never joined", () => {
    const env = providerEnv({
      providers: {},
      currentRoom: {
        baseUrl: "https://operator.example",
        slug: "abc123",
        token: "saved-token",
      },
    });

    expect(() => resolveRoomRef("somewhere-else", {}, env)).toThrow(
      "Short room IDs need a default host",
    );
  });

  it("keeps explicit hosts winning over saved rooms without leaking their credentials", () => {
    const env = providerEnv({
      providers: {},
      currentRoom: {
        baseUrl: "https://operator.example",
        slug: "abc123",
        token: "saved-token",
      },
    });

    // Env host wins; the saved room's credentials belong to a different host
    // and must not attach (spec 091 non-leakage).
    expect(resolveRoomRef("abc123", {}, { ...env, GRP_BASE_URL: "https://other.example" })).toEqual(
      {
        baseUrl: "https://other.example",
        slug: "abc123",
      },
    );
    // Explicit --base wins too.
    expect(resolveRoomRef("abc123", { base: "https://flag.example" }, env)).toEqual({
      baseUrl: "https://flag.example",
      slug: "abc123",
    });
  });
});

describe("room CLI event rendering", () => {
  it("parses SSE frames and renders compact event lines", () => {
    expect(
      parseSseMessage(
        'id: e1\nevent: decision.completed\ndata: {"seq":3,"event_type":"decision.completed"}\n\n',
      ),
    ).toEqual({
      id: "e1",
      event: "decision.completed",
      data: '{"seq":3,"event_type":"decision.completed"}',
    });

    expect(
      renderEventLine({
        id: "e1",
        seq: 3,
        event_type: "vote.cast",
        occurred_at: "2026-06-14T00:00:00.000Z",
        decision_id: "d1",
        data: { choice_redacted: true },
      }),
    ).toBe('[3] 2026-06-14T00:00:00.000Z choice submitted decision=d1 {"choice_redacted":true}');
  });
});

describe("room CLI requests", () => {
  it("rejects an unknown destination flag before current-room fallback or fetch (spec 192)", async () => {
    const env = providerEnv({
      defaultProvider: "grp",
      providers: { grp: { name: "grp", baseUrl: "https://operator.example" } },
      currentRoom: {
        provider: "grp",
        slug: "public-day",
        token: "t_day",
      },
    });
    const before = readFileSync(String(env.GRP_CONFIG), "utf8");
    let stderr = "";
    let fetches = 0;

    const code = await runRoomCli(
      ["ask", "Night 1: who should be eliminated?", "--room=private-mafia"],
      {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch: async () => {
          fetches += 1;
          throw new Error("unknown flags must fail before fetch");
        },
        env,
      },
    );

    expect(code).toBe(1);
    expect(stderr).toBe("grp ask: unknown flag --room\n");
    expect(fetches).toBe(0);
    expect(readFileSync(String(env.GRP_CONFIG), "utf8")).toBe(before);
  });

  it("rejects flags that belong to another room command (spec 192)", async () => {
    for (const { argv, error } of [
      { argv: ["create", "--name=Wrong room name"], error: "grp create: unknown flag --name\n" },
      { argv: ["read", "--scores=1=5"], error: "grp read: unknown flag --scores\n" },
      { argv: ["invite", "list", "--role=observer"], error: "grp invite: unknown flag --role\n" },
    ]) {
      let stderr = "";
      const code = await runRoomCli(argv, {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch: async () => {
          throw new Error(`fetch should not run for ${argv.join(" ")}`);
        },
        env: { GRP_BASE_URL: "https://operator.example" },
      });
      expect(code).toBe(1);
      expect(stderr).toBe(error);
    }
  });

  it("prints command-scoped help for command help flags without executing the command", async () => {
    for (const { argv, usage, maxLines } of [
      // Spec 126 (TS1-2a) — create documents the room-shape flags, so it
      // carries a larger (still scoped) bound than the other commands.
      { argv: ["create", "--help"], usage: "Usage: grp create", maxLines: 30 },
      { argv: ["create", "-h"], usage: "Usage: grp create", maxLines: 30 },
      { argv: ["join", "--help"], usage: "Usage: grp join <room-url|slug>", maxLines: 16 },
      { argv: ["read", "--help"], usage: "Usage: grp read [room]", maxLines: 16 },
      { argv: ["watch", "--help"], usage: "Usage: grp watch [room]", maxLines: 16 },
    ]) {
      let stdout = "";
      const code = await runRoomCli(argv, {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () => {
          throw new Error(`fetch should not run for ${argv.join(" ")}`);
        },
        env: { GRP_BASE_URL: "https://operator.example" },
      });

      expect(code).toBe(0);
      // Spec 112 (WR4-7) — scoped help, not the full room usage dump.
      expect(stdout).toContain(usage);
      expect(stdout).not.toContain("Usage: grp room <command>");
      expect(stdout.split("\n").length).toBeLessThan(maxLines);
    }
  });

  // Spec 126 (TS1-2a/TS1-4) — the room shape is discoverable before errors.
  it("documents room-shape flags on create help and settable keys on settings help", async () => {
    const outputs: Record<string, string> = {};
    for (const cmd of ["create", "settings"]) {
      let stdout = "";
      const code = await runRoomCli([cmd, "--help"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () => {
          throw new Error("fetch should not run for --help");
        },
        env: { GRP_BASE_URL: "https://operator.example" },
      });
      expect(code).toBe(0);
      outputs[cmd] = stdout;
    }
    expect(outputs.create).toContain("--mechanism=NAME");
    expect(outputs.create).toContain("--quorum=N");
    expect(outputs.create).toContain("two-party mutual assent: --quorum=2");
    expect(outputs.settings).toContain("Settable keys:");
    expect(outputs.settings).toContain("choice_visibility");
    expect(outputs.settings).toContain("Fixed at create");
  });

  it("keeps the full room map on the room namespace help", async () => {
    let stdout = "";
    const code = await runRoomCli(["--help"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () => {
        throw new Error("fetch should not run for --help");
      },
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Usage: grp room <command>");
    expect(stdout).toContain("create         create a room");
  });

  it("sets, prints, uses, and leaves the current room context", async () => {
    const env = providerEnv({
      defaultProvider: "acme",
      providers: {
        acme: { name: "acme", baseUrl: "https://grp.internal.acme.com" },
      },
    });
    let stdout = "";

    const useCode = await runRoomCli(["use", "abc123", "--token=t_1", "--json"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () => {
        throw new Error("unexpected fetch");
      },
      env,
    });

    expect(useCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      provider: "acme",
      baseUrl: null,
      slug: "abc123",
      hasToken: true,
      hasPassword: false,
    });

    const requests: Request[] = [];
    stdout = "";
    const readCode = await runRoomCli(["read", "--json"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return jsonResponse({ slug: "abc123", status: "open", decisions: [] });
      },
      env,
    });

    expect(readCode).toBe(0);
    expect(requests[0]?.url).toBe("https://grp.internal.acme.com/api/rooms/abc123");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer t_1");
    expect(stdout).toContain('"slug": "abc123"');

    stdout = "";
    const leaveCode = await runRoomCli(["leave", "--json"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      env,
    });

    expect(leaveCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ current_room: null });
  });

  it("does not follow redirects that could receive room credentials", async () => {
    let redirect: RequestRedirect | undefined;
    let authorization: string | null = null;
    let stderr = "";

    const code = await runRoomCli(
      ["read", "https://operator.example/r/abc123?token=t_secret", "--json"],
      {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch: async (input, init) => {
          redirect = init?.redirect;
          authorization = new Request(input, init).headers.get("authorization");
          return new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/collect" },
          });
        },
        env: {},
      },
    );

    expect(code).toBe(1);
    expect(redirect).toBe("manual");
    expect(authorization).toBe("Bearer t_secret");
    expect(stderr).toContain("HTTP 302");
  });

  it("rejects oversized JSON responses before buffering their bodies", async () => {
    let stderr = "";
    const code = await runRoomCli(["read", "https://operator.example/r/abc123", "--json"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () =>
        new Response("{}", {
          headers: { "content-length": String(2 * 1024 * 1024 + 1) },
        }),
      env: {},
    });

    expect(code).toBe(1);
    expect(stderr).toContain("response exceeded 2097152 bytes");
  });

  it("creates an open-ended room without requiring seed options", async () => {
    const bodies: unknown[] = [];
    const env = { ...providerEnv({ providers: {} }), GRP_BASE_URL: "https://operator.example" };
    const code = await runRoomCli(
      [
        "create",
        "--question=Pick the operating principle",
        "--option-proposal-authority=any_participant",
        "--max-participants=2",
        "--voting-window=120",
        "--settle-window=45",
        "--early-close=true",
        "--creator-votes=false",
        "--unlisted",
      ],
      {
        stdout: () => {},
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          expect(new URL(request.url).pathname).toBe("/api/rooms");
          bodies.push(await request.json());
          return jsonResponse({ slug: "abc123", creatorToken: "t_creator" });
        },
        env,
      },
    );

    expect(code).toBe(0);
    expect(bodies[0]).toEqual({
      question: "Pick the operating principle",
      options: [],
      config: {
        visibility: "unlisted",
        option_proposal_authority: { kind: "any_participant" },
        voting_window: 120,
        settle_window: 45,
        max_participants: 2,
        early_close: true,
        creator_votes: false,
      },
    });
  });

  // Spec 139 (C2) — the async pace preset sizes windows for seats that
  // check in on a schedule; explicit window flags always win.
  it("creates an async-pace room with a days-scale window and minutes-scale settle", async () => {
    const bodies: unknown[] = [];
    const env = { ...providerEnv({ providers: {} }), GRP_BASE_URL: "https://operator.example" };
    const code = await runRoomCli(["create", "--about=Family decisions", "--pace=async"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        bodies.push(await new Request(input, init).json());
        return jsonResponse({ slug: "abc123", creatorToken: "t_creator" });
      },
      env,
    });

    expect(code).toBe(0);
    expect(bodies[0]).toMatchObject({
      about: "Family decisions",
      config: {
        voting_window: 3 * 24 * 3600,
        settle_window: 300,
        early_close: true,
      },
    });
  });

  it("lets explicit window flags override the pace preset and rejects unknown paces", async () => {
    const bodies: unknown[] = [];
    const env = { ...providerEnv({ providers: {} }), GRP_BASE_URL: "https://operator.example" };
    const code = await runRoomCli(
      ["create", "--about=Deal room", "--pace=async", "--voting-window=600"],
      {
        stdout: () => {},
        stderr: () => {},
        fetch: async (input, init) => {
          bodies.push(await new Request(input, init).json());
          return jsonResponse({ slug: "abc123", creatorToken: "t_creator" });
        },
        env,
      },
    );
    expect(code).toBe(0);
    expect(bodies[0]).toMatchObject({
      config: { voting_window: 600, settle_window: 300 },
    });

    let stderr = "";
    const bad = await runRoomCli(["create", "--about=Deal room", "--pace=fast"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () => {
        throw new Error("must not reach the network");
      },
      env,
    });
    expect(bad).toBe(1);
    expect(stderr).toContain('--pace must be "live" or "async"');
    expect(stderr).toContain("longer than its cadence");
  });

  it("creates a room with repeatable options without splitting internal commas", async () => {
    const bodies: unknown[] = [];
    const env = { ...providerEnv({ providers: {} }), GRP_BASE_URL: "https://operator.example" };
    let stdout = "";
    const code = await runRoomCli(
      [
        "create",
        "--ask=Pick a route",
        "--option=Fast, but exposed",
        "--option=Slow, safe, and dry",
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (_input, init) => {
          bodies.push(await new Request(_input, init).json());
          return jsonResponse({ slug: "abc123", creatorToken: "t_creator" });
        },
        env,
      },
    );

    expect(code).toBe(0);
    expect(bodies[0]).toMatchObject({
      question: "Pick a route",
      options: ["Fast, but exposed", "Slow, safe, and dry"],
    });
    expect(stdout).toContain('Question opened: "Pick a route" (2 options)');
    expect(stdout).not.toContain('grp ask "..."');
    expect(stdout).toContain("grp read");
  });

  it("creates a room with about and no first question", async () => {
    const bodies: unknown[] = [];
    const env = { ...providerEnv({ providers: {} }), GRP_BASE_URL: "https://operator.example" };
    let stdout = "";
    const code = await runRoomCli(["create", "--about=Planning Friday dinner", "--json"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect(new URL(request.url).pathname).toBe("/api/rooms");
        bodies.push(await request.json());
        return jsonResponse({
          slug: "abc123",
          creator_token: "t_creator",
          about: "Planning Friday dinner",
          voting_ends_at: null,
        });
      },
      env,
    });

    expect(code).toBe(0);
    expect(bodies[0]).toMatchObject({
      about: "Planning Friday dinner",
      config: { visibility: "private", early_close: true },
    });
    const password = (bodies[0] as { password: string }).password;
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(JSON.parse(stdout)).toMatchObject({ room_password: password });
    expect(readProviderConfig(env).currentRoom).toMatchObject({ password });
  });

  it("maps create access flags without ambiguous password combinations", async () => {
    const bodies: Record<string, unknown>[] = [];
    const env = { ...providerEnv({ providers: {} }), GRP_BASE_URL: "https://operator.example" };
    for (const argv of [
      ["create", "--about=Public", "--public", "--json"],
      ["create", "--about=Unlisted", "--unlisted", "--json"],
      ["create", "--about=Private", "--private", "--json"],
      ["create", "--about=Password", "--password=correct-horse-battery", "--json"],
    ]) {
      const code = await runRoomCli(argv, {
        stdout: () => {},
        stderr: () => {},
        fetch: async (input, init) => {
          bodies.push((await new Request(input, init).json()) as Record<string, unknown>);
          return jsonResponse({ slug: `room-${bodies.length}`, creator_token: "t_creator" });
        },
        env,
      });
      expect(code).toBe(0);
    }
    expect(bodies[0]).toMatchObject({ config: { visibility: "public" } });
    expect(bodies[1]).toMatchObject({ config: { visibility: "unlisted" } });
    expect(bodies[2]).toMatchObject({ config: { visibility: "private" } });
    expect(bodies[2]).not.toHaveProperty("password");
    expect(bodies[3]).toMatchObject({
      password: "correct-horse-battery",
      config: { visibility: "private" },
    });

    for (const argv of [
      ["create", "--about=Bad", "--public", "--password=correct-horse-battery"],
      ["create", "--about=Bad", "--unlisted", "--password=correct-horse-battery"],
      ["create", "--about=Bad", "--visibility=password"],
    ]) {
      let stderr = "";
      const code = await runRoomCli(argv, {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch: async () => {
          throw new Error("must not reach the network");
        },
        env,
      });
      expect(code).toBe(1);
      expect(stderr).toMatch(/password|visibility/);
    }
  });

  it("lets CLI-created rooms opt out of early close", async () => {
    const bodies: unknown[] = [];
    const env = { ...providerEnv({ providers: {} }), GRP_BASE_URL: "https://operator.example" };
    const code = await runRoomCli(
      ["create", "--about=Planning Friday dinner", "--early-close=false", "--json"],
      {
        stdout: () => {},
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          expect(new URL(request.url).pathname).toBe("/api/rooms");
          bodies.push(await request.json());
          return jsonResponse({
            slug: "abc123",
            creator_token: "t_creator",
            about: "Planning Friday dinner",
            voting_ends_at: null,
          });
        },
        env,
      },
    );

    expect(code).toBe(0);
    expect(bodies[0]).toMatchObject({
      config: { early_close: false },
    });
  });

  it("prompts for room purpose when create is run bare in a terminal", async () => {
    const env = providerEnv({ defaultProvider: "local", providers: {} });
    const bodies: unknown[] = [];
    let stdout = "";
    const code = await runRoomCli(["create"], {
      env,
      isInteractive: true,
      stdin: Readable.from(["Planning Friday dinner\n"]),
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect(new URL(request.url).pathname).toBe("/api/rooms");
        bodies.push(await request.json());
        return jsonResponse({
          slug: "abc123",
          creator_token: "t_creator",
          about: "Planning Friday dinner",
          voting_ends_at: null,
        });
      },
    });

    expect(code).toBe(0);
    expect(bodies[0]).toMatchObject({
      about: "Planning Friday dinner",
      config: { visibility: "private", early_close: true },
    });
    const password = (bodies[0] as { password: string }).password;
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(stdout).toContain("Create a GRP room");
    expect(stdout).toContain("Room created");
    expect(stdout).toContain("URL: http://127.0.0.1:3001/r/abc123");
    expect(stdout).toContain("Room access: Private — valid invite or room password required");
    expect(stdout).toContain(`Room password: ${password}`);
    expect(stdout.split(password)).toHaveLength(2);
    expect(stdout).toContain("Current room: set");
    expect(stdout).toContain("Room commands:");
    expect(stdout).toContain("grp invite --name NAME");
    expect(stdout).not.toContain("Common next steps:");
    expect(stdout).not.toContain("Next:");
    expect(readProviderConfig(env).currentRoom).toEqual({
      provider: "local",
      slug: "abc123",
      token: "t_creator",
      password,
    });
  });

  it("reads a full room URL using URL token auth", async () => {
    const requests: Request[] = [];
    let stdout = "";
    const code = await runRoomCli(
      ["read", "https://operator.example/r/abc123?token=t_1", "--json"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          return jsonResponse({
            slug: "abc123",
            status: "open",
            participant_count: 1,
            decisions: [],
          });
        },
        env: {},
      },
    );

    expect(code).toBe(0);
    expect(requests[0]?.url).toBe("https://operator.example/api/rooms/abc123");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer t_1");
    expect(stdout).toContain('"slug": "abc123"');
  });

  it("keeps follow-up hints inside an explicit grp as persona", async () => {
    const previousSession = process.env.GRP_SESSION;
    const previousAsActive = process.env.GRP_AS_ACTIVE;
    process.env.GRP_SESSION = "reviewer";
    process.env.GRP_AS_ACTIVE = "1";
    try {
      const env = {
        ...providerEnv({
          providers: {},
          sessions: { reviewer: { profile: { displayName: "Risk reviewer" } } },
        }),
        GRP_SESSION: "reviewer",
        GRP_AS_ACTIVE: "1",
      };
      let joined = "";
      const joinCode = await runRoomCli(["join", "https://operator.example/r/abc123?token=t_1"], {
        stdout: (text) => {
          joined += text;
        },
        stderr: () => {},
        fetch: async () => jsonResponse({ participant_token: "t_joined", role: "participant" }),
        env,
      });
      expect(joinCode).toBe(0);
      expect(joined).toContain("Run:\n  grp as reviewer read");
      expect(joined).not.toContain("Run:\n  grp read");

      let invite = "";
      const inviteCode = await runRoomCli(["invite", "--name=Alex"], {
        stdout: (text) => {
          invite += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            slug: "abc123",
            invite: { code: "inv_alex", label: "Alex", role: "participant" },
            paste_block: [
              "Join the room:",
              "grp join https://operator.example/r/abc123 --invite it_secret",
            ].join("\n"),
          }),
        env,
      });
      expect(inviteCode).toBe(0);
      expect(invite).toContain("grp as reviewer invite revoke inv_alex");
      expect(invite).toContain("grp join https://operator.example/r/abc123 --invite it_secret");
      expect(invite).not.toContain("grp as reviewer join");
    } finally {
      if (previousSession === undefined) Reflect.deleteProperty(process.env, "GRP_SESSION");
      else process.env.GRP_SESSION = previousSession;
      if (previousAsActive === undefined) Reflect.deleteProperty(process.env, "GRP_AS_ACTIVE");
      else process.env.GRP_AS_ACTIVE = previousAsActive;
    }
  });

  it("reads an explicit current-room slug using saved current-room credentials", async () => {
    const env = providerEnv({
      defaultProvider: "acme",
      providers: {
        acme: { name: "acme", baseUrl: "https://operator.example" },
      },
      currentRoom: {
        provider: "acme",
        slug: "abc123",
        token: "saved-token",
      },
    });
    const requests: Request[] = [];
    let stdout = "";
    const code = await runRoomCli(["read", "abc123"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return jsonResponse({
          slug: "abc123",
          status: "open",
          participant_count: 1,
          decisions: [],
        });
      },
      env,
    });

    expect(code).toBe(0);
    expect(requests[0]?.url).toBe("https://operator.example/api/rooms/abc123");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer saved-token");
    expect(stdout).toContain("room abc123");
  });

  it("tells agents to join first when reading a room returns join required", async () => {
    const env = providerEnv({
      defaultProvider: "acme",
      providers: {
        acme: { name: "acme", baseUrl: "https://operator.example" },
      },
    });
    let stderr = "";
    const code = await runRoomCli(["read", "abc123"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () => jsonResponse({ error: "join required" }, 403),
      env,
    });

    expect(code).toBe(1);
    expect(stderr).toContain("join required (HTTP 403)");
    expect(stderr).toContain("This room needs you to join before reading or acting.");
    expect(stderr).toContain("Run: grp join abc123");
    expect(stderr).not.toContain("invite token");
  });

  it("keys join-required self-heal off error.code from the canonical envelope", async () => {
    const env = providerEnv({
      defaultProvider: "acme",
      providers: {
        acme: { name: "acme", baseUrl: "https://operator.example" },
      },
    });
    let stderr = "";
    const code = await runRoomCli(["read", "abc123"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () =>
        jsonResponse(
          {
            error: {
              code: "room.join_required",
              message: "this is an unlisted room — join it before reading",
            },
          },
          403,
        ),
      env,
    });

    expect(code).toBe(1);
    expect(stderr).toContain("This room needs you to join before reading or acting.");
    expect(stderr).toContain("Run: grp join abc123");
  });

  it("prints error.hint from the canonical envelope and maps codes to grp commands", async () => {
    let stderr = "";
    const code = await runRoomCli(["read", "abc123"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      // Spec 106 — the server copy is transport-neutral (names the
      // start_choosing action, not the CLI command); the CLI maps the stable
      // code back to `grp start choosing` itself.
      fetch: async () =>
        jsonResponse(
          {
            error: {
              code: "decision.proposing",
              message:
                "you can't choose yet — this decision is still collecting options; propose options and discuss, then start choosing (the start_choosing action / POST /api/rooms/{slug}/start-choosing) when the option list is ready, or wait for the proposal window to close",
              hint: "propose options and discuss, then start choosing when the option list is ready",
            },
          },
          400,
        ),
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(1);
    expect(stderr).toContain("you can't choose yet");
    expect(stderr).toContain("propose options and discuss");
    expect(stderr).toContain("grp start choosing abc123");
  });

  it("maps room.concluded errors to grp outcome", async () => {
    let stderr = "";
    const code = await runRoomCli(["read", "abc123"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () =>
        jsonResponse(
          {
            error: {
              code: "room.concluded",
              message:
                "this room has concluded — it is read-only; read the outcome (the outcome action / GET /api/rooms/abc123/outcome) for the final record",
            },
          },
          400,
        ),
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(1);
    expect(stderr).toContain("this room has concluded");
    expect(stderr).toContain("grp outcome abc123");
  });

  it("preserves the stable participant.token_superseded code in CLI errors", async () => {
    let stderr = "";
    const code = await runRoomCli(["discuss", "abc123", "--body=still here"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () =>
        jsonResponse(
          {
            error: {
              code: "participant.token_superseded",
              message: "this seat was re-joined from another session",
            },
          },
          401,
        ),
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(1);
    expect(stderr).toContain("[participant.token_superseded]");
    expect(stderr).toContain("this seat was re-joined from another session");
    // Spec 139 (C3) — the stand-down convention: eviction means another
    // session of the same principal holds the seat; do not fight back.
    expect(stderr).toContain("Stand down");
    expect(stderr).toContain("do not re-join automatically");
    expect(stderr).toContain("grp join abc123 --invite <invite-token>");
  });

  it("reads a room with bearer auth when supplied", async () => {
    let authorization: string | null = null;
    const code = await runRoomCli(["read", "abc123", "--bearer=rk_1"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return jsonResponse({ slug: "abc123", status: "open", decisions: [] });
      },
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(authorization).toBe("Bearer rk_1");
  });

  it("reads a room with saved host identity when no room token is present", async () => {
    const env = providerEnv({
      defaultProvider: "grp",
      auth: {
        baseUrl: "https://grp.app",
        accessToken: "rk_test_secret",
        mandate: "mandate.jws",
        savedAt: "2026-06-19T00:00:00.000Z",
      },
      providers: {},
    });
    let authorization: string | null = null;
    let mandate: string | null = null;
    const code = await runRoomCli(["read", "abc123"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect(request.url).toBe("https://grp.app/api/rooms/abc123");
        const headers = new Headers(init?.headers);
        authorization = headers.get("authorization");
        mandate = headers.get("x-mandate");
        return jsonResponse({ slug: "abc123", status: "open", decisions: [] });
      },
      env,
    });

    expect(code).toBe(0);
    expect(authorization).toBe("Bearer rk_test_secret");
    expect(mandate).toBe("mandate.jws");
  });

  it("uses a room token instead of saved host identity when a token is present", async () => {
    const env = providerEnv({
      defaultProvider: "grp",
      auth: {
        baseUrl: "https://grp.app",
        accessToken: "rk_test_secret",
        mandate: "mandate.jws",
        savedAt: "2026-06-19T00:00:00.000Z",
      },
      providers: {},
    });
    let authorization: string | null = "unset";
    let mandate: string | null = "unset";
    const code = await runRoomCli(["read", "abc123", "--token=t_1"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect(request.url).toBe("https://grp.app/api/rooms/abc123");
        const headers = new Headers(init?.headers);
        authorization = headers.get("authorization");
        mandate = headers.get("x-mandate");
        return jsonResponse({ slug: "abc123", status: "open", decisions: [] });
      },
      env,
    });

    expect(code).toBe(0);
    expect(authorization).toBe("Bearer t_1");
    expect(mandate).toBeNull();
  });

  it("renders room reads as next-action guidance when agent-view fields are present", async () => {
    let stdout = "";
    const code = await runRoomCli(["read", "abc123"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          about: "Planning Friday dinner with Alex, Blair, Casey, and Drew",
          brief: 'Taking proposals: "Choose one dinner plan".',
          decision: {
            question: "Choose one dinner plan",
            status: "proposing",
            options: ["Tamarind Table at 7:30"],
            eligible: ["Alex", "Blair"],
          },
          rules: { how_to_choose: "choose with a single option (string) from the options list" },
        }),
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Room abc123");
    expect(stdout).toContain("Project: Planning Friday dinner with Alex, Blair, Casey, and Drew");
    expect(stdout).toContain("Question: Choose one dinner plan");
    expect(stdout).toContain("Who can choose: Alex, Blair");
    expect(stdout).toContain("Available actions:");
    expect(stdout).toContain("grp propose");
    expect(stdout).toContain("Next:");
    expect(stdout).toContain("Build the option slate through the room.");
    expect(stdout).toContain("Propose the full option text; keep commentary in");
  });

  it("renders the members line count-first from the new roster shape", async () => {
    let stdout = "";
    const code = await runRoomCli(["read", "abc123"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          about: "Writers room",
          status: "open",
          decision: null,
          roster: {
            joined: [
              { name: "Showrunner", role: "participant" },
              { name: "Cobalt", role: "participant" },
            ],
            observers: 1,
            expected: [],
            waiting_for: [],
          },
        }),
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    // Spec 115 (WR7-6) — the read says each fact once: roster counts live in
    // the brief; the separate Members line is gone (names via grp members).
    expect(stdout).not.toContain("Members:");
  });

  it("tolerates the old roster shape with observers inline in joined", async () => {
    let stdout = "";
    const code = await runRoomCli(["read", "abc123"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          status: "open",
          decision: null,
          roster: {
            joined: [
              { name: "Showrunner", role: "participant" },
              { name: "Meridian", role: "observer" },
            ],
            expected: [],
            waiting_for: [],
          },
        }),
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout).not.toContain("Members:");
  });

  it("omits the observer suffix when the room has no observers", async () => {
    let stdout = "";
    const code = await runRoomCli(["read", "abc123"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          status: "open",
          decision: null,
          roster: {
            joined: [{ name: "Showrunner", role: "participant" }],
            expected: [],
            waiting_for: [],
          },
        }),
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout).not.toContain("Members:");
    expect(stdout).not.toContain("observer");
  });

  it("leads unauthorized idle participants to watch without advertising ask", async () => {
    let stdout = "";
    const code = await runRoomCli(["read", "abc123"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          about: "Bug triage",
          status: "open",
          decision: null,
          more: { wait: "GET /api/rooms/abc123/next-action" },
        }),
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Project: Bug triage");
    expect(stdout).toContain("No active question yet.");
    expect(stdout).toContain("Next:");
    expect(stdout).toContain("Wait for what's next: grp watch");
    expect(stdout).toContain('grp discuss "..."');
    expect(stdout).toContain("grp discuss --file=PATH");
    expect(stdout).toContain("short, shell-safe message");
    expect(stdout).toContain("exact, multiline, or shell-sensitive text");
    expect(stdout).not.toContain('grp ask "..."');
  });

  it("shows ask as a secondary idle action when the server authorizes it", async () => {
    let stdout = "";
    const code = await runRoomCli(["read", "abc123"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          status: "open",
          decision: null,
          more: {
            wait: "GET /api/rooms/abc123/next-action",
            ask: "POST /api/rooms/abc123/ask",
          },
        }),
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout.indexOf("grp watch")).toBeLessThan(stdout.indexOf("grp ask"));
    expect(stdout).toContain('Or ask the next question: grp ask "..."');
  });

  it("tells agents to stay with unresolved choosing rooms", async () => {
    let stdout = "";
    const code = await runRoomCli(["read", "abc123"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          brief: 'Deciding now: "Choose one dinner plan" — 1/3 choices in.',
          decision: {
            question: "Choose one dinner plan",
            status: "voting",
            options: ["Tamarind Table at 7:30", "Noodle House at 8:00"],
            choices_cast: 1,
            eligible_voters: 3,
            can_propose_more: true,
          },
          rules: { how_to_choose: "choose with a single option (string) from the options list" },
        }),
      env: { ...providerEnv({ providers: {} }), GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    // Spec 115 (WR7-6) — progress is stated once, in the brief.
    expect(stdout).toContain('Deciding now: "Choose one dinner plan" — 1/3 choices in.');
    expect(stdout).not.toContain("Progress:");
    expect(stdout).not.toContain("Waiting on:");
    expect(stdout).toContain("Next:");
    // Spec 112 (WR4-4b) — room mechanics: engagement before choosing.
    expect(stdout).toContain(
      "This room resolves when its configured choice rules determine the outcome",
    );
    expect(stdout).not.toContain("every participant has chosen");
    expect(stdout).toContain("choices can be revised until the outcome locks");
    expect(stdout).toContain("If you have not responded yet: grp choose N abc123");
    expect(stdout).toContain(
      "If context or options are drifting, add to the discussion or propose another option:",
    );
    expect(stdout).toContain('grp discuss "..." abc123');
    expect(stdout).toContain("grp discuss --file=PATH abc123");
    expect(stdout).toContain('grp propose "..." abc123');
    // Spec 113 — ONE wait: no resolved/needed split in guidance.
    expect(stdout).toContain("Wait for what's next: grp watch abc123");
    expect(stdout).not.toContain("--until=");
    // Vocabulary — no turns anywhere on the surface.
    expect(stdout).not.toMatch(/\bturn\b/i);
  });

  // Spec 112 (WR4-5) — the plain read renders the discussion tail the agent
  // view carries; plain-read agents must not vote deliberation-blind.
  it("renders the discussion tail between the options and the guidance", async () => {
    let stdout = "";
    const code = await runRoomCli(["read", "abc123"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          brief: 'Deciding now: "Pick a thesis" — 1/3 choices in.',
          decision: {
            question: "Pick a thesis",
            status: "voting",
            options: ["Love wins", "Safety wins"],
            choices_cast: 1,
            eligible_voters: 3,
          },
          discussion: [
            {
              who: "Showrunner",
              said: "PREMISE — 200 years after Cooties.\nAct one is set in the vault.",
              at: "2026-07-07T16:00:00Z",
            },
            {
              who: "Cobalt",
              said: "I lean toward the love thesis.",
              stance: "extend",
              at: "2026-07-07T16:05:00Z",
            },
          ],
          discussion_earlier: 3,
        }),
      env: { ...providerEnv({ providers: {} }), GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Discussion:");
    expect(stdout).toContain("Showrunner: PREMISE — 200 years after Cooties.");
    expect(stdout).toContain("    Act one is set in the vault.");
    expect(stdout).toContain("Cobalt (extend): I lean toward the love thesis.");
    expect(stdout).toContain("(+3 earlier — grp timeline)");
    // The discussion sits between the options list and the Next block.
    expect(stdout.indexOf("Discussion:")).toBeGreaterThan(stdout.indexOf("Options:"));
    expect(stdout.indexOf("Discussion:")).toBeLessThan(stdout.indexOf("Next:"));
    // Nothing was truncated, so no full-text pointer.
    expect(stdout).not.toContain("full text: grp read --json");
  });

  it("renders long discussion entries in full (WR7-1: the read is the catch-up surface)", async () => {
    let stdout = "";
    const code = await runRoomCli(["read", "abc123"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          brief: "No decision is open right now.",
          decision: null,
          status: "open",
          discussion: [{ who: "Showrunner", said: "x".repeat(700), at: "2026-07-07T16:00:00Z" }],
        }),
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Discussion:");
    // Spec 115 — no display cap and no dead-end pointer: the full message
    // renders (the server windows the tail, so the read stays bounded).
    expect(stdout).toContain(`Showrunner: ${"x".repeat(700)}`);
    expect(stdout).not.toContain("(new activity appears in full");
  });

  it("omits the discussion section entirely when there is none", async () => {
    let stdout = "";
    const code = await runRoomCli(["read", "abc123"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          brief: "No decision is open right now.",
          decision: null,
          status: "open",
          discussion: [],
        }),
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout).not.toContain("Discussion:");
  });

  it("accepts long options and pre-rejects only the 500k abuse rail", async () => {
    // Spec 114 — options carry the full proposal text; a 201-char option is
    // ordinary now and goes to the room.
    let called = false;
    const okCode = await runRoomCli(["propose", "abc123", "--option", "x".repeat(201)], {
      stdout: () => {},
      stderr: () => {},
      fetch: async () => {
        called = true;
        return jsonResponse({ ok: true, option_count: 1 });
      },
      env: { GRP_BASE_URL: "https://operator.example" },
    });
    expect(okCode).toBe(0);
    expect(called).toBe(true);

    let stderr = "";
    let railCalled = false;
    const code = await runRoomCli(["propose", "abc123", "--option", "x".repeat(500_001)], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () => {
        railCalled = true;
        return jsonResponse({});
      },
      env: { GRP_BASE_URL: "https://operator.example" },
    });
    expect(code).toBe(1);
    expect(railCalled).toBe(false);
    expect(stderr).toContain("option text is too long (max 500,000 characters)");
  });

  it("casts a vote with the token in Authorization, not the action body", async () => {
    const bodies: unknown[] = [];
    let authorization: string | null = null;
    const code = await runRoomCli(["choose", "abc123", "--token=t_1", "--choice=approve"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        bodies.push(await request.json());
        authorization = request.headers.get("authorization");
        return jsonResponse({ ok: true, slug: "abc123", cast_choice: "approve" });
      },
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(bodies[0]).toEqual({ choice: "approve" });
    expect(authorization).toBe("Bearer t_1");
  });

  it("submits a choice through the preferred choose alias", async () => {
    const requests: Request[] = [];
    const bodies: unknown[] = [];
    const code = await runRoomCli(
      ["choose", "abc123", "--token=t_1", "--choice=approve", "--rationale=Caps risk"],
      {
        stdout: () => {},
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          bodies.push(await request.json());
          return jsonResponse({ ok: true, slug: "abc123", cast_choice: "approve" });
        },
        env: { GRP_BASE_URL: "https://operator.example" },
      },
    );

    expect(code).toBe(0);
    expect(requests[0] ? new URL(requests[0].url).pathname : "").toBe("/api/rooms/abc123/choose");
    expect(bodies[0]).toEqual({ choice: "approve", rationale: "Caps risk" });
  });

  it("keeps comma-containing choices as exact option strings", async () => {
    const bodies: unknown[] = [];
    const code = await runRoomCli(
      ["choose", "abc123", "--token=t_1", "--choice=A romantic logline, with a ticking-clock kiss"],
      {
        stdout: () => {},
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          expect(new URL(request.url).pathname).toBe("/api/rooms/abc123/choose");
          bodies.push(await request.json());
          return jsonResponse({
            ok: true,
            slug: "abc123",
            cast_choice: "A romantic logline, with a ticking-clock kiss",
          });
        },
        env: { GRP_BASE_URL: "https://operator.example" },
      },
    );

    expect(code).toBe(0);
    expect(bodies[0]).toEqual({
      choice: "A romantic logline, with a ticking-clock kiss",
    });
  });

  // Spec 141 — the optional decision selector: --decision=N sends the
  // room-local decision number; untargeted calls send nothing (exact pre-141
  // bodies, covered by the tests above).
  it("sends --decision as the numeric selector on choose, discuss, and propose", async () => {
    const bodies: unknown[] = [];
    const fetchSpy = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      bodies.push(await request.json());
      return jsonResponse({
        ok: true,
        id: "m_1",
        accepted: true,
        options: ["x"],
        choosing_open: true,
        slug: "abc123",
        cast_choice: "approve",
      });
    };
    const io = {
      stdout: () => {},
      stderr: () => {},
      fetch: fetchSpy,
      env: { GRP_BASE_URL: "https://operator.example" },
    };

    expect(
      await runRoomCli(["choose", "abc123", "--token=t_1", "--choice=approve", "--decision=3"], io),
    ).toBe(0);
    expect(
      await runRoomCli(
        ["discuss", "abc123", "--token=t_1", "--body=attaching explicitly", "--decision=2"],
        io,
      ),
    ).toBe(0);
    expect(
      await runRoomCli(["propose", "abc123", "--token=t_1", "--option=plan B", "--decision=2"], io),
    ).toBe(0);

    expect(bodies[0]).toEqual({ choice: "approve", decision: 3 });
    expect(bodies[1]).toEqual({ body: "attaching explicitly", decision: 2 });
    expect(bodies[2]).toEqual({ option: "plan B", decision: 2 });
  });

  it("rejects a non-numeric --decision before any HTTP", async () => {
    let stderr = "";
    let fetched = false;
    const code = await runRoomCli(
      ["choose", "abc123", "--token=t_1", "--choice=approve", "--decision=first"],
      {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch: async () => {
          fetched = true;
          return jsonResponse({ ok: true });
        },
        env: { GRP_BASE_URL: "https://operator.example" },
      },
    );

    expect(code).not.toBe(0);
    expect(fetched).toBe(false);
    expect(stderr).toContain("--decision must be a decision number");
  });

  it("confirms a recorded choice and points at watch/read next", async () => {
    let stdout = "";
    const code = await runRoomCli(["choose", "abc123", "--token=t_1", "--choice=approve"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          ok: true,
          slug: "abc123",
          cast_choice: "approve",
          status: "voting",
          resolved_winner: null,
          resolved_outcome: null,
        }),
      env: { ...providerEnv({ providers: {} }), GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout).toContain('Choice recorded: "approve"');
    expect(stdout).toContain("Next:");
    // Spec 113 — post-vote route is the one wait; no watch-mode split.
    expect(stdout).toContain("Wait for what's next: grp watch abc123");
    expect(stdout).not.toContain("--until=");
  });

  it("announces the resolved decision when a choice completes it", async () => {
    let stdout = "";
    const code = await runRoomCli(["choose", "abc123", "--token=t_1", "--choice=approve"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          ok: true,
          slug: "abc123",
          cast_choice: "approve",
          status: "resolved",
          resolved_winner: "approve",
          resolved_outcome: "approve",
        }),
      env: { ...providerEnv({ providers: {} }), GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout).toContain('Choice recorded: "approve"');
    expect(stdout).toContain('Decision resolved: "approve"');
    // The resolved-winner case keeps the outcome first; the loop continues.
    expect(stdout).toContain("See the outcome: grp outcome abc123");
    expect(stdout).toContain("Then wait for what's next: grp watch abc123");
  });

  it("keeps choose --json as the exact raw response for scripts", async () => {
    let stdout = "";
    const response = {
      ok: true,
      slug: "abc123",
      cast_choice: "approve",
      status: "voting",
      resolved_winner: null,
      resolved_outcome: null,
    };
    const code = await runRoomCli(
      ["choose", "abc123", "--token=t_1", "--choice=approve", "--json"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () => jsonResponse(response),
        env: { GRP_BASE_URL: "https://operator.example" },
      },
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(response);
  });

  it("teaches the usage form when choose swallows the option as a room ref", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stderr = "";
    let called = false;
    const code = await runRoomCli(["choose", "lasagna-forever"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () => {
        called = true;
        return jsonResponse({});
      },
      env,
    });

    expect(code).toBe(1);
    expect(called).toBe(false);
    expect(stderr).toContain('usage: grp choose "<option>" [room]');
    expect(stderr).toContain('(did you mean: grp choose "lasagna-forever"?)');
  });

  it("gives a plain usage error when choose targets a known room without an option", async () => {
    const env = {
      ...providerEnv({
        currentRoom: { baseUrl: "https://operator.example", slug: "abc123xyz", token: "t_1" },
        providers: {},
      }),
      GRP_BASE_URL: "https://operator.example",
    };
    let stderr = "";
    const code = await runRoomCli(["choose", "abc123xyz"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () => jsonResponse({}),
      env,
    });

    expect(code).toBe(1);
    expect(stderr).toContain('usage: grp choose "<option>" [room]');
    expect(stderr).not.toContain("did you mean");
  });

  it("teaches the ask usage form when no question is given", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stderr = "";
    const code = await runRoomCli(["ask"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () => jsonResponse({}),
      env,
    });

    expect(code).toBe(1);
    expect(stderr).toContain('usage: grp ask "<question>" [room]');
  });

  it("submits explicit array choices with --choices", async () => {
    const bodies: unknown[] = [];
    const code = await runRoomCli(["choose", "abc123", "--token=t_1", "--choices=approve,revise"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect(new URL(request.url).pathname).toBe("/api/rooms/abc123/choose");
        bodies.push(await request.json());
        return jsonResponse({ ok: true, slug: "abc123", cast_choice: ["approve", "revise"] });
      },
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(bodies[0]).toEqual({ choice: ["approve", "revise"] });
  });

  it("submits a score map ballot with --scores (spec 150)", async () => {
    const bodies: unknown[] = [];
    const code = await runRoomCli(["choose", "abc123", "--token=t_1", "--scores=1=5,#2=2.5,3=0"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect(new URL(request.url).pathname).toBe("/api/rooms/abc123/choose");
        bodies.push(await request.json());
        return jsonResponse({ ok: true, slug: "abc123" });
      },
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(bodies[0]).toEqual({ choice: { "1": 5, "2": 2.5, "3": 0 } });
  });

  it("keeps an explicit room after a score-map flag (spec 167 regression)", async () => {
    const bodies: unknown[] = [];
    const code = await runRoomCli(["choose", "--scores=1=5,2=0", "abc123", "--token=t_1"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        expect(new URL(new Request(input, init).url).pathname).toBe("/api/rooms/abc123/choose");
        bodies.push(await new Request(input, init).json());
        return jsonResponse({ ok: true, slug: "abc123" });
      },
      env: { GRP_BASE_URL: "https://operator.example" },
    });
    expect(code).toBe(0);
    expect(bodies[0]).toMatchObject({ choice: { "1": 5, "2": 0 } });
  });

  it("records a deliberate abstention with an explicit room", async () => {
    const bodies: unknown[] = [];
    const code = await runRoomCli(
      ["abstain", "abc123", "--token=t_1", "--reason=Conflict of interest", "--decision=2"],
      {
        stdout: () => {},
        stderr: () => {},
        fetch: async (input, init) => {
          expect(new URL(new Request(input, init).url).pathname).toBe("/api/rooms/abc123/abstain");
          bodies.push(await new Request(input, init).json());
          return jsonResponse({
            ok: true,
            slug: "abc123",
            abstained: true,
            reason: "Conflict of interest",
          });
        },
        env: { GRP_BASE_URL: "https://operator.example" },
      },
    );
    expect(code).toBe(0);
    expect(bodies[0]).toEqual({
      reason: "Conflict of interest",
      decision: 2,
    });
  });

  it("rejects malformed --scores before any HTTP (spec 150)", async () => {
    let stderr = "";
    let fetched = false;
    const code = await runRoomCli(["choose", "abc123", "--token=t_1", "--scores=Cedar House=4"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () => {
        fetched = true;
        return jsonResponse({});
      },
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(1);
    expect(fetched).toBe(false);
    expect(stderr).toContain("option-number=score");
  });

  it("rejects --scores combined with --choice or --choices (spec 150)", async () => {
    let stderr = "";
    const code = await runRoomCli(
      ["choose", "abc123", "--token=t_1", "--scores=1=5", "--choices=1,2"],
      {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch: async () => jsonResponse({}),
        env: { GRP_BASE_URL: "https://operator.example" },
      },
    );

    expect(code).toBe(1);
    expect(stderr).toContain("--scores cannot be combined");
  });

  it("choose 1 --scores=… acts on the current room instead of resolving '1' as a room (spec 152 W2)", async () => {
    const env = providerEnv({
      defaultProvider: "acme",
      providers: { acme: { name: "acme", baseUrl: "https://operator.example" } },
      currentRoom: { provider: "acme", slug: "fs1qjwl80", token: "saved-token" },
    });
    const bodies: unknown[] = [];
    const code = await runRoomCli(["choose", "1", "--scores=1=5,2=0"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect(new URL(request.url).pathname).toBe("/api/rooms/fs1qjwl80/choose");
        bodies.push(await request.json());
        return jsonResponse({ ok: true, slug: "fs1qjwl80" });
      },
      env,
    });

    expect(code).toBe(0);
    expect(bodies[0]).toEqual({ choice: { "1": 5, "2": 0 } });
  });

  it("choose <room> 1 --scores=… treats the trailing handle as redundant, not an error (spec 152 W2)", async () => {
    const bodies: unknown[] = [];
    const code = await runRoomCli(
      ["choose", "https://operator.example/r/fs1qjwl80", "1", "--token=t_1", "--scores=1=5,2=0"],
      {
        stdout: () => {},
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          expect(new URL(request.url).pathname).toBe("/api/rooms/fs1qjwl80/choose");
          bodies.push(await request.json());
          return jsonResponse({ ok: true, slug: "fs1qjwl80" });
        },
        env: {},
      },
    );

    expect(code).toBe(0);
    expect(bodies[0]).toEqual({ choice: { "1": 5, "2": 0 } });
  });

  it("choose N --scores=… without N in the map is a conflict, caught before HTTP (spec 152 W2)", async () => {
    const env = providerEnv({
      defaultProvider: "acme",
      providers: { acme: { name: "acme", baseUrl: "https://operator.example" } },
      currentRoom: { provider: "acme", slug: "fs1qjwl80", token: "saved-token" },
    });
    let stderr = "";
    let fetched = false;
    const code = await runRoomCli(["choose", "3", "--scores=1=5,2=0"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () => {
        fetched = true;
        return jsonResponse({});
      },
      env,
    });

    expect(code).toBe(1);
    expect(fetched).toBe(false);
    expect(stderr).toContain("--scores is the whole ballot");
    expect(stderr).toContain("option 3");
  });

  it("short-ref failure names the current room when one is set (spec 152 W2)", () => {
    const env = providerEnv({
      providers: { acme: { name: "acme", baseUrl: "https://grp.internal.acme.com" } },
      currentRoom: { provider: "acme", slug: "fs1qjwl80", token: "saved-token" },
    });
    expect(() => resolveRoomRef("unknownroom", {}, env)).toThrow(
      /Short room IDs need a default host.*current room is "fs1qjwl80"/s,
    );
  });

  it("opens a question in the current room with the public ask command", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    const requests: Request[] = [];
    const bodies: unknown[] = [];
    const code = await runRoomCli(["ask", "Choose one dinner plan"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        bodies.push(await request.json());
        return jsonResponse({ ok: true, decision_id: "d1" });
      },
      env,
    });

    expect(code).toBe(0);
    expect(requests[0] ? new URL(requests[0].url).pathname : "").toBe("/api/rooms/abc123/ask");
    expect(bodies[0]).toEqual({ question: "Choose one dinner plan", options: [] });
  });

  it("opens a question with repeatable options and preserves punctuation", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    const bodies: unknown[] = [];
    const code = await runRoomCli(
      [
        "ask",
        "How do you enter?",
        "abc123",
        "--option=Descend now — fast, direct, and wet",
        "--option=Take the stair — slower, safe, and dry",
      ],
      {
        stdout: () => {},
        stderr: () => {},
        fetch: async (_input, init) => {
          bodies.push(await new Request(_input, init).json());
          return jsonResponse({ ok: true, decision_id: "d1" });
        },
        env,
      },
    );

    expect(code).toBe(0);
    expect(bodies[0]).toEqual({
      question: "How do you enter?",
      options: ["Descend now — fast, direct, and wet", "Take the stair — slower, safe, and dry"],
    });
  });

  it("rejects mixing repeatable options with the legacy comma-separated flag", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stderr = "";
    let called = false;
    const code = await runRoomCli(["ask", "Pick one", "--option=First", "--options=Second,Third"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () => {
        called = true;
        return jsonResponse({ ok: true });
      },
      env,
    });

    expect(code).toBe(1);
    expect(called).toBe(false);
    expect(stderr).toContain("repeatable --option=TEXT or legacy --options=A,B, not both");
  });

  it("rejects a repeatable option without a value", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stderr = "";
    const code = await runRoomCli(["ask", "Pick one", "--option"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () => jsonResponse({ ok: true }),
      env,
    });

    expect(code).toBe(1);
    expect(stderr).toContain("--option requires a value");
  });

  it("closes the current room with a positional statement and saved token", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_operator" },
      providers: {},
    });
    const requests: Request[] = [];
    const bodies: unknown[] = [];
    const code = await runRoomCli(["close", "Town wins"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        bodies.push(await request.json());
        return jsonResponse({
          ok: true,
          slug: "abc123",
          receipt_hash: "sha256:abc",
        });
      },
      env,
    });

    expect(code).toBe(0);
    expect(requests[0] ? new URL(requests[0].url).pathname : "").toBe("/api/rooms/abc123/close");
    expect(bodies[0]).toEqual({ statement: "Town wins" });
  });

  it("passes per-question eligibility when asking", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    const bodies: unknown[] = [];
    const code = await runRoomCli(["ask", "Night action", "--eligible=felix,tessa"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (_input, init) => {
        bodies.push(await new Request(_input, init).json());
        return jsonResponse({ ok: true, decision_id: "d1" });
      },
      env,
    });

    expect(code).toBe(0);
    expect(bodies[0]).toEqual({
      question: "Night action",
      options: [],
      eligible: ["felix", "tessa"],
    });
  });

  it("summarizes HTML host errors instead of dumping the page", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stderr = "";

    const code = await runRoomCli(["ask", "Choose one dinner plan"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () =>
        new Response("<!DOCTYPE html><html><body><h1>404</h1></body></html>", {
          status: 404,
          headers: { "content-type": "text/html" },
        }),
      env,
    });

    expect(code).toBe(1);
    expect(stderr).toContain("HTTP 404");
    expect(stderr).toContain("expected a GRP JSON response");
    expect(stderr).not.toContain("<!DOCTYPE html>");
  });

  it("uses the public start choosing command for collect-first questions", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    const requests: Request[] = [];
    const bodies: unknown[] = [];
    const code = await runRoomCli(["start", "choosing"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        bodies.push(await request.json());
        return jsonResponse({ ok: true });
      },
      env,
    });

    expect(code).toBe(0);
    expect(requests[0] ? new URL(requests[0].url).pathname : "").toBe(
      "/api/rooms/abc123/start-choosing",
    );
    expect(bodies[0]).toEqual({});
  });

  it("opens ordinary questions in fluid mode by default", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    const bodies: unknown[] = [];
    const code = await runRoomCli(["ask", "Choose one dinner plan"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (_input, init) => {
        const request = new Request(_input, init);
        bodies.push(await request.json());
        return jsonResponse({ ok: true, decision_id: "d1" });
      },
      env,
    });

    expect(code).toBe(0);
    expect(bodies[0]).toEqual({ question: "Choose one dinner plan", options: [] });
  });

  it("supports collect-first questions with a friendly flag", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    const bodies: unknown[] = [];
    const code = await runRoomCli(["ask", "Choose one dinner plan", "--collect-options=600"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (_input, init) => {
        const request = new Request(_input, init);
        bodies.push(await request.json());
        return jsonResponse({ ok: true, decision_id: "d1" });
      },
      env,
    });

    expect(code).toBe(0);
    expect(bodies[0]).toEqual({
      question: "Choose one dinner plan",
      options: [],
      proposal_window: 600,
    });
  });

  it("uses a roomy default collection window for bare --collect-options", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    const bodies: unknown[] = [];
    const code = await runRoomCli(["ask", "Choose one dinner plan", "--collect-options"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (_input, init) => {
        const request = new Request(_input, init);
        bodies.push(await request.json());
        return jsonResponse({ ok: true, decision_id: "d1" });
      },
      env,
    });

    expect(code).toBe(0);
    expect(bodies[0]).toEqual({
      question: "Choose one dinner plan",
      options: [],
      proposal_window: 60 * 60 * 24,
    });
  });

  it("maps the preferred --reason flag to the v0.1 rationale wire field", async () => {
    const bodies: unknown[] = [];
    const code = await runRoomCli(
      ["choose", "abc123", "--token=t_1", "--choice=approve", "--reason=Best fit"],
      {
        stdout: () => {},
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          bodies.push(await request.json());
          return jsonResponse({ ok: true, slug: "abc123", cast_choice: "approve" });
        },
        env: { GRP_BASE_URL: "https://operator.example" },
      },
    );

    expect(code).toBe(0);
    expect(bodies[0]).toEqual({ choice: "approve", rationale: "Best fit" });
  });

  it("maps the public --why flag to the v0.1 rationale wire field", async () => {
    const bodies: unknown[] = [];
    const code = await runRoomCli(
      ["choose", "abc123", "--token=t_1", "--choice=approve", "--why=Best fit"],
      {
        stdout: () => {},
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          bodies.push(await request.json());
          return jsonResponse({ ok: true, slug: "abc123", cast_choice: "approve" });
        },
        env: { GRP_BASE_URL: "https://operator.example" },
      },
    );

    expect(code).toBe(0);
    expect(bodies[0]).toEqual({ choice: "approve", rationale: "Best fit" });
  });

  it("posts discussion messages through the existing room action", async () => {
    const bodies: unknown[] = [];
    const code = await runRoomCli(
      [
        "discuss",
        "abc123",
        "--token=t_1",
        "--body=Clarity first; the best protocol surface is the one agents can skim.",
        "--stance=agree",
      ],
      {
        stdout: () => {},
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          expect(new URL(request.url).pathname).toBe("/api/rooms/abc123/discuss");
          bodies.push(await request.json());
          return jsonResponse({ ok: true, id: "msg_1" });
        },
        env: { GRP_BASE_URL: "https://operator.example" },
      },
    );

    expect(code).toBe(0);
    expect(bodies[0]).toEqual({
      body: "Clarity first; the best protocol surface is the one agents can skim.",
      stance: "agree",
    });
  });

  it("rejects discussion stance values the server would otherwise drop", async () => {
    let stderr = "";
    const code = await runRoomCli(
      ["discuss", "abc123", "--token=t_1", "--body=Support this", "--stance=support"],
      {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch: async () => {
          throw new Error("unexpected fetch");
        },
        env: { GRP_BASE_URL: "https://operator.example" },
      },
    );

    expect(code).toBe(1);
    expect(stderr).toContain("available discussion stances are: agree, disagree, clarify, extend");
  });

  it("prints timeline history as JSONL", async () => {
    let stdout = "";
    const code = await runRoomCli(["history", "abc123", "--jsonl"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          events: [
            {
              id: "e1",
              seq: 1,
              event_type: "decision.opened",
              occurred_at: "2026-06-14T00:00:00.000Z",
              decision_id: "d1",
              data: {},
            },
          ],
        }),
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout.trim()).toBe(
      '{"id":"e1","seq":1,"event_type":"decision.opened","occurred_at":"2026-06-14T00:00:00.000Z","decision_id":"d1","data":{}}',
    );
  });

  it("paginates JSONL timelines past the endpoint cap", async () => {
    const urls: URL[] = [];
    let stdout = "";
    const code = await runRoomCli(["timeline", "abc123", "--jsonl"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input) => {
        const url = new URL(String(input));
        urls.push(url);
        const since = Number(url.searchParams.get("since_seq") ?? 0);
        const count = since === 0 ? 1000 : 2;
        return jsonResponse({
          slug: "abc123",
          events: Array.from({ length: count }, (_, index) => ({
            id: `e${since + index + 1}`,
            seq: since + index + 1,
            event_type: "discussion.posted",
            occurred_at: "2026-07-18T00:00:00.000Z",
            decision_id: null,
            data: {},
          })),
        });
      },
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout.trim().split("\n")).toHaveLength(1002);
    expect(urls).toHaveLength(2);
    expect(urls[0]?.searchParams.get("limit")).toBe("1000");
    expect(urls[1]?.searchParams.get("since_seq")).toBe("1000");
  });

  it("treats an explicit timeline limit as a total cap across pages", async () => {
    const urls: URL[] = [];
    let stdout = "";
    const code = await runRoomCli(["timeline", "abc123", "--jsonl", "--limit=1200"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input) => {
        const url = new URL(String(input));
        urls.push(url);
        const since = Number(url.searchParams.get("since_seq") ?? 0);
        const limit = Number(url.searchParams.get("limit"));
        return jsonResponse({
          slug: "abc123",
          events: Array.from({ length: limit }, (_, index) => ({
            id: `e${since + index + 1}`,
            seq: since + index + 1,
            event_type: "discussion.posted",
            occurred_at: "2026-07-18T00:00:00.000Z",
            decision_id: null,
            data: {},
          })),
        });
      },
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout.trim().split("\n")).toHaveLength(1200);
    expect(urls.map((url) => url.searchParams.get("limit"))).toEqual(["1000", "200"]);
    expect(urls[1]?.searchParams.get("since_seq")).toBe("1000");
  });

  it("prints timeline history through the preferred timeline alias", async () => {
    let stdout = "";
    const code = await runRoomCli(["timeline", "abc123"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          events: [
            {
              id: "e1",
              seq: 1,
              event_type: "decision.voting_phase_started",
              occurred_at: "2026-06-14T00:00:00.000Z",
              decision_id: "d1",
              data: {},
            },
          ],
        }),
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout.trim()).toBe("[1] 2026-06-14T00:00:00.000Z choice window opened decision=d1 {}");
  });

  it("prints options with choosing language from the current room", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stdout = "";
    const code = await runRoomCli(["options"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          decision: {
            question: "Choose one dinner plan",
            status: "proposing",
            options: ["Tamarind Table at 7:30", "Noodle House at 8:00"],
          },
          rules: { how_to_choose: "choose with a single option (string) from the options list" },
        }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Question: Choose one dinner plan");
    expect(stdout).toContain("Choice mode: single choice");
    expect(stdout).toContain("grp start choosing");
  });

  it("options --full derives choice mode from the mechanism when rules are absent (spec 152 W4)", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stdout = "";
    const code = await runRoomCli(["options", "--full"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          config: { mechanism: "score_vote" },
          decision: {
            question: "Pitch season: which title?",
            status: "voting",
            options: ["The Salt Ledger", "Nine-Tenths"],
          },
        }),
      env,
    });

    expect(code).toBe(0);
    // The Stage A lie: this surface said "single choice" on a score room.
    expect(stdout).toContain("Choice mode: score map");
    expect(stdout).toContain("grp choose --scores=1=5,2=0");
    expect(stdout).not.toContain('grp choose "<option>"');
    expect(stdout).not.toContain("Choice mode: single choice");
  });

  it("renders neutral mechanism-correct commands for every supported ballot shape", async () => {
    const cases = [
      ["choose with a single option (string) from the options list", "grp choose N abc123"],
      [
        "choose with an array of every option you find acceptable",
        "grp choose --choices=1,3 abc123",
      ],
      ["choose with a ranked array of options, best first", "grp choose --choices=2,1,3 abc123"],
      [
        "choose with an object mapping options to scores from 0 to 5",
        "grp choose --scores=1=5,2=0 abc123",
      ],
      [
        "choose with an object mapping options to integer credits, spending at most 9 in total",
        "grp choose --scores=1=4,2=1 abc123",
      ],
    ] as const;

    for (const [howToChoose, expected] of cases) {
      let stdout = "";
      const code = await runRoomCli(["options", "abc123", "--token=t_1"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            slug: "abc123",
            decision: {
              question: "Choose",
              status: "voting",
              options: ["A", "B", "C"],
            },
            rules: { how_to_choose: howToChoose },
          }),
        env: { GRP_BASE_URL: "https://operator.example" },
      });
      expect(code).toBe(0);
      expect(stdout).toContain(expected);
    }
  });

  it("map-ballot rejection copy teaches the --scores form (spec 152 W4)", async () => {
    let stderr = "";
    const code = await runRoomCli(["choose", "1", "https://operator.example/r/abc123?token=t_1"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "input.invalid",
              message:
                'mechanism "score_vote" requires a score/allocation map ballot — submit a map of option numbers to scores, e.g. {"1": 5, "2": 0}',
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      env: {},
    });

    expect(code).toBe(1);
    expect(stderr).toContain('Try: grp choose --scores="1=5,2=0" [room]');
  });

  it("prints fluid choosing as both proposable and choosable", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stdout = "";
    const code = await runRoomCli(["options"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          decision: {
            question: "Choose one dinner plan",
            status: "voting",
            can_propose_more: true,
            can_start_choosing: false,
            options: ["Tamarind Table at 7:30", "Noodle House at 8:00"],
          },
          rules: { how_to_choose: "choose with a single option (string) from the options list" },
        }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Phase: Choosing");
    expect(stdout).toContain("Proposal status: open");
    expect(stdout).toContain('grp propose "..."');
    expect(stdout).toContain("grp choose N");
    expect(stdout).not.toContain("grp start choosing");
  });

  it("shows the latest outcome without making receipts the first-mile noun", async () => {
    let stdout = "";
    const code = await runRoomCli(["outcome", "abc123"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          decided: [{ question: "Choose one dinner plan", outcome: "Tamarind Table at 7:30" }],
        }),
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Outcome");
    expect(stdout).toContain("Chosen: Tamarind Table at 7:30");
    expect(stdout).not.toContain("receipt");
    // No status field on the response: the open-room loop line stays silent.
    expect(stdout).not.toContain("Room is still open.");
  });

  // Spec 112 (WR4-6) — an outcome in a still-open room continues the loop.
  it("points outcome readers back at the room while it stays open", async () => {
    let stdout = "";
    const code = await runRoomCli(["outcome", "abc123"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          status: "open",
          decided: [{ question: "Pick a thesis", outcome: "Love wins" }],
        }),
      env: { ...providerEnv({ providers: {} }), GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Chosen: Love wins");
    expect(stdout).toContain(
      "Room is still open. Next: grp read abc123 — a new question may follow; stay with the room.",
    );
  });

  it("tells agents to keep monitoring when no outcome exists yet", async () => {
    let stdout = "";
    const code = await runRoomCli(["outcome", "abc123"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          decision: {
            question: "Choose one dinner plan",
            status: "voting",
            options: ["Tamarind Table at 7:30"],
          },
          decided: [],
        }),
      env: { ...providerEnv({ providers: {} }), GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("No outcome yet.");
    expect(stdout).toContain("Keep monitoring until the decision resolves.");
    expect(stdout).toContain("Wait for what's next: grp watch abc123");
    expect(stdout).toContain("Check again: grp outcome abc123");
  });

  it("remembers joined rooms as current-room context", async () => {
    const env = providerEnv({ providers: {} });
    const bodies: unknown[] = [];
    let stdout = "";
    const code = await runRoomCli(["join", "https://operator.example/r/abc123", "--as=Alex"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ participant_token: "t_joined", role: "participant" });
      },
      env,
    });

    expect(code).toBe(0);
    expect(bodies[0]).toEqual({ display_name: "Alex" });
    expect(readProviderConfig(env).currentRoom).toEqual({
      baseUrl: "https://operator.example",
      slug: "abc123",
      token: "t_joined",
      role: "participant",
    });
    expect(readProviderConfig(env).rooms).toEqual({
      "base:https://operator.example|abc123": {
        baseUrl: "https://operator.example",
        slug: "abc123",
        token: "t_joined",
        role: "participant",
      },
    });
    expect(stdout).toContain("Joined room abc123.");
    expect(stdout).toContain("Current room: set.");
    expect(stdout).toContain("Role: participant.");
    expect(stdout).toContain("grp read");
    expect(stdout).not.toContain("participant_token");
  });

  it("keeps credentials for multiple joined rooms without hijacking current", async () => {
    const env = providerEnv({
      defaultProvider: "acme",
      providers: {
        acme: { name: "acme", baseUrl: "https://operator.example" },
      },
    });
    const requests: Request[] = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      const slug = url.pathname.split("/")[3];
      if (request.method === "POST" && url.pathname.endsWith("/join")) {
        return jsonResponse({
          participant_token: slug === "day" ? "t_day" : "t_night",
          role: "participant",
        });
      }
      return jsonResponse({
        slug,
        status: "open",
        participant_count: 1,
        decisions: [],
      });
    };

    expect(
      await runRoomCli(["join", "day", "--as=Iris"], {
        stdout: () => {},
        stderr: () => {},
        fetch,
        env,
      }),
    ).toBe(0);
    expect(
      await runRoomCli(["join", "night", "--as=Iris"], {
        stdout: () => {},
        stderr: () => {},
        fetch,
        env,
      }),
    ).toBe(0);
    expect(
      await runRoomCli(["read", "day"], {
        stdout: () => {},
        stderr: () => {},
        fetch,
        env,
      }),
    ).toBe(0);
    expect(
      await runRoomCli(["read", "night"], {
        stdout: () => {},
        stderr: () => {},
        fetch,
        env,
      }),
    ).toBe(0);

    expect(requests.map((request) => request.url)).toContain(
      "https://operator.example/api/rooms/day",
    );
    expect(requests.map((request) => request.url)).toContain(
      "https://operator.example/api/rooms/night",
    );
    expect(
      requests.some(
        (request) =>
          request.url.endsWith("/api/rooms/day") &&
          request.headers.get("authorization") === "Bearer t_day",
      ),
    ).toBe(true);
    expect(
      requests.some(
        (request) =>
          request.url.endsWith("/api/rooms/night") &&
          request.headers.get("authorization") === "Bearer t_night",
      ),
    ).toBe(true);
    expect(readProviderConfig(env).currentRoom).toMatchObject({
      slug: "day",
      token: "t_day",
    });
    expect(readProviderConfig(env).rooms).toMatchObject({
      "base:https://operator.example|day": { token: "t_day" },
      "base:https://operator.example|night": { token: "t_night" },
    });
  });

  it("keeps join JSON and quiet modes scriptable", async () => {
    const env = providerEnv({ providers: {} });
    let jsonStdout = "";
    const jsonCode = await runRoomCli(["join", "https://operator.example/r/abc123", "--json"], {
      stdout: (text) => {
        jsonStdout += text;
      },
      stderr: () => {},
      fetch: async () => jsonResponse({ participant_token: "t_joined", role: "participant" }),
      env,
    });

    let quietStdout = "";
    const quietCode = await runRoomCli(["join", "https://operator.example/r/def456", "--quiet"], {
      stdout: (text) => {
        quietStdout += text;
      },
      stderr: () => {},
      fetch: async () => jsonResponse({ participant_token: "t_quiet", role: "participant" }),
      env,
    });

    expect(jsonCode).toBe(0);
    expect(JSON.parse(jsonStdout)).toEqual({
      participant_token: "t_joined",
      role: "participant",
    });
    expect(quietCode).toBe(0);
    expect(quietStdout).toBe("t_quiet\n");
  });

  it("uses the profile display name when joining unless --as overrides it", async () => {
    const env = providerEnv({
      profile: { displayName: "Alex's agent" },
      providers: {},
    });
    const bodies: unknown[] = [];

    const first = await runRoomCli(["join", "https://operator.example/r/abc123"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ participant_token: "t_joined" });
      },
      env,
    });

    const second = await runRoomCli(
      ["join", "https://operator.example/r/abc123", "--as=Dinner proxy"],
      {
        stdout: () => {},
        stderr: () => {},
        fetch: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return jsonResponse({ participant_token: "t_joined_2" });
        },
        env,
      },
    );

    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(bodies).toEqual([{ display_name: "Alex's agent" }, { display_name: "Dinner proxy" }]);
  });

  it("streams watch output from SSE as JSONL", async () => {
    const requests: Request[] = [];
    let stdout = "";
    let stderr = "";

    const code = await runRoomCli(
      ["watch", "https://operator.example/r/abc123?token=t_1", "--jsonl", "--until=resolved"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          if (!request.url.includes("/events/stream")) {
            // WR2-11 head probe before following the stream.
            return jsonResponse({ slug: "abc123", events: [] });
          }
          return new Response(
            sseStream([
              'id: e1\nevent: decision.completed\ndata: {"id":"e1","seq":2,"event_type":"decision.completed","occurred_at":"2026-06-14T00:00:01.000Z","decision_id":"d1","data":{"winner":"approve"}}\n\n',
            ]),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
        env: {},
      },
    );

    expect(code).toBe(0);
    expect(requests[0]?.url).toBe("https://operator.example/api/rooms/abc123/events");
    expect(requests[1]?.url).toBe("https://operator.example/api/rooms/abc123/events/stream");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer t_1");
    expect(requests[1]?.headers.get("authorization")).toBe("Bearer t_1");
    expect(stdout.trim()).toBe(
      '{"id":"e1","seq":2,"event_type":"decision.completed","occurred_at":"2026-06-14T00:00:01.000Z","decision_id":"d1","data":{"winner":"approve"}}',
    );
    // JSONL stays machine-clean: no epilogue, no status lines.
    expect(stderr).toBe("");
  });

  it("fails closed when an SSE frame exceeds the client memory bound", async () => {
    let stderr = "";
    const oversizedFrame = `data: ${"x".repeat(2 * 1024 * 1024)}\n\n`;

    const code = await runRoomCli(
      ["watch", "https://operator.example/r/abc123?token=t_1", "--until=resolved"],
      {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch: async (input) => {
          if (!String(input).includes("/events/stream")) {
            return jsonResponse({ slug: "abc123", events: [] });
          }
          return new Response(sseStream([oversizedFrame]), {
            headers: { "content-type": "text/event-stream" },
          });
        },
        env: {},
      },
    );

    expect(code).toBe(1);
    expect(stderr).toContain("event stream frame exceeded 2097152 bytes");
    expect(stderr).not.toContain("reconnecting");
  });

  it("can stop watching when a decision resolves", async () => {
    let stdout = "";

    const code = await runRoomCli(
      ["watch", "https://operator.example/r/abc123?token=t_1", "--until=resolved"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (!request.url.includes("/events/stream")) {
            return jsonResponse({ slug: "abc123", events: [] });
          }
          return new Response(
            sseStream([
              [
                'id: e1\nevent: decision.completed\ndata: {"id":"e1","seq":2,"event_type":"decision.completed","occurred_at":"2026-06-14T00:00:01.000Z","decision_id":"d1","data":{"winner":"approve"}}',
                "",
                'id: e2\nevent: discussion.posted\ndata: {"id":"e2","seq":3,"event_type":"discussion.posted","occurred_at":"2026-06-14T00:00:02.000Z","decision_id":null,"data":{"body":"late note"}}',
                "",
                "",
              ].join("\n"),
            ]),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
        env: providerEnv({ providers: {} }),
      },
    );

    expect(code).toBe(0);
    // Spec 115 (WR7-11) — until-modes are quiet: no per-event echo, no
    // replayed history; only the stop block prints.
    expect(stdout).not.toContain("decision completed");
    expect(stdout).not.toContain("late note");
    expect(stdout).toContain('Decision resolved: "approve"');
    expect(stdout).toContain("Next:");
    expect(stdout).toContain("grp read abc123");
  });

  it("returns immediately when --until=resolved starts after the latest decision resolved", async () => {
    const requests: Request[] = [];
    let stdout = "";
    const code = await runRoomCli(
      ["watch", "https://operator.example/r/abc123?token=t_1", "--until=resolved"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          if (request.url.includes("/events")) throw new Error("watch should not open a stream");
          return jsonResponse({
            slug: "abc123",
            status: "open",
            decisions: [
              {
                seq: 1,
                question: "Ship it?",
                status: "resolved",
                resolved_winner: "approve",
              },
            ],
          });
        },
        env: providerEnv({ providers: {} }),
      },
    );

    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://operator.example/api/rooms/abc123?include=full");
    expect(stdout).toContain('Decision already resolved: "approve"');
    expect(stdout).toContain("grp outcome abc123");
  });

  it("keeps waiting when an older decision is resolved but another decision is open", async () => {
    const requests: Request[] = [];
    let stdout = "";
    const code = await runRoomCli(
      ["watch", "https://operator.example/r/abc123?token=t_1", "--until=resolved"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          if (request.url.endsWith("/events/stream?since_seq=4")) {
            return new Response(
              sseStream([
                'id: e5\ndata: {"id":"e5","seq":5,"event_type":"decision.completed","occurred_at":"2026-06-14T00:00:03.000Z","decision_id":"d2","data":{"winner":"ship it"}}\n\n',
              ]),
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          if (request.url.endsWith("/events")) {
            return jsonResponse({
              slug: "abc123",
              events: [
                {
                  id: "e4",
                  seq: 4,
                  event_type: "discussion.posted",
                  occurred_at: "2026-06-14T00:00:02.000Z",
                  decision_id: "d2",
                  data: {},
                },
              ],
            });
          }
          return jsonResponse({
            slug: "abc123",
            status: "open",
            decisions: [
              { seq: 1, status: "resolved", resolved_winner: "old" },
              { seq: 2, status: "voting", question: "New question" },
            ],
            decisions_open: [{ seq: 2, status: "voting", question: "New question" }],
          });
        },
        env: providerEnv({ providers: {} }),
      },
    );

    expect(code).toBe(0);
    expect(requests.some((request) => request.url.includes("/events/stream"))).toBe(true);
    expect(stdout).not.toContain("Decision already resolved");
    expect(stdout).toContain('Decision resolved: "ship it"');
  });

  it("returns immediately when --until=resolved starts after room conclusion", async () => {
    let streamed = false;
    let stdout = "";
    const code = await runRoomCli(
      ["watch", "https://operator.example/r/abc123?token=t_1", "--until=resolved"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input) => {
          if (String(input).includes("/events")) streamed = true;
          return jsonResponse({ slug: "abc123", status: "concluded" });
        },
        env: providerEnv({ providers: {} }),
      },
    );

    expect(code).toBe(0);
    expect(streamed).toBe(false);
    expect(stdout).toContain("Room already concluded.");
    expect(stdout).toContain("grp outcome abc123");
  });

  it("keeps the concluded-room watch epilogue outcome-only", async () => {
    let stdout = "";
    const code = await runRoomCli(
      ["watch", "https://operator.example/r/abc123?token=t_1", "--until=resolved"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (!request.url.includes("/events/stream")) {
            return jsonResponse({ slug: "abc123", events: [] });
          }
          return new Response(
            sseStream([
              'id: e1\ndata: {"id":"e1","seq":2,"event_type":"room.concluded","occurred_at":"2026-06-14T00:00:01.000Z","decision_id":null,"data":{"statement":"done"}}\n\n',
            ]),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
        env: providerEnv({ providers: {} }),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toContain("Room concluded.");
    expect(stdout).toContain("grp outcome abc123");
    expect(stdout).not.toContain("a new question may be open");
  });

  // Spec 112 (WR4-4a) — --until=needed long-polls next-action quietly and
  // exits the moment a decision needs the caller's choice.
  it("wakes watch --until=needed from the next-action long-poll", async () => {
    const requests: Request[] = [];
    let stdout = "";
    const code = await runRoomCli(
      ["watch", "https://operator.example/r/abc123?token=t_1", "--until=needed"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          if (requests.length === 1) {
            return jsonResponse({ status: "timeout", next_poll_at: "2026-07-07T16:00:50Z" });
          }
          return jsonResponse({
            status: "actionable",
            for: "my_choice",
            decision: {
              id: "d2",
              seq: 3,
              question: "Pick the three-act structure",
              options: ["A", "B"],
              status: "voting",
            },
          });
        },
        env: providerEnv({ providers: {} }),
      },
    );

    expect(code).toBe(0);
    // Long-polls next-action with the room token; re-polls silently on timeout.
    expect(requests).toHaveLength(2);
    const url = new URL(requests[0]?.url ?? "");
    expect(url.pathname).toBe("/api/rooms/abc123/next-action");
    expect(url.searchParams.get("for")).toBe("my_choice");
    expect(url.searchParams.get("wait")).toBe("50");
    expect(url.searchParams.get("token")).toBeNull();
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer t_1");
    // Nothing printed for the timeout; one compact wake line at the end.
    expect(stdout).toContain('The room needs you: "Pick the three-act structure"');
    expect(stdout).toContain("grp read abc123");
    expect(stdout).toContain('grp choose "<option>"');
    expect(stdout).not.toContain("timeout");
  });

  // Spec 125 (WR12-1) — the opener-seal wake: a resolved-status actionable
  // means the caller's own question sealed with nothing else open; the wake
  // says so and routes to ask/outcome, never to choose.
  it("renders the opener-seal wake distinctly for watch --until=needed", async () => {
    let stdout = "";
    const code = await runRoomCli(
      ["watch", "https://operator.example/r/abc123?token=t_1", "--until=needed"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            status: "actionable",
            for: "my_choice",
            decision: {
              id: "d4",
              seq: 4,
              question: "What is the ending tone?",
              options: ["A", "B"],
              status: "resolved",
            },
          }),
        env: providerEnv({ providers: {} }),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toContain('Your question resolved: "What is the ending tone?"');
    expect(stdout).toContain('grp ask "..."');
    expect(stdout).toContain("grp outcome abc123");
    expect(stdout).not.toContain("The room needs you");
    expect(stdout).not.toContain('grp choose "<option>"');
  });

  // Spec 125 — --timeout was silently ignored on the --until=needed branch;
  // run 12's bounded needed-watches blocked forever. The bound must hold.
  it("watch --until=needed honors --timeout and exits with the timeout line", async () => {
    let stdout = "";
    const code = await runRoomCli(
      ["watch", "https://operator.example/r/abc123?token=t_1", "--until=needed", "--timeout=1"],
      {
        stdout: (t) => {
          stdout += t;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const url = new Request(input, init).url;
          if (url.includes("/next-action")) {
            // Long-poll that never becomes actionable.
            await new Promise((r) => setTimeout(r, 1100));
            return jsonResponse({ status: "timeout", next_poll_at: "2026-07-11T00:00:50Z" });
          }
          // Phase check at timeout: a question is open -> generic copy.
          return jsonResponse({
            slug: "abc123",
            status: "open",
            state: "seq 1 deciding — 1/4 chosen; closes in 60m",
            new: [],
            current_through: 10,
          });
        },
        env: providerEnv({ providers: {} }),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toContain("Nothing new after 1s");
  }, 15000);

  it("accepts the old my-turn spelling as a silent alias for --until=needed", async () => {
    let stdout = "";
    const code = await runRoomCli(
      ["watch", "https://operator.example/r/abc123?token=t_1", "--until=my-turn"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            status: "actionable",
            for: "my_choice",
            decision: { id: "d1", seq: 1, question: "Pick one", options: [], status: "voting" },
          }),
        env: providerEnv({ providers: {} }),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toContain('The room needs you: "Pick one"');
  });

  it("requires room credentials for watch --until=needed", async () => {
    let stderr = "";
    const code = await runRoomCli(
      ["watch", "https://operator.example/r/abc123", "--until=needed"],
      {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch: async () => {
          throw new Error("fetch should not run without credentials");
        },
        env: providerEnv({ providers: {} }),
      },
    );

    expect(code).toBe(1);
    expect(stderr).toContain("Join first: grp join <room-id>");
  });

  // Spec 109 (WR2-11) — the stream backfills history; a replayed
  // decision.completed (seq <= head at watch start) must NOT satisfy --until,
  // while a live one (seq > head) must.
  it("does not stop --until=next-resolved on replayed history, only on live events", async () => {
    const requests: Request[] = [];
    let stdout = "";

    const code = await runRoomCli(
      ["watch", "https://operator.example/r/abc123?token=t_1", "--until=next-resolved"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          if (!request.url.includes("/events/stream")) {
            // The room already resolved one decision before the watch began.
            return jsonResponse({
              slug: "abc123",
              events: [
                {
                  id: "e3",
                  seq: 3,
                  event_type: "decision.completed",
                  occurred_at: "2026-06-14T00:00:01.000Z",
                  decision_id: "d1",
                  data: { winner: "approve" },
                },
              ],
            });
          }
          return new Response(
            sseStream([
              // Replayed history: same completed decision, seq <= head.
              'id: e3\ndata: {"id":"e3","seq":3,"event_type":"decision.completed","occurred_at":"2026-06-14T00:00:01.000Z","decision_id":"d1","data":{"winner":"approve"}}\n\n',
              'id: e4\ndata: {"id":"e4","seq":4,"event_type":"discussion.posted","occurred_at":"2026-06-14T00:00:02.000Z","decision_id":null,"data":{"body":"still going"}}\n\n',
              // Live completion: seq > head at watch start.
              'id: e5\ndata: {"id":"e5","seq":5,"event_type":"decision.completed","occurred_at":"2026-06-14T00:00:03.000Z","decision_id":"d2","data":{"winner":"ship it"}}\n\n',
            ]),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
        env: providerEnv({ providers: {} }),
      },
    );

    expect(code).toBe(0);
    expect(requests[0]?.url).toBe("https://operator.example/api/rooms/abc123/events");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer t_1");
    // Spec 115 (WR7-11) — replayed history never echoes; the live completion
    // is the only thing that prints, as the stop block.
    expect(stdout).not.toContain("still going");
    expect(stdout).not.toContain('"winner":"ship it"');
    expect(stdout).toContain('Decision resolved: "ship it"');
  });

  // Spec 109 (WR2-8) — a dropped stream reconnects with backoff, resumes from
  // the last seen event, dedupes replay, and still honors --until afterwards.
  it("reconnects after a stream drop, dedupes replay, and honors --until", async () => {
    const requests: Request[] = [];
    let stdout = "";
    let stderr = "";

    const code = await runRoomCli(
      ["watch", "https://operator.example/r/abc123?token=t_1", "--until=resolved"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          if (!request.url.includes("/events/stream")) {
            return jsonResponse({
              slug: "abc123",
              events: [
                {
                  id: "e1",
                  seq: 1,
                  event_type: "participant.joined",
                  occurred_at: "2026-06-14T00:00:00.000Z",
                  decision_id: null,
                  data: { name: "Prism" },
                },
              ],
            });
          }
          const streamConnects = requests.filter((r) => r.url.includes("/events/stream"));
          if (streamConnects.length === 1) {
            // First connection: one live discussion event, then the stream
            // drops without satisfying --until.
            return new Response(
              sseStream([
                'id: e2\ndata: {"id":"e2","seq":2,"event_type":"discussion.posted","occurred_at":"2026-06-14T00:00:01.000Z","decision_id":null,"data":{"body":"first note"}}\n\n',
              ]),
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          // Reconnected stream: replays the already-seen event, then resolves.
          return new Response(
            sseStream([
              'id: e2\ndata: {"id":"e2","seq":2,"event_type":"discussion.posted","occurred_at":"2026-06-14T00:00:01.000Z","decision_id":null,"data":{"body":"first note"}}\n\n',
              'id: e3\ndata: {"id":"e3","seq":3,"event_type":"decision.completed","occurred_at":"2026-06-14T00:00:02.000Z","decision_id":"d1","data":{"winner":"approve"}}\n\n',
            ]),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
        env: { ...providerEnv({ providers: {} }), GRP_WATCH_RECONNECT_MS: "0" },
      },
    );

    expect(code).toBe(0);
    // One reconnect status line, and the resumed connection carries the
    // last-seen cursor so no events are missed.
    expect(stderr).toContain("[watch] stream ended; reconnecting...");
    const streamUrls = requests.map((r) => r.url).filter((url) => url.includes("/events/stream"));
    expect(streamUrls).toHaveLength(2);
    expect(streamUrls[1]).toContain("since_event_id=e2");
    const resumed = requests[requests.length - 1];
    expect(resumed?.headers.get("last-event-id")).toBe("e2");
    // The replayed event does not re-print: exactly one "first note" line.
    // Spec 115 (WR7-11) — quiet until-mode: no event echo at all.
    expect(stdout).not.toContain("first note");
    // --until still fires after the reconnect.
    expect(stdout).not.toContain("decision completed");
    expect(stdout).toContain('Decision resolved: "approve"');
  });

  it("renders room members from full room state", async () => {
    const requests: Request[] = [];
    let stdout = "";
    const code = await runRoomCli(["members", "https://operator.example/r/abc123?token=t_1"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return jsonResponse({
          slug: "abc123",
          config: { creator_votes: false },
          participants: [
            {
              display_name: "Alex's agent",
              role: "participant",
              joined_at: "2026-06-18T20:00:00.000Z",
              last_seen_at: "2026-06-18T20:05:00.000Z",
            },
            {
              display_name: "Casey's agent",
              role: "observer",
              joined_at: "2026-06-18T20:02:00.000Z",
              last_seen_at: null,
            },
          ],
        });
      },
      env: {},
    });

    expect(code).toBe(0);
    expect(requests[0]?.url).toBe("https://operator.example/api/rooms/abc123?include=full");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer t_1");
    expect(stdout).toContain("Members for abc123");
    expect(stdout).toContain("Alex's agent (participant; non-voting host)");
    expect(stdout).toContain("Casey's agent (observer)");
  });

  it("updates a member role from the current room context", async () => {
    const env = providerEnv({
      currentRoom: {
        baseUrl: "https://operator.example",
        slug: "abc123",
        token: "t_operator",
      },
    });
    const requests: Request[] = [];
    let stdout = "";
    const code = await runRoomCli(["members", "set-role", "Felix", "observer"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        expect(request.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({
          role: "observer",
        });
        expect(request.headers.get("authorization")).toBe("Bearer t_operator");
        return jsonResponse({
          slug: "abc123",
          participant: { id: "p_felix", display_name: "Felix", role: "observer" },
        });
      },
      env,
    });

    expect(code).toBe(0);
    expect(requests[0]?.url).toBe("https://operator.example/api/rooms/abc123/members/Felix");
    expect(stdout).toContain("Updated Felix: observer.");
    // Spec 106 — targetless hint: this is the current room.
    expect(stdout).toContain("Run:\n  grp members\n");
  });

  it("renders room settings from full room state", async () => {
    let stdout = "";
    const code = await runRoomCli(["settings", "https://operator.example/r/abc123", "--json"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          config: { visibility: "unlisted", mechanism: "simple_majority" },
        }),
      env: {},
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      slug: "abc123",
      config: { visibility: "unlisted", mechanism: "simple_majority" },
    });
  });

  it("settings teaches agreement questions on majority rooms (spec 152 W3)", async () => {
    let stdout = "";
    const code = await runRoomCli(["settings", "https://operator.example/r/abc123"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          config: { visibility: "unlisted", mechanism: "simple_majority" },
        }),
      env: {},
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Agreement questions: supported");
    expect(stdout).toContain('grp ask --agreement "..."');
  });

  it("settings stays quiet about agreement on non-majority rooms (spec 152 W3)", async () => {
    let stdout = "";
    const code = await runRoomCli(["settings", "https://operator.example/r/abc123"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          config: { visibility: "unlisted", mechanism: "score_vote" },
        }),
      env: {},
    });

    expect(code).toBe(0);
    expect(stdout).not.toContain("Agreement questions");
  });

  it("creates a named room invite", async () => {
    const requests: Request[] = [];
    let stdout = "";
    const code = await runRoomCli(
      ["invite", "https://operator.example/r/abc123?token=t_1", "--name=Alex's agent"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          expect(JSON.parse(String(init?.body))).toEqual({
            label: "Alex's agent",
          });
          expect(request.headers.get("authorization")).toBe("Bearer t_1");
          return jsonResponse({
            slug: "abc123",
            about: "Planning Friday dinner",
            invite: {
              code: "inv_alex",
              label: "Alex's agent",
              role: "participant",
              expected: true,
              status: "pending",
            },
            invite_token: "it_alex",
            join_url: "https://operator.example/r/abc123?invite=it_alex",
            join_command: "grp join https://operator.example/r/abc123 --invite it_alex",
            paste_block: [
              "You’re invited to join a GRP room. GRP (Group Resolution Protocol) is an open protocol for shared deliberation and decisions.",
              "",
              "Room purpose: Planning Friday dinner",
              "",
              "This invite is for Alex's agent (participant).",
              "",
              "Room service: Example Rooms at https://operator.example, operated by Example Org.",
              "",
              "If needed, install the open-source GRP CLI:",
              "npm install -g @grp-protocol/cli",
              "",
              "Join the room:",
              "grp join https://operator.example/r/abc123 --invite it_alex",
            ].join("\n"),
          });
        },
        env: {},
      },
    );

    expect(code).toBe(0);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe("https://operator.example/api/rooms/abc123/invites");
    expect(stdout).toContain("Invite created for Alex's agent");
    expect(stdout).toContain("Management code (list/revoke): inv_alex");
    expect(stdout).toContain("Secret join credential: included only in the paste block below.");
    expect(stdout).not.toContain("\nCode: inv_alex");
    expect(stdout).toContain("Binding: token invite");
    expect(stdout).toContain(
      "Credential warning: this invite can recover its named seat even after acceptance.",
    );
    expect(stdout).toContain("grp invite revoke inv_alex");
    // Spec 111 (WR3-1) — participant invites get the one operator-facing
    // observer hint, right after the role line.
    expect(stdout).toContain("Role: participant (expected)");
    expect(stdout).toContain("Watch-only seat? Re-create with --role observer.");
    // Spec 111 (WR-2 + WR3-2) — the server paste block is relayed verbatim
    // (indented), framed as one keep-intact artifact.
    expect(stdout).toContain("Paste this to the agent, intact:");
    expect(stdout).toContain(
      "You’re invited to join a GRP room. GRP (Group Resolution Protocol) is an open protocol",
    );
    expect(stdout).toContain("Room purpose: Planning Friday dinner");
    expect(stdout).toContain("This invite is for Alex's agent (participant).");
    expect(stdout).toContain(
      "Room service: Example Rooms at https://operator.example, operated by Example Org.",
    );
    expect(stdout).toContain("If needed, install the open-source GRP CLI:");
    expect(stdout).toContain("npm install -g @grp-protocol/cli");
    expect(stdout).toContain("Join the room:");
    expect(stdout).not.toContain("stay with the room");
    // Spec 106 — the paste block carries the full join URL so a cold machine
    // with no default host can run the command as-is.
    expect(stdout).toContain("grp join https://operator.example/r/abc123 --invite it_alex");
    expect(stdout).toContain("Browser link:");
    expect(stdout).toContain("https://operator.example/r/abc123");
    expect(stdout).not.toContain("Browser link:\n  https://operator.example/r/abc123?invite=");
  });

  it("does not show the observer hint for observer invites", async () => {
    let stdout = "";
    const code = await runRoomCli(
      [
        "invite",
        "https://operator.example/r/abc123?token=t_1",
        "--name=Meridian",
        "--role=observer",
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            slug: "abc123",
            invite: {
              code: "inv_meridian",
              label: "Meridian",
              role: "observer",
              expected: false,
              status: "pending",
            },
            invite_token: "it_meridian",
            join_command: "grp join https://operator.example/r/abc123 --invite it_meridian",
          }),
        env: {},
      },
    );

    expect(code).toBe(0);
    expect(stdout).toContain("Role: observer (optional)");
    expect(stdout).toContain("This invite is for Meridian (observer).");
    expect(stdout).not.toContain("Watch-only seat?");
  });

  it("builds the full paste block locally when the host omits paste_block and join_command", async () => {
    let stdout = "";
    const code = await runRoomCli(
      ["invite", "https://operator.example/r/abc123?token=t_1", "--name=Alex"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            slug: "abc123",
            about: "Planning Friday dinner",
            invite: {
              code: "inv_alex",
              label: "Alex",
              role: "participant",
              expected: true,
              status: "pending",
            },
            invite_token: "it_alex",
          }),
        env: {},
      },
    );

    expect(code).toBe(0);
    // Spec 213 — old servers get an honest client-built grounding block. The
    // old response has no discovery metadata, so the fallback names the URL
    // without inventing an operator.
    expect(stdout).toContain("Paste this to the agent, intact:");
    expect(stdout).toContain(
      "You’re invited to join a GRP room. GRP (Group Resolution Protocol) is an open protocol",
    );
    expect(stdout).toContain("Room purpose: Planning Friday dinner");
    expect(stdout).toContain("This invite is for Alex (participant).");
    expect(stdout).toContain("Room service: https://operator.example.");
    expect(stdout).toContain("If needed, install the open-source GRP CLI:");
    expect(stdout).toContain("npm install -g @grp-protocol/cli");
    expect(stdout).toContain("Join the room:");
    expect(stdout).not.toContain("operated by the person who sent you this invite");
    expect(stdout).not.toContain("stay with the room");
    expect(stdout).toContain("grp join https://operator.example/r/abc123 --invite it_alex");
    expect(stdout.indexOf("install the open-source GRP CLI")).toBeLessThan(
      stdout.indexOf("grp join https://operator.example/r/abc123 --invite it_alex"),
    );
  });

  // Spec 126 (TS1-3) — the fallback block never clips the room purpose.
  it("carries a long about whole in the locally built paste block", async () => {
    const about = `${"the operative rules of this room matter ".repeat(8)}and the tail is load-bearing`;
    let stdout = "";
    const code = await runRoomCli(
      ["invite", "https://operator.example/r/abc123?token=t_1", "--name=Alex"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            slug: "abc123",
            about,
            invite: {
              code: "inv_alex",
              label: "Alex",
              role: "participant",
              expected: true,
              status: "pending",
            },
            invite_token: "it_alex",
          }),
        env: {},
      },
    );

    expect(code).toBe(0);
    expect(stdout).toContain(`Room purpose: ${about}`);
    expect(stdout).not.toContain("...");
  });

  it("drops the room-purpose line when the host does not return room context", async () => {
    let stdout = "";
    const code = await runRoomCli(
      ["invite", "https://operator.example/r/abc123?token=t_1", "--name=Alex"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            slug: "abc123",
            invite: {
              code: "inv_alex",
              label: "Alex",
              role: "participant",
              expected: true,
              status: "pending",
            },
            invite_token: "it_alex",
            join_command: "grp join https://operator.example/r/abc123 --invite it_alex",
          }),
        env: {},
      },
    );

    expect(code).toBe(0);
    expect(stdout).toContain(
      "You’re invited to join a GRP room. GRP (Group Resolution Protocol) is an open protocol",
    );
    expect(stdout).not.toContain("Room purpose:");
    expect(stdout).toContain("This invite is for Alex (participant).");
    expect(stdout).toContain("grp join https://operator.example/r/abc123 --invite it_alex");
  });

  it("creates an email-bound room invite", async () => {
    const bodies: unknown[] = [];
    let stdout = "";
    const code = await runRoomCli(
      [
        "invite",
        "https://operator.example/r/abc123?token=t_1",
        "--name=Alex",
        "--email=Alex@Example.com",
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return jsonResponse({
            slug: "abc123",
            invite: {
              code: "inv_alex",
              label: "Alex",
              role: "participant",
              expected: true,
              status: "pending",
              binding: { kind: "email", value: "alex@example.com" },
            },
            invite_token: "it_alex",
            join_command: "grp join https://operator.example/r/abc123 --invite it_alex",
          });
        },
        env: {},
      },
    );

    expect(code).toBe(0);
    expect(bodies).toEqual([
      {
        label: "Alex",
        binding: { kind: "email", value: "Alex@Example.com" },
      },
    ]);
    expect(stdout).toContain("Binding: email alex@example.com");
  });

  it("lists durable room invites", async () => {
    const requests: Request[] = [];
    let stdout = "";
    const code = await runRoomCli(
      ["invite", "list", "https://operator.example/r/abc123?token=t_1"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          return jsonResponse({
            slug: "abc123",
            invites: [
              {
                code: "inv_alex",
                label: "Alex",
                role: "participant",
                expected: true,
                status: "pending",
              },
            ],
          });
        },
        env: {},
      },
    );

    expect(code).toBe(0);
    expect(requests[0]?.url).toBe("https://operator.example/api/rooms/abc123/invites");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer t_1");
    expect(stdout).toContain("Invites for abc123");
    expect(stdout).toContain("Alex inv_alex participant expected pending");
  });

  it("revokes durable room invites", async () => {
    const requests: Request[] = [];
    let stdout = "";
    const code = await runRoomCli(
      ["invite", "revoke", "inv_alex", "https://operator.example/r/abc123?token=t_1"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          return jsonResponse({
            slug: "abc123",
            invite: {
              code: "inv_alex",
              label: "Alex",
              role: "participant",
              expected: true,
              status: "revoked",
            },
          });
        },
        env: {},
      },
    );

    expect(code).toBe(0);
    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.url).toBe("https://operator.example/api/rooms/abc123/invites/inv_alex");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer t_1");
    expect(stdout).toContain("revoked inv_alex (Alex)");
  });

  it("passes invite tokens when joining rooms", async () => {
    const bodies: unknown[] = [];
    const code = await runRoomCli(
      ["join", "https://operator.example/r/abc123", "--invite=it_alex", "--as=Alex"],
      {
        stdout: () => {},
        stderr: () => {},
        fetch: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return jsonResponse({ participant_token: "t_joined", role: "participant" });
        },
        env: providerEnv({ providers: {} }),
      },
    );

    expect(code).toBe(0);
    expect(bodies).toEqual([{ display_name: "Alex", invite: "it_alex" }]);
  });

  it("rejects invite-shaped tokens passed as participant tokens when joining rooms", async () => {
    let stderr = "";
    let called = false;
    const code = await runRoomCli(
      ["join", "https://operator.example/r/abc123", "--token=it_alex", "--as=Alex"],
      {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch: async () => {
          called = true;
          return jsonResponse({ participant_token: "t_joined", role: "participant" });
        },
        env: providerEnv({ providers: {} }),
      },
    );

    expect(code).toBe(1);
    expect(called).toBe(false);
    expect(stderr).toContain("That looks like an invite token.");
    expect(stderr).toContain("grp join <room-id> --invite <invite-token>");
  });

  it("prints an empty durable invite list", async () => {
    let stdout = "";
    const code = await runRoomCli(
      ["invite", "list", "https://operator.example/r/abc123?token=t_1"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            slug: "abc123",
            invites: [],
          }),
        env: {},
      },
    );

    expect(code).toBe(0);
    expect(stdout).toContain("Invites for abc123");
    expect(stdout).toContain("No named invites yet");
    expect(stdout).toContain("grp invite --name <name>");
  });

  // Spec 143 (F142-S1) — the CLI allowlist mirrors the server's mutable keys:
  // the spec-142 room cap and settle_window are settable without REST detours.
  it("sets max_open_decisions and settle_window as integer settings", async () => {
    const bodies: unknown[] = [];
    const io = {
      stdout: () => {},
      stderr: () => {},
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ slug: "abc123", changed: ["max_open_decisions"], config: {} });
      },
      env: {},
    };
    expect(
      await runRoomCli(
        [
          "settings",
          "set",
          "max_open_decisions",
          "3",
          "https://operator.example/r/abc123?token=t_1",
        ],
        io,
      ),
    ).toBe(0);
    expect(
      await runRoomCli(
        ["settings", "set", "settle_window", "60", "https://operator.example/r/abc123?token=t_1"],
        io,
      ),
    ).toBe(0);
    expect(bodies[0]).toEqual({ settings: { max_open_decisions: 3 } });
    expect(bodies[1]).toEqual({ settings: { settle_window: 60 } });
  });

  it("creates a room with --max-open-decisions in the config", async () => {
    const bodies: unknown[] = [];
    const env = {
      ...providerEnv({ providers: {} }),
      GRP_BASE_URL: "https://operator.example",
    };
    const code = await runRoomCli(["create", "--about=cap room", "--max-open-decisions=2"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          slug: "cap123",
          creator_token: "t_c",
          about: "cap room",
          config: {},
        });
      },
      env,
    });
    expect(code).toBe(0);
    const body = bodies[0] as { config?: Record<string, unknown> };
    expect(body.config?.max_open_decisions).toBe(2);
  });

  it("creates a persistent organization room with the declared ordinary settings", async () => {
    const bodies: unknown[] = [];
    const env = {
      ...providerEnv({ providers: {} }),
      GRP_BASE_URL: "https://operator.example",
    };
    const code = await runRoomCli(
      [
        "create",
        "--about=Publishing greenlight",
        "--type=persistent",
        "--mechanism=score_vote",
        "--decision-opening-authority=none",
        "--conclusion-authority=any_participant",
        "--deliberation-mode=disabled",
        "--read-receipts=true",
        "--choice-visibility=after_decided",
        "--json",
      ],
      {
        stdout: () => {},
        stderr: () => {},
        fetch: async (input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return jsonResponse({
            slug: "persistent123",
            creator_token: "t_c",
            about: "Publishing greenlight",
            config: {},
          });
        },
        env,
      },
    );

    expect(code).toBe(0);
    expect(bodies[0]).toMatchObject({
      config: {
        type: "persistent",
        mechanism: "score_vote",
        decision_opening_authority: { kind: "none" },
        conclusion_authority: { kind: "any_participant" },
        deliberation_mode: "disabled",
        read_receipts: true,
        choice_visibility: "after_decided",
      },
    });
  });

  it("updates a room setting", async () => {
    const requests: Request[] = [];
    let stdout = "";
    const code = await runRoomCli(
      ["settings", "set", "quorum", "4", "https://operator.example/r/abc123?token=t_1"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          expect(JSON.parse(String(init?.body))).toEqual({
            settings: { quorum: 4 },
          });
          expect(request.headers.get("authorization")).toBe("Bearer t_1");
          return jsonResponse({
            slug: "abc123",
            changed: ["quorum"],
            config: {
              visibility: "unlisted",
              mechanism: "simple_majority",
              quorum: 4,
              invite_authority: { kind: "operator" },
            },
          });
        },
        env: {},
      },
    );

    expect(code).toBe(0);
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.url).toBe("https://operator.example/api/rooms/abc123/settings");
    expect(stdout).toContain("Settings updated for abc123");
    expect(stdout).toContain("Changed: quorum");
    expect(stdout).toContain("Can invite: operator");
  });

  it("updates authority settings with canonical values", async () => {
    const bodies: unknown[] = [];
    const code = await runRoomCli(
      [
        "settings",
        "set",
        "invite_authority",
        "any_participant",
        "https://operator.example/r/abc123?token=t_1",
        "--json",
      ],
      {
        stdout: () => {},
        stderr: () => {},
        fetch: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return jsonResponse({ slug: "abc123", changed: ["invite_authority"], config: {} });
        },
        env: {},
      },
    );

    expect(code).toBe(0);
    expect(bodies).toEqual([
      {
        settings: { invite_authority: { kind: "any_participant" } },
      },
    ]);
  });

  it("rejects unknown room setting keys locally", async () => {
    let stderr = "";
    const code = await runRoomCli(["settings", "set", "bogus_key", "public"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () => {
        throw new Error("unexpected fetch");
      },
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(1);
    expect(stderr).toContain("unknown room setting: bogus_key");
    expect(stderr).toContain("Available settings:");
  });

  // Spec 126 (TS1-2b) — real create-time keys point at the create flag
  // instead of the generic unknown-setting line.
  it("points mechanism/visibility at create-time flags", async () => {
    for (const [key, needle] of [
      ["mechanism", "grp create --mechanism=supermajority --quorum=2"],
      ["visibility", "grp create --visibility=public"],
    ] as const) {
      let stderr = "";
      const code = await runRoomCli(["settings", "set", key, "anything"], {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch: async () => {
          throw new Error("unexpected fetch");
        },
        env: { GRP_BASE_URL: "https://operator.example" },
      });
      expect(code).toBe(1);
      expect(stderr).toContain(needle);
      expect(stderr).not.toContain("unknown room setting");
    }
  });

  // Spec 106 — write commands confirm what happened and name the next action.
  it("confirms an opened question and points at read/watch", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stdout = "";
    const code = await runRoomCli(["ask", "Choose one dinner plan"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          ok: true,
          slug: "abc123",
          decision: {
            id: "d1",
            seq: 2,
            question: "Choose one dinner plan",
            options: [],
            status: "voting",
          },
        }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain('Question opened: "Choose one dinner plan"');
    expect(stdout).toContain("Next:");
    // Spec 106 — targetless hints: this is the current room.
    expect(stdout).toContain("Read the room: grp read\n");
    // Spec 113 — the one wait; the floor rule covers the asker's own choice.
    expect(stdout).toContain("Wait for what's next: grp watch\n");
  });

  it("notes the collecting phase when ask opens a slate decision", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stdout = "";
    const code = await runRoomCli(["ask", "Pick a title", "--collect-options=600"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          ok: true,
          slug: "abc123",
          decision: {
            id: "d1",
            seq: 2,
            question: "Pick a title",
            options: [],
            status: "proposing",
          },
        }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain('Question opened: "Pick a title"');
    expect(stdout).toContain("Collecting options first: propose options, then start choosing.");
  });

  it("confirms a proposed option and points at options/start-choosing", async () => {
    let stdout = "";
    const code = await runRoomCli(
      ["propose", "https://operator.example/r/abc123?token=t_1", "--option=Tamarind Table"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({ accepted: true, options: ["Noodle House", "Tamarind Table"] }),
        env: providerEnv({ providers: {} }),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toContain('Option proposed: "Tamarind Table"');
    expect(stdout).toContain("Options on the slate: 2");
    expect(stdout).toContain("See the slate: grp options abc123");
    // Spec 116 (WR8-5) — the slate-phase gate is start choosing, not choose.
    expect(stdout).toContain("When the slate is ready: grp start choosing abc123");
    expect(stdout).not.toContain("grp choose");
  });

  it("explains when a proposed option already exists", async () => {
    let stdout = "";
    const code = await runRoomCli(
      ["propose", "https://operator.example/r/abc123?token=t_1", "--option=Tamarind Table"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            accepted: false,
            reason: "option already exists",
            options: ["Tamarind Table"],
          }),
        env: providerEnv({ providers: {} }),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toContain('Option not added: "Tamarind Table" — option already exists.');
  });

  it("confirms a posted discussion and points at read", async () => {
    let stdout = "";
    const code = await runRoomCli(
      ["discuss", "https://operator.example/r/abc123?token=t_1", "--body=Clarity first."],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () => jsonResponse({ ok: true, id: "m1" }),
        env: providerEnv({ providers: {} }),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toContain("Discussion posted.");
    expect(stdout).toContain("Read the room: grp read abc123");
    expect(stdout).toContain("If more work may follow: grp watch abc123");
  });

  it("confirms open choices after start choosing", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stdout = "";
    const code = await runRoomCli(["start", "choosing"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          ok: true,
          slug: "abc123",
          decision: { id: "d1", seq: 2, options: ["A", "B"], status: "voting" },
        }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Choices are open.");
    expect(stdout).toContain("Options: 2 on the slate");
    expect(stdout).toContain('Submit your choice: grp choose "<option>"');
    expect(stdout).toContain("See the options: grp options\n");
  });

  it("confirms room closure and points at the final record", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_operator" },
      providers: {},
    });
    let stdout = "";
    const code = await runRoomCli(["close", "Town wins"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          ok: true,
          slug: "abc123",
          concluded_at: "2026-07-02T00:00:00.000Z",
          receipt_hash: "sha256:abc",
        }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Room closed.");
    expect(stdout).toContain("Final record: grp outcome\n");
  });

  it("keeps close --quiet printing only the receipt hash", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_operator" },
      providers: {},
    });
    let stdout = "";
    const code = await runRoomCli(["close", "Town wins", "--quiet"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () => jsonResponse({ ok: true, slug: "abc123", receipt_hash: "sha256:abc" }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout.trim()).toBe("sha256:abc");
  });

  it("hides write actions when reading a concluded room", async () => {
    let stdout = "";
    const code = await runRoomCli(["read", "abc123"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          about: "Bug triage",
          status: "concluded",
          brief: "Room concluded: Town wins.",
          decision: null,
        }),
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Available actions:");
    expect(stdout).toContain("grp outcome");
    expect(stdout).toContain("grp members");
    expect(stdout).not.toContain("grp ask");
    expect(stdout).not.toContain("grp discuss");
    expect(stdout).not.toContain("grp invite");
    expect(stdout).not.toContain("No active question yet.");
  });

  // Spec 106 — hints for the current room use the targetless form, which is
  // the form that works on a cold machine with no default host.
  it("prints targetless hints when choosing in the current room", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stdout = "";
    const code = await runRoomCli(["choose", "--choice=approve"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          ok: true,
          slug: "abc123",
          cast_choice: "approve",
          status: "voting",
          resolved_winner: null,
          resolved_outcome: null,
        }),
      env,
    });

    expect(code).toBe(0);
    // Spec 113 — one wait, targetless for the current room.
    expect(stdout).toContain("Wait for what's next: grp watch\n");
    expect(stdout).not.toContain("--until=");
    expect(stdout).not.toContain("grp watch abc123");
  });

  it("prints targetless read guidance when reading the current room", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stdout = "";
    const code = await runRoomCli(["read"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          brief: 'Deciding now: "Choose one dinner plan" — 1/3 choices in.',
          decision: {
            question: "Choose one dinner plan",
            status: "voting",
            options: ["Tamarind Table at 7:30"],
            choices_cast: 1,
            eligible_voters: 3,
          },
          rules: { how_to_choose: "choose with a single option (string) from the options list" },
        }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Wait for what's next: grp watch\n");
    expect(stdout).not.toContain("--until=");
    expect(stdout).not.toContain("grp watch abc123");
    expect(stdout).not.toContain("grp outcome abc123");
  });

  // Spec 109 (WR2-1) — role-aware read guidance: observers get watch/read
  // guidance, never choose/propose/discuss/ask affordances.
  it("renders observer guidance when the server reports an observer role", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stdout = "";
    const code = await runRoomCli(["read"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          role: "observer",
          brief: 'Deciding now: "Choose one dinner plan" — 1/3 choices in.',
          decision: {
            question: "Choose one dinner plan",
            status: "voting",
            options: ["Tamarind Table at 7:30"],
            choices_cast: 1,
            eligible_voters: 3,
          },
          rules: { how_to_choose: "choose with a single option (string) from the options list" },
        }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain("You are an observer in this room");
    // Spec 113 — watch wakes observers too; read-only Next.
    expect(stdout).toContain("Wait for what's next: grp watch");
    expect(stdout).toContain("Check the result: grp outcome");
    expect(stdout).toContain("grp members");
    expect(stdout).not.toContain("If you have not chosen yet");
    expect(stdout).not.toContain("grp choose");
    expect(stdout).not.toContain("grp propose");
    expect(stdout).not.toContain("grp discuss");
    expect(stdout).not.toContain("grp ask");
    expect(stdout).not.toContain("grp invite");
  });

  it("falls back to the role saved from the join response on old servers", async () => {
    const env = providerEnv({ providers: {} });
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/join")) {
        return jsonResponse({ participant_token: "t_observer", role: "observer" });
      }
      // Old server: the read does not echo the caller's role.
      return jsonResponse({
        slug: "abc123",
        brief: "No decision is open right now.",
        decision: null,
        status: "open",
      });
    };

    expect(
      await runRoomCli(["join", "https://operator.example/r/abc123", "--as=Lookout"], {
        stdout: () => {},
        stderr: () => {},
        fetch,
        env,
      }),
    ).toBe(0);

    let stdout = "";
    const code = await runRoomCli(["read"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch,
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Watch for the next question: grp watch");
    expect(stdout).toContain("grp outcome");
    expect(stdout).not.toContain("grp choose");
    expect(stdout).not.toContain("grp ask");
    expect(stdout).not.toContain("grp discuss");
    expect(stdout).not.toContain("grp invite");
  });

  it("keeps participant read guidance when the server reports a participant role", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stdout = "";
    const code = await runRoomCli(["read"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          role: "participant",
          brief: 'Deciding now: "Choose one dinner plan" — 1/3 choices in.',
          decision: {
            question: "Choose one dinner plan",
            status: "voting",
            options: ["Tamarind Table at 7:30"],
            choices_cast: 1,
            eligible_voters: 3,
          },
          rules: { how_to_choose: "choose with a single option (string) from the options list" },
        }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain("If you have not responded yet: grp choose N");
    expect(stdout).toContain("grp choose N");
    expect(stdout).not.toContain("You are an observer");
  });

  // Spec 109 (WR2-2) — the creator's participant row takes the saved profile
  // display name at create time.
  it("sends the profile display name as the creator name on create", async () => {
    const env = {
      ...providerEnv({ profile: { displayName: "Prism" }, providers: {} }),
      GRP_BASE_URL: "https://operator.example",
    };
    const bodies: unknown[] = [];
    let stdout = "";
    const code = await runRoomCli(["create", "--about=Writers room", "--unlisted"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect(new URL(request.url).pathname).toBe("/api/rooms");
        bodies.push(await request.json());
        return jsonResponse({
          slug: "abc123",
          creator_token: "t_creator",
          about: "Writers room",
        });
      },
      env,
    });

    expect(code).toBe(0);
    expect(bodies[0]).toEqual({
      about: "Writers room",
      display_name: "Prism",
      config: { visibility: "unlisted", early_close: true },
    });
    expect(stdout).toContain("You: Prism (creator)");
  });

  it("omits the creator display name when no profile name is set", async () => {
    const env = { ...providerEnv({ providers: {} }), GRP_BASE_URL: "https://operator.example" };
    const bodies: unknown[] = [];
    let stdout = "";
    const code = await runRoomCli(["create", "--about=Writers room", "--unlisted"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        bodies.push(await request.json());
        return jsonResponse({
          slug: "abc123",
          creator_token: "t_creator",
          about: "Writers room",
        });
      },
      env,
    });

    expect(code).toBe(0);
    expect(bodies[0]).toEqual({
      about: "Writers room",
      config: { visibility: "unlisted", early_close: true },
    });
    expect(stdout).not.toContain("(creator)");
  });
});

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

describe("spec 113 delta reads", () => {
  const roomConfig = (extra: Record<string, unknown> = {}) => ({
    providers: {},
    currentRoom: {
      slug: "abc123",
      baseUrl: "https://operator.example",
      token: "t_1",
      ...extra,
    },
  });

  const deltaBody = {
    slug: "abc123",
    status: "voting",
    about: "Writers room",
    role: "participant",
    brief: 'Deciding now: "Pick one" — 1/4 choices in.',
    your_status: "you have not chosen on the open decision",
    new: [
      {
        seq: 6,
        type: "discussion",
        at: "2026-07-07T20:00:00Z",
        who: "Neon",
        stance: "extend",
        said: "Full text of the argument, uncut.",
      },
      {
        seq: 7,
        type: "option_proposed",
        at: "2026-07-07T20:00:05Z",
        who: "Argon",
        option: "Option B",
      },
      {
        seq: 8,
        type: "decision_resolved",
        at: "2026-07-07T20:00:09Z",
        question: "Earlier question",
        winner: "Option A",
        outcome: "pass",
        decision_seq: 1,
      },
    ],
    current_through: 8,
    more: {},
  };

  it("renders the anchored delta on a bare read and advances the mark", async () => {
    const env = providerEnv(roomConfig({ lastSeenSeq: 5 }));
    let stdout = "";
    let sinceParam: string | null = null;
    const code = await runRoomCli(["read"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        sinceParam = new URL(new Request(input, init).url).searchParams.get("since");
        return jsonResponse(deltaBody);
      },
      env,
    });
    expect(code).toBe(0);
    expect(sinceParam).toBe("5");
    expect(stdout).toContain("abc123 —"); // Spec 117 thin header
    expect(stdout).not.toContain("Project:"); // Spec 117 diet: no premise on deltas
    expect(stdout).toContain("You: you have not chosen on the open decision");
    expect(stdout).toContain("New since your last read:");
    expect(stdout).toContain("Full text of the argument, uncut.");
    expect(stdout).toContain("Option B");
    expect(stdout).toContain('Choose: grp choose "<option>"');
    expect(stdout).toContain(
      "This room resolves when its configured choice rules determine the outcome",
    );
    expect(stdout).not.toContain("every participant has chosen");
    expect(stdout).toContain("Current through seq 8.");
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(8);
  });

  it("renders selector-bearing guidance for a plural delta (spec 145)", async () => {
    const env = providerEnv(roomConfig({ lastSeenSeq: 5 }));
    let stdout = "";
    const code = await runRoomCli(["read"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          ...deltaBody,
          your_status:
            "you have not chosen on decisions 1, 2 and 3 (target each with decision: <seq>)",
        }),
      env,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Review each owed thread: grp read --decision=N");
    expect(stdout).toContain("See a slate: grp options --decision=N");
    expect(stdout).toContain('Choose: grp choose "<option>" --decision=N');
    expect(stdout).not.toContain('Choose: grp choose "<option>"\n');
  });

  it("renders selector-bearing guidance for a plural snapshot (spec 145)", async () => {
    let stdout = "";
    const code = await runRoomCli(["read"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          status: "voting",
          brief: 'Deciding now: "First" — 1/2 choices in. 1 more decision is open.',
          role: "participant",
          your_status:
            "you have not chosen on decisions 1 and 2 (target each with decision: <seq>)",
          decision: {
            seq: 1,
            question: "First",
            options: ["A", "B"],
            status: "voting",
            choices_cast: 1,
            eligible_voters: 2,
          },
          decisions_open: [
            { seq: 1, question: "First", status: "voting" },
            { seq: 2, question: "Second", status: "voting" },
          ],
          discussion: [],
          roster: { joined: [], expected: [], waiting_for: [] },
          rules: {},
          more: {},
        }),
      env: providerEnv(roomConfig()),
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Review each open thread: grp read --decision=N");
    expect(stdout).toContain("See its slate: grp options --decision=N");
    expect(stdout).toContain("using the ballot form shown by grp options --decision=N");
    expect(stdout).toContain('grp discuss "..." --decision=N');
    expect(stdout).toContain("grp discuss --file=PATH --decision=N");
    expect(stdout).toContain("grp options --decision=N");
  });

  it("keeps the full snapshot on first contact (no stored mark)", async () => {
    let sinceParam: string | null = "unset";
    let stdout = "";
    const code = await runRoomCli(["read"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        sinceParam = new URL(new Request(input, init).url).searchParams.get("since");
        return jsonResponse({
          slug: "abc123",
          status: "voting",
          brief: 'Deciding now: "Pick one" — 0/2 choices in.',
          decision: {
            seq: 1,
            question: "Pick one",
            options: ["A"],
            status: "voting",
            choices_cast: 0,
            eligible_voters: 2,
          },
          discussion: [],
          roster: { joined: [], expected: [], waiting_for: [] },
          rules: {},
          more: {},
        });
      },
      env: providerEnv(roomConfig()),
    });
    expect(code).toBe(0);
    expect(sinceParam).toBeNull();
    expect(stdout).toContain("Question: Pick one");
    expect(stdout).not.toContain("does not support delta reads");
  });

  it("falls back to the snapshot with a note on hosts without delta support", async () => {
    const env = providerEnv(roomConfig({ lastSeenSeq: 5 }));
    let stdout = "";
    const code = await runRoomCli(["read"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          status: "voting",
          brief: 'Deciding now: "Pick one" — 0/2 choices in.',
          decision: {
            seq: 1,
            question: "Pick one",
            options: ["A"],
            status: "voting",
            choices_cast: 0,
            eligible_voters: 2,
          },
          discussion: [],
          roster: { joined: [], expected: [], waiting_for: [] },
          rules: {},
          more: {},
        }),
      env,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("(this host does not support delta reads)");
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(5);
  });

  // Spec 142 (D9/P-6) — the focused read: one decision's thread, and it
  // NEVER advances the room mark (a focused read of one thread must not eat
  // the other threads' wakes).
  const focusedFullBody = {
    slug: "abc123",
    status: "voting",
    current_through: 99,
    decisions: [
      {
        id: "d1",
        seq: 1,
        question: "Old business",
        status: "resolved",
        options: ["x"],
        resolved_winner: "x",
        resolved_outcome: "pass",
        receipt_hash: "sha256:aaaa",
        voting_ends_at: new Date(Date.now() - 3600_000).toISOString(),
      },
      {
        id: "d2",
        seq: 2,
        question: "Which venue?",
        status: "voting",
        options: ["Blue Door", "Patio"],
        voting_ends_at: new Date(Date.now() + 3600_000).toISOString(),
      },
    ],
    participants: [{ id: "p9", display_name: "Casey" }],
    discussion: [
      {
        id: "m1",
        participant_id: "p9",
        body: "prefer the patio",
        stance: "extend",
        decision_id: "d2",
        posted_at: new Date().toISOString(),
      },
      {
        id: "m2",
        participant_id: "p9",
        body: "unrelated room chatter",
        decision_id: null,
        posted_at: new Date().toISOString(),
      },
    ],
  };

  it("read --decision=N renders one thread and never moves the mark (spec 142 P-6)", async () => {
    const env = providerEnv(roomConfig({ lastSeenSeq: 5 }));
    let stdout = "";
    let requestUrl = "";
    const code = await runRoomCli(["read", "--decision=2"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        requestUrl = new Request(input, init).url;
        return jsonResponse(focusedFullBody);
      },
      env,
    });
    expect(code).toBe(0);
    expect(new URL(requestUrl).searchParams.get("include")).toBe("full");
    expect(stdout).toContain('Decision 2: "Which venue?"');
    expect(stdout).toContain("1. Blue Door");
    expect(stdout).toContain("Casey (extend): prefer the patio");
    expect(stdout).not.toContain("unrelated room chatter"); // other-thread chatter filtered
    expect(stdout).toContain("grp choose <option> --decision=2");
    expect(stdout).toContain("your room position did not move");
    // The response carried current_through: 99 — the mark must NOT advance.
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(5);
  });

  it("adds persona identity only to human reads, never JSON or focused quiet output", async () => {
    const room = {
      baseUrl: "https://operator.example",
      slug: "abc123",
      token: "t_silica",
      lastSeenSeq: 5,
    };
    const env = {
      ...providerEnv({
        providers: {},
        sessions: {
          silica: {
            profile: { displayName: "Silica Editor" },
            currentRoom: room,
            rooms: { current: room },
          },
        },
      }),
      GRP_SESSION: "silica",
    };
    const identity = "You are Silica Editor here (persona: silica).";

    let human = "";
    expect(
      await runRoomCli(["read", "--decision=2"], {
        stdout: (text) => {
          human += text;
        },
        stderr: () => {},
        fetch: async () => jsonResponse(focusedFullBody),
        env,
      }),
    ).toBe(0);
    expect(human.startsWith(`${identity}\n\nDecision 2:`)).toBe(true);

    let json = "";
    expect(
      await runRoomCli(["read", "--decision=2", "--json"], {
        stdout: (text) => {
          json += text;
        },
        stderr: () => {},
        fetch: async () => jsonResponse(focusedFullBody),
        env,
      }),
    ).toBe(0);
    expect(json).not.toContain(identity);
    expect(JSON.parse(json)).toMatchObject({ decision: { seq: 2, question: "Which venue?" } });

    let quiet = "";
    expect(
      await runRoomCli(["read", "--decision=2", "--quiet"], {
        stdout: (text) => {
          quiet += text;
        },
        stderr: () => {},
        fetch: async () => jsonResponse(focusedFullBody),
        env,
      }),
    ).toBe(0);
    expect(quiet).not.toContain(identity);
    expect(JSON.parse(quiet)).toMatchObject({ decision: { seq: 2, question: "Which venue?" } });
  });

  it("pins a workspace persona across an in-flight join response", async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), "grp-room-persona-pin-"));
    const cwd = pathJoin(root, "workspace");
    const markerPath = pathJoin(cwd, ".grp", "persona");
    const env = { XDG_CONFIG_HOME: pathJoin(root, "xdg") };
    mkdirSync(pathJoin(cwd, ".grp"), { recursive: true });
    writeFileSync(markerPath, "alpha\n", "utf8");
    updateProviderConfig(
      () => ({
        providers: {},
        sessions: {
          alpha: { profile: { displayName: "Alpha" } },
          beta: { profile: { displayName: "Beta" } },
        },
      }),
      env,
      { scope: "global" },
    );

    const code = await runRoomCli(
      ["join", "https://operator.example/r/rebind-room", "--invite=it_alpha"],
      {
        cwd,
        env,
        stdout: () => {},
        stderr: () => {},
        fetch: async () => {
          writeFileSync(markerPath, "beta\n", "utf8");
          return jsonResponse({
            participant_token: "t_alpha",
            participant_id: "p_alpha",
            role: "participant",
          });
        },
      },
    );

    expect(code).toBe(0);
    const config = readProviderConfig(env, { scope: "global" });
    expect(resolveLocalSession(config, "alpha")?.currentRoom).toMatchObject({
      slug: "rebind-room",
      token: "t_alpha",
    });
    expect(resolveLocalSession(config, "beta")?.currentRoom).toBeUndefined();
    expect(readFileSync(markerPath, "utf8")).toBe("beta\n");
  });

  it("read --decision misses list the open decisions", async () => {
    let stderr = "";
    const code = await runRoomCli(["read", "--decision=9"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () => jsonResponse(focusedFullBody),
      env: providerEnv(roomConfig({ lastSeenSeq: 5 })),
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain("no decision numbered 9");
    expect(stderr).toContain('seq 2: "Which venue?"');
  });

  it("options --decision=N renders the selected slate and targeted actions (spec 145)", async () => {
    const env = providerEnv(roomConfig({ lastSeenSeq: 5 }));
    let stdout = "";
    let requestUrl = "";
    const code = await runRoomCli(["options", "--decision=2"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        requestUrl = new Request(input, init).url;
        return jsonResponse(focusedFullBody);
      },
      env,
    });
    expect(code).toBe(0);
    expect(new URL(requestUrl).searchParams.get("include")).toBe("full");
    expect(stdout).toContain("Question: Which venue?");
    expect(stdout).toContain("1. Blue Door");
    expect(stdout).not.toContain("Old business");
    expect(stdout).toContain(
      "grp options --full --decision=2  # host did not report the ballot shape",
    );
    expect(stdout).toContain('grp discuss "..." --decision=2');
    expect(stdout).toContain("grp discuss --file=PATH --decision=2");
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(5);
  });

  it("options --decision=N JSON identifies the selected decision (spec 145)", async () => {
    let stdout = "";
    const code = await runRoomCli(["options", "--decision=2", "--json"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () => jsonResponse(focusedFullBody),
      env: providerEnv(roomConfig({ lastSeenSeq: 5 })),
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      slug: "abc123",
      decision: 2,
      question: "Which venue?",
      options: [
        { number: 1, text: "Blue Door" },
        { number: 2, text: "Patio" },
      ],
    });
  });

  it("keeps targeted proposal and full-text hints on the selected thread (spec 145)", async () => {
    const longOption = `Decision two: ${"full proposal ".repeat(30)}end`;
    const targetedBody = {
      ...focusedFullBody,
      decisions: focusedFullBody.decisions.map((decision) =>
        decision.seq === 2
          ? {
              ...decision,
              status: "proposing",
              proposals_open: true,
              options: [longOption],
            }
          : decision,
      ),
    };
    let stdout = "";
    const code = await runRoomCli(["options", "--decision=2"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () => jsonResponse(targetedBody),
      env: providerEnv(roomConfig({ lastSeenSeq: 5 })),
    });
    expect(code).toBe(0);
    expect(stdout).toContain("grp options --full --decision=2");
    expect(stdout).toContain('grp propose "..." --decision=2');
    expect(stdout).toContain('grp discuss "..." --decision=2');
    expect(stdout).toContain("grp discuss --file=PATH --decision=2");
    expect(stdout).not.toContain("grp start choosing");
  });

  it("keeps a targeted resolved slate read-only (spec 145)", async () => {
    let stdout = "";
    const code = await runRoomCli(["options", "--decision=1"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () => jsonResponse(focusedFullBody),
      env: providerEnv(roomConfig({ lastSeenSeq: 5 })),
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Question: Old business");
    expect(stdout).toContain("grp read --decision=1");
    expect(stdout).toContain("grp outcome");
    expect(stdout).not.toContain("grp choose");
    expect(stdout).not.toContain("grp discuss");
  });

  it("options --decision misses list the open decisions (spec 145)", async () => {
    let stderr = "";
    const code = await runRoomCli(["options", "--decision=9"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () => jsonResponse(focusedFullBody),
      env: providerEnv(roomConfig({ lastSeenSeq: 5 })),
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain("no decision numbered 9");
    expect(stderr).toContain('seq 2: "Which venue?"');
  });

  it("--full bypasses the stored mark", async () => {
    let sinceParam: string | null = "unset";
    const code = await runRoomCli(["read", "--full"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        sinceParam = new URL(new Request(input, init).url).searchParams.get("since");
        return jsonResponse({
          slug: "abc123",
          status: "voting",
          brief: "x",
          decision: { seq: 1, question: "Q", options: [], status: "voting" },
          discussion: [],
          roster: { joined: [], expected: [], waiting_for: [] },
          rules: {},
          more: {},
        });
      },
      env: providerEnv(roomConfig({ lastSeenSeq: 5 })),
    });
    expect(code).toBe(0);
    expect(sinceParam).toBeNull();
  });

  it("--since=N requests an explicit delta", async () => {
    let sinceParam: string | null = null;
    const code = await runRoomCli(["read", "--since=3"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        sinceParam = new URL(new Request(input, init).url).searchParams.get("since");
        return jsonResponse(deltaBody);
      },
      env: providerEnv(roomConfig()),
    });
    expect(code).toBe(0);
    expect(sinceParam).toBe("3");
  });

  it("--since=last without a stored mark errors with the recovery hint", async () => {
    let stderr = "";
    const code = await runRoomCli(["read", "--since=last"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () => jsonResponse({}),
      env: providerEnv(roomConfig()),
    });
    expect(code).toBe(1);
    expect(stderr).toContain("no stored position");
  });

  it("renders nothing-new deltas honestly", async () => {
    let stdout = "";
    const code = await runRoomCli(["read"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () => jsonResponse({ ...deltaBody, new: [], current_through: 9 }),
      env: providerEnv(roomConfig({ lastSeenSeq: 9 })),
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Nothing new since seq 9.");
  });
});

describe("spec 113 unified watch", () => {
  const wakeConfig = (lastSeenSeq: number) => ({
    providers: {},
    currentRoom: {
      slug: "abc123",
      baseUrl: "https://operator.example",
      token: "t_1",
      participantId: "p_me",
      lastSeenSeq,
    },
  });

  const discussionEvent = (seq: number, participantId: string) =>
    `id: e${seq}\nevent: discussion.posted\ndata: ${JSON.stringify({
      id: `e${seq}`,
      seq,
      event_type: "discussion.posted",
      occurred_at: "2026-07-07T20:00:01.000Z",
      decision_id: "d1",
      data: {
        id: `m${seq}`,
        stance: "extend",
        posted_at: "2026-07-07T20:00:01.000Z",
        decision_id: "d1",
        participant_id: participantId,
      },
    })}\n\n`;

  it("wakes on discussion by someone else and pre-positions the mark", async () => {
    const env = providerEnv(wakeConfig(4));
    let stdout = "";
    const code = await runRoomCli(["watch"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const url = new Request(input, init).url;
        if (url.includes("/next-action")) return new Promise<Response>(() => {});
        if (url.includes("/events/stream")) {
          return new Response(sseStream([discussionEvent(6, "p_other")]), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        // wakeDeltaEntry name join-back
        return jsonResponse({
          slug: "abc123",
          new: [{ seq: 6, type: "discussion", who: "Neon", said: "hi" }],
          current_through: 6,
        });
      },
      env,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Neon posted discussion.");
    expect(stdout).toContain("grp read");
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    // Mark parks just before the wake event so the follow-up read includes it.
    expect(saved.currentRoom.lastSeenSeq).toBe(5);
  });

  it("never wakes on the caller's own events", async () => {
    const env = providerEnv(wakeConfig(4));
    let stdout = "";
    const code = await runRoomCli(["watch"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const url = new Request(input, init).url;
        if (url.includes("/next-action")) return new Promise<Response>(() => {});
        if (url.includes("/events/stream")) {
          return new Response(
            sseStream([discussionEvent(5, "p_me"), discussionEvent(6, "p_other")]),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return jsonResponse({
          slug: "abc123",
          new: [{ seq: 6, type: "discussion", who: "Neon", said: "hi" }],
          current_through: 6,
        });
      },
      env,
    });
    expect(code).toBe(0);
    // Woke on seq 6 (the other participant), not the caller's own seq 5.
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(5);
    expect(stdout).toContain("Neon posted discussion.");
  });

  it("floor rule: the needs-you wake fires even under --until=resolved", async () => {
    const env = { ...providerEnv(wakeConfig(4)), GRP_WATCH_RECONNECT_MS: "1" };
    let stdout = "";
    const code = await runRoomCli(["watch", "--until=resolved"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const url = new Request(input, init).url;
        if (url.includes("/next-action")) {
          return jsonResponse({
            status: "actionable",
            for: "my_choice",
            decision: {
              id: "d2",
              seq: 2,
              question: "Pick the ending tone",
              options: ["A"],
              status: "voting",
            },
          });
        }
        if (url.includes("/events/stream")) {
          return new Response(sseStream([]), { headers: { "content-type": "text/event-stream" } });
        }
        return jsonResponse({ slug: "abc123", events: [] });
      },
      env,
    });
    expect(code).toBe(0);
    expect(stdout).toContain('The room needs you: "Pick the ending tone"');
  });

  it("--jsonl never advances the stored mark", async () => {
    const env = providerEnv(wakeConfig(5));
    const code = await runRoomCli(["watch", "--jsonl", "--until=resolved"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        const url = new Request(input, init).url;
        if (url.includes("/events/stream")) {
          return new Response(
            sseStream([
              'id: e9\nevent: decision.completed\ndata: {"id":"e9","seq":9,"event_type":"decision.completed","occurred_at":"2026-07-07T20:00:01.000Z","decision_id":"d1","data":{"winner":"A"}}\n\n',
            ]),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return jsonResponse({ slug: "abc123", events: [] });
      },
      env,
    });
    expect(code).toBe(0);
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(5);
  });
});

describe("spec 113 invite relay packaging", () => {
  it("places the paste block last with the relay instruction", async () => {
    let stdout = "";
    const code = await runRoomCli(
      ["invite", "https://operator.example/r/abc123?token=t_1", "--name=Cobalt"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            slug: "abc123",
            about: "Writers room",
            invite: {
              code: "inv_c",
              label: "Cobalt",
              role: "participant",
              expected: true,
              status: "pending",
            },
            invite_token: "it_c",
            join_url: "https://operator.example/r/abc123?invite=it_c",
            join_command: "grp join https://operator.example/r/abc123 --invite it_c",
            paste_block:
              "You are invited to a GRP room. ...\ngrp join https://operator.example/r/abc123 --invite it_c",
          }),
        env: providerEnv({ providers: {} }),
      },
    );
    expect(code).toBe(0);
    const browserAt = stdout.indexOf("Browser link:");
    const relayAt = stdout.indexOf(
      "Relay the whole block below — every line matters to the receiving agent.",
    );
    const pasteAt = stdout.indexOf("Paste this to the agent, intact:");
    expect(browserAt).toBeGreaterThan(-1);
    expect(relayAt).toBeGreaterThan(browserAt);
    expect(pasteAt).toBeGreaterThan(relayAt);
    expect(
      stdout.indexOf("grp join https://operator.example/r/abc123 --invite it_c", pasteAt),
    ).toBeGreaterThan(pasteAt);
  });
});

describe("spec 114 surface", () => {
  it("renders a tie as a status with a runoff hint, never as a winner", async () => {
    let stdout = "";
    const code = await runRoomCli(["outcome", "https://operator.example/r/abc123?token=t_1"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          status: "open",
          decided: [
            { seq: 2, question: "Structure?", outcome: "tied", decided_at: "2026-07-07T22:43:46Z" },
          ],
        }),
      env: providerEnv({ providers: {} }),
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Status: tied — no winner");
    expect(stdout).toContain("runoff");
    expect(stdout).not.toContain("Chosen: tied");
  });

  it("clips long options in the slate and points at --full", async () => {
    const longOption = `Draft A: ${"scene beat ".repeat(30)}end`;
    let stdout = "";
    const code = await runRoomCli(["options", "https://operator.example/r/abc123?token=t_1"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          status: "voting",
          decision: {
            seq: 1,
            question: "Which draft?",
            options: [longOption, "short"],
            status: "voting",
          },
        }),
      env: providerEnv({ providers: {} }),
    });
    expect(code).toBe(0);
    expect(stdout).not.toContain(longOption);
    expect(stdout).toContain(`${longOption.slice(0, 200)}…`);
    expect(stdout).toContain("full text: grp options --full");
    expect(stdout).toContain("2. short");
  });

  it("--full requests the uncut slate via include=full", async () => {
    const longOption = `Draft A: ${"scene beat ".repeat(30)}end`;
    let url = "";
    let stdout = "";
    const code = await runRoomCli(
      ["options", "https://operator.example/r/abc123?token=t_1", "--full"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          url = new Request(input, init).url;
          return jsonResponse({
            slug: "abc123",
            status: "voting",
            decision: {
              seq: 1,
              question: "Which draft?",
              options: [longOption],
              status: "voting",
            },
          });
        },
        env: providerEnv({ providers: {} }),
      },
    );
    expect(code).toBe(0);
    expect(new URL(url).searchParams.get("include")).toBe("full");
    expect(stdout).toContain(longOption);
    expect(stdout).not.toContain("full text: grp options --full");
  });

  it("echoes the canonical choice when the host resolves a numeric handle", async () => {
    let stdout = "";
    const code = await runRoomCli(["choose", "abc123", "--token=t_1", "--choice=2"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          ok: true,
          slug: "abc123",
          cast_choice: "the full second option text",
          status: "voting",
        }),
      env: { GRP_BASE_URL: "https://operator.example" },
    });
    expect(code).toBe(0);
    expect(stdout).toContain('Choice recorded: "the full second option text"');
  });

  it("never wakes a bare watch on the caller's own decision.opened", async () => {
    const env = providerEnv({
      providers: {},
      currentRoom: {
        slug: "abc123",
        baseUrl: "https://operator.example",
        token: "t_1",
        participantId: "p_me",
        lastSeenSeq: 4,
      },
    });
    let stdout = "";
    const code = await runRoomCli(["watch"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const url = new Request(input, init).url;
        if (url.includes("/next-action")) return new Promise<Response>(() => {});
        if (url.includes("/events/stream")) {
          const own = JSON.stringify({
            id: "e5",
            seq: 5,
            event_type: "decision.opened",
            occurred_at: "2026-07-07T20:00:01.000Z",
            decision_id: "d2",
            data: {
              seq: 2,
              question: "Mine",
              opened_by: { participant_id: "p_me", display_name: "Me" },
            },
          });
          const other = JSON.stringify({
            id: "e6",
            seq: 6,
            event_type: "decision.opened",
            occurred_at: "2026-07-07T20:00:02.000Z",
            decision_id: "d3",
            data: {
              seq: 3,
              question: "Theirs",
              opened_by: { participant_id: "p_other", display_name: "Neon" },
            },
          });
          return new Response(
            sseStream([
              `id: e5\nevent: decision.opened\ndata: ${own}\n\n`,
              `id: e6\nevent: decision.opened\ndata: ${other}\n\n`,
            ]),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return jsonResponse({ slug: "abc123", new: [], current_through: 6 });
      },
      env,
    });
    expect(code).toBe(0);
    // Woke on seq 6 (someone else's ask), not the caller's own seq 5.
    expect(stdout).toContain('Decision opened by Neon: "Theirs"'); // Spec 117 wake attribution
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    // Spec 125 (WR12-2) — the wake line carries the whole payload, so the
    // event is CONSUMED (mark through seq 6), never re-fired.
    expect(saved.currentRoom.lastSeenSeq).toBe(6);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function providerEnv(config: unknown): Record<string, string | undefined> {
  const dir = mkdtempSync(pathJoin(tmpdir(), "grp-room-provider-test-"));
  const path = pathJoin(dir, "config.json");
  writeFileSync(path, `${JSON.stringify(config)}\n`, "utf8");
  return { GRP_CONFIG: path };
}

describe("spec 116 — run-8 edge pass", () => {
  it("create persists the creator participant id (WR8-1: no self-wakes)", async () => {
    const env = providerEnv({ providers: {} });
    let stdout = "";
    const code = await runRoomCli(["create", "--about=Edge pass room"], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "edge123",
          creator_token: "t_creator",
          participant_id: "p_creator",
          about: "Edge pass room",
          config: {},
        }),
      env: { ...env, GRP_BASE_URL: "https://operator.example" },
    });
    expect(code).toBe(0);
    const saved = JSON.parse(readFileSync(env.GRP_CONFIG as string, "utf8"));
    expect(saved.currentRoom.participantId).toBe("p_creator");
  });

  it("a resolution wake consumes its event (WR8-2: watch-after-watch never re-fires)", async () => {
    const env = providerEnv({ providers: {} });
    const config = JSON.parse(readFileSync(env.GRP_CONFIG as string, "utf8"));
    config.currentRoom = {
      baseUrl: "https://operator.example",
      slug: "abc123",
      token: "t_1",
      participantId: "p_me",
      lastSeenSeq: 4,
    };
    writeFileSync(env.GRP_CONFIG as string, JSON.stringify(config));
    let stdout = "";
    const code = await runRoomCli(["watch"], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (!request.url.includes("/events/stream")) {
          return jsonResponse({ slug: "abc123", events: [] });
        }
        return new Response(
          sseStream([
            'id: e9\nevent: decision.completed\ndata: {"id":"e9","seq":9,"event_type":"decision.completed","occurred_at":"2026-07-08T17:00:00.000Z","decision_id":"d1","data":{"question":"Q","resolved_winner":"west","participant":{"participant_id":"p_other"}}}\n\n',
          ]),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      env,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Decision resolved");
    // The wake block carried the full outcome, so the mark advances THROUGH
    // the event: the next watch must not re-fire on seq 9.
    const after = JSON.parse(readFileSync(env.GRP_CONFIG as string, "utf8"));
    expect(after.currentRoom.lastSeenSeq).toBe(9);
  });

  it("a discussion wake still parks before its event (delta carries the text)", async () => {
    const env = providerEnv({ providers: {} });
    const config = JSON.parse(readFileSync(env.GRP_CONFIG as string, "utf8"));
    config.currentRoom = {
      baseUrl: "https://operator.example",
      slug: "abc123",
      token: "t_1",
      participantId: "p_me",
      lastSeenSeq: 4,
    };
    writeFileSync(env.GRP_CONFIG as string, JSON.stringify(config));
    let stdout = "";
    const code = await runRoomCli(["watch"], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (!request.url.includes("/events/stream")) {
          return jsonResponse({ slug: "abc123", events: [] });
        }
        return new Response(
          sseStream([
            'id: e7\nevent: discussion.posted\ndata: {"id":"e7","seq":7,"event_type":"discussion.posted","occurred_at":"2026-07-08T17:00:00.000Z","decision_id":null,"data":{"id":"m1","participant_id":"p_other"}}\n\n',
          ]),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      env,
    });
    expect(code).toBe(0);
    const after = JSON.parse(readFileSync(env.GRP_CONFIG as string, "utf8"));
    expect(after.currentRoom.lastSeenSeq).toBe(6);
  });

  it("watch --timeout exits 0 with a nothing-new line (WR8-4)", async () => {
    const env = providerEnv({ providers: {} });
    const config = JSON.parse(readFileSync(env.GRP_CONFIG as string, "utf8"));
    config.currentRoom = {
      baseUrl: "https://operator.example",
      slug: "abc123",
      token: "t_1",
      lastSeenSeq: 4,
    };
    writeFileSync(env.GRP_CONFIG as string, JSON.stringify(config));
    let stdout = "";
    const code = await runRoomCli(["watch", "--timeout=1"], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (!request.url.includes("/events/stream")) {
          return jsonResponse({ slug: "abc123", events: [] });
        }
        // A stream that never says anything.
        return new Response(sseStream([]), {
          headers: { "content-type": "text/event-stream" },
        });
      },
      env,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Nothing new after 1s");
  });

  it("quiet watch derives its --timeout suggestion from the open deadline (spec 152 W5)", async () => {
    const env = providerEnv({ providers: {} });
    const config = JSON.parse(readFileSync(env.GRP_CONFIG as string, "utf8"));
    config.currentRoom = {
      baseUrl: "https://operator.example",
      slug: "abc123",
      token: "t_1",
      lastSeenSeq: 4,
    };
    writeFileSync(env.GRP_CONFIG as string, JSON.stringify(config));
    const endsAt = new Date(Date.now() + 1000 * 1000).toISOString();
    let stdout = "";
    const code = await runRoomCli(["watch", "--timeout=1"], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (!request.url.includes("/events/stream")) {
          // Spec 153 / F152-S1 — match the live full agent view. The broken
          // test supplied delta-only `state` plus a field name no live read
          // used, so W5 passed here while failing in the packaged smoke.
          expect(new URL(request.url).searchParams.has("since")).toBe(false);
          return jsonResponse({
            slug: "abc123",
            status: "open",
            decision: { seq: 2, status: "voting", closes_at: endsAt },
          });
        }
        return new Response(sseStream([]), {
          headers: { "content-type": "text/event-stream" },
        });
      },
      env,
    });
    expect(code).toBe(0);
    // ~1000s deadline: human ≈17m, suggestion ceils to the next minute.
    expect(stdout).toContain("closes in ~17m");
    expect(stdout).toMatch(/--timeout=10[02]0/);
    expect(stdout).not.toContain("--timeout=N");
    expect(stdout).toContain("your agent runtime's scheduling tools");
    expect(stdout).toContain("then run grp inbox");
  });

  it("quiet watch with no open deadline teaches --timeout=N without a number (spec 152 W5)", async () => {
    const env = providerEnv({ providers: {} });
    const config = JSON.parse(readFileSync(env.GRP_CONFIG as string, "utf8"));
    config.currentRoom = {
      baseUrl: "https://operator.example",
      slug: "abc123",
      token: "t_1",
      lastSeenSeq: 4,
    };
    writeFileSync(env.GRP_CONFIG as string, JSON.stringify(config));
    let stdout = "";
    const code = await runRoomCli(["watch", "--timeout=1"], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (!request.url.includes("/events/stream")) {
          return jsonResponse({ slug: "abc123", status: "open", decision: null });
        }
        return new Response(sseStream([]), {
          headers: { "content-type": "text/event-stream" },
        });
      },
      env,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("grp watch --timeout=N");
    expect(stdout).toContain("(seconds)");
    expect(stdout).toContain("your agent runtime's scheduling tools");
    expect(stdout).toContain("then run grp inbox");
  });

  it("never hints close, even when more.close exists (spec 117 burial)", async () => {
    let stdout = "";
    const code = await runRoomCli(["read", "abc123"], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          brief: "No question is open right now.",
          decision: null,
          status: "open",
          more: { close: "POST /api/rooms/abc123/close" },
        }),
      env: { GRP_BASE_URL: "https://operator.example" },
    });
    expect(code).toBe(0);
    // Spec 117 — close is the one irreversible verb; it is never advertised
    // on surfaces agents visit routinely (help advanced + docs only).
    expect(stdout).not.toContain("grp close");
  });
});

describe("spec 117 — collaboration defaults (CLI)", () => {
  it("start choosing on an already-open decision renders idempotent success", async () => {
    let stdout = "";
    const code = await runRoomCli(["start", "choosing", "abc123", "--token=t_1"], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          ok: true,
          slug: "abc123",
          already_open: true,
          decision: { seq: 2, options: ["a", "b"], status: "voting" },
        }),
      env: { GRP_BASE_URL: "https://operator.example" },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Choices are already open — someone beat you to it.");
  });

  it("delta choice entries render as numbers", async () => {
    const env = providerEnv({ providers: {} });
    const config = JSON.parse(readFileSync(env.GRP_CONFIG as string, "utf8"));
    config.currentRoom = {
      baseUrl: "https://operator.example",
      slug: "abc123",
      token: "t_1",
      lastSeenSeq: 8,
    };
    writeFileSync(env.GRP_CONFIG as string, JSON.stringify(config));
    let stdout = "";
    const code = await runRoomCli(["read"], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          status: "open",
          state: "seq 2 deciding — 2/4 chosen; closes in 57m",
          new: [
            {
              seq: 9,
              type: "choice_submitted",
              at: "2026-07-08T21:00:00Z",
              who: "Cobalt",
              option: 5,
            },
            {
              seq: 10,
              type: "choice_submitted",
              at: "2026-07-08T21:00:05Z",
              who: "Neon",
              option: 5,
              revised: true,
            },
          ],
          current_through: 10,
        }),
      env,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("abc123 — seq 2 deciding — 2/4 chosen; closes in 57m");
    expect(stdout).toContain("Cobalt chose #5");
    expect(stdout).toContain("Neon chose #5 (revised)");
  });

  it("renders a map ballot as scores, never an escaped-JSON blob (spec 152 W4)", async () => {
    const env = providerEnv({ providers: {} });
    const config = JSON.parse(readFileSync(env.GRP_CONFIG as string, "utf8"));
    config.currentRoom = {
      baseUrl: "https://operator.example",
      slug: "abc123",
      token: "t_1",
      lastSeenSeq: 3,
    };
    writeFileSync(env.GRP_CONFIG as string, JSON.stringify(config));
    let stdout = "";
    const code = await runRoomCli(["read"], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          status: "open",
          state: "seq 1 deciding — 1/3 chosen; closes in 29m",
          new: [
            {
              seq: 4,
              type: "choice_submitted",
              at: "2026-07-20T18:00:00Z",
              who: "Cobalt",
              choice:
                '{"The Salt Ledger — a century of tide-keeping":5,"Nine-Tenths — a repossession parable":2}',
            },
          ],
          current_through: 4,
        }),
      env,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Cobalt scored:");
    expect(stdout).toContain("= 5");
    expect(stdout).toContain("= 2");
    expect(stdout).not.toContain('\\"');
  });

  // Spec 128 — agreement decisions on the CLI surface.
  it("sends agreement:true on grp ask --agreement and renders the mode copy", async () => {
    const bodies: unknown[] = [];
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stdout = "";
    const code = await runRoomCli(["ask", "Which package?", "--agreement"], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          ok: true,
          slug: "abc123",
          decision: { id: "d1", seq: 1, question: "Which package?", agreement: true },
        });
      },
      env,
    });
    expect(code).toBe(0);
    expect(bodies[0]).toMatchObject({ question: "Which package?", agreement: true });
    expect(stdout).toContain('Question opened (agreement): "Which package?"');
    expect(stdout).toContain("resolves only when every voter accepts the same option");
  });

  it("grp accept is choose by another name and confirms as an acceptance", async () => {
    const requests: string[] = [];
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stdout = "";
    const code = await runRoomCli(["accept", "2"], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        requests.push(new Request(input, init).url);
        return jsonResponse({
          ok: true,
          slug: "abc123",
          cast_choice: "package two",
          status: "open",
          resolved_winner: null,
          resolved_outcome: null,
          agreement: true,
        });
      },
      env,
    });
    expect(code).toBe(0);
    expect(requests[0]).toContain("/choose");
    expect(stdout).toContain('Acceptance recorded: "package two"');
    expect(stdout).toContain("resolves when every voter accepts the same option");
  });

  it("delta entries on agreement decisions speak in acceptances", async () => {
    const env = providerEnv({ providers: {} });
    const config = JSON.parse(readFileSync(env.GRP_CONFIG as string, "utf8"));
    config.currentRoom = {
      baseUrl: "https://operator.example",
      slug: "abc123",
      token: "t_1",
      lastSeenSeq: 8,
    };
    writeFileSync(env.GRP_CONFIG as string, JSON.stringify(config));
    let stdout = "";
    const code = await runRoomCli(["read"], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          status: "open",
          state:
            "seq 1 seeking agreement — 1/2 accepted; resolves only when every voter accepts the same option; closes in 57m",
          new: [
            {
              seq: 9,
              type: "choice_submitted",
              at: "2026-07-13T21:00:00Z",
              who: "Kestrel Signal",
              option: 3,
              agreement: true,
            },
            {
              seq: 10,
              type: "decision_resolved",
              at: "2026-07-13T21:05:00Z",
              question: "Which package?",
              winner: null,
              outcome: "no_pass",
              agreement: true,
            },
          ],
          current_through: 10,
        }),
      env,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Kestrel Signal accepted #3");
    expect(stdout).toContain("no agreement reached");
    expect(stdout).not.toContain("tied — no winner");
  });

  it("close is buried: absent from room help common commands", async () => {
    let stdout = "";
    await runRoomCli(["help"], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      fetch: async () => jsonResponse({}),
      env: { GRP_BASE_URL: "https://operator.example" },
    });
    expect(stdout).toContain("outcome");
    expect(stdout).not.toContain("close a resolved room");
  });
});

describe("spec 118 — run-10 surface honesty (CLI)", () => {
  it("reports proposals open for a fluid voting decision served by a FULL read (WR10-1)", async () => {
    // Run 10: `grp options --full` hits the full read, whose decisions lacked
    // the honest booleans — phase inference said "closed" while proposes
    // succeeded. The wire now carries proposals_open; the CLI must use it.
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stdout = "";
    const code = await runRoomCli(["options", "--full"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          active_decision_id: "d1",
          decisions: [
            {
              id: "d1",
              question: "What is the scene list?",
              status: "voting",
              voting_opens_at: null,
              proposals_open: true,
              options: ["List A", "List B"],
            },
          ],
          rules: { how_to_choose: "choose with a single option (string) from the options list" },
        }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Proposal status: open");
    expect(stdout).toContain('grp propose "..."');
    // Start-choosing is a slate verb; open proposals on a fluid decision
    // must never resurrect it.
    expect(stdout).not.toContain("grp start choosing");
  });

  it("derives proposal status from voting_opens_at on old hosts without proposals_open", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stdout = "";
    const code = await runRoomCli(["options", "--full"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          active_decision_id: "d1",
          decisions: [
            {
              id: "d1",
              question: "What is the scene list?",
              status: "voting",
              voting_opens_at: null,
              options: ["List A"],
            },
          ],
        }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Proposal status: open");
  });

  it("renders option authorship from option_proposers (WR10-3)", async () => {
    const env = providerEnv({
      currentRoom: { baseUrl: "https://operator.example", slug: "abc123", token: "t_1" },
      providers: {},
    });
    let stdout = "";
    const code = await runRoomCli(["options"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          decision: {
            question: "What is the scene list?",
            status: "voting",
            can_propose_more: true,
            can_start_choosing: false,
            options: ["List A", "List B", "List C"],
            option_proposers: ["Argon", null, "Neon"],
          },
        }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain("1. List A — proposed by Argon");
    // Creator-seeded options have no provenance row: no dangling attribution.
    expect(stdout).toContain("2. List B\n");
    expect(stdout).toContain("3. List C — proposed by Neon");
  });

  it("points a mid-choosing propose at choose, not start choosing (WR10-2)", async () => {
    let stdout = "";
    const code = await runRoomCli(
      ["propose", "https://operator.example/r/abc123?token=t_1", "--option=List D"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            accepted: true,
            options: ["List A", "List D"],
            choosing_open: true,
          }),
        env: providerEnv({ providers: {} }),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toContain('Option proposed: "List D"');
    expect(stdout).toContain("Choices are open — cast or revise yours: grp choose N");
    expect(stdout).not.toContain("When the slate is ready");
  });

  it("keeps the slate gate when choosing is not open yet", async () => {
    let stdout = "";
    const code = await runRoomCli(
      ["propose", "https://operator.example/r/abc123?token=t_1", "--option=List D"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            accepted: true,
            options: ["List A", "List D"],
            choosing_open: false,
          }),
        env: providerEnv({ providers: {} }),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toContain("When the slate is ready: grp start choosing abc123");
    expect(stdout).not.toContain("cast or revise");
  });
});

describe("spec 119 — the watch-trust pass (CLI)", () => {
  const roomConfig = (extra: Record<string, unknown> = {}) => ({
    providers: {},
    currentRoom: {
      slug: "abc123",
      baseUrl: "https://operator.example",
      token: "t_1",
      ...extra,
    },
  });
  const snapshotBody = (currentThrough?: number) => ({
    slug: "abc123",
    status: "voting",
    brief: 'Deciding now: "Pick one" — 0/2 choices in.',
    decision: { seq: 1, question: "Pick one", options: ["A"], status: "voting" },
    discussion: [],
    roster: { joined: [], expected: [], waiting_for: [] },
    rules: {},
    more: {},
    ...(currentThrough !== undefined ? { current_through: currentThrough } : {}),
  });

  it("resumes a fresh watch from its durable sequence beyond event 200 (CH22)", async () => {
    const env = providerEnv(roomConfig({ participantId: "p_argon", lastSeenSeq: 223 }));
    const opened = JSON.stringify({
      id: "e224",
      seq: 224,
      event_type: "decision.opened",
      occurred_at: "2026-07-15T17:14:14.815Z",
      decision_id: "d22",
      data: {
        seq: 22,
        question: "Choose a different legal move",
        options: [],
        opened_by: { participant_id: "p_host", display_name: "creator" },
      },
    });
    let streamUrl: URL | null = null;

    let stdout = "";
    const code = await runRoomCli(["watch"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname.endsWith("/next-action")) return new Promise<Response>(() => {});
        if (url.pathname.endsWith("/events/stream")) {
          streamUrl = url;
          return new Response(
            sseStream([`id: e224\nevent: decision.opened\ndata: ${opened}\n\n`]),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        throw new Error(`unexpected request: ${url}`);
      },
      env,
    });

    expect(code).toBe(0);
    expect(streamUrl?.searchParams.get("since_seq")).toBe("223");
    expect(streamUrl?.searchParams.get("since_event_id")).toBeNull();
    expect(stdout).toContain('Decision opened by creator: "Choose a different legal move"');
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(224);
  });

  it("--full advances the mark through current_through (WR11-1)", async () => {
    // Run 11's stale wakes: wake parks the mark at seq-1, the follow-up
    // `read --full` used to leave it there, and the next bare watch
    // re-fired the same event. A full picture now advances the mark.
    const env = providerEnv(roomConfig({ lastSeenSeq: 30 }));
    let sinceParam: string | null = "unset";
    const code = await runRoomCli(["read", "--full"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        sinceParam = new URL(new Request(input, init).url).searchParams.get("since");
        return jsonResponse(snapshotBody(42));
      },
      env,
    });
    expect(code).toBe(0);
    expect(sinceParam).toBeNull();
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(42);
  });

  // Spec 125 (WR12-2) — Run 12, Argon seat: wake on choosing-started, then
  // ACT (grp choose) without reading, then watch again. The wake line had
  // already carried the event's whole payload, so the event is consumed and
  // the second watch must not re-fire it.
  it("watch → act without reading → watch does not re-fire a full-content wake", async () => {
    const env = providerEnv({
      providers: {},
      currentRoom: {
        slug: "abc123",
        baseUrl: "https://operator.example",
        token: "t_1",
        participantId: "p_argon",
        lastSeenSeq: 44,
      },
    });
    const vps = JSON.stringify({
      id: "e46",
      seq: 46,
      event_type: "decision.voting_phase_started",
      occurred_at: "2026-07-10T23:50:50.000Z",
      decision_id: "d2",
      data: { seq: 2, started_by: { participant_id: "p_neon", display_name: "Neon" } },
    });
    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new Request(input, init).url;
      if (url.includes("/next-action")) return new Promise<Response>(() => {});
      if (url.includes("/events/stream")) {
        return new Response(
          sseStream([`id: e46\nevent: decision.voting_phase_started\ndata: ${vps}\n\n`]),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const since = Number(new URL(url).searchParams.get("since") ?? "0");
      const entries =
        since < 46 ? [{ seq: 46, type: "choosing_started", question: "Structure?" }] : [];
      return jsonResponse({
        slug: "abc123",
        status: "open",
        state: "seq 2 deciding — 1/4 chosen; closes in 60m",
        new: entries,
        current_through: 46,
      });
    };

    let firstWake = "";
    expect(
      await runRoomCli(["watch", "--timeout=5"], {
        stdout: (t) => {
          firstWake += t;
        },
        stderr: () => {},
        fetch: fetchMock,
        env,
      }),
    ).toBe(0);
    expect(firstWake).toContain("Choosing started by Neon");
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(46); // consumed, not parked at 45

    // The seat votes without reading (no CLI read runs), then watches again.
    let secondWatch = "";
    expect(
      await runRoomCli(["watch", "--timeout=2"], {
        stdout: (t) => {
          secondWatch += t;
        },
        stderr: () => {},
        fetch: fetchMock,
        env,
      }),
    ).toBe(0);
    expect(secondWatch).not.toContain("Choosing started");
    expect(secondWatch).toContain("Nothing new after 2s");
  }, 20000);

  it("watch → read --full → watch does not re-fire the pointer wake", async () => {
    const env = providerEnv(roomConfig({ participantId: "p_me", lastSeenSeq: 30 }));
    const oldWake = JSON.stringify({
      id: "e42",
      seq: 42,
      event_type: "decision.opened",
      occurred_at: "2026-07-09T18:00:00.000Z",
      decision_id: "d_old",
      data: {
        seq: 2,
        question: "Old wake",
        opened_by: { participant_id: "p_other", display_name: "Argon" },
      },
    });
    const freshWake = JSON.stringify({
      id: "e43",
      seq: 43,
      event_type: "decision.opened",
      occurred_at: "2026-07-09T18:00:01.000Z",
      decision_id: "d_fresh",
      data: {
        seq: 3,
        question: "Fresh wake",
        opened_by: { participant_id: "p_other", display_name: "Argon" },
      },
    });
    let watchPass = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith("/next-action")) return new Promise<Response>(() => {});
      if (url.pathname.endsWith("/events/stream")) {
        watchPass += 1;
        const frames =
          watchPass === 1
            ? [`id: e42\nevent: decision.opened\ndata: ${oldWake}\n\n`]
            : [
                `id: e42\nevent: decision.opened\ndata: ${oldWake}\n\n`,
                `id: e43\nevent: decision.opened\ndata: ${freshWake}\n\n`,
              ];
        return new Response(sseStream(frames), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return jsonResponse(snapshotBody(42));
    };

    let firstWake = "";
    expect(
      await runRoomCli(["watch"], {
        stdout: (text) => {
          firstWake += text;
        },
        stderr: () => {},
        fetch,
        env,
      }),
    ).toBe(0);
    expect(firstWake).toContain('Decision opened by Argon: "Old wake"');
    let saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    // Spec 125 (WR12-2) — decision.opened wakes are consumed (mark through
    // the wake seq), not parked: the wake line already carried the payload.
    expect(saved.currentRoom.lastSeenSeq).toBe(42);

    expect(
      await runRoomCli(["read", "--full"], {
        stdout: () => {},
        stderr: () => {},
        fetch,
        env,
      }),
    ).toBe(0);
    saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(42);

    let secondWake = "";
    expect(
      await runRoomCli(["watch"], {
        stdout: (text) => {
          secondWake += text;
        },
        stderr: () => {},
        fetch,
        env,
      }),
    ).toBe(0);
    expect(secondWake).toContain('Decision opened by Argon: "Fresh wake"');
    expect(secondWake).not.toContain("Old wake");
  });

  it("the first-contact snapshot sets the mark, so the second read is a delta", async () => {
    const env = providerEnv(roomConfig());
    const code = await runRoomCli(["read"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async () => jsonResponse(snapshotBody(17)),
      env,
    });
    expect(code).toBe(0);
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(17);
  });

  it("old hosts without current_through leave the mark untouched", async () => {
    const env = providerEnv(roomConfig({ lastSeenSeq: 30 }));
    const code = await runRoomCli(["read", "--full"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async () => jsonResponse(snapshotBody()),
      env,
    });
    expect(code).toBe(0);
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(30);
  });

  it("keeps an honest fallback for old hosts that expose a hash but no portable JWS", async () => {
    // Every run-11 seat: signed receipts asserted in the invite, invisible
    // at resolution.
    const env = providerEnv(roomConfig());
    let stdout = "";
    const code = await runRoomCli(["outcome"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          status: "open",
          decided: [
            {
              seq: 1,
              question: "Ship it?",
              winner: "yes",
              outcome: "pass",
              receipt: "sha256:abc123def456",
            },
          ],
        }),
      env,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Chosen: yes");
    // Spec 125 — nothing to verify (no portable receipt yet) stays quiet:
    // the surface only speaks about receipts when verification FAILS.
    expect(stdout).not.toContain("Receipt:");
    expect(stdout).not.toContain("Verification");
    expect(stdout).not.toContain("verifier");
  });

  it("fetches the authenticated outcome and verifies its compact JWS locally", async () => {
    const privateKey = new Uint8Array(32).fill(7);
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const jws = await signCompactJws({
      header: { alg: "EdDSA", typ: "grp-receipt+jwt", kid: "op-test" },
      payload: {
        iss: "https://operator.example/api/rooms/abc123",
        grp: { sequence: 1, prev_hash: null, outcome: { status: "completed" } },
      },
      privateKey,
    });
    const receiptHash = computeJwsReceiptHash(jws);
    const env = providerEnv(roomConfig());
    let stdout = "";
    let outcomeUrl: URL | null = null;
    const code = await runRoomCli(["outcome"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname === "/api/rooms/abc123/outcome") {
          outcomeUrl = url;
          return jsonResponse({
            slug: "abc123",
            status: "resolved",
            question: "Ship it?",
            resolved_at: "2026-07-09T12:00:00.000Z",
            resolved_winner: "yes",
            resolved_outcome: "pass",
            verification: { jwks_url: "https://operator.example/.well-known/grp.json" },
            decisions: [
              {
                seq: 1,
                question: "Ship it?",
                prev_hash: null,
                receipt_hash: receiptHash,
                receipt_jws: jws,
              },
            ],
            conclusion: null,
          });
        }
        if (url.pathname === "/.well-known/grp.json") {
          return jsonResponse({
            keys: [
              {
                kid: "op-test",
                kty: "OKP",
                crv: "Ed25519",
                alg: "EdDSA",
                x: Buffer.from(publicKey).toString("base64url"),
              },
            ],
          });
        }
        return jsonResponse({}, 404);
      },
      env,
    });

    expect(code).toBe(0);
    expect(outcomeUrl?.searchParams.get("token")).toBeNull();
    // Spec 125 — verification runs under the hood and passing is SILENT
    // (browser-padlock posture); the chain and result live in --json.
    expect(stdout).toContain("Chosen:");
    expect(stdout).not.toContain("Receipt:");
    expect(stdout).not.toContain("Verification");
    expect(stdout).not.toContain("Ed25519");
    expect(stdout).not.toContain("JWS");
  });

  it("exports the portable JWS and verification result as JSON", async () => {
    const privateKey = new Uint8Array(32).fill(8);
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const jws = await signCompactJws({
      header: { alg: "EdDSA", typ: "grp-receipt+jwt", kid: "op-json" },
      payload: { iss: "https://operator.example", grp: { sequence: 1, prev_hash: null } },
      privateKey,
    });
    const receiptHash = computeJwsReceiptHash(jws);
    let stdout = "";
    const code = await runRoomCli(["outcome", "--json"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname === "/.well-known/grp.json") {
          return jsonResponse({
            keys: [
              {
                kid: "op-json",
                kty: "OKP",
                crv: "Ed25519",
                alg: "EdDSA",
                x: Buffer.from(publicKey).toString("base64url"),
              },
            ],
          });
        }
        return jsonResponse({
          slug: "abc123",
          status: "resolved",
          question: "Ship it?",
          resolved_at: "2026-07-09T12:00:00.000Z",
          resolved_winner: "yes",
          resolved_outcome: "pass",
          verification: { jwks_url: "https://operator.example/.well-known/grp.json" },
          decisions: [
            {
              seq: 1,
              question: "Ship it?",
              prev_hash: null,
              receipt_hash: receiptHash,
              receipt_jws: jws,
            },
          ],
          conclusion: null,
        });
      },
      env: providerEnv(roomConfig()),
    });

    expect(code).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.outcome.receipt_jws).toBe(jws);
    expect(output.verification).toMatchObject({ status: "verified", receipts: 1 });
    expect(output.chain.decisions[0].receipt_jws).toBe(jws);
  });

  it("fails a validly signed agreement receipt whose outcome contradicts its votes", async () => {
    const privateKey = new Uint8Array(32).fill(18);
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const jws = await signCompactJws({
      header: { alg: "EdDSA", typ: "grp-receipt+jwt", kid: "op-semantic" },
      payload: {
        iss: "https://operator.example",
        grp: {
          sequence: 1,
          prev_hash: null,
          mechanism: {
            kind: "simple_majority",
            parameters: {
              agreement: true,
              options: ["yes", "no"],
              ballot_mode: "single_choice",
              quorum: 1,
              pass_threshold: 1,
              tie_break: "no_pass",
              plurality_fallthrough: false,
            },
          },
          votes: [
            { agent_id: "did:one", choice: "yes", weight: 1 },
            { agent_id: "did:two", choice: "yes", weight: 1 },
          ],
          // The signature is authentic, but this claimed rejection is not.
          outcome: {
            status: "rejected",
            winning_option: null,
            tallies: { yes: 2, no: 0 },
            diagnostics: { cast_votes: 2, eligible_voters: 2 },
          },
        },
      },
      privateKey,
    });
    const receiptHash = computeJwsReceiptHash(jws);
    let stdout = "";
    const code = await runRoomCli(["outcome"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname === "/.well-known/grp.json") {
          return jsonResponse({
            keys: [
              {
                kid: "op-semantic",
                kty: "OKP",
                crv: "Ed25519",
                alg: "EdDSA",
                x: Buffer.from(publicKey).toString("base64url"),
              },
            ],
          });
        }
        return jsonResponse({
          slug: "abc123",
          status: "resolved",
          question: "Ship it?",
          resolved_at: "2026-07-09T12:00:00.000Z",
          resolved_winner: null,
          resolved_outcome: "no_pass",
          verification: { jwks_url: "https://operator.example/.well-known/grp.json" },
          decisions: [
            {
              seq: 1,
              question: "Ship it?",
              prev_hash: null,
              receipt_hash: receiptHash,
              receipt_jws: jws,
            },
          ],
          conclusion: null,
        });
      },
      env: providerEnv(roomConfig()),
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Verification: failed");
    expect(stdout).toContain("semantic verification failed");
    expect(stdout).toContain("outcome does not match its signed votes");
  });

  it("rejects a chain entry whose signed prev_hash disagrees with the summary", async () => {
    const privateKey = new Uint8Array(32).fill(9);
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const jws = await signCompactJws({
      header: { alg: "EdDSA", typ: "grp-receipt+jwt", kid: "op-link" },
      payload: {
        iss: "https://operator.example",
        grp: { sequence: 1, prev_hash: "sha256:forged" },
      },
      privateKey,
    });
    const receiptHash = computeJwsReceiptHash(jws);
    let stdout = "";
    const code = await runRoomCli(["outcome"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname === "/.well-known/grp.json") {
          return jsonResponse({
            keys: [
              {
                kid: "op-link",
                kty: "OKP",
                crv: "Ed25519",
                alg: "EdDSA",
                x: Buffer.from(publicKey).toString("base64url"),
              },
            ],
          });
        }
        return jsonResponse({
          slug: "abc123",
          status: "resolved",
          question: "Ship it?",
          resolved_at: "2026-07-09T12:00:00.000Z",
          resolved_winner: "yes",
          resolved_outcome: "pass",
          verification: { jwks_url: "https://operator.example/.well-known/grp.json" },
          decisions: [
            {
              seq: 1,
              question: "Ship it?",
              prev_hash: null,
              receipt_hash: receiptHash,
              receipt_jws: jws,
            },
          ],
          conclusion: null,
        });
      },
      env: providerEnv(roomConfig()),
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Verification: failed");
    expect(stdout).toContain("signed prev_hash does not match its chain entry");
  });

  it("propose --file sends the file's contents as the option (WR11-4)", async () => {
    // Run 11's Silica lost a propose to shell quoting and detoured through
    // a temp file + $(cat …); documents now travel as documents.
    const dir = mkdtempSync(pathJoin(tmpdir(), "grp-propose-file-"));
    const file = pathJoin(dir, "scene-list.txt");
    writeFileSync(file, "SCENE LIST (1) it has 'quotes' and (parens)\n", "utf8");
    let sentOption: string | null = null;
    let stdout = "";
    const code = await runRoomCli(["propose", `--file=${file}`], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const body = JSON.parse(String(new Request(input, init).body ? init?.body : "{}"));
        sentOption = body.option ?? null;
        return jsonResponse({ accepted: true, options: [body.option], choosing_open: true });
      },
      env: providerEnv(roomConfig()),
    });
    expect(code).toBe(0);
    expect(sentOption).toBe("SCENE LIST (1) it has 'quotes' and (parens)");
    expect(stdout).toContain("Option proposed:");
  });

  it("propose rejects --file combined with option text", async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "grp-propose-file-"));
    const file = pathJoin(dir, "opt.txt");
    writeFileSync(file, "from file", "utf8");
    let stderr = "";
    const code = await runRoomCli(["propose", "inline text", `--file=${file}`], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () => jsonResponse({}),
      env: providerEnv(roomConfig()),
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain("either --file or option text");
  });

  it("propose --file with an empty file falls to the option-required error", async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "grp-propose-file-"));
    const file = pathJoin(dir, "empty.txt");
    writeFileSync(file, "\n", "utf8");
    let stderr = "";
    const code = await runRoomCli(["propose", `--file=${file}`], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () => jsonResponse({}),
      env: providerEnv(roomConfig()),
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain("propose");
  });

  it("discuss --file preserves an exact shell-sensitive text snapshot", async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "grp-discuss-file-"));
    const file = pathJoin(dir, "handoff.txt");
    const content =
      "  Budget is $800; do not expand `git rev-parse HEAD`.\nKeep 'quotes' and (parens).\n";
    writeFileSync(file, content, "utf8");
    let sentBody: string | null = null;
    const code = await runRoomCli(["discuss", `--file=${file}`], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        const body = JSON.parse(String(new Request(input, init).body ? init?.body : "{}"));
        sentBody = body.body ?? null;
        return jsonResponse({ id: "m-file" });
      },
      env: providerEnv(roomConfig()),
    });
    expect(code).toBe(0);
    expect(sentBody).toBe(content);
  });

  it("discuss - reads an exact message from stdin", async () => {
    const content = "first line with $PATH\nsecond line\n";
    let sentBody: string | null = null;
    const code = await runRoomCli(["discuss", "-"], {
      stdin: Readable.from([content]),
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        const body = JSON.parse(String(new Request(input, init).body ? init?.body : "{}"));
        sentBody = body.body ?? null;
        return jsonResponse({ id: "m-stdin" });
      },
      env: providerEnv(roomConfig()),
    });
    expect(code).toBe(0);
    expect(sentBody).toBe(content);
  });

  it("discuss rejects --file combined with inline message text", async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "grp-discuss-file-"));
    const file = pathJoin(dir, "message.txt");
    writeFileSync(file, "from file", "utf8");
    let stderr = "";
    const code = await runRoomCli(["discuss", "inline text", `--file=${file}`], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () => jsonResponse({}),
      env: providerEnv(roomConfig()),
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain("either --file or message text");
  });
});

describe("spec 193 — safe room-read pagination", () => {
  const roomConfig = (lastSeenSeq = 10) => ({
    providers: {},
    currentRoom: {
      slug: "abc123",
      baseUrl: "https://operator.example",
      token: "t_1",
      lastSeenSeq,
    },
  });

  const longMessage = (label: string) =>
    Array.from({ length: 60 }, (_, index) => `${label} line ${index + 1}`).join("\n");

  const entries = [
    {
      seq: 11,
      type: "discussion",
      at: "2026-08-08T17:00:00Z",
      who: "Silica",
      said: longMessage("first complete event"),
    },
    {
      seq: 12,
      type: "discussion",
      at: "2026-08-08T17:01:00Z",
      who: "Cobalt",
      said: longMessage("second complete event"),
    },
    {
      seq: 13,
      type: "discussion",
      at: "2026-08-08T17:02:00Z",
      who: "Mica",
      said: "later event remains readable",
    },
  ];

  const deltaFetch: typeof globalThis.fetch = async (input, init) => {
    const since = Number(new URL(new Request(input, init).url).searchParams.get("since") ?? 0);
    return jsonResponse({
      slug: "abc123",
      status: "open",
      state: "no question open",
      role: "participant",
      new: entries.filter((entry) => entry.seq > since),
      current_through: 13,
      more: {},
    });
  };

  it("acknowledges only complete events on page one and leaves the suffix for the next read", async () => {
    const env = providerEnv(roomConfig());
    let firstPage = "";
    expect(
      await runRoomCli(["read"], {
        stdout: (text) => {
          firstPage += text;
        },
        stderr: () => {},
        fetch: deltaFetch,
        env,
      }),
    ).toBe(0);

    expect(firstPage).toContain("first complete event line 60");
    expect(firstPage).not.toContain("second complete event line 1");
    expect(firstPage).not.toContain("later event remains readable");
    expect(firstPage).toContain("More unread activity remains: grp read");
    expect(firstPage).toContain("Current through seq 11.");
    let saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(11);

    let secondPage = "";
    expect(
      await runRoomCli(["read"], {
        stdout: (text) => {
          secondPage += text;
        },
        stderr: () => {},
        fetch: deltaFetch,
        env,
      }),
    ).toBe(0);

    expect(secondPage).not.toContain("first complete event line 1");
    expect(secondPage).toContain("second complete event line 60");
    expect(secondPage).toContain("later event remains readable");
    expect(secondPage).not.toContain("More unread activity remains");
    expect(secondPage).toContain("Current through seq 13.");
    saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(13);
  });

  it("renders one oversized event whole and advances through it", async () => {
    const env = providerEnv(roomConfig());
    const oversized = Array.from(
      { length: 120 },
      (_, index) => `oversized event line ${index + 1}`,
    ).join("\n");
    let stdout = "";
    const code = await runRoomCli(["read"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          status: "open",
          state: "no question open",
          new: [{ seq: 11, type: "discussion", who: "Silica", said: oversized }],
          current_through: 11,
          more: {},
        }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain("oversized event line 120");
    expect(stdout).not.toContain("More unread activity remains");
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(11);
  });

  it("also pages complete events when their combined character size exceeds the budget", async () => {
    const env = providerEnv(roomConfig());
    const largeEntries = [
      { seq: 11, type: "discussion", who: "Silica", said: `first-${"a".repeat(60_000)}` },
      { seq: 12, type: "discussion", who: "Cobalt", said: `second-${"b".repeat(60_000)}` },
    ];
    let stdout = "";
    const code = await runRoomCli(["read"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          status: "open",
          state: "no question open",
          new: largeEntries,
          current_through: 12,
          more: {},
        }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain(`first-${"a".repeat(60_000)}`);
    expect(stdout).not.toContain("second-");
    expect(stdout).toContain("Current through seq 11.");
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(11);
  });

  it("keeps JSON reads complete and acknowledges the host high-water mark", async () => {
    const env = providerEnv(roomConfig());
    let stdout = "";
    const code = await runRoomCli(["read", "--json"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: deltaFetch,
      env,
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout).new).toHaveLength(3);
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(13);
  });

  it("honors limit and since-seq on the human timeline without moving the read mark", async () => {
    const env = providerEnv(roomConfig());
    const seenSince: number[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const since = Number(new URL(new Request(input, init).url).searchParams.get("since") ?? 0);
      seenSince.push(since);
      return jsonResponse({
        slug: "abc123",
        new: entries.filter((entry) => entry.seq > since),
        current_through: 13,
      });
    };

    let limited = "";
    expect(
      await runRoomCli(["timeline", "--limit=1"], {
        stdout: (text) => {
          limited += text;
        },
        stderr: () => {},
        fetch,
        env,
      }),
    ).toBe(0);
    expect(limited).toContain("first complete event line 60");
    expect(limited).not.toContain("second complete event line 1");

    let since = "";
    expect(
      await runRoomCli(["timeline", "--since-seq=11", "--limit=1"], {
        stdout: (text) => {
          since += text;
        },
        stderr: () => {},
        fetch,
        env,
      }),
    ).toBe(0);
    expect(since).not.toContain("first complete event line 1");
    expect(since).toContain("second complete event line 60");
    expect(since).not.toContain("later event remains readable");
    expect(seenSince).toEqual([0, 11]);
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(10);
  });
});

describe("spec 131 — multi-room attention and routing", () => {
  const multiRoomConfig = () => ({
    providers: {},
    currentRoom: {
      baseUrl: "https://operator.example",
      slug: "dayroom01",
      token: "t_day_secret",
      role: "participant",
      lastSeenSeq: 5,
    },
    rooms: {
      day: {
        baseUrl: "https://operator.example",
        slug: "dayroom01",
        token: "t_day_secret",
        role: "participant",
        lastSeenSeq: 5,
      },
      night: {
        baseUrl: "https://operator.example",
        slug: "nightroom2",
        token: "t_night_secret",
        password: "secret-password",
        role: "participant",
        lastSeenSeq: 10,
      },
    },
  });

  it("labels remembered rooms as local state and does not invent an unknown role", async () => {
    let stdout = "";
    const code = await runRoomCli(["rooms"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      env: providerEnv({
        providers: {},
        currentRoom: { baseUrl: "https://operator.example", slug: "room-without-role" },
      }),
    });

    expect(code).toBe(0);
    expect(stdout).toContain("CURRENT  ROOM");
    expect(stdout).toContain("ROLE");
    expect(stdout).toContain("—");
    expect(stdout).not.toContain("unknown");
    expect(stdout).toContain("Local memory only");
    expect(stdout).toContain("grp inbox");
    expect(stdout).toContain("grp forget ROOM");
  });

  it("forgets one room locally without contacting or changing the hosted room", async () => {
    const env = providerEnv(multiRoomConfig());
    let stdout = "";
    let fetched = false;
    const code = await runRoomCli(["forget", "dayroom01"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () => {
        fetched = true;
        throw new Error("forget must stay local");
      },
      env,
    });

    expect(code).toBe(0);
    expect(fetched).toBe(false);
    expect(stdout).toContain("Forgot dayroom01 on operator.example locally");
    expect(stdout).toContain("The hosted room was not changed");
    const config = readProviderConfig(env);
    expect(config.currentRoom).toBeUndefined();
    expect(config.rooms && Object.values(config.rooms).map((room) => room.slug)).toEqual([
      "nightroom2",
    ]);
  });

  it("uses the documented text-first trailing-room destination", async () => {
    const env = providerEnv(multiRoomConfig());
    let requestedUrl = "";
    let requestedBody: Record<string, unknown> = {};
    let stdout = "";
    const code = await runRoomCli(["discuss", "I am ready", "nightroom2"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requestedUrl = request.url;
        requestedBody = JSON.parse(String(init?.body));
        return jsonResponse({ id: "m1" });
      },
      env,
    });

    expect(code).toBe(0);
    expect(requestedUrl).toBe("https://operator.example/api/rooms/nightroom2/discuss");
    expect(requestedBody).toEqual({ body: "I am ready" });
    expect(stdout).toContain("Discussion posted. Room: nightroom2.");
    expect(stdout).toContain("Read the room: grp read nightroom2");
    expect(stdout).toContain("If more work may follow: grp watch nightroom2");
    expect(readProviderConfig(env).currentRoom?.slug).toBe("dayroom01");
  });

  it("keeps every next-action hint scoped after an explicit non-current read", async () => {
    const env = providerEnv(multiRoomConfig());
    let stdout = "";
    const code = await runRoomCli(["read", "nightroom2", "--full"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "nightroom2",
          status: "open",
          current_through: 12,
          brief: "A choice is open.",
          decision: {
            question: "Choose a target",
            status: "voting",
            options: ["Silica", "Cobalt"],
            choices_cast: 0,
            eligible_voters: 2,
          },
          rules: { can_propose: true },
        }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain(
      "grp options --full nightroom2  # host did not report the ballot shape",
    );
    expect(stdout).toContain('grp discuss "..." nightroom2');
    expect(stdout).toContain("grp discuss --file=PATH nightroom2");
    expect(stdout).toContain("grp options nightroom2");
    expect(stdout).toContain("grp watch nightroom2");
    expect(readProviderConfig(env).currentRoom?.slug).toBe("dayroom01");
  });

  it("routes flag-first full reads and option reads to the named room (spec 147)", async () => {
    const env = providerEnv(multiRoomConfig());
    const requested: Array<{ pathname: string; include: string | null; since: string | null }> = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      requested.push({
        pathname: url.pathname,
        include: url.searchParams.get("include"),
        since: url.searchParams.get("since"),
      });
      return jsonResponse({
        slug: "nightroom2",
        status: "voting",
        brief: 'Deciding now: "Night choice" — 0/2 choices in.',
        decision: {
          question: "Night choice",
          status: "voting",
          options: ["Moon", "Stars"],
          choices_cast: 0,
          eligible_voters: 2,
        },
        discussion: [],
        roster: { joined: [], expected: [], waiting_for: [] },
        rules: {},
        more: {},
      });
    };

    expect(
      await runRoomCli(["read", "--full", "nightroom2"], {
        stdout: () => {},
        stderr: () => {},
        fetch,
        env,
      }),
    ).toBe(0);
    expect(
      await runRoomCli(["options", "--full", "nightroom2"], {
        stdout: () => {},
        stderr: () => {},
        fetch,
        env,
      }),
    ).toBe(0);

    expect(requested).toEqual([
      { pathname: "/api/rooms/nightroom2", include: null, since: null },
      { pathname: "/api/rooms/nightroom2", include: "full", since: null },
    ]);
    expect(readProviderConfig(env).currentRoom?.slug).toBe("dayroom01");
  });

  it("rejects surplus text-command positionals before making a request", async () => {
    let fetched = false;
    let stderr = "";
    const code = await runRoomCli(["discuss", "message", "nightroom2", "ignored"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () => {
        fetched = true;
        return jsonResponse({});
      },
      env: providerEnv(multiRoomConfig()),
    });

    expect(code).toBe(1);
    expect(fetched).toBe(false);
    expect(stderr).toContain("too many arguments for grp discuss");
  });

  it("requires an explicit host when one short slug is remembered on two hosts", () => {
    const env = providerEnv({
      providers: {},
      rooms: {
        first: { baseUrl: "https://one.example", slug: "sharedroom", token: "t_one" },
        second: { baseUrl: "https://two.example", slug: "sharedroom", token: "t_two" },
      },
    });

    expect(() => resolveRoomRef("sharedroom", {}, env)).toThrow("remembered on multiple hosts");
  });

  it("lists local room metadata without credentials or content", async () => {
    const env = providerEnv(multiRoomConfig());
    let stdout = "";
    const code = await runRoomCli(["rooms", "--json"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () => {
        throw new Error("rooms must stay local");
      },
      env,
    });

    expect(code).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.current_room).toBe("dayroom01");
    expect(output.rooms).toHaveLength(2);
    expect(stdout).not.toContain("t_day_secret");
    expect(stdout).not.toContain("t_night_secret");
    expect(stdout).not.toContain("secret-password");
  });

  it("offers foreground watch or a runtime-scheduled return when inbox is quiet", async () => {
    const env = providerEnv(multiRoomConfig());
    let stdout = "";
    const code = await runRoomCli(["inbox"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () => jsonResponse({ status: "timeout" }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain("No remembered rooms need attention (2 checked).");
    expect(stdout).toContain("Stay present now: grp watch");
    expect(stdout).toContain("your agent runtime's scheduling tools");
    expect(stdout).toContain("then run grp inbox");
  });

  it("scans every remembered room without switching or consuming its cursor", async () => {
    const env = providerEnv(multiRoomConfig());
    const before = JSON.stringify(readProviderConfig(env));
    const urls: string[] = [];
    let stdout = "";
    const code = await runRoomCli(["inbox"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        urls.push(url.toString());
        if (url.pathname.includes("dayroom01")) {
          return jsonResponse({
            status: "actionable",
            for: "my_choice",
            decision: { question: "Who should be eliminated?" },
          });
        }
        return jsonResponse({
          status: "activity",
          event: { seq: 11, type: "discussion.posted", who: "Neon" },
        });
      },
      env,
    });

    expect(code).toBe(0);
    expect(urls).toHaveLength(2);
    expect(urls.some((url) => url.includes("dayroom01") && url.includes("since_seq=5"))).toBe(true);
    expect(urls.some((url) => url.includes("nightroom2") && url.includes("since_seq=10"))).toBe(
      true,
    );
    for (const url of urls) {
      expect(url).toContain("for=activity");
      expect(url).toContain("wait=0");
    }
    expect(stdout).toContain('CHOICE NEEDED  dayroom01  "Who should be eliminated?"');
    expect(stdout).toContain("NEW ACTIVITY   nightroom2  Neon: discussion posted");
    expect(JSON.stringify(readProviderConfig(env))).toBe(before);
  });

  // Spec 142 (D8) — a multi-open room fans out to one CHOICE NEEDED row per
  // owed decision (via also_actionable), each naming its decision number.
  it("renders one row per owed decision when a room has several open", async () => {
    const env = providerEnv(multiRoomConfig());
    const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const later = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    let stdout = "";
    const code = await runRoomCli(["inbox"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname.includes("dayroom01")) {
          return jsonResponse({
            status: "actionable",
            for: "my_choice",
            decision: { seq: 4, question: "First owed", voting_ends_at: later },
            also_actionable: [{ seq: 6, question: "Second owed", voting_ends_at: soon }],
          });
        }
        return jsonResponse({ status: "timeout", next_poll_at: new Date().toISOString() });
      },
      env,
    });
    expect(code).toBe(0);
    // Two rows from one room, each tagged with its decision number; the
    // sooner deadline sorts first across the whole inbox.
    expect(stdout).toContain('CHOICE NEEDED  dayroom01  "Second owed"');
    expect(stdout).toContain('CHOICE NEEDED  dayroom01  "First owed"');
    expect(stdout).toContain("(decision 4)");
    expect(stdout).toContain("(decision 6)");
    expect(stdout.indexOf('"Second owed"')).toBeLessThan(stdout.indexOf('"First owed"'));
  });

  // Spec 139 (C1) — the inbox is deadline-aware: choice rows carry the
  // window close, the soonest deadline sorts first, and voting_ends_at is
  // on the --json shape so a routine-driven agent can triage by time.
  it("renders window deadlines on choice rows and sorts the soonest first", async () => {
    const env = providerEnv(multiRoomConfig());
    const soon = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const later = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    let stdout = "";
    const code = await runRoomCli(["inbox"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname.includes("dayroom01")) {
          // dayroom01 sorts first in room order but has the LATER deadline.
          return jsonResponse({
            status: "actionable",
            for: "my_choice",
            decision: { question: "Pick a venue", status: "voting", voting_ends_at: later },
          });
        }
        return jsonResponse({
          status: "actionable",
          for: "my_choice",
          decision: { question: "Approve the offer?", status: "voting", voting_ends_at: soon },
        });
      },
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain('CHOICE NEEDED  nightroom2  "Approve the offer?" — closes in ~20m');
    expect(stdout).toContain('CHOICE NEEDED  dayroom01  "Pick a venue" — closes in ~3d');
    expect(stdout.indexOf("nightroom2")).toBeLessThan(stdout.indexOf("dayroom01"));
  });

  it("reports a sealed own question as RESOLVED, not a choice, with voting_ends_at in json", async () => {
    const env = providerEnv(multiRoomConfig());
    const soon = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    let stdout = "";
    const code = await runRoomCli(["inbox", "--json"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname.includes("dayroom01")) {
          // The opener-seal wake shape (spec 125): actionable + resolved.
          return jsonResponse({
            status: "actionable",
            for: "my_choice",
            decision: { question: "Which cut do we ship?", status: "resolved" },
          });
        }
        return jsonResponse({
          status: "actionable",
          for: "my_choice",
          decision: { question: "Approve the offer?", status: "voting", voting_ends_at: soon },
        });
      },
      env,
    });

    expect(code).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.rooms[0]).toMatchObject({
      slug: "nightroom2",
      status: "choice_needed",
      voting_ends_at: soon,
    });
    expect(output.rooms[1]).toMatchObject({
      slug: "dayroom01",
      status: "question_resolved",
      question: "Which cut do we ship?",
    });

    let text = "";
    const textCode = await runRoomCli(["inbox"], {
      stdout: (chunk) => {
        text += chunk;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname.includes("dayroom01")) {
          return jsonResponse({
            status: "actionable",
            for: "my_choice",
            decision: { question: "Which cut do we ship?", status: "resolved" },
          });
        }
        return jsonResponse({ status: "timeout" });
      },
      env,
    });
    expect(textCode).toBe(0);
    expect(text).toContain(
      'RESOLVED       dayroom01  "Which cut do we ship?" — your question sealed',
    );
  });

  it("contains an inbox failure to that room and checks the others", async () => {
    const env = providerEnv(multiRoomConfig());
    let stdout = "";
    const code = await runRoomCli(["inbox", "--json"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname.includes("nightroom2")) throw new Error("host unavailable");
        return jsonResponse({ status: "timeout" });
      },
      env,
    });

    expect(code).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.rooms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "dayroom01", status: "quiet" }),
        expect.objectContaining({
          slug: "nightroom2",
          status: "unavailable",
          error: "host unavailable",
        }),
      ]),
    );
  });

  it("switches on a later join only when --enter is explicit", async () => {
    const env = providerEnv(multiRoomConfig());
    let stdout = "";
    const code = await runRoomCli(
      ["join", "https://operator.example/r/thirdroom", "--as=Iris", "--enter"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () => jsonResponse({ participant_token: "t_third", role: "participant" }),
        env,
      },
    );

    expect(code).toBe(0);
    expect(readProviderConfig(env).currentRoom).toMatchObject({
      slug: "thirdroom",
      token: "t_third",
    });
    expect(stdout).toContain("Current room switched to: thirdroom.");
  });

  it("keeps remembered rooms isolated to the active local session", async () => {
    const env = providerEnv({
      providers: {},
      sessions: {
        silica: {
          currentRoom: { baseUrl: "https://operator.example", slug: "silica-room" },
          rooms: {
            silica: { baseUrl: "https://operator.example", slug: "silica-room" },
          },
        },
        cobalt: {
          currentRoom: { baseUrl: "https://operator.example", slug: "cobalt-room" },
          rooms: {
            cobalt: { baseUrl: "https://operator.example", slug: "cobalt-room" },
          },
        },
      },
    });
    let stdout = "";
    const code = await runRoomCli(["rooms"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      env: { ...env, GRP_SESSION: "silica" },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("silica-room");
    expect(stdout).not.toContain("cobalt-room");
  });
});
