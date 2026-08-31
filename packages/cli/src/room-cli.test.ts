import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { Readable } from "node:stream";
import * as ed25519 from "@noble/ed25519";
import { describe, expect, it, vi } from "vitest";
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
      "as-discussion",
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
    const env = providerEnv({ providers: {} });
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
        env,
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
      fetch: withCoordinationDiscovery(
        async () =>
          jsonResponse(
            {
              error: {
                code: "participant.token_superseded",
                message: "this seat was re-joined from another session",
              },
            },
            401,
          ),
        false,
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
    expect(stdout).toContain("Other commands:");
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
    expect(stdout).toContain("Nothing currently needs your response.");
    expect(stdout).toContain("Next:");
    expect(stdout).toContain("Discuss — exchange context; creates no formal outcome.");
    expect(stdout).toContain("Watch — wait for relevant room activity.");
    expect(stdout).not.toContain('grp ask "..."');
    expect(stdout).not.toContain("Coordinate work:");
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
          state_revision: "rev-1",
          actions: [],
          artifacts: [],
          more: {
            wait: "GET /api/rooms/abc123/next-action",
            ask: "POST /api/rooms/abc123/ask",
          },
        }),
      env: { GRP_BASE_URL: "https://operator.example" },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Discuss — exchange context; creates no formal outcome.");
    expect(stdout).toContain("Act — track work inside or outside GRP and what counts as complete:");
    expect(stdout).toContain('grp act start --title="Describe the work"');
    expect(stdout).toContain("Ask — record a group choice.");
    expect(stdout).toContain("Watch — wait for relevant room activity.");
    expect(stdout).toContain(
      "Attach an artifact for exact shared work. Modes and artifacts: grp act --help",
    );
    expect(stdout).not.toContain("One participant; peers continue");
    expect(stdout).not.toContain("Canonical resource only when that action needs one");
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
    expect(stdout).toContain("If the option set is incomplete, propose another candidate answer:");
    expect(stdout).toContain('grp discuss "..." abc123');
    expect(stdout).toContain("grp discuss --file=PATH abc123");
    expect(stdout).toContain('grp propose "..." abc123');
    // Spec 113 — ONE wait: no resolved/needed split in guidance.
    expect(stdout).toContain("Wait for what's next: grp watch abc123");
    expect(stdout).not.toContain("--until=");
    // Vocabulary — no turns anywhere on the surface.
    expect(stdout).not.toMatch(/\bturn\b/i);
  });

  // Spec 112 (WR4-5) — exact expansion renders the discussion tail the agent
  // view carries; agents can recover the deliberation without truncation.
  it("renders the discussion tail between the options and the guidance", async () => {
    let stdout = "";
    const code = await runRoomCli(["read", "abc123", "--expand"], {
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
    const code = await runRoomCli(["read", "abc123", "--expand"], {
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
    expect(stdout.match(/No decision is open right now\./g)).toHaveLength(1);
    expect(stdout).not.toContain("\nNo open decision.\n");
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
      fetch: withCoordinationDiscovery(fetchSpy, false),
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
      fetch: withCoordinationDiscovery(async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        bodies.push(await request.json());
        return jsonResponse({ ok: true, decision_id: "d1" });
      }, false),
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
        fetch: withCoordinationDiscovery(async (_input, init) => {
          bodies.push(await new Request(_input, init).json());
          return jsonResponse({ ok: true, decision_id: "d1" });
        }, false),
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
      fetch: withCoordinationDiscovery(async (_input, init) => {
        bodies.push(await new Request(_input, init).json());
        return jsonResponse({ ok: true, decision_id: "d1" });
      }, false),
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
      fetch: withCoordinationDiscovery(async (_input, init) => {
        const request = new Request(_input, init);
        bodies.push(await request.json());
        return jsonResponse({ ok: true, decision_id: "d1" });
      }, false),
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
      fetch: withCoordinationDiscovery(async (_input, init) => {
        const request = new Request(_input, init);
        bodies.push(await request.json());
        return jsonResponse({ ok: true, decision_id: "d1" });
      }, false),
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
      fetch: withCoordinationDiscovery(async (_input, init) => {
        const request = new Request(_input, init);
        bodies.push(await request.json());
        return jsonResponse({ ok: true, decision_id: "d1" });
      }, false),
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
        fetch: withCoordinationDiscovery(async (input, init) => {
          const request = new Request(input, init);
          expect(new URL(request.url).pathname).toBe("/api/rooms/abc123/discuss");
          bodies.push(await request.json());
          return jsonResponse({ ok: true, id: "msg_1" });
        }, false),
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

  it("auto-paginates the complete human timeline using event page metadata", async () => {
    const urls: URL[] = [];
    let stdout = "";
    const code = await runRoomCli(["timeline", "abc123"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input) => {
        const url = new URL(String(input));
        urls.push(url);
        const since = Number(url.searchParams.get("since") ?? 0);
        if (since === 0) {
          return jsonResponse({
            slug: "abc123",
            current_through: 2,
            page: { through_event: 2, room_event: 4, complete: false, next_since: 2 },
            new: [
              {
                seq: 1,
                type: "discussion",
                at: "2026-08-25T12:00:00.000Z",
                who: "Silica",
                said: "First",
              },
              {
                seq: 2,
                type: "discussion",
                at: "2026-08-25T12:01:00.000Z",
                who: "Cobalt",
                said: "Second",
              },
            ],
          });
        }
        return jsonResponse({
          slug: "abc123",
          current_through: 4,
          page: { through_event: 4, room_event: 4, complete: true },
          new: [
            {
              seq: 3,
              type: "discussion",
              at: "2026-08-25T12:02:00.000Z",
              who: "Argon",
              said: "Third",
            },
            {
              seq: 4,
              type: "discussion",
              at: "2026-08-25T12:03:00.000Z",
              who: "Neon",
              said: "Fourth",
            },
          ],
        });
      },
      env: operatorEnv(),
    });

    expect(code).toBe(0);
    expect(urls).toHaveLength(2);
    expect(urls[0]?.searchParams.get("since")).toBe("0");
    expect(urls[1]?.searchParams.get("since")).toBe("2");
    expect(stdout).toContain("Silica: First");
    expect(stdout).toContain("Neon: Fourth");
  });

  it("returns exactly one requested event in the raw timeline", async () => {
    let stdout = "";
    const code = await runRoomCli(["timeline", "abc123", "--event=3", "--jsonl"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("since_seq")).toBe("2");
        expect(url.searchParams.get("limit")).toBe("1");
        return jsonResponse({
          slug: "abc123",
          events: [
            {
              id: "e3",
              seq: 3,
              event_type: "discussion.posted",
              occurred_at: "2026-08-25T12:02:00.000Z",
              data: {},
            },
          ],
          page: { through_event: 3, room_event: 4, complete: false },
        });
      },
      env: operatorEnv(),
    });

    expect(code).toBe(0);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout)).toMatchObject({ id: "e3", seq: 3 });
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
      "Room is still open. Next: grp read abc123 — the shared state may have changed; stay with the room.",
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
  // says so and routes through read/outcome, never to choose or presume the
  // room's next kind of work.
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
    expect(stdout).toContain("grp outcome abc123");
    expect(stdout).toContain("grp read abc123");
    expect(stdout).not.toContain('grp ask "..."');
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
      "You’re invited to join a GRP room. GRP gives agents shared rooms for working together.",
    );
    expect(stdout).not.toContain("Room purpose: Planning Friday dinner");
    expect(stdout).toContain("This invite is for Alex (participant).");
    expect(stdout).toContain("Room service: https://operator.example.");
    expect(stdout).toContain("If needed, install the open-source GRP CLI:");
    expect(stdout).toContain("npm install -g @grp-protocol/cli");
    expect(stdout).toContain(
      "After joining, grp read shows the room’s purpose and current shared state.",
    );
    expect(stdout).toContain("Join the room:");
    expect(stdout).not.toContain("operated by the person who sent you this invite");
    expect(stdout).not.toContain("stay with the room");
    expect(stdout).toContain("grp join https://operator.example/r/abc123 --invite it_alex");
    expect(stdout.indexOf("install the open-source GRP CLI")).toBeLessThan(
      stdout.indexOf("grp join https://operator.example/r/abc123 --invite it_alex"),
    );
  });

  // Spec 231 — purpose remains canonical room state regardless of length.
  it("does not duplicate a long room purpose into the locally built paste block", async () => {
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
    expect(stdout).not.toContain(`Room purpose: ${about}`);
    expect(stdout).toContain("grp read shows the room’s purpose and current shared state");
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
      "You’re invited to join a GRP room. GRP gives agents shared rooms for working together.",
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
    expect(stdout).toContain("Wait for what's next: grp watch --timeout=300\n");
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
    expect(stdout).toContain("Stay with the room: grp watch --timeout=300 abc123");
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
    expect(stdout).toContain("Other commands:");
    expect(stdout).toContain("grp outcome");
    expect(stdout).toContain("grp members");
    expect(stdout).not.toContain("grp ask");
    expect(stdout).not.toContain("grp discuss");
    expect(stdout).not.toContain("grp invite");
    expect(stdout).not.toContain("No open decision.");
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
    expect(stdout).toContain("Wait for room activity: grp watch");
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

  it("renders the anchored delta and advances the mark when acknowledged", async () => {
    const env = providerEnv(roomConfig({ lastSeenSeq: 5 }));
    let stdout = "";
    let sinceParam: string | null = null;
    const code = await runRoomCli(["read", "--ack"], {
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
    expect(stdout).toContain("COMPLETE CATCH-UP — 3 updates shown, through event 8 of 8.");
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(8);
  });

  it("names a direct action handoff to its recipient", async () => {
    const env = providerEnv(roomConfig({ lastSeenSeq: 8, participantId: "p_northline" }));
    let stdout = "";
    expect(
      await runRoomCli(["read"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            slug: "abc123",
            status: "open",
            state: "no question open",
            new: [
              {
                seq: 9,
                type: "action_handed_off",
                action_id: "act_1",
                from: "Kestrel",
                to: "Northline",
                to_you: true,
              },
            ],
            current_through: 9,
            actions: [
              {
                id: "act_1",
                revision: "4",
                title: "Prepare the shared result",
                status: "in_progress",
                mode: "handoff",
                holder_id: "p_northline",
                holder_display_name: "Northline",
                previous_holder_id: "p_kestrel",
                previous_holder_display_name: "Kestrel",
              },
            ],
            artifacts: [],
            more: {},
          }),
        env,
      }),
    ).toBe(0);
    expect(stdout).toContain("Kestrel handed action act_1 to you.");
    expect(stdout).toContain("holder you");
    expect(stdout).toContain("Continue with the action guidance above.");
    expect(stdout).not.toContain("holder p_northline");
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

  it("keeps the working-set snapshot on first contact (no stored mark)", async () => {
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

  it("--snapshot requests a fresh working-set snapshot rather than exhaustive content", async () => {
    let sinceParam: string | null = "unset";
    let includeParam: string | null = "unset";
    const code = await runRoomCli(["read", "--snapshot"], {
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        const params = new URL(new Request(input, init).url).searchParams;
        sinceParam = params.get("since");
        includeParam = params.get("include");
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
    expect(includeParam).toBeNull();
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
    expect(stdout).toContain("Nothing new through event 9.");
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

  it("names a direct handoff when bare watch wakes its exact recipient", async () => {
    const env = providerEnv(wakeConfig(4));
    const handedOff = JSON.stringify({
      id: "e6",
      seq: 6,
      event_type: "action.handed_off",
      occurred_at: "2026-08-23T03:01:00.000Z",
      decision_id: null,
      data: {
        action_id: "act_1",
        from_holder_id: "p_kestrel",
        to_holder_id: "p_me",
      },
    });
    let stdout = "";
    expect(
      await runRoomCli(["watch"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const url = new URL(new Request(input, init).url);
          if (url.pathname.endsWith("/next-action")) return new Promise<Response>(() => {});
          if (url.pathname.endsWith("/events/stream")) {
            return new Response(
              sseStream([`id: e6\nevent: action.handed_off\ndata: ${handedOff}\n\n`]),
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          return jsonResponse({
            slug: "abc123",
            new: [
              {
                seq: 6,
                type: "action_handed_off",
                action_id: "act_1",
                from: "Kestrel",
                to: "Me",
                to_you: true,
              },
            ],
            current_through: 6,
          });
        },
        env,
      }),
    ).toBe(0);
    expect(stdout).toContain("Kestrel handed action act_1 to you.");
    expect(stdout).toContain("Next:\n  grp read");
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

  it("wakes on another participant's transient working signal without moving either durable marker", async () => {
    const base = wakeConfig(4);
    const env = providerEnv({
      ...base,
      currentRoom: { ...base.currentRoom, observedStateRevision: "opaque-90" },
    });
    let stdout = "";
    const code = await runRoomCli(["watch", "--timeout=2"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const url = new Request(input, init).url;
        if (url.includes("/next-action")) {
          return jsonResponse({
            status: "working",
            signal_change: {
              signal_id: "signal_1",
              participant_id: "p_other",
              change: "started",
            },
            requires_read: true,
          });
        }
        if (url.includes("/events/stream")) {
          return new Response(sseStream([]), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return jsonResponse({ slug: "abc123", events: [] });
      },
      env,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Working state changed (started) for participant p_other.");
    expect(stdout).toContain("Signal: signal_1");
    expect(stdout).toContain("grp read");
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(4);
    expect(saved.currentRoom.observedStateRevision).toBe("opaque-90");
  });

  it("wakes from durable activity long-poll when the SSE racer misses an artifact review", async () => {
    const env = providerEnv(wakeConfig(20));
    let stdout = "";
    const code = await runRoomCli(["watch", "--timeout=2"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const url = new Request(input, init).url;
        if (url.includes("/next-action")) {
          return jsonResponse({
            status: "activity",
            event: {
              seq: 21,
              type: "artifact.reviewed",
              who: "Northline Ventures",
            },
          });
        }
        if (url.includes("/events/stream")) return new Promise<Response>(() => {});
        throw new Error(`unexpected request: ${url}`);
      },
      env,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Northline Ventures reviewed an artifact.");
    expect(stdout).toContain("grp read");
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(20);
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

function withCoordinationDiscovery(
  next: typeof globalThis.fetch,
  enabled = true,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === "/.well-known/grp.json") {
      return jsonResponse(
        enabled
          ? {
              metadata: {
                experimental_coordination_state: { status: "experimental" },
              },
            }
          : { metadata: {} },
      );
    }
    return next(input, init);
  };
}

// Retained temporarily as executable migration documentation. Spec 228 replaces
// this operator-facing surface with actions, filtered watch, and action-owned
// artifacts; these assertions describe the unpublished candidate it superseded.
describe.skip("obsolete spec 224 candidate — replaced by spec 228", () => {
  const roomConfig = (extra: Record<string, unknown> = {}) => ({
    providers: {},
    currentRoom: {
      slug: "abc123",
      baseUrl: "https://operator.example",
      token: "t_1",
      lastSeenSeq: 8,
      ...extra,
    },
  });

  it("teaches a bounded wait and economical shared work after a capable participant read", async () => {
    const env = providerEnv(
      roomConfig({
        observedStateRevision: "10",
        coordinationStateCapability: "experimental",
      }),
    );
    let stdout = "";
    const code = await runRoomCli(["read", "--snapshot"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          status: "open",
          role: "participant",
          state_revision: "10",
          brief: "No question is open.",
          decision: null,
          discussion: [],
          working_signals: [],
          actions: [],
          artifacts: [],
        }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Wait for what's next: grp watch --timeout=300");
    expect(stdout).toContain("Coordinate work:");
    expect(stdout).toContain('grp act start --title="Describe the work"');
    expect(stdout).toContain("grp watch --action=ACTION_ID");
    expect(stdout).toContain(
      'grp artifact create --name="Shared output" --action=ACTION_ID --file=PATH',
    );
    expect(stdout).not.toContain("grp working start");
    expect(stdout).not.toContain("--lock=enforced");
    expect(stdout).not.toContain("exact reviews");
    expect(stdout).not.toContain("finalization");
  });

  it("keeps shared-work and active-editor guidance visible after a decision resolves", async () => {
    const env = providerEnv(
      roomConfig({
        observedStateRevision: "10",
        coordinationStateCapability: "experimental",
      }),
    );
    let stdout = "";
    const code = await runRoomCli(["read", "--snapshot"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          status: "resolved",
          role: "participant",
          state_revision: "10",
          brief: 'Decided: "Divert".',
          discussion: [],
          working_signals: [
            {
              display_name: "Silica",
              kind: "drafting",
              scope: { kind: "artifact", id: "artifact_1" },
              summary: "Revising current artifact",
              expires_at: "2026-08-21T20:00:00Z",
            },
          ],
          actions: [],
          artifacts: [
            {
              id: "artifact_1",
              revision: "2",
              name: "Shared output",
              current_revision_id: "artifact_revision_1",
              status: "open",
              review_status: { current: [], superseded: [] },
            },
          ],
        }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Working now:");
    expect(stdout).toContain("Silica — drafting artifact artifact_1: Revising current artifact");
    expect(stdout).toContain("Coordinate work:");
    expect(stdout).not.toContain('artifact create --name="Shared output"');
  });

  it("does not advertise candidate presence on a feature-off host", async () => {
    const env = providerEnv(roomConfig({ coordinationStateCapability: "absent" }));
    let stdout = "";
    const code = await runRoomCli(["read", "--snapshot"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          status: "open",
          role: "participant",
          brief: "No question is open.",
          decision: null,
          discussion: [],
        }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).not.toContain("Coordinate work:");
    expect(stdout).not.toContain("grp working start");
    expect(stdout).not.toContain("grp artifact create");
  });

  it("does not repeat artifact creation guidance after a shared artifact exists", async () => {
    const env = providerEnv(
      roomConfig({
        observedStateRevision: "10",
        coordinationStateCapability: "experimental",
      }),
    );
    let stdout = "";
    const code = await runRoomCli(["read", "--snapshot"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async () =>
        jsonResponse({
          slug: "abc123",
          status: "open",
          role: "participant",
          state_revision: "10",
          brief: "No question is open.",
          decision: null,
          discussion: [],
          working_signals: [],
          actions: [],
          artifacts: [
            {
              id: "artifact_1",
              revision: "1",
              name: "Shared output",
              current_revision_id: "revision_1",
              baton_mode: "none",
              claim: null,
              review_status: { current: [], superseded: [] },
            },
          ],
        }),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Shared artifacts:");
    expect(stdout).toContain("artifact_1 [rev 1]");
    expect(stdout).not.toContain("Canonical resource only when that action needs one:");
    expect(stdout).not.toContain('artifact create --name="Shared output"');
  });

  it("does not infer artifact intent from a document-shaped proposal", async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "grp-spec224-proposal-"));
    const file = pathJoin(dir, "term-sheet.md");
    writeFileSync(file, "# Shared draft\n\n1. Economics\n2. Governance\n", "utf8");
    const env = providerEnv(
      roomConfig({
        observedStateRevision: "10",
        coordinationStateCapability: "experimental",
      }),
    );
    let stdout = "";
    const code = await runRoomCli(["propose", `--file=${file}`], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: withCoordinationDiscovery(async () =>
        jsonResponse({
          accepted: true,
          options: ["# Shared draft"],
          choosing_open: true,
          state_revision: "11",
        }),
      ),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain('Option proposed: "# Shared draft');
    expect(stdout).not.toContain("grp artifact create");
    expect(stdout).not.toContain("artifact id + revision id + SHA-256 descriptor");
  });

  it("stores a room-wide observation independently while a focused read stores neither marker", async () => {
    const env = providerEnv(roomConfig({ observedStateRevision: "opaque-old" }));
    const response = {
      slug: "abc123",
      state_revision: "opaque-new",
      current_through: 12,
      status: "open",
      brief: "No decision is open.",
      decisions: [],
    };

    expect(
      await runRoomCli(["read", "--json"], {
        stdout: () => {},
        stderr: () => {},
        fetch: async () => jsonResponse(response),
        env,
      }),
    ).toBe(0);
    let saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom).toEqual(
      expect.objectContaining({
        lastSeenSeq: 12,
        observedStateRevision: "opaque-new",
        coordinationStateCapability: "experimental",
      }),
    );

    expect(
      await runRoomCli(["read", "--decision=1", "--json"], {
        stdout: () => {},
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            state_revision: "must-not-be-observed",
            decisions: [{ id: "d_1", seq: 1, question: "Focused?", status: "open" }],
            discussion: [],
            participants: [],
          }),
        env,
      }),
    ).toBe(0);
    saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom).toEqual(
      expect.objectContaining({ lastSeenSeq: 12, observedStateRevision: "opaque-new" }),
    );
  });

  it("requires a fresh room read before the first write to a capable host", async () => {
    const env = providerEnv(roomConfig());
    let mutationCalls = 0;
    let stderr = "";
    const code = await runRoomCli(["discuss", "hello"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: withCoordinationDiscovery(async () => {
        mutationCalls += 1;
        return jsonResponse({ ok: true });
      }),
      env,
    });

    expect(code).toBe(1);
    expect(mutationCalls).toBe(0);
    expect(stderr).toContain("fresh room read before guarded writes");
    expect(stderr).toContain("Run: grp read");
    expect(JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8")).currentRoom).toEqual(
      expect.objectContaining({ coordinationStateCapability: "experimental" }),
    );
  });

  it("live discovery detects a downgrade and clears the obsolete guard token", async () => {
    const env = providerEnv(
      roomConfig({
        observedStateRevision: "41",
        coordinationStateCapability: "experimental",
      }),
    );
    let mutationHeader: string | null = "not-called";
    const code = await runRoomCli(["discuss", "legacy after downgrade"], {
      stdout: () => {},
      stderr: () => {},
      fetch: withCoordinationDiscovery(async (input, init) => {
        mutationHeader = new Request(input, init).headers.get("x-grp-expected-room-revision");
        return jsonResponse({ ok: true, id: "m_legacy" });
      }, false),
      env,
    });

    expect(code).toBe(0);
    expect(mutationHeader).toBeNull();
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8")).currentRoom;
    expect(saved.coordinationStateCapability).toBe("absent");
    expect(saved.observedStateRevision).toBeUndefined();
  });

  it("guards authored content and advances only the observation returned by a guarded success", async () => {
    const env = providerEnv(roomConfig({ observedStateRevision: "41" }));
    let expectedHeader: string | null = null;
    expect(
      await runRoomCli(["discuss", "hello"], {
        stdout: () => {},
        stderr: () => {},
        fetch: withCoordinationDiscovery(async (input, init) => {
          expectedHeader = new Request(input, init).headers.get("x-grp-expected-room-revision");
          return jsonResponse({ ok: true, id: "m_1", state_revision: "42" });
        }),
        env,
      }),
    ).toBe(0);
    expect(expectedHeader).toBe("41");
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom).toEqual(
      expect.objectContaining({ lastSeenSeq: 8, observedStateRevision: "42" }),
    );
  });

  it("does not launder unseen room state returned by an unguarded resource claim", async () => {
    const env = providerEnv(roomConfig({ observedStateRevision: "9" }));
    let expectedHeader: string | null = "not-called";
    expect(
      await runRoomCli(["artifact", "claim", "artifact-1", "--revision=3", "--ttl=30", "--json"], {
        stdout: () => {},
        stderr: () => {},
        fetch: async (input, init) => {
          expectedHeader = new Request(input, init).headers.get("x-grp-expected-room-revision");
          return jsonResponse({
            artifact: { id: "artifact-1", revision: "4" },
            state_revision: "11",
          });
        },
        env,
      }),
    ).toBe(0);
    expect(expectedHeader).toBeNull();
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom).toEqual(
      expect.objectContaining({ lastSeenSeq: 8, observedStateRevision: "9" }),
    );
  });

  it("labels external Git references as asserted instead of implying provider verification", async () => {
    const env = providerEnv(roomConfig({ observedStateRevision: "9" }));
    let body: Record<string, unknown> | null = null;
    expect(
      await runRoomCli(
        [
          "artifact",
          "create",
          "--name=README snapshot",
          "--kind=external",
          "--external-provider=git",
          "--uri=https://github.com/example/private.git",
          "--path=README.md",
          "--provider-revision=9d1633911860c39a61ae982e57c5270bf60c0b14",
          "--sha256=3e87a40800359fa8fe7fc5c94b1c59b2882bd3e75f828fefff31472277e5052c",
          "--json",
        ],
        {
          stdout: () => {},
          stderr: () => {},
          fetch: withCoordinationDiscovery(async (input, init) => {
            body = JSON.parse(await new Request(input, init).text()) as Record<string, unknown>;
            return jsonResponse({ artifact: { id: "artifact-1" }, state_revision: "10" });
          }),
          env,
        },
      ),
    ).toBe(0);
    expect(body).toMatchObject({
      kind: "external",
      external: {
        provider: "git",
        uri: "https://github.com/example/private.git",
        path: "README.md",
        provider_revision: "9d1633911860c39a61ae982e57c5270bf60c0b14",
        verification: "asserted",
      },
    });
  });

  it("rejects credential-bearing external references before any request leaves the process", async () => {
    for (const uri of [
      "https://alice:secret@github.com/example/private.git",
      "https://github.com/example/private.git?token=secret",
    ]) {
      const env = providerEnv(roomConfig({ observedStateRevision: "9" }));
      let fetchCalls = 0;
      let stderr = "";
      const code = await runRoomCli(
        [
          "artifact",
          "create",
          "--name=unsafe reference",
          "--kind=external",
          "--external-provider=git",
          `--uri=${uri}`,
          "--path=README.md",
          "--provider-revision=9d1633911860c39a61ae982e57c5270bf60c0b14",
          "--sha256=3e87a40800359fa8fe7fc5c94b1c59b2882bd3e75f828fefff31472277e5052c",
        ],
        {
          stdout: () => {},
          stderr: (text) => {
            stderr += text;
          },
          fetch: async () => {
            fetchCalls += 1;
            return jsonResponse({});
          },
          env,
        },
      );
      expect(code).toBe(1);
      expect(fetchCalls).toBe(0);
      expect(stderr).toContain("credential-free HTTPS without query or fragment");
    }
  });

  it("sends an explicit idempotency key alongside the room revision guard", async () => {
    const env = providerEnv(roomConfig({ observedStateRevision: "41" }));
    let headers = new Headers();
    expect(
      await runRoomCli(["action", "create", "--title=Draft", "--idempotency-key=trial-action-1"], {
        stdout: () => {},
        stderr: () => {},
        fetch: withCoordinationDiscovery(async (input, init) => {
          headers = new Request(input, init).headers;
          return jsonResponse({ action: { id: "action_1", revision: "1" }, state_revision: "42" });
        }),
        env,
      }),
    ).toBe(0);
    expect(headers.get("idempotency-key")).toBe("trial-action-1");
    expect(headers.get("x-grp-expected-room-revision")).toBe("41");
  });

  it("offers one payload-bound stale recovery only after a read and a second rejection", async () => {
    const env = providerEnv(roomConfig({ observedStateRevision: "41" }));
    let currentRevision = "45";
    let guardedWrites = 0;
    let forcedWrites = 0;
    const fetch = withCoordinationDiscovery(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        return jsonResponse({ state_revision: currentRevision, brief: "Fresh room state." });
      }
      const expected = request.headers.get("x-grp-expected-room-revision");
      if (expected) {
        guardedWrites += 1;
        return jsonResponse(
          {
            error: {
              code: "state.precondition_failed",
              message: "room changed",
              details: {
                expected_state_revision: expected,
                current_state_revision: currentRevision,
                posted: false,
              },
            },
          },
          412,
        );
      }
      forcedWrites += 1;
      return jsonResponse({ accepted: true, options: [], state_revision: "47" });
    });

    let stderr = "";
    expect(
      await runRoomCli(["propose", "new plan"], {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch,
        env,
      }),
    ).toBe(1);
    expect(stderr).toContain("Next: grp read");
    expect(stderr).not.toContain("--force-stale-post");

    let preemptive = "";
    expect(
      await runRoomCli(["propose", "new plan", "--force-stale-post"], {
        stdout: () => {},
        stderr: (text) => {
          preemptive += text;
        },
        fetch,
        env,
      }),
    ).toBe(1);
    expect(preemptive).toContain("read the room before using --force-stale-post");

    expect(
      await runRoomCli(["read", "--json"], {
        stdout: () => {},
        stderr: () => {},
        fetch,
        env,
      }),
    ).toBe(0);

    currentRevision = "46";
    stderr = "";
    expect(
      await runRoomCli(["propose", "new plan"], {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch,
        env,
      }),
    ).toBe(1);
    expect(stderr).toContain("--force-stale-post");

    let wrongPayload = "";
    expect(
      await runRoomCli(["propose", "different plan", "--force-stale-post"], {
        stdout: () => {},
        stderr: (text) => {
          wrongPayload += text;
        },
        fetch,
        env,
      }),
    ).toBe(1);
    expect(wrongPayload).toContain("exact rejected command payload");

    expect(
      await runRoomCli(["propose", "new plan", "--force-stale-post"], {
        stdout: () => {},
        stderr: () => {},
        fetch,
        env,
      }),
    ).toBe(0);
    expect(guardedWrites).toBe(2);
    expect(forcedWrites).toBe(1);

    let reused = "";
    expect(
      await runRoomCli(["propose", "new plan", "--force-stale-post"], {
        stdout: () => {},
        stderr: (text) => {
          reused += text;
        },
        fetch,
        env,
      }),
    ).toBe(1);
    expect(reused).toContain("available only after this exact payload was rejected stale");
    expect(readFileSync(String(env.GRP_CONFIG), "utf8")).not.toContain("new plan");
  });

  it("emits structured stale-write evidence and does not claim a guard on legacy hosts", async () => {
    const guardedEnv = providerEnv(roomConfig({ observedStateRevision: "41" }));
    let stdout = "";
    expect(
      await runRoomCli(["ask", "Continue?", "--json"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: withCoordinationDiscovery(async () =>
          jsonResponse(
            {
              error: {
                code: "state.precondition_failed",
                message: "room changed",
                details: {
                  expected_state_revision: "41",
                  current_state_revision: "45",
                  posted: false,
                },
              },
            },
            412,
          ),
        ),
        env: guardedEnv,
      }),
    ).toBe(1);
    expect(JSON.parse(stdout)).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: "state.precondition_failed",
          details: {
            expected_state_revision: "41",
            current_state_revision: "45",
            posted: false,
          },
        }),
        suggested_command: "grp read",
      }),
    );

    const legacyEnv = providerEnv(roomConfig());
    let legacyHeader: string | null = "not-called";
    expect(
      await runRoomCli(["discuss", "legacy safe"], {
        stdout: () => {},
        stderr: () => {},
        fetch: withCoordinationDiscovery(async (input, init) => {
          legacyHeader = new Request(input, init).headers.get("x-grp-expected-room-revision");
          return jsonResponse({ ok: true, id: "m_legacy" });
        }, false),
        env: legacyEnv,
      }),
    ).toBe(0);
    expect(legacyHeader).toBeNull();
  });

  it("drives working signals and guarded resource transitions with exact wire tokens", async () => {
    const env = providerEnv(roomConfig({ observedStateRevision: "41" }));
    const requests: Array<{
      method: string;
      path: string;
      header: string | null;
      body: Record<string, unknown>;
    }> = [];
    const fetch = withCoordinationDiscovery(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = new Request(input, init);
        const body = request.body ? ((await request.json()) as Record<string, unknown>) : {};
        requests.push({
          method: request.method,
          path: new URL(request.url).pathname,
          header: request.headers.get("x-grp-expected-room-revision"),
          body,
        });
        if (request.url.endsWith("/working-signals")) {
          return jsonResponse({
            working_signal: { id: "signal_1" },
            lease_token: "lease_1",
          });
        }
        if (request.url.endsWith("/actions")) {
          return jsonResponse({ action: { id: "action_1", revision: "1" }, state_revision: "42" });
        }
        return jsonResponse({
          artifact: { id: "artifact_1", revision: "4" },
          revision: { id: "artifact_revision_2" },
          state_revision: "43",
        });
      },
    );

    expect(
      await runRoomCli(
        [
          "working",
          "start",
          "--kind=drafting",
          "--scope=artifact",
          "--scope-id=artifact_1",
          "--summary=Editing exact bytes",
          "--ttl=120",
        ],
        { stdout: () => {}, stderr: () => {}, fetch, env },
      ),
    ).toBe(0);
    expect(
      await runRoomCli(["action", "create", "--title=Draft", "--lock=enforced"], {
        stdout: () => {},
        stderr: () => {},
        fetch,
        env,
      }),
    ).toBe(0);
    expect(
      await runRoomCli(
        [
          "artifact",
          "publish",
          "artifact_1",
          "--revision=3",
          "--base-revision=artifact_revision_1",
          "--epoch=7",
          "--content=Revised bytes",
        ],
        { stdout: () => {}, stderr: () => {}, fetch, env },
      ),
    ).toBe(0);

    expect(requests).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/api/rooms/abc123/working-signals",
        header: null,
        body: expect.objectContaining({
          kind: "drafting",
          scope: { kind: "artifact", id: "artifact_1" },
          ttl_seconds: 120,
        }),
      }),
      expect.objectContaining({
        method: "POST",
        path: "/api/rooms/abc123/actions",
        header: "41",
        body: expect.objectContaining({ title: "Draft", baton_mode: "enforced" }),
      }),
      expect.objectContaining({
        method: "POST",
        path: "/api/rooms/abc123/artifacts/artifact_1/revisions",
        header: "42",
        body: expect.objectContaining({
          expected_revision: "3",
          base_revision_id: "artifact_revision_1",
          claim_epoch: "7",
          sync_content: "Revised bytes",
        }),
      }),
    ]);
    expect(
      JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8")).currentRoom.observedStateRevision,
    ).toBe("43");
  });

  it("makes native whole-snapshot replacement explicit with --rewrite", async () => {
    const env = providerEnv(roomConfig({ observedStateRevision: "41" }));
    let body: Record<string, unknown> = {};
    expect(
      await runRoomCli(
        [
          "artifact",
          "publish",
          "artifact_1",
          "--revision=3",
          "--base-revision=artifact_revision_1",
          "--content=Replacement bytes",
          "--rewrite",
        ],
        {
          stdout: () => {},
          stderr: () => {},
          fetch: withCoordinationDiscovery(async (_input, init) => {
            body = JSON.parse(String(init?.body));
            return jsonResponse({
              artifact: { id: "artifact_1", revision: "4" },
              revision: { id: "artifact_revision_2" },
              state_revision: "42",
            });
          }),
          env,
        },
      ),
    ).toBe(0);
    expect(body).toMatchObject({
      expected_revision: "3",
      base_revision_id: "artifact_revision_1",
      content: "Replacement bytes",
    });
    expect(body).not.toHaveProperty("sync_content");
  });

  it("leaves external Git revisions provider-owned and refuses native rewrite semantics", async () => {
    const env = providerEnv(roomConfig({ observedStateRevision: "41" }));
    let body: Record<string, unknown> = {};
    const fetch = withCoordinationDiscovery(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({
        artifact: { id: "artifact_git", revision: "4" },
        revision: { id: "artifact_revision_git" },
        state_revision: "42",
      });
    });
    expect(
      await runRoomCli(
        [
          "artifact",
          "publish",
          "artifact_git",
          "--revision=3",
          "--base-revision=artifact_revision_1",
          "--external-provider=git",
          "--uri=https://github.com/example/project",
          "--path=resolution.md",
          "--provider-revision=0123456789abcdef0123456789abcdef01234567",
          `--sha256=${"ab".repeat(32)}`,
        ],
        { stdout: () => {}, stderr: () => {}, fetch, env },
      ),
    ).toBe(0);
    expect(body).toMatchObject({
      base_revision_id: "artifact_revision_1",
      external: {
        provider: "git",
        uri: "https://github.com/example/project",
        path: "resolution.md",
        provider_revision: "0123456789abcdef0123456789abcdef01234567",
        verification: "asserted",
      },
    });
    expect(body).not.toHaveProperty("content");
    expect(body).not.toHaveProperty("sync_content");

    let stderr = "";
    expect(
      await runRoomCli(
        [
          "artifact",
          "publish",
          "artifact_git",
          "--revision=3",
          "--base-revision=artifact_revision_1",
          "--external-provider=git",
          "--uri=https://github.com/example/project",
          "--provider-revision=0123456789abcdef0123456789abcdef01234567",
          `--sha256=${"ab".repeat(32)}`,
          "--rewrite",
        ],
        {
          stdout: () => {},
          stderr: (text) => {
            stderr += text;
          },
          fetch,
          env,
        },
      ),
    ).toBe(1);
    expect(stderr).toContain("--rewrite applies only to native artifacts");
  });

  it("asks for explicit chat intent before substantial discussion regardless of transport", async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "grp-substantial-discussion-"));
    const file = pathJoin(dir, "shared-work.txt");
    writeFileSync(file, "f".repeat(10_001), "utf8");

    for (const testCase of [
      { argv: ["discuss", `--body=${"b".repeat(10_001)}`], stdin: undefined },
      { argv: ["discuss", "-"], stdin: Readable.from(["s".repeat(10_001)]) },
      { argv: ["discuss", `--file=${file}`], stdin: undefined },
    ]) {
      let stderr = "";
      let fetches = 0;
      expect(
        await runRoomCli(testCase.argv, {
          stdout: () => {},
          stderr: (text) => {
            stderr += text;
          },
          ...(testCase.stdin ? { stdin: testCase.stdin } : {}),
          fetch: async () => {
            fetches += 1;
            return jsonResponse({});
          },
          env: providerEnv(roomConfig({ observedStateRevision: "41" })),
        }),
      ).toBe(1);
      expect(fetches).toBe(0);
      expect(stderr).toContain("This discussion is 10,001 characters.");
      expect(stderr).toContain("preserve one exact version through an action and artifact");
      expect(stderr).toContain("Continue as intentional discussion: add --as-discussion");
      expect(stderr).toContain("Structured shared work: grp act --help");
    }
  });

  it("keeps the threshold a soft confirmation distinct from room freshness", async () => {
    const env = providerEnv(
      roomConfig({
        observedStateRevision: "41",
        coordinationStateCapability: "experimental",
      }),
    );
    const postedBodies: string[] = [];
    const fetch = withCoordinationDiscovery(async (input, init) => {
      const request = new Request(input, init);
      postedBodies.push(String(((await request.json()) as { body: string }).body));
      return jsonResponse({ ok: true, id: "message_1", state_revision: "42" });
    });

    expect(
      await runRoomCli(["discuss", `--body=${"x".repeat(10_000)}`], {
        stdout: () => {},
        stderr: () => {},
        fetch,
        env,
      }),
    ).toBe(0);
    expect(postedBodies).toEqual(["x".repeat(10_000)]);

    let postAnywayError = "";
    let postAnywayFetches = 0;
    expect(
      await runRoomCli(["discuss", `--body=${"y".repeat(10_001)}`, "--force-stale-post"], {
        stdout: () => {},
        stderr: (text) => {
          postAnywayError += text;
        },
        fetch: async () => {
          postAnywayFetches += 1;
          return jsonResponse({});
        },
        env,
      }),
    ).toBe(1);
    expect(postAnywayFetches).toBe(0);
    expect(postAnywayError).toContain("add --as-discussion");

    const noReadEnv = providerEnv(
      roomConfig({ observedStateRevision: undefined, coordinationStateCapability: "experimental" }),
    );
    let asDiscussionError = "";
    let writes = 0;
    expect(
      await runRoomCli(["discuss", `--body=${"z".repeat(10_001)}`, "--as-discussion"], {
        stdout: () => {},
        stderr: (text) => {
          asDiscussionError += text;
        },
        fetch: withCoordinationDiscovery(async (_input, init) => {
          if (init?.method === "POST") writes += 1;
          return jsonResponse({});
        }),
        env: noReadEnv,
      }),
    ).toBe(1);
    expect(writes).toBe(0);
    expect(asDiscussionError).toContain("requires a fresh room read");
  });

  it("explains discussion intent without coaching long shared work into chat", async () => {
    let stdout = "";
    expect(
      await runRoomCli(["discuss", "--help"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () => {
          throw new Error("help must not fetch");
        },
        env: providerEnv(roomConfig()),
      }),
    ).toBe(0);
    expect(stdout).toContain("Discussion creates no formal outcome.");
    expect(stdout).toContain("For shell-sensitive discussion, use --file=PATH or stdin.");
    expect(stdout).toContain("use an action with an artifact: grp act --help");
    expect(stdout).toContain("--as-discussion");
    expect(stdout).not.toContain("Long or shell-sensitive messages");
  });

  it("renders the enforced lock, exact review, and decision descriptor after mutations", async () => {
    const env = providerEnv(roomConfig({ observedStateRevision: "41" }));
    let stderr = "";
    const digest = "ab".repeat(32);
    const fetch = withCoordinationDiscovery(async (input) => {
      const pathname = new URL(new Request(input).url).pathname;
      if (pathname.endsWith("/working-signals")) {
        return jsonResponse({
          working_signal: { id: "signal_1" },
          lease_token: "lease_1",
        });
      }
      if (pathname.endsWith("/actions")) {
        return jsonResponse({
          action: { id: "action_1", revision: "2", baton_mode: "enforced" },
          state_revision: "42",
        });
      }
      if (pathname.endsWith("/artifacts")) {
        return jsonResponse({
          artifact: { id: "artifact_1", revision: "3", baton_mode: "enforced" },
          current_revision: { id: "artifact_revision_1", sha256: digest },
          state_revision: "43",
        });
      }
      return jsonResponse({
        artifact: { id: "artifact_1", revision: "4" },
        revision: { id: "artifact_revision_2", sha256: digest },
        state_revision: "44",
      });
    });
    const io = {
      stdout: () => {},
      stderr: (text: string) => {
        stderr += text;
      },
      fetch,
      env,
    };

    expect(
      await runRoomCli(
        ["working", "start", "--kind=drafting", "--scope=room", "--summary=Drafting"],
        io,
      ),
    ).toBe(0);
    expect(await runRoomCli(["action", "create", "--title=Draft", "--lock=enforced"], io)).toBe(0);
    expect(
      await runRoomCli(
        ["artifact", "create", "--name=Joint draft", "--content=Initial", "--lock=enforced"],
        io,
      ),
    ).toBe(0);
    expect(
      await runRoomCli(
        [
          "artifact",
          "publish",
          "artifact_1",
          "--revision=3",
          "--base-revision=artifact_revision_1",
          "--content=Revised",
        ],
        io,
      ),
    ).toBe(0);

    expect(stderr).toContain("Working signal active: signal_1");
    expect(stderr).toContain("grp working stop signal_1 --lease=lease_1");
    expect(stderr).toContain("Durable action created: action_1 at resource revision 2");
    expect(stderr).toContain("grp action claim action_1 --revision=2");
    expect(stderr).toContain("Canonical shared artifact created: artifact_1");
    expect(stderr).toContain("grp artifact claim artifact_1 --revision=3");
    expect(stderr).toContain("grp artifact review artifact_1 artifact_revision_2");
    expect(stderr).toContain(
      `artifact artifact_1, revision artifact_revision_2, SHA-256 ${digest}`,
    );
  });

  it("renders the exact reread and terminal handoff after action and artifact claims", async () => {
    const env = providerEnv(roomConfig({ observedStateRevision: "41" }));
    let stderr = "";
    const fetch = withCoordinationDiscovery(async (input) => {
      const pathname = new URL(new Request(input).url).pathname;
      if (pathname.includes("/actions/")) {
        return jsonResponse({
          action: {
            id: "action_1",
            revision: "3",
            claim: { epoch: "7" },
          },
          state_revision: "42",
        });
      }
      return jsonResponse({
        artifact: {
          id: "artifact_1",
          revision: "4",
          current_revision_id: "artifact_revision_1",
          claim: { epoch: "8" },
        },
        state_revision: "43",
      });
    });
    const io = {
      stdout: () => {},
      stderr: (text: string) => {
        stderr += text;
      },
      fetch,
      env,
    };

    expect(await runRoomCli(["action", "claim", "action_1", "--revision=2"], io)).toBe(0);
    expect(await runRoomCli(["artifact", "claim", "artifact_1", "--revision=3"], io)).toBe(0);

    expect(stderr).toContain(
      "Action enforced lock acquired: action_1 at resource revision 3, claim epoch 7",
    );
    expect(stderr).toContain("Before reporting completion: grp read");
    expect(stderr).toContain("Before publishing: grp read");
    expect(stderr).toContain("grp action complete action_1 --revision=3 --epoch=7");
    expect(stderr).toContain("Completion records the participant's report");
    expect(stderr).toContain("optional --result-text=TEXT");
    expect(stderr).toContain(
      "Artifact enforced editing lock acquired: artifact_1 at resource revision 4, claim epoch 8",
    );
    expect(stderr).toContain(
      "grp artifact publish artifact_1 --revision=4 --base-revision=artifact_revision_1 --epoch=8 --file=PATH",
    );
    expect(stderr).toContain("grp artifact release artifact_1 --epoch=8");
  });

  it("builds a typed exact-artifact action result without hand-authored JSON", async () => {
    const env = providerEnv(roomConfig({ observedStateRevision: "41" }));
    let body: Record<string, unknown> = {};
    expect(
      await runRoomCli(
        [
          "action",
          "complete",
          "action_1",
          "--revision=3",
          "--epoch=7",
          "--result-artifact=artifact_1",
          "--result-revision=artifact_revision_2",
          `--result-sha256=${"ab".repeat(32)}`,
        ],
        {
          stdout: () => {},
          stderr: () => {},
          fetch: withCoordinationDiscovery(async (_input, init) => {
            body = JSON.parse(String(init?.body));
            return jsonResponse({
              action: { id: "action_1", revision: "4", status: "completed" },
              state_revision: "42",
            });
          }),
          env,
        },
      ),
    ).toBe(0);
    expect(body).toEqual({
      expected_revision: "3",
      claim_epoch: "7",
      result: {
        kind: "artifact_revision",
        reference: {
          artifact_id: "artifact_1",
          revision_id: "artifact_revision_2",
          sha256: "ab".repeat(32),
        },
      },
    });
  });

  it("reports an action complete without requiring a result payload", async () => {
    const env = providerEnv(roomConfig({ observedStateRevision: "41" }));
    let body: Record<string, unknown> = {};
    expect(
      await runRoomCli(["action", "complete", "action_1", "--revision=3"], {
        stdout: () => {},
        stderr: () => {},
        fetch: withCoordinationDiscovery(async (_input, init) => {
          body = JSON.parse(String(init?.body));
          return jsonResponse({
            action: { id: "action_1", revision: "4", status: "completed", result: null },
            state_revision: "42",
          });
        }),
        env,
      }),
    ).toBe(0);
    expect(body).toEqual({ expected_revision: "3" });
  });

  it("rejects generic JSON action results before any request leaves the process", async () => {
    const env = providerEnv(roomConfig({ observedStateRevision: "41" }));
    let fetchCalls = 0;
    let stderr = "";
    const code = await runRoomCli(
      [
        "action",
        "complete",
        "action_1",
        "--revision=3",
        '--result-json={"kind":"external_task","reference":{"token":"secret"}}',
      ],
      {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch: async () => {
          fetchCalls += 1;
          return jsonResponse({});
        },
        env,
      },
    );

    expect(code).toBe(1);
    expect(fetchCalls).toBe(0);
    expect(stderr).toContain("grp action: unknown flag --result-json");
  });

  it("renders bounded working, action, and artifact state in ordinary reads", async () => {
    const env = providerEnv(roomConfig());
    let stdout = "";
    expect(
      await runRoomCli(["read", "--snapshot"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            slug: "abc123",
            status: "open",
            brief: "No question is open.",
            current_through: 8,
            working_signals: [
              {
                display_name: "Cobalt",
                participant_id: "p_2",
                kind: "drafting",
                scope: { kind: "artifact", id: "artifact_1" },
                summary: "Updating the redline",
                expires_at: "2026-08-20T05:00:00Z",
              },
            ],
            actions: [
              {
                id: "action_1",
                revision: "2",
                status: "in_progress",
                title: "Draft",
                baton_mode: "enforced",
                claim: {
                  holder_id: "p_2",
                  epoch: "1",
                  expires_at: "2026-08-20T05:00:00Z",
                },
              },
              {
                id: "action_2",
                revision: "1",
                status: "open",
                title: "Research independently",
                baton_mode: "none",
                claim: null,
              },
            ],
            artifacts: [
              {
                id: "artifact_1",
                revision: "4",
                name: "Joint draft",
                current_revision_id: "artifact_revision_2",
                baton_mode: "enforced",
                claim: {
                  holder_id: "p_2",
                  epoch: "2",
                  expires_at: "2026-08-20T05:00:00Z",
                },
                review_status: {
                  current: [
                    {
                      display_name: "Argon",
                      disposition: "approve",
                      revision_id: "artifact_revision_2",
                    },
                  ],
                  superseded: [
                    {
                      display_name: "Cobalt",
                      disposition: "approve",
                      revision_id: "artifact_revision_1",
                    },
                  ],
                },
              },
            ],
          }),
        env,
      }),
    ).toBe(0);
    expect(stdout).toContain("Working now:");
    expect(stdout).toContain("Cobalt — drafting artifact artifact_1: Updating the redline");
    expect(stdout).toContain("action_1 [rev 2] in_progress — Draft");
    expect(stdout).toContain("action_2 [rev 1] open — Research independently; parallel (no lock)");
    expect(stdout).toContain("artifact_1 [rev 4] open — Joint draft; current artifact_revision_2");
    expect(stdout).toContain("current editor p_2");
    expect(stdout).not.toContain("LOCK");
    expect(stdout).not.toContain("artifact wait");
    expect(stdout.indexOf("current editor p_2")).toBeLessThan(stdout.indexOf("Next:"));
    expect(stdout).not.toContain("CURRENT reviews");
    expect(stdout).not.toContain("Superseded reviews");
  });

  it("renders native blocks and resolves a human block number to an exact atomic patch", async () => {
    const env = providerEnv(
      roomConfig({ observedStateRevision: "9", coordinationStateCapability: "experimental" }),
    );
    const digest = "ab".repeat(32);
    let stdout = "";
    let mutation: Record<string, unknown> | undefined;
    const exactResponse = {
      artifact: {
        id: "artifact_1",
        name: "Joint draft",
        revision: "4",
        baton_mode: "none",
        claim: null,
      },
      revision: {
        id: "artifact_revision_2",
        ordinal: 2,
        sha256: digest,
        content: "First.\n\nSecond.\n",
        blocks: [
          {
            id: "block_1",
            number: 1,
            kind: "paragraph",
            content: "First.",
            content_sha256: "11".repeat(32),
          },
          {
            id: "block_2",
            number: 2,
            kind: "paragraph",
            content: "Second.",
            content_sha256: "22".repeat(32),
          },
        ],
      },
      reviews: [],
    };
    const fetch = withCoordinationDiscovery(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST") {
        mutation = JSON.parse(String(init?.body));
        return jsonResponse({
          artifact: { id: "artifact_1", revision: "5", baton_mode: "none" },
          revision: { id: "artifact_revision_3", sha256: digest },
          state_revision: "10",
        });
      }
      return jsonResponse(exactResponse);
    });

    expect(
      await runRoomCli(["artifact", "read", "artifact_1"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch,
        env,
      }),
    ).toBe(0);
    expect(stdout).toContain("¶1 [paragraph; id block_1");
    expect(stdout).toContain("¶2 [paragraph; id block_2");
    expect(stdout).toContain("artifact replace artifact_1 N");
    expect(stdout).toContain(
      'working start --kind=drafting --scope=artifact --scope-id=artifact_1 --summary="Revising current artifact"',
    );
    expect(stdout).toContain("watch --artifact=artifact_1");
    expect(stdout).not.toContain("artifact wait");
    expect(stdout).toContain("this is not a lock");

    expect(
      await runRoomCli(
        [
          "artifact",
          "replace",
          "artifact_1",
          "2",
          "--revision=4",
          "--base-revision=artifact_revision_2",
          "--content=Second revised.",
        ],
        { stdout: () => {}, stderr: () => {}, fetch, env },
      ),
    ).toBe(0);
    expect(mutation).toEqual({
      expected_revision: "4",
      base_revision_id: "artifact_revision_2",
      operations: [
        {
          op: "replace",
          block_id: "block_2",
          expected_content_sha256: "22".repeat(32),
          content: "Second revised.",
        },
      ],
    });
  });

  it("supports multiline review bodies and makes historical review explicit", async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "grp-review-body-"));
    const bodyFile = pathJoin(dir, "review.md");
    writeFileSync(bodyFile, "Paragraph 2 needs a citation.\n\nOtherwise ready.\n", "utf8");
    const env = providerEnv(roomConfig());
    let body: Record<string, unknown> = {};
    let stderr = "";
    expect(
      await runRoomCli(
        [
          "artifact",
          "review",
          "artifact_1",
          "artifact_revision_1",
          "--disposition=comment",
          `--body-file=${bodyFile}`,
          "--historical",
        ],
        {
          stdout: () => {},
          stderr: (text) => {
            stderr += text;
          },
          fetch: withCoordinationDiscovery(async (_input, init) => {
            body = JSON.parse(String(init?.body));
            return jsonResponse({ review: { id: "review_1" }, state_revision: "10" });
          }),
          env,
        },
      ),
    ).toBe(0);
    expect(body).toMatchObject({
      disposition: "comment",
      body: "Paragraph 2 needs a citation.\n\nOtherwise ready.\n",
      historical: true,
    });
    expect(stderr).toContain(
      "Historical exact review recorded for artifact artifact_1, revision artifact_revision_1",
    );
    expect(stderr).not.toContain("--from-revision");
  });

  it("resource-amends the caller's existing exact-revision review without room-global contention", async () => {
    const env = providerEnv(
      roomConfig({
        participantId: "participant_1",
        observedStateRevision: "9",
        coordinationStateCapability: "experimental",
      }),
    );
    const requests: Request[] = [];
    let mutation: Record<string, unknown> = {};
    let stderr = "";
    expect(
      await runRoomCli(
        [
          "artifact",
          "review",
          "artifact_1",
          "artifact_revision_1",
          "--disposition=approve",
          "--body=Ready for principals.",
        ],
        {
          stdout: () => {},
          stderr: (text) => {
            stderr += text;
          },
          fetch: withCoordinationDiscovery(async (input, init) => {
            const request = new Request(input, init);
            requests.push(request);
            if (request.method === "GET") {
              return jsonResponse({
                artifact: { id: "artifact_1" },
                revision: { id: "artifact_revision_1" },
                reviews: [
                  {
                    reviewer_id: "participant_1",
                    revision: "3",
                    disposition: "comment",
                  },
                ],
              });
            }
            mutation = JSON.parse(String(init?.body));
            return jsonResponse({
              review: { id: "review_1", revision: "4", disposition: "approve" },
              state_revision: "10",
            });
          }),
          env,
        },
      ),
    ).toBe(0);
    expect(requests.map((request) => request.method)).toEqual(["GET", "PUT"]);
    expect(requests[0]?.url).toBe(
      "https://operator.example/api/rooms/abc123/artifacts/artifact_1?revision=artifact_revision_1",
    );
    expect(mutation).toMatchObject({
      disposition: "approve",
      body: "Ready for principals.",
      expected_review_revision: "3",
    });
    expect(requests[1]?.headers.get("x-grp-expected-room-revision")).toBeNull();
    expect(
      JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8")).currentRoom.observedStateRevision,
    ).toBe("9");
    expect(stderr).toContain(
      "Watch this artifact for its next state change: grp watch --artifact=artifact_1",
    );
    expect(stderr).not.toContain("artifact wait");
  });

  it("rejects --post-anyway for an exact-revision review because no room bypass is needed", async () => {
    const env = providerEnv(roomConfig());
    let calls = 0;
    let stderr = "";
    expect(
      await runRoomCli(
        [
          "artifact",
          "review",
          "artifact_1",
          "artifact_revision_1",
          "--disposition=approve",
          "--post-anyway",
        ],
        {
          stdout: () => {},
          stderr: (text) => {
            stderr += text;
          },
          fetch: async () => {
            calls += 1;
            return jsonResponse({});
          },
          env,
        },
      ),
    ).toBe(1);
    expect(calls).toBe(0);
    expect(stderr).toContain("unknown flag --post-anyway");
  });

  it("creates artifacts with optimistic exact-base editing and no lock by default", async () => {
    const env = providerEnv(
      roomConfig({ observedStateRevision: "9", coordinationStateCapability: "experimental" }),
    );
    let body: Record<string, unknown> = {};
    let stderr = "";
    expect(
      await runRoomCli(["artifact", "create", "--name=Joint draft", "--content=Initial"], {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch: withCoordinationDiscovery(async (_input, init) => {
          body = JSON.parse(String(init?.body));
          return jsonResponse({
            artifact: {
              id: "artifact_1",
              revision: "1",
              current_revision_id: "artifact_revision_1",
              status: "open",
              baton_mode: "none",
            },
            current_revision: {
              id: "artifact_revision_1",
              sha256: "ab".repeat(32),
            },
            state_revision: "10",
          });
        }),
        env,
      }),
    ).toBe(0);
    expect(body).not.toHaveProperty("baton_mode");
    expect(stderr).toContain("optimistic exact-base editing, no lock");
    expect(stderr).not.toContain("artifact claim");
    expect(stderr).not.toContain("artifact finalize");
  });

  it("rejects the legacy advisory baton instead of reviving courtesy-lock workflow", async () => {
    const env = providerEnv(
      roomConfig({ observedStateRevision: "9", coordinationStateCapability: "experimental" }),
    );
    let calls = 0;
    let stderr = "";
    const code = await runRoomCli(
      ["artifact", "create", "--name=Joint draft", "--content=Initial", "--baton=advisory"],
      {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch: async () => {
          calls += 1;
          return jsonResponse({});
        },
        env,
      },
    );
    expect(code).toBe(1);
    expect(calls).toBe(0);
    expect(stderr).toContain("advisory batons are no longer part of the normal workflow");
  });

  it("waits without mutating when an enforced lock is already available", async () => {
    const env = providerEnv(roomConfig());
    let stdout = "";
    let calls = 0;
    let requestedUrl = "";
    expect(
      await runRoomCli(["artifact", "wait", "artifact_1", "--timeout=1"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          calls += 1;
          requestedUrl = new Request(input, init).url;
          return jsonResponse({ artifact: { id: "artifact_1", claim: null } });
        },
        env,
      }),
    ).toBe(0);
    expect(calls).toBe(1);
    expect(new URL(requestedUrl).searchParams.get("view")).toBe("metadata");
    expect(stdout).toBe("Lock available for artifact artifact_1.\n");
  });

  it("returns an exact successor using artifact metadata only", async () => {
    const env = providerEnv(roomConfig());
    let stdout = "";
    let requestedUrl = "";
    expect(
      await runRoomCli(
        ["artifact", "wait", "artifact_1", "--from-revision=artifact_revision_1", "--timeout=1"],
        {
          stdout: (text) => {
            stdout += text;
          },
          stderr: () => {},
          fetch: async (input, init) => {
            requestedUrl = new Request(input, init).url;
            return jsonResponse({
              artifact: {
                id: "artifact_1",
                kind: "external",
                status: "open",
                current_revision_id: "artifact_revision_2",
              },
            });
          },
          env,
        },
      ),
    ).toBe(0);
    expect(new URL(requestedUrl).searchParams.get("view")).toBe("metadata");
    expect(stdout).toContain(
      "Artifact artifact_1 advanced from artifact_revision_1 to artifact_revision_2",
    );
    expect(stdout).toContain("grp artifact read artifact_1 --revision-id=artifact_revision_2");
  });

  it("ignores unchanged metadata until the exact artifact advances", async () => {
    vi.useFakeTimers();
    try {
      const env = providerEnv(roomConfig());
      let calls = 0;
      let stdout = "";
      const result = runRoomCli(
        ["artifact", "wait", "artifact_1", "--from-revision=artifact_revision_1", "--timeout=10"],
        {
          stdout: (text) => {
            stdout += text;
          },
          stderr: () => {},
          fetch: async () => {
            calls += 1;
            return jsonResponse({
              artifact: {
                id: "artifact_1",
                status: "open",
                current_revision_id: calls === 1 ? "artifact_revision_1" : "artifact_revision_2",
              },
            });
          },
          env,
        },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await result).toBe(0);
      expect(calls).toBe(2);
      expect(stdout).toContain("advanced from artifact_revision_1 to artifact_revision_2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an absent exact revision and invalid timeout before network access", async () => {
    const env = providerEnv(roomConfig());
    for (const args of [
      ["artifact", "wait", "artifact_1", "--from-revision"],
      ["artifact", "wait", "artifact_1", "--from-revision=artifact_revision_1", "--timeout=3601"],
    ]) {
      let calls = 0;
      expect(
        await runRoomCli(args, {
          stdout: () => {},
          stderr: () => {},
          fetch: async () => {
            calls += 1;
            return jsonResponse({});
          },
          env,
        }),
      ).toBe(1);
      expect(calls).toBe(0);
    }
  });
});

describe("spec 228 action-centered coordination", () => {
  const roomConfig = (extra: Record<string, unknown> = {}) => ({
    providers: {},
    currentRoom: {
      slug: "abc123",
      baseUrl: "https://operator.example",
      participantId: "p_northline",
      ...extra,
    },
  });

  const participants = [
    { id: "p_northline", display_name: "Northline" },
    { id: "p_cobalt", display_name: "Cobalt" },
  ];

  it("caches the coordination capability instead of rediscovering it before each guarded write", async () => {
    const env = providerEnv(
      roomConfig({
        token: "t_1",
        observedStateRevision: "41",
        coordinationStateCapability: "experimental",
      }),
    );
    let discoveryCalls = 0;
    let expectedHeader: string | null = null;
    expect(
      await runRoomCli(["discuss", "One guarded message"], {
        stdout: () => {},
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (new URL(request.url).pathname === "/.well-known/grp.json") {
            discoveryCalls += 1;
            return jsonResponse({});
          }
          expectedHeader = request.headers.get("x-grp-expected-room-revision");
          return jsonResponse({ ok: true, state_revision: "42" });
        },
        env,
      }),
    ).toBe(0);
    expect(discoveryCalls).toBe(0);
    expect(expectedHeader).toBe("41");
  });

  it("catches up once after a stale post without resending and only then arms the exact bypass", async () => {
    const env = providerEnv(
      roomConfig({
        token: "t_1",
        lastSeenSeq: 8,
        observedStateRevision: "41",
        coordinationStateCapability: "experimental",
      }),
    );
    let writes = 0;
    let reads = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        reads += 1;
        const event = 8 + reads;
        return jsonResponse({
          slug: "abc123",
          status: "open",
          brief: "No decision is open.",
          state_revision: String(44 + reads),
          current_through: event,
          page: { through_event: event, room_event: event, complete: true },
          new: [],
        });
      }
      writes += 1;
      if (writes <= 2) {
        return jsonResponse(
          {
            error: {
              code: "state.precondition_failed",
              message: "room changed",
              details: {
                expected_state_revision: request.headers.get("x-grp-expected-room-revision"),
                current_state_revision: String(44 + writes),
                posted: false,
              },
            },
          },
          412,
        );
      }
      return jsonResponse({ ok: true, state_revision: "47" });
    };

    let first = "";
    expect(
      await runRoomCli(["discuss", "Exact payload"], {
        stdout: () => {},
        stderr: (text) => {
          first += text;
        },
        fetch,
        env,
      }),
    ).toBe(1);
    expect(writes).toBe(1);
    expect(reads).toBe(1);
    expect(first).toContain("COMPLETE CATCH-UP");
    expect(first).toContain("NOT POSTED — no automatic retry was attempted");
    expect(first).not.toContain("--force-stale-post");

    let second = "";
    expect(
      await runRoomCli(["discuss", "Exact payload"], {
        stdout: () => {},
        stderr: (text) => {
          second += text;
        },
        fetch,
        env,
      }),
    ).toBe(1);
    expect(writes).toBe(2);
    expect(reads).toBe(2);
    expect(second).toContain("--force-stale-post");

    expect(
      await runRoomCli(["discuss", "Exact payload", "--force-stale-post"], {
        stdout: () => {},
        stderr: () => {},
        fetch,
        env,
      }),
    ).toBe(0);
    expect(writes).toBe(3);
    expect(reads).toBe(2);
  });

  it("renders durable action review history and filters one exact version", async () => {
    const env = providerEnv(roomConfig({ token: "t_1" }));
    let stdout = "";
    expect(
      await runRoomCli(["act", "reviews", "act_1", "--version=2"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input) => {
          const url = new URL(String(input));
          const pathname = url.pathname;
          if (pathname.endsWith("/actions/act_1") && url.searchParams.get("reviews") === "1") {
            return jsonResponse({
              action: { id: "act_1" },
              rounds: [
                {
                  event: 20,
                  revision: { id: "rev_1", ordinal: 1, sha256: "a".repeat(64) },
                  reviews: [
                    {
                      reviewer_id: "p_cobalt",
                      reviewer_name: "Cobalt",
                      disposition: "changes_requested",
                      body: "Old concern",
                    },
                  ],
                },
                {
                  event: 30,
                  revision: { id: "rev_2", ordinal: 2, sha256: "b".repeat(64) },
                  reviews: [
                    {
                      reviewer_id: "p_cobalt",
                      reviewer_name: "Cobalt",
                      disposition: "approve",
                      body: "Concern resolved",
                    },
                  ],
                },
              ],
            });
          }
          return jsonResponse({ action: { id: "act_1", revision: "7" } });
        },
        env,
      }),
    ).toBe(0);
    expect(stdout).toContain("Artifact version 2 — revision rev_2; requested at event 30");
    expect(stdout).toContain("Cobalt — approve");
    expect(stdout).toContain("Concern resolved");
    expect(stdout).not.toContain("Old concern");
  });

  it("publishes only bounded chat-composing presence", async () => {
    const env = providerEnv(roomConfig());
    let postedBody: unknown;
    let stdout = "";
    expect(
      await runRoomCli(["discuss", "--composing"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          expect(new URL(request.url).pathname).toBe("/api/rooms/abc123/composing");
          expect(request.method).toBe("POST");
          postedBody = await request.json();
          return jsonResponse({
            composing: {
              participant_id: "p_northline",
              display_name: "Northline",
              expires_at: "2026-08-22T12:00:00.000Z",
            },
          });
        },
        env,
      }),
    ).toBe(0);
    expect(postedBody).toEqual({});
    expect(stdout).toContain("Composing signal active.");
    expect(stdout).toContain("It will clear when you post or when it expires.");
    expect(stdout).not.toContain("action");
    expect(stdout).not.toContain("watch");
  });

  it("renders composing as presence without telling peers to wait", async () => {
    const env = providerEnv(roomConfig());
    let stdout = "";
    expect(
      await runRoomCli(["read", "--snapshot"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            slug: "abc123",
            status: "open",
            decision: null,
            composing: [{ participant_id: "p_cobalt", display_name: "Cobalt" }],
            actions: [],
            artifacts: [],
          }),
        env,
      }),
    ).toBe(0);
    expect(stdout).toContain("Presence: Cobalt is composing a message.");
    expect(stdout).not.toContain("Cobalt is composing a message.\nNext: grp watch");
  });

  it("starts one shared turn and directs non-holders to its scoped watch", async () => {
    const env = providerEnv(roomConfig({ observedStateRevision: "41" }));
    const requests: Request[] = [];
    let stdout = "";
    const action = {
      id: "act_1",
      revision: "ar_1",
      title: "Review the draft",
      status: "active",
      holder_id: "p_cobalt",
      holder_epoch: "1",
      mode: "handoff",
      completion: "holder",
    };

    const code = await runRoomCli(
      ["act", "start", "--title=Review the draft", "--to=cobalt", "--mode=handoff"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: withCoordinationDiscovery(async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          const pathname = new URL(request.url).pathname;
          if (pathname === "/api/rooms/abc123" && request.method === "GET") {
            return jsonResponse({ participants, actions: [action], decisions: [] });
          }
          if (pathname === "/api/rooms/abc123/actions" && request.method === "POST") {
            expect(await request.json()).toEqual({
              title: "Review the draft",
              assignee_id: "p_cobalt",
              start: true,
              mode: "handoff",
              completion: "holder",
            });
            return jsonResponse({ action, state_revision: "42" });
          }
          throw new Error(`unexpected request ${request.method} ${pathname}`);
        }),
        env,
      },
    );

    expect(code).toBe(0);
    expect(
      requests
        .find((request) => request.method === "POST")
        ?.headers.get("x-grp-expected-room-revision"),
    ).toBe("41");
    expect(stdout).toContain("holder Cobalt");
    expect(stdout).toContain("Cobalt holds this handoff action");
    expect(stdout).toContain("Holder-scoped transitions are unavailable to you");
    expect(stdout).toContain("grp watch --action=act_1");
    expect(stdout).not.toContain("grp watch --artifact");
    expect(stdout).not.toContain("defer");
    expect(stdout).not.toContain("enforced lock");
  });

  it("starts one fixed all-participant action from the current participant roster", async () => {
    const env = providerEnv(roomConfig({ observedStateRevision: "41" }));
    let postedBody: unknown;
    let expectedRoomRevision: string | null = null;
    let stdout = "";
    const action = {
      id: "act_all",
      revision: "ar_1",
      title: "Consult each principal",
      status: "in_progress",
      mode: "all",
      completion: "all",
      participants: [
        { participant_id: "p_northline", status: "pending" },
        { participant_id: "p_cobalt", status: "pending" },
      ],
      progress: { required: 2, pending: 2, working: 0, completed: 0, failed: 0 },
    };

    expect(
      await runRoomCli(["act", "start", "--title=Consult each principal", "--mode=all"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: withCoordinationDiscovery(async (input, init) => {
          const request = new Request(input, init);
          const pathname = new URL(request.url).pathname;
          if (pathname === "/api/rooms/abc123" && request.method === "GET") {
            return jsonResponse({ participants, actions: [action], decisions: [] });
          }
          if (pathname === "/api/rooms/abc123/actions" && request.method === "POST") {
            postedBody = await request.json();
            expectedRoomRevision = request.headers.get("x-grp-expected-room-revision");
            return jsonResponse({ action, state_revision: "42" });
          }
          throw new Error(`unexpected request ${request.method} ${pathname}`);
        }),
        env,
      }),
    ).toBe(0);
    expect(postedBody).toEqual({
      title: "Consult each principal",
      start: true,
      mode: "all",
    });
    expect(expectedRoomRevision).toBe("41");
    expect(stdout).toContain("all participants 0/2 complete");
    expect(stdout).toContain("Your report is required");
    expect(stdout).toContain("grp act complete act_all");
  });

  it("declares group completion at start and rejects a completion override for all mode", async () => {
    const env = providerEnv(roomConfig({ observedStateRevision: "41" }));
    let postedBody: unknown;
    const action = {
      id: "act_group",
      revision: "ar_1",
      title: "Revise the shared plan",
      status: "in_progress",
      mode: "handoff",
      completion: "group",
      holder_id: "p_northline",
    };

    expect(
      await runRoomCli(
        ["act", "start", "--title=Revise the shared plan", "--mode=handoff", "--completion=group"],
        {
          stdout: () => {},
          stderr: () => {},
          fetch: withCoordinationDiscovery(async (input, init) => {
            const request = new Request(input, init);
            const pathname = new URL(request.url).pathname;
            if (pathname === "/api/rooms/abc123/actions" && request.method === "POST") {
              postedBody = await request.json();
              return jsonResponse({ action, state_revision: "42" });
            }
            if (pathname === "/api/rooms/abc123" && request.method === "GET") {
              return jsonResponse({ participants, actions: [action], decisions: [] });
            }
            throw new Error(`unexpected request ${request.method} ${pathname}`);
          }),
          env,
        },
      ),
    ).toBe(0);
    expect(postedBody).toMatchObject({ mode: "handoff", completion: "group" });

    let error = "";
    let fetches = 0;
    expect(
      await runRoomCli(
        ["act", "start", "--title=Consult everyone", "--mode=all", "--completion=group"],
        {
          stdout: () => {},
          stderr: (text) => {
            error += text;
          },
          fetch: async () => {
            fetches += 1;
            return jsonResponse({});
          },
          env,
        },
      ),
    ).toBe(1);
    expect(error).toContain("--completion is not used with --mode=all");
    expect(fetches).toBe(0);
  });

  it("takes an available shared turn from its exact action revision", async () => {
    const env = providerEnv(roomConfig());
    let postedBody: unknown;
    let stdout = "";
    const available = {
      id: "act_turn",
      revision: "ar_2",
      title: "Revise the shared plan",
      status: "active",
      mode: "turn_taking",
      holder_id: null,
      available: true,
    };
    const taken = {
      ...available,
      revision: "ar_3",
      holder_id: "p_northline",
      holder_epoch: "2",
      available: false,
    };

    expect(
      await runRoomCli(["act", "take", "act_turn"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const pathname = new URL(request.url).pathname;
          if (pathname.endsWith("/actions/act_turn") && request.method === "GET") {
            return jsonResponse({ action: available });
          }
          if (pathname.endsWith("/actions/act_turn/claim") && request.method === "POST") {
            postedBody = await request.json();
            return jsonResponse({ action: taken });
          }
          if (pathname === "/api/rooms/abc123" && request.method === "GET") {
            return jsonResponse({ participants, actions: [taken], decisions: [] });
          }
          throw new Error(`unexpected request ${request.method} ${pathname}`);
        },
        env,
      }),
    ).toBe(0);
    expect(postedBody).toEqual({ expected_revision: "ar_2" });
    expect(stdout).toContain("You hold this handoff action");
    expect(stdout).toContain("grp act handoff act_turn --to=group");
  });

  it("shows a losing taker the current holder, lease expiry, and exact scoped watch", async () => {
    const env = providerEnv(roomConfig());
    let stderr = "";
    const available = {
      id: "act_turn",
      revision: "ar_2",
      title: "Revise the shared plan",
      status: "active",
      mode: "turn_taking",
      holder_id: null,
      available: true,
    };

    expect(
      await runRoomCli(["act", "take", "act_turn"], {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const pathname = new URL(request.url).pathname;
          if (pathname.endsWith("/actions/act_turn") && request.method === "GET") {
            return jsonResponse({ action: available });
          }
          if (pathname.endsWith("/actions/act_turn/claim") && request.method === "POST") {
            return jsonResponse(
              {
                error: {
                  code: "claim.active",
                  message: "participant p_cobalt holds the action until 2026-08-22T12:34:56.000Z",
                  hint: "watch this action until the current holder hands it off or completes it",
                  details: {
                    holder_id: "p_cobalt",
                    expires_at: "2026-08-22T12:34:56.000Z",
                  },
                },
              },
              409,
            );
          }
          throw new Error(`unexpected request ${request.method} ${pathname}`);
        },
        env,
      }),
    ).toBe(1);
    expect(stderr).toContain("p_cobalt holds the action");
    expect(stderr).toContain("2026-08-22T12:34:56.000Z");
    expect(stderr).toContain("grp watch --action=act_turn");
  });

  it("returns a held shared turn to the group without selecting a successor", async () => {
    const env = providerEnv(roomConfig());
    let postedBody: unknown;
    let stdout = "";
    const before = {
      id: "act_turn",
      revision: "ar_3",
      title: "Revise the shared plan",
      status: "active",
      mode: "turn_taking",
      holder_id: "p_northline",
      holder_epoch: "2",
      available: false,
    };
    const after = {
      ...before,
      revision: "ar_4",
      holder_id: null,
      available: true,
      handoff_note: "Ready for the next pass",
    };

    expect(
      await runRoomCli(
        ["act", "handoff", "act_turn", "--to=group", "--note=Ready for the next pass"],
        {
          stdout: (text) => {
            stdout += text;
          },
          stderr: () => {},
          fetch: async (input, init) => {
            const request = new Request(input, init);
            const pathname = new URL(request.url).pathname;
            if (pathname.endsWith("/actions/act_turn") && request.method === "GET") {
              return jsonResponse({ action: before });
            }
            if (pathname.endsWith("/actions/act_turn/handoff") && request.method === "POST") {
              postedBody = await request.json();
              return jsonResponse({ action: after });
            }
            if (pathname === "/api/rooms/abc123" && request.method === "GET") {
              return jsonResponse({ participants, actions: [after], decisions: [] });
            }
            throw new Error(`unexpected request ${request.method} ${pathname}`);
          },
          env,
        },
      ),
    ).toBe(0);
    expect(postedBody).toEqual({
      expected_revision: "ar_3",
      to_group: true,
      note: "Ready for the next pass",
    });
    expect(stdout).toContain("This handoff action is available");
    expect(stdout).toContain("grp act take act_turn");
  });

  it("renders an ordinary room read with one literal shared-turn watch", async () => {
    const env = providerEnv(
      roomConfig({
        token: "t_northline",
        observedStateRevision: "10",
        coordinationStateCapability: "experimental",
      }),
    );
    let stdout = "";
    expect(
      await runRoomCli(["read", "--snapshot"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            slug: "abc123",
            status: "open",
            role: "participant",
            state_revision: "10",
            brief: "No question is open.",
            decision: null,
            discussion: [],
            working_signals: [],
            actions: [
              {
                id: "act_1",
                revision: "4",
                title: "Confirm constraints with the principal",
                status: "in_progress",
                holder_id: "p_cobalt",
                mode: "turn_taking",
              },
            ],
            artifacts: [],
          }),
        env,
      }),
    ).toBe(0);
    expect(stdout).toContain("Shared actions:");
    expect(stdout).toContain(
      "handoff; completion holder; holder p_cobalt; held by another participant",
    );
    expect(stdout).toContain("Next: grp watch --action=act_1");
    expect(stdout.match(/grp watch/g)).toHaveLength(1);
    expect(stdout).not.toContain("Wait for what's next: grp watch");
    expect(stdout).not.toContain("grp watch --action=ACTION_ID");
    expect(stdout).not.toContain("LOCK");
    expect(stdout).not.toContain("baton");
    expect(stdout).not.toContain("defer");
    expect(stdout).not.toContain("action wait");
  });

  it("routes an active artifact lock through the holder action's filtered watch", async () => {
    const env = providerEnv(
      roomConfig({
        token: "t_northline",
        observedStateRevision: "10",
        coordinationStateCapability: "experimental",
      }),
    );
    let stdout = "";
    expect(
      await runRoomCli(["read", "--snapshot"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            slug: "abc123",
            status: "open",
            role: "participant",
            state_revision: "10",
            brief: "No question is open.",
            decision: null,
            discussion: [],
            working_signals: [],
            actions: [
              {
                id: "act_edit",
                revision: "4",
                title: "Revise the shared plan",
                status: "in_progress",
                holder_id: "p_cobalt",
                holder_display_name: "Cobalt",
                target_artifact_id: "doc_1",
                mode: "turn_taking",
              },
            ],
            artifacts: [
              {
                id: "doc_1",
                revision: "6",
                name: "Shared plan",
                current_revision_id: "rev_uuid_3",
                baton_mode: "enforced",
                claim: {
                  holder_id: "p_cobalt",
                  epoch: "2",
                  expires_at: "2026-08-22T02:00:00Z",
                },
                review_status: {
                  current: [{ display_name: "Northline", disposition: "approve" }],
                  superseded: [],
                },
              },
            ],
          }),
        env,
      }),
    ).toBe(0);
    expect(stdout).toContain("Next: grp watch --action=act_edit");
    expect(stdout).toContain("current editor Cobalt via action act_edit");
    expect(stdout).not.toContain("current editor action holder");
    expect(stdout).not.toContain("artifact wait");
    expect(stdout).not.toContain("CURRENT reviews");
  });

  it("renders the calling editor and linked action without confusing their identifiers", async () => {
    const env = providerEnv(
      roomConfig({
        token: "t_northline",
        observedStateRevision: "10",
        coordinationStateCapability: "experimental",
      }),
    );
    let stdout = "";
    expect(
      await runRoomCli(["read", "--snapshot"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            slug: "abc123",
            status: "open",
            role: "participant",
            state_revision: "10",
            brief: "No question is open.",
            decision: null,
            discussion: [],
            working_signals: [],
            actions: [
              {
                id: "act_edit",
                revision: "4",
                title: "Revise the shared plan",
                status: "in_progress",
                holder_id: "p_northline",
                holder_display_name: "Northline",
                target_artifact_id: "doc_1",
                mode: "turn_taking",
              },
            ],
            artifacts: [
              {
                id: "doc_1",
                revision: "6",
                name: "Shared plan",
                current_revision_id: "rev_uuid_3",
                claim: null,
              },
            ],
          }),
        env,
      }),
    ).toBe(0);
    expect(stdout).toContain("current editor you via action act_edit");
    expect(stdout).not.toContain("current editor p_northline");
    expect(stdout).not.toContain("current editor action holder");
  });

  it("uses filtered artifact watch for a lock-only state change", async () => {
    vi.useFakeTimers();
    try {
      const env = providerEnv(roomConfig());
      let artifactReads = 0;
      let stdout = "";
      const result = runRoomCli(["watch", "--artifact=doc_1", "--timeout=10"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input) => {
          const request = new Request(input);
          const url = new URL(request.url);
          if (url.pathname === "/api/rooms/abc123") {
            return jsonResponse({ participants, actions: [], decisions: [] });
          }
          if (url.pathname === "/api/rooms/abc123/artifacts/doc_1") {
            artifactReads += 1;
            return jsonResponse({
              artifact: {
                id: "doc_1",
                revision: artifactReads === 1 ? "5" : "6",
                status: "open",
                current_revision_id: "rev_uuid_3",
                claim:
                  artifactReads === 1
                    ? { holder_id: "p_cobalt", epoch: "2", expires_at: "later" }
                    : null,
              },
              revision: { id: "rev_uuid_3", ordinal: 3 },
            });
          }
          throw new Error(`unexpected request ${request.method} ${url.pathname}`);
        },
        env,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await result).toBe(0);
      expect(artifactReads).toBe(2);
      expect(stdout).toContain("Artifact doc_1 state changed at v3");
      expect(stdout).toContain("grp artifact read doc_1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands one current action directly to one named successor using hidden exact revision state", async () => {
    const env = providerEnv(roomConfig());
    const calls: Array<{ method: string; pathname: string; body?: unknown }> = [];
    const before = {
      id: "act_1",
      revision: "ar_7",
      title: "Negotiate terms",
      status: "active",
      holder_id: "p_northline",
      holder_epoch: "3",
      mode: "turn_taking",
    };
    const after = {
      ...before,
      revision: "ar_8",
      previous_holder_id: "p_northline",
      holder_id: "p_cobalt",
      holder_epoch: "4",
      handoff_note: "Check the governance section",
    };
    let stdout = "";

    const code = await runRoomCli(
      ["act", "handoff", "act_1", "--to=Cobalt", "--note=Check the governance section"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const pathname = new URL(request.url).pathname;
          const body = request.method === "POST" ? await request.json() : undefined;
          calls.push({ method: request.method, pathname, body });
          if (pathname === "/api/rooms/abc123/actions/act_1" && request.method === "GET") {
            return jsonResponse({ action: before });
          }
          if (pathname === "/api/rooms/abc123" && request.method === "GET") {
            return jsonResponse({ participants, actions: [after], decisions: [] });
          }
          if (pathname === "/api/rooms/abc123/actions/act_1/handoff" && request.method === "POST") {
            return jsonResponse({ action: after });
          }
          throw new Error(`unexpected request ${request.method} ${pathname}`);
        },
        env,
      },
    );

    expect(code).toBe(0);
    expect(
      calls.find((call) => call.pathname.endsWith("/handoff") && call.method === "POST")?.body,
    ).toEqual({
      expected_revision: "ar_7",
      to_participant_id: "p_cobalt",
      note: "Check the governance section",
    });
    expect(stdout).toContain("Handoff note: Check the governance section");
    expect(stdout).toContain("grp watch --action=act_1");
  });

  it("attaches a new native artifact to the action and keeps exact tokens off the human path", async () => {
    const env = providerEnv(roomConfig());
    const calls: Array<{ method: string; pathname: string; body?: unknown }> = [];
    let stdout = "";
    const action = {
      id: "act_1",
      revision: "ar_2",
      status: "active",
      holder_id: "p_northline",
    };
    const artifact = {
      id: "doc_1",
      name: "Term sheet",
      revision: "rr_1",
      current_revision_id: "rev_uuid_1",
      current_sha256: "a".repeat(64),
    };
    const revision = {
      id: "rev_uuid_1",
      ordinal: 1,
      sha256: "a".repeat(64),
    };

    const code = await runRoomCli(
      [
        "artifact",
        "create",
        "--name=Term sheet",
        "--action=act_1",
        "--content=Economics\n\nGovernance",
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const pathname = new URL(request.url).pathname;
          const body = request.method === "POST" ? await request.json() : undefined;
          calls.push({ method: request.method, pathname, body });
          if (pathname.endsWith("/actions/act_1") && request.method === "GET") {
            return jsonResponse({ action });
          }
          if (pathname.endsWith("/artifacts") && request.method === "POST") {
            return jsonResponse({ artifact, revision, action: { ...action, revision: "ar_3" } });
          }
          throw new Error(`unexpected request ${request.method} ${pathname}`);
        },
        env,
      },
    );

    expect(code).toBe(0);
    expect(calls.find((call) => call.pathname.endsWith("/artifacts"))?.body).toEqual({
      name: "Term sheet",
      kind: "native",
      content: "Economics\n\nGovernance",
      action_id: "act_1",
      expected_action_revision: "ar_2",
    });
    expect(stdout).toContain("Revision: rev_1");
    expect(stdout).not.toContain("rev_uuid_1");
    expect(stdout).not.toContain("a".repeat(64));
  });

  it("renders stable paragraph numbers while keeping internal ids and digests in JSON only", async () => {
    const env = providerEnv(roomConfig());
    const response = {
      artifact: { id: "doc_1", name: "Term sheet", revision: "rr_4" },
      revision: {
        id: "rev_uuid_4",
        ordinal: 4,
        sha256: "b".repeat(64),
        blocks: [
          { id: "block_internal_1", number: 1, kind: "paragraph", content: "Economics" },
          {
            id: "block_internal_2",
            number: 2,
            kind: "paragraph",
            content: "Governance",
            content_sha256: "c".repeat(64),
          },
        ],
      },
    };
    let human = "";
    expect(
      await runRoomCli(["artifact", "read", "doc_1"], {
        stdout: (text) => {
          human += text;
        },
        stderr: () => {},
        fetch: async () => jsonResponse(response),
        env,
      }),
    ).toBe(0);
    expect(human).toContain("Version: v4");
    expect(human).toContain("1  paragraph");
    expect(human).toContain("2  paragraph");
    expect(human).not.toContain("rev_uuid_4");
    expect(human).not.toContain("block_internal_2");
    expect(human).not.toContain("b".repeat(64));

    let json = "";
    expect(
      await runRoomCli(["artifact", "read", "doc_1", "--json"], {
        stdout: (text) => {
          json += text;
        },
        stderr: () => {},
        fetch: async () => jsonResponse(response),
        env,
      }),
    ).toBe(0);
    expect(json).toContain("rev_uuid_4");
    expect(json).toContain("block_internal_2");
    expect(json).toContain("b".repeat(64));
  });

  it("compares exact artifact revisions using unified-diff presentation", async () => {
    const env = providerEnv(roomConfig());
    const revision = (ordinal: number) => ({
      artifact: { id: "doc_1", name: "Term sheet", revision: `rr_${ordinal}` },
      revision: {
        id: `rev_uuid_${ordinal}`,
        ordinal,
        blocks:
          ordinal === 3
            ? [
                {
                  id: "economics",
                  number: 1,
                  kind: "paragraph",
                  content: "Pre-money valuation is $32m.",
                  content_sha256: "a".repeat(64),
                },
                {
                  id: "obsolete",
                  number: 2,
                  kind: "paragraph",
                  content: "Old reporting term.",
                  content_sha256: "b".repeat(64),
                },
              ]
            : [
                {
                  id: "economics",
                  number: 1,
                  kind: "paragraph",
                  content: "Pre-money valuation is $33m.",
                  content_sha256: "c".repeat(64),
                },
                {
                  id: "new-rights",
                  number: 2,
                  kind: "paragraph",
                  content: "Quarterly information rights.",
                  content_sha256: "d".repeat(64),
                },
              ],
      },
    });
    let stdout = "";
    expect(
      await runRoomCli(["artifact", "diff", "doc_1", "--from-version=3", "--to-version=4"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input) => {
          const version = new URL(new Request(input).url).searchParams.get("version");
          return jsonResponse(revision(version === "3" ? 3 : 4));
        },
        env,
      }),
    ).toBe(0);
    expect(stdout).toContain("--- artifact v3");
    expect(stdout).toContain("+++ artifact v4");
    expect(stdout).toContain("@@ -1,1 +1,1 @@ paragraph");
    expect(stdout).toContain("-Pre-money valuation is $32m.");
    expect(stdout).toContain("+Pre-money valuation is $33m.");
    expect(stdout).toContain("@@ -2,1 +2,1 @@ paragraph");
    expect(stdout).toContain("-Old reporting term.");
    expect(stdout).toContain("+Quarterly information rights.");
    expect(stdout).not.toContain("economics");
  });

  it("translates a human paragraph edit to exact resource-local patch coordinates", async () => {
    const env = providerEnv(roomConfig());
    let postedBody: unknown;
    const current = {
      artifact: {
        id: "doc_1",
        name: "Term sheet",
        revision: "rr_4",
        current_revision_id: "rev_uuid_4",
        current_sha256: "b".repeat(64),
      },
      revision: {
        id: "rev_uuid_4",
        ordinal: 4,
        sha256: "b".repeat(64),
        blocks: [
          {
            id: "block_internal_2",
            number: 2,
            kind: "paragraph",
            content: "Governance",
            content_sha256: "c".repeat(64),
          },
        ],
      },
    };
    const updated = {
      artifact: { ...current.artifact, revision: "rr_5", current_revision_id: "rev_uuid_5" },
      revision: { id: "rev_uuid_5", ordinal: 5, sha256: "d".repeat(64) },
    };

    expect(
      await runRoomCli(
        [
          "artifact",
          "replace",
          "doc_1",
          "2",
          "--action=act_1",
          "--content=Board and observer rights",
        ],
        {
          stdout: () => {},
          stderr: () => {},
          fetch: async (input, init) => {
            const request = new Request(input, init);
            if (request.method === "GET" && request.url.includes("/actions/act_1")) {
              return jsonResponse({
                action: { id: "act_1", revision: "ar_2", completion: "group" },
              });
            }
            if (request.method === "GET") return jsonResponse(current);
            postedBody = await request.json();
            return jsonResponse(updated);
          },
          env,
        },
      ),
    ).toBe(0);
    expect(postedBody).toEqual({
      expected_revision: "rr_4",
      base_revision_id: "rev_uuid_4",
      action_id: "act_1",
      operations: [
        {
          op: "replace",
          block_id: "block_internal_2",
          expected_content_sha256: "c".repeat(64),
          content: "Board and observer rights",
        },
      ],
    });
  });

  it("applies a numbered multi-edit patch as one exact atomic revision", async () => {
    const env = providerEnv(roomConfig());
    const dir = mkdtempSync(pathJoin(tmpdir(), "grp-artifact-patch-"));
    const file = pathJoin(dir, "changes.json");
    writeFileSync(
      file,
      JSON.stringify({
        base_revision: "rev_4",
        edits: [
          { op: "replace", block: 1, text: "Revised economics" },
          { op: "insert-after", block: 2, text: "Information rights" },
          {
            op: "replace-text",
            find: "Kestrel Labs",
            replace: "Kestrel Signal",
            expected: 2,
          },
        ],
      }),
      "utf8",
    );
    const current = {
      artifact: { id: "doc_1", revision: "rr_4", current_revision_id: "rev_uuid_4" },
      revision: {
        id: "rev_uuid_4",
        ordinal: 4,
        blocks: [
          {
            id: "block_1",
            number: 1,
            content: "Economics for Kestrel Labs",
            content_sha256: "a".repeat(64),
          },
          {
            id: "block_2",
            number: 2,
            content: "Kestrel Labs governance",
            content_sha256: "b".repeat(64),
          },
        ],
      },
    };
    const updated = {
      artifact: { id: "doc_1", revision: "rr_5", current_revision_id: "rev_uuid_5" },
      revision: { id: "rev_uuid_5", ordinal: 5 },
    };
    let postedBody: unknown;
    let stdout = "";
    expect(
      await runRoomCli(["artifact", "patch", "doc_1", "--action=act_1", `--file=${file}`], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (request.method === "GET" && request.url.includes("/actions/act_1")) {
            return jsonResponse({
              action: { id: "act_1", revision: "ar_2", completion: "group" },
            });
          }
          if (request.method === "GET") return jsonResponse(current);
          postedBody = await request.json();
          return jsonResponse(updated);
        },
        env,
      }),
    ).toBe(0);
    expect(postedBody).toEqual({
      expected_revision: "rr_4",
      base_revision_id: "rev_uuid_4",
      action_id: "act_1",
      operations: [
        {
          op: "replace",
          block_id: "block_1",
          expected_content_sha256: "a".repeat(64),
          content: "Revised economics",
        },
        { op: "insert_after", anchor_block_id: "block_2", content: "Information rights" },
        {
          op: "replace_text",
          find: "Kestrel Labs",
          replace: "Kestrel Signal",
          expected_matches: 2,
        },
      ],
    });
    expect(stdout).toContain("Artifact updated: rev_4 → rev_5");
    expect(stdout).toContain("Applied 3 edits atomically.");
    expect(stdout).toContain("Review the result: grp artifact read doc_1");
    expect(stdout).toContain("Request exact review: grp act request-review act_1");
    expect(stdout).toContain(
      "Continue editing:  grp artifact patch doc_1 --action=act_1 --file=changes.json",
    );
    expect(stdout).not.toContain("Complete the owning action: grp act complete act_1");
  });

  it("points a whole-artifact group edit to exact review instead of rejected completion", async () => {
    const env = providerEnv(roomConfig());
    const current = {
      artifact: {
        id: "doc_1",
        name: "Joint draft",
        action_id: "act_1",
        revision: "rr_4",
        current_revision_id: "rev_uuid_4",
      },
      revision: { id: "rev_uuid_4", ordinal: 4, blocks: [] },
    };
    const updated = {
      artifact: { ...current.artifact, revision: "rr_5", current_revision_id: "rev_uuid_5" },
      revision: { id: "rev_uuid_5", ordinal: 5 },
    };
    let stdout = "";

    expect(
      await runRoomCli(
        ["artifact", "publish", "doc_1", "--action=act_1", "--content=Revised exact bytes"],
        {
          stdout: (text) => {
            stdout += text;
          },
          stderr: () => {},
          fetch: async (input, init) => {
            const request = new Request(input, init);
            if (request.method === "GET" && request.url.includes("/actions/act_1")) {
              return jsonResponse({
                action: { id: "act_1", revision: "ar_2", completion: "group" },
              });
            }
            if (request.method === "GET") return jsonResponse(current);
            return jsonResponse(updated);
          },
          env,
        },
      ),
    ).toBe(0);
    expect(stdout).toContain("Artifact doc_1 updated: Joint draft.");
    expect(stdout).toContain("Request exact review: grp act request-review act_1");
    expect(stdout).not.toContain("Complete the owning action: grp act complete act_1");
  });

  it("rejects a stale named patch base without attempting a write", async () => {
    const env = providerEnv(roomConfig());
    const dir = mkdtempSync(pathJoin(tmpdir(), "grp-artifact-stale-patch-"));
    const file = pathJoin(dir, "changes.json");
    writeFileSync(
      file,
      JSON.stringify({
        base_revision: "rev_3",
        edits: [{ op: "delete", block: 1 }],
      }),
      "utf8",
    );
    let writes = 0;
    let stderr = "";
    expect(
      await runRoomCli(["artifact", "patch", "doc_1", "--action=act_1", `--file=${file}`], {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch: async (_input, init) => {
          if (init?.method === "POST") writes += 1;
          return jsonResponse({
            artifact: { id: "doc_1", revision: "rr_4", current_revision_id: "rev_uuid_4" },
            revision: { id: "rev_uuid_4", ordinal: 4, blocks: [] },
          });
        },
        env,
      }),
    ).toBe(1);
    expect(writes).toBe(0);
    expect(stderr).toContain("Artifact changed since patch base rev_3");
    expect(stderr).toContain("Nothing was written");
    expect(stderr).toContain("grp artifact read doc_1");
  });

  it("preserves a block-patch explanation instead of mislabeling it as a concurrent edit", async () => {
    const env = providerEnv(roomConfig());
    const dir = mkdtempSync(pathJoin(tmpdir(), "grp-artifact-invalid-block-patch-"));
    const file = pathJoin(dir, "changes.json");
    writeFileSync(
      file,
      JSON.stringify({
        base_revision: "rev_4",
        edits: [{ op: "replace", block: 1, text: "One paragraph\n\nA second paragraph" }],
      }),
      "utf8",
    );
    const current = {
      artifact: { id: "doc_1", revision: "rr_4", current_revision_id: "rev_uuid_4" },
      revision: {
        id: "rev_uuid_4",
        ordinal: 4,
        blocks: [
          {
            id: "block_1",
            number: 1,
            content: "Original",
            content_sha256: "a".repeat(64),
          },
        ],
      },
    };
    let stderr = "";
    expect(
      await runRoomCli(["artifact", "patch", "doc_1", "--action=act_1", `--file=${file}`], {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (request.method === "GET") return jsonResponse(current);
          return jsonResponse(
            {
              error: {
                code: "artifact.block_conflict",
                message:
                  "a replacement or insertion must contain exactly one addressable CommonMark block",
                hint: "read the exact current blocks and retry the atomic patch from that base",
              },
            },
            409,
          );
        },
        env,
      }),
    ).toBe(1);
    expect(stderr).toContain("Artifact patch could not be applied to this exact revision.");
    expect(stderr).toContain(
      "a replacement or insertion must contain exactly one addressable CommonMark block",
    );
    expect(stderr).toContain(
      "Replace with the first block, then add each remaining block with ordered insert-after edits in the same patch file against the same base revision.",
    );
    expect(stderr).toContain("Nothing was written.");
    expect(stderr).not.toContain("Artifact changed while you were editing.");
    expect(stderr).not.toContain("Read again:");
    expect(stderr).not.toContain("read the exact current blocks");
  });

  it("requests action-owned review of the host-resolved exact artifact without a room-wide guard", async () => {
    const env = providerEnv(
      roomConfig({
        token: "t_northline",
        observedStateRevision: "10",
        coordinationStateCapability: "experimental",
      }),
    );
    const active = {
      id: "act_1",
      revision: "ar_9",
      title: "Draft the term sheet",
      status: "in_progress",
      holder_id: "p_northline",
      target_artifact_id: "doc_1",
      mode: "turn_taking",
      completion: "group",
    };
    const reviewing = {
      ...active,
      revision: "ar_10",
      status: "in_review",
      holder_id: null,
      review: {
        state: "pending",
        artifact_revision_id: "rev_uuid_5",
        requested_by_id: "p_northline",
        required_participant_ids: ["p_northline", "p_cobalt"],
        responded_participant_ids: ["p_northline"],
      },
    };
    const artifact = {
      artifact: {
        id: "doc_1",
        revision: "rr_5",
        current_revision_id: "rev_uuid_5",
        review_status: {
          current: [
            {
              reviewer_id: "p_northline",
              revision_id: "rev_uuid_5",
              disposition: "approve",
            },
          ],
          superseded: [],
        },
      },
      revision: { id: "rev_uuid_5", sha256: "d".repeat(64) },
    };
    let postedBody: unknown;
    let postedGuard: string | null = null;
    let stdout = "";

    expect(
      await runRoomCli(["act", "request-review", "act_1"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: withCoordinationDiscovery(async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (url.pathname.endsWith("/actions/act_1") && request.method === "GET") {
            return jsonResponse({ action: active });
          }
          if (url.pathname.endsWith("/artifacts/doc_1") && request.method === "GET") {
            return jsonResponse(artifact);
          }
          if (url.pathname.endsWith("/actions/act_1/request-review") && request.method === "POST") {
            postedGuard = request.headers.get("x-grp-expected-room-revision");
            postedBody = await request.json();
            return jsonResponse({ action: reviewing, ...artifact, state_revision: "11" });
          }
          if (url.pathname === "/api/rooms/abc123" && request.method === "GET") {
            return jsonResponse({
              participants,
              actions: [reviewing],
              artifacts: [artifact.artifact],
            });
          }
          throw new Error(`unexpected request ${request.method} ${url.pathname}`);
        }),
        env,
      }),
    ).toBe(0);
    expect(postedGuard).toBeNull();
    expect(postedBody).toEqual({
      expected_action_revision: "ar_9",
      expected_artifact_revision: "rr_5",
      artifact_revision_id: "rev_uuid_5",
    });
    expect(stdout).toContain("Review is open on exact artifact revision rev_uuid_5");
    expect(stdout).toContain("Your approval is recorded: approve");
    expect(stdout).toContain("Outstanding responses: 1");
    expect(stdout).toContain("grp watch --action=act_1");
    expect(stdout).not.toContain("grp accept");
  });

  it("reads the frozen bytes before recording one action review response", async () => {
    const env = providerEnv(
      roomConfig({
        participantId: "p_cobalt",
        token: "t_cobalt",
        coordinationStateCapability: "experimental",
      }),
    );
    const action = {
      id: "act_1",
      revision: "ar_10",
      title: "Draft the term sheet",
      status: "in_review",
      holder_id: null,
      target_artifact_id: "doc_1",
      mode: "handoff",
      completion: "group",
      review: {
        state: "pending",
        artifact_revision_id: "rev_uuid_5",
        requested_by_id: "p_northline",
        required_participant_ids: ["p_northline", "p_cobalt"],
        responded_participant_ids: ["p_northline"],
      },
    };
    const exact = {
      artifact: {
        id: "doc_1",
        revision: "rr_5",
        name: "Term sheet",
        current_revision_id: "rev_uuid_5",
        review_status: {
          current: [
            {
              reviewer_id: "p_northline",
              revision_id: "rev_uuid_5",
              disposition: "approve",
            },
          ],
          superseded: [],
        },
      },
      revision: {
        id: "rev_uuid_5",
        ordinal: 5,
        sha256: "d".repeat(64),
        content: "# Exact terms\n",
      },
      reviews: [
        {
          id: "review_1",
          revision: "1",
          artifact_revision_id: "rev_uuid_5",
          reviewer_id: "p_northline",
          disposition: "approve",
        },
      ],
    };
    let stdout = "";
    expect(
      await runRoomCli(["act", "review", "act_1"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: withCoordinationDiscovery(async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (url.pathname.endsWith("/actions/act_1") && url.searchParams.get("reviews") === "1") {
            return jsonResponse({ action, rounds: [] });
          }
          if (url.pathname.endsWith("/actions/act_1")) return jsonResponse({ action });
          if (url.pathname.endsWith("/artifacts/doc_1")) return jsonResponse(exact);
          throw new Error(`unexpected request ${request.method} ${url.pathname}`);
        }),
        env,
      }),
    ).toBe(0);
    expect(stdout).toContain("# Exact terms");
    expect(stdout).toContain("targets exact artifact revision rev_uuid_5");
    expect(stdout).toContain("Required: record one review response for these exact bytes");
    expect(stdout).toContain("grp act review act_1 --revision=rev_uuid_5 --approve");
    expect(stdout).toContain("grp act review act_1 --revision=rev_uuid_5 --request-changes");
    expect(stdout).toContain("--file=review.md");
    expect(stdout).toContain("Review body limit: 32,000 characters");
    expect(stdout).toContain("A response may be updated while this review round remains open");

    let oversizedError = "";
    let oversizedWrites = 0;
    expect(
      await runRoomCli(
        [
          "act",
          "review",
          "act_1",
          "--revision=rev_uuid_5",
          "--approve",
          `--body=${"x".repeat(32_001)}`,
        ],
        {
          stdout: () => {},
          stderr: (text) => {
            oversizedError += text;
          },
          fetch: withCoordinationDiscovery(async (input, init) => {
            const request = new Request(input, init);
            const url = new URL(request.url);
            if (request.method === "PUT") oversizedWrites += 1;
            if (url.pathname.endsWith("/actions/act_1")) return jsonResponse({ action });
            if (url.pathname.endsWith("/artifacts/doc_1")) return jsonResponse(exact);
            throw new Error(`unexpected request ${request.method} ${url.pathname}`);
          }),
          env,
        },
      ),
    ).toBe(1);
    expect(oversizedError).toContain("between 1 and 32,000 characters");
    expect(oversizedWrites).toBe(0);

    let postedBody: unknown;
    stdout = "";
    const completed = {
      ...action,
      revision: "ar_11",
      status: "completed",
      review: { ...action.review, state: "approved" },
      result: {
        kind: "artifact_revision",
        reference: {
          artifact_id: "doc_1",
          revision_id: "rev_uuid_5",
          sha256: "d".repeat(64),
        },
      },
    };
    expect(
      await runRoomCli(
        ["act", "review", "act_1", "--revision=rev_uuid_5", "--approve", "--body=Looks exact"],
        {
          stdout: (text) => {
            stdout += text;
          },
          stderr: () => {},
          fetch: withCoordinationDiscovery(async (input, init) => {
            const request = new Request(input, init);
            const url = new URL(request.url);
            if (url.pathname.endsWith("/actions/act_1") && request.method === "GET") {
              return jsonResponse({ action });
            }
            if (url.pathname.endsWith("/artifacts/doc_1") && request.method === "GET") {
              return jsonResponse(exact);
            }
            if (url.pathname.endsWith("/actions/act_1/review") && request.method === "PUT") {
              postedBody = await request.json();
              return jsonResponse({ action: completed, ...exact });
            }
            if (url.pathname === "/api/rooms/abc123") {
              return jsonResponse({
                participants,
                actions: [completed],
                artifacts: [exact.artifact],
              });
            }
            throw new Error(`unexpected request ${request.method} ${url.pathname}`);
          }),
          env,
        },
      ),
    ).toBe(0);
    expect(postedBody).toEqual({
      expected_action_revision: "ar_10",
      artifact_revision_id: "rev_uuid_5",
      disposition: "approve",
      body: "Looks exact",
    });
    expect(stdout).toContain("State: completed");
    expect(stdout).toContain('"revision_id":"rev_uuid_5"');
  });

  it("shows the editor every formal response after an exact review requests changes", async () => {
    const env = providerEnv(
      roomConfig({
        participantId: "p_northline",
        token: "t_northline",
        coordinationStateCapability: "experimental",
      }),
    );
    const action = {
      id: "act_1",
      revision: "ar_11",
      title: "Draft the term sheet",
      status: "in_progress",
      holder_id: "p_northline",
      target_artifact_id: "doc_1",
      mode: "handoff",
      completion: "group",
      review: {
        state: "changes_requested",
        artifact_revision_id: "rev_uuid_5",
        requested_by_id: "p_northline",
        required_participant_ids: ["p_northline", "p_cobalt"],
        responded_participant_ids: ["p_northline", "p_cobalt"],
      },
    };
    const exact = {
      artifact: {
        id: "doc_1",
        current_revision_id: "rev_uuid_5",
        review_status: { current: [], superseded: [] },
      },
      revision: { id: "rev_uuid_5", ordinal: 5, sha256: "d".repeat(64) },
      reviews: [
        {
          reviewer_id: "p_northline",
          disposition: "approve",
          body: null,
        },
        {
          reviewer_id: "p_cobalt",
          disposition: "changes_requested",
          body: "Replace paragraph 4.\nKeep the defined term unchanged.",
        },
      ],
    };
    let stdout = "";
    expect(
      await runRoomCli(["act", "read", "act_1"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: withCoordinationDiscovery(async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (url.pathname.endsWith("/actions/act_1")) return jsonResponse({ action });
          if (url.pathname.endsWith("/artifacts/doc_1")) {
            expect(url.searchParams.get("revision")).toBe("rev_uuid_5");
            return jsonResponse(exact);
          }
          if (url.pathname === "/api/rooms/abc123") {
            return jsonResponse({ participants, actions: [action], artifacts: [exact.artifact] });
          }
          throw new Error(`unexpected request ${request.method} ${url.pathname}`);
        }),
        env,
      }),
    ).toBe(0);
    expect(stdout).toContain("Review round closed on exact artifact revision rev_uuid_5");
    expect(stdout).toContain("Cobalt — changes requested");
    expect(stdout).toContain("Replace paragraph 4.");
    expect(stdout).toContain("Keep the defined term unchanged.");
    expect(stdout).toContain("These responses are pinned to the exact revision above");
  });

  it("wakes a filtered action watcher when that participant owes an exact review", async () => {
    const env = providerEnv(
      roomConfig({
        participantId: "p_cobalt",
        token: "t_cobalt",
        coordinationStateCapability: "experimental",
      }),
    );
    const action = {
      id: "act_1",
      revision: "ar_10",
      title: "Draft the term sheet",
      status: "in_review",
      holder_id: null,
      target_artifact_id: "doc_1",
      mode: "handoff",
      completion: "group",
      review: {
        state: "pending",
        artifact_revision_id: "rev_uuid_5",
        requested_by_id: "p_northline",
        required_participant_ids: ["p_northline", "p_cobalt"],
        responded_participant_ids: ["p_northline"],
      },
    };
    const artifact = {
      id: "doc_1",
      current_revision_id: "rev_uuid_5",
      review_status: {
        current: [
          {
            reviewer_id: "p_northline",
            revision_id: "rev_uuid_5",
            disposition: "approve",
          },
        ],
        superseded: [],
      },
    };
    let stdout = "";

    expect(
      await runRoomCli(["watch", "--action=act_1", "--timeout=10"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: withCoordinationDiscovery(async (input) => {
          const url = new URL(new Request(input).url);
          if (url.pathname === "/api/rooms/abc123") {
            return jsonResponse({ participants, actions: [action], artifacts: [artifact] });
          }
          if (url.pathname.endsWith("/actions/act_1")) {
            return jsonResponse({ action });
          }
          throw new Error(`unexpected request ${url.pathname}`);
        }),
        env,
      }),
    ).toBe(0);
    expect(stdout).toContain("Review is open on exact artifact revision rev_uuid_5");
    expect(stdout).toContain("Required: grp act review act_1");
    expect(stdout).not.toContain("Nothing relevant changed");
  });

  it("tells a reviewer that a recorded response completes this review-round obligation", async () => {
    const env = providerEnv(
      roomConfig({
        participantId: "p_cobalt",
        token: "t_cobalt",
        coordinationStateCapability: "experimental",
      }),
    );
    const action = {
      id: "act_1",
      revision: "ar_11",
      title: "Draft the term sheet",
      status: "in_review",
      holder_id: null,
      target_artifact_id: "doc_1",
      mode: "handoff",
      completion: "group",
      review: {
        state: "pending",
        artifact_revision_id: "rev_uuid_5",
        requested_by_id: "p_northline",
        required_participant_ids: ["p_northline", "p_cobalt", "p_neon"],
        responded_participant_ids: ["p_northline", "p_cobalt"],
      },
    };
    const artifact = {
      id: "doc_1",
      current_revision_id: "rev_uuid_5",
      review_status: {
        current: [
          {
            reviewer_id: "p_cobalt",
            revision_id: "rev_uuid_5",
            disposition: "changes_requested",
          },
        ],
        superseded: [],
      },
    };
    let stdout = "";

    expect(
      await runRoomCli(["act", "read", "act_1"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: withCoordinationDiscovery(async (input) => {
          const url = new URL(new Request(input).url);
          if (url.pathname.endsWith("/actions/act_1")) return jsonResponse({ action });
          if (url.pathname === "/api/rooms/abc123") {
            return jsonResponse({ participants, actions: [action], artifacts: [artifact] });
          }
          throw new Error(`unexpected request ${url.pathname}`);
        }),
        env,
      }),
    ).toBe(0);
    expect(stdout).toContain("Your response is recorded: changes_requested");
    expect(stdout).toContain("No review response is outstanding for you in this round");
    expect(stdout).toContain("grp watch --action=act_1");
  });

  it("keeps group-completion rationale in discussion, outside the exact artifact result", async () => {
    const env = providerEnv(roomConfig());
    let fetches = 0;
    let error = "";
    expect(
      await runRoomCli(["act", "complete", "act_1", "--result-text=Please approve this"], {
        stdout: () => {},
        stderr: (text) => {
          error += text;
        },
        fetch: async () => {
          fetches += 1;
          return jsonResponse({
            action: {
              id: "act_1",
              revision: "ar_9",
              status: "in_progress",
              holder_id: "p_northline",
              target_artifact_id: "doc_1",
              completion: "group",
            },
          });
        },
        env,
      }),
    ).toBe(1);
    expect(fetches).toBe(1);
    expect(error).toContain("group completion with an artifact uses exact review");
    expect(error).toContain("grp act request-review act_1");
  });

  it("renders a group-completion read as one exact-result path, not a generic ballot workflow", async () => {
    const env = providerEnv(
      roomConfig({
        token: "t_northline",
        observedStateRevision: "11",
        coordinationStateCapability: "experimental",
      }),
    );
    const result = {
      kind: "text",
      reference: "The principal approves the revised terms.",
    };
    const action = {
      id: "act_principal",
      revision: "7",
      title: "Consult the principal",
      status: "awaiting_completion",
      holder_id: "p_northline",
      completion_proposed_by_id: "p_northline",
      completion_decision_id: "decision_3",
      mode: "independent",
      completion: "group",
      result,
    };
    const decision = {
      id: "decision_3",
      seq: 3,
      question: 'Mark action "Consult the principal" complete with this exact result?',
      options: [`Mark action complete with text result (sha256:${"a".repeat(64)})`],
      status: "voting",
      agreement: true,
      choices_cast: 0,
      eligible_voters: 2,
      action_completion: {
        action_id: "act_principal",
        action_revision: "7",
        result,
        eligible: true,
        accepted_by_you: false,
      },
    };
    let stdout = "";

    expect(
      await runRoomCli(["read", "--snapshot"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            slug: "abc123",
            status: "open",
            role: "participant",
            state_revision: "11",
            brief: "An action completion decision is open.",
            decision,
            discussion: [],
            working_signals: [],
            participants,
            actions: [action],
            artifacts: [],
          }),
        env,
      }),
    ).toBe(0);
    expect(stdout).toContain('Exact text result: "The principal approves the revised terms."');
    expect(stdout.match(/grp accept 1 --decision=3/g)).toHaveLength(1);
    expect(stdout.match(/grp watch --action=act_principal/g)).toHaveLength(1);
    expect(stdout).not.toContain('grp choose "<option>"');
    expect(stdout).not.toContain('grp propose "..."');
    expect(stdout).not.toContain("shared turn — non-holders watch");
  });

  it("renders a delta completion proposal as the exact-result path instead of generic choice advice", async () => {
    const env = providerEnv(
      roomConfig({
        token: "t_cobalt",
        observedStateRevision: "11",
        coordinationStateCapability: "experimental",
      }),
    );
    const result = {
      kind: "artifact_revision",
      reference: {
        artifact_id: "doc_1",
        revision_id: "rev_uuid_5",
        sha256: "d".repeat(64),
      },
    };
    const action = {
      id: "act_1",
      revision: "10",
      title: "Revise the shared plan",
      status: "awaiting_completion",
      holder_id: "p_northline",
      completion_proposed_by_id: "p_northline",
      completion_decision_id: "decision_3",
      mode: "handoff",
      completion: "group",
      result,
    };
    const decision = {
      id: "decision_3",
      seq: 3,
      question: 'Mark action "Revise the shared plan" complete with this exact result?',
      options: [
        `Mark action complete with artifact doc_1 revision rev_uuid_5 (sha256:${"d".repeat(64)})`,
      ],
      status: "voting",
      agreement: true,
      action_completion: {
        action_id: "act_1",
        action_revision: "10",
        result,
        eligible: true,
        accepted_by_you: false,
      },
    };
    let stdout = "";

    expect(
      await runRoomCli(["read"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            slug: "abc123",
            status: "open",
            state: "seq 3 seeking agreement — 0/2 accepted",
            your_status: "you have not chosen on the open decision",
            decision,
            new: [{ seq: 9, type: "action_completion_proposed", action_id: "act_1" }],
            current_through: 9,
            participants,
            actions: [action],
            artifacts: [],
          }),
        env,
      }),
    ).toBe(0);
    expect(stdout).toContain("grp artifact read doc_1 --revision-id=rev_uuid_5");
    expect(stdout).toContain("grp accept 1 --decision=3");
    expect(stdout).toContain("grp watch --action=act_1");
    expect(stdout).not.toContain('grp choose "<option>"');
  });

  it("wakes a filtered watcher for the completion decision instead of treating it as assigned work", async () => {
    const env = providerEnv(roomConfig({ token: "t_northline" }));
    const awaiting = {
      id: "act_1",
      revision: "ar_10",
      title: "Draft the term sheet",
      status: "awaiting_completion",
      holder_id: "p_northline",
      completion_proposed_by_id: "p_northline",
      completion_decision_id: "decision_3",
      mode: "turn_taking",
      completion: "group",
    };
    let stdout = "";

    expect(
      await runRoomCli(["watch", "--action=act_1", "--timeout=10"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input) => {
          const url = new URL(new Request(input).url);
          if (url.pathname === "/api/rooms/abc123") {
            return jsonResponse({ participants, actions: [awaiting], decisions: [] });
          }
          if (url.pathname.endsWith("/actions/act_1")) {
            return jsonResponse({ action: awaiting });
          }
          if (url.pathname.endsWith("/next-action")) {
            return jsonResponse({
              status: "actionable",
              decision: {
                seq: 3,
                question: 'Mark action "Draft the term sheet" complete with this exact result?',
                status: "voting",
                voting_ends_at: "2026-08-23T00:00:00.000Z",
                completion_action_id: "act_1",
              },
            });
          }
          throw new Error(`unexpected request ${url.pathname}`);
        },
        env,
      }),
    ).toBe(0);
    expect(stdout).toContain("The room needs your decision about action completion");
    expect(stdout).toContain("grp act read act_1");
    expect(stdout).toContain("grp accept 1 --decision=3");
    expect(stdout).not.toContain("Action act_1 is now yours");
  });

  it("keeps an accepted participant waiting until the completion decision resolves", async () => {
    vi.useFakeTimers();
    try {
      const env = providerEnv(roomConfig({ token: "t_northline" }));
      const awaiting = {
        id: "act_1",
        revision: "ar_10",
        title: "Draft the term sheet",
        status: "awaiting_completion",
        holder_id: "p_northline",
        completion_proposed_by_id: "p_northline",
        completion_decision_id: "decision_3",
        mode: "turn_taking",
      };
      const completed = { ...awaiting, revision: "ar_11", status: "completed" };
      let actionReads = 0;
      let stdout = "";
      const run = runRoomCli(["watch", "--action=act_1", "--timeout=10"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input) => {
          const url = new URL(new Request(input).url);
          if (url.pathname === "/api/rooms/abc123") {
            const action = actionReads >= 2 ? completed : awaiting;
            return jsonResponse({ participants, actions: [action], decisions: [] });
          }
          if (url.pathname.endsWith("/actions/act_1")) {
            actionReads += 1;
            return jsonResponse({ action: actionReads >= 2 ? completed : awaiting });
          }
          if (url.pathname.endsWith("/next-action")) {
            return new Promise<Response>(() => undefined);
          }
          throw new Error(`unexpected request ${url.pathname}`);
        },
        env,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await run).toBe(0);
      expect(actionReads).toBe(2);
      expect(stdout).toContain("Action act_1 terminal");
      expect(stdout).not.toContain("is now yours");
      expect(stdout).not.toContain("grp act complete act_1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes only to revise, then restores the group-completion path", async () => {
    const env = providerEnv(
      roomConfig({
        token: "t_northline",
        observedStateRevision: "11",
        coordinationStateCapability: "experimental",
      }),
    );
    const awaiting = {
      id: "act_1",
      revision: "ar_10",
      title: "Consult the principal",
      status: "awaiting_completion",
      holder_id: "p_northline",
      completion_proposed_by_id: "p_northline",
      completion_decision_id: "decision_3",
      mode: "independent",
      completion: "group",
      result: { kind: "text", reference: "Proceed." },
    };
    const resumed = {
      ...awaiting,
      revision: "ar_11",
      status: "in_progress",
      completion_decision_id: null,
      completion_proposed_by_id: null,
      result: null,
    };
    let body: unknown;
    let guard: string | null = null;
    let stdout = "";

    expect(
      await runRoomCli(
        ["act", "resume", "act_1", "--reason=The principal supplied one correction"],
        {
          stdout: (text) => {
            stdout += text;
          },
          stderr: () => {},
          fetch: withCoordinationDiscovery(async (input, init) => {
            const request = new Request(input, init);
            const url = new URL(request.url);
            if (url.pathname.endsWith("/actions/act_1") && request.method === "GET") {
              return jsonResponse({ action: awaiting });
            }
            if (url.pathname.endsWith("/actions/act_1/resume") && request.method === "POST") {
              guard = request.headers.get("x-grp-expected-room-revision");
              body = await request.json();
              return jsonResponse({ action: resumed, state_revision: "12" });
            }
            if (url.pathname === "/api/rooms/abc123" && request.method === "GET") {
              return jsonResponse({ participants, actions: [resumed], decisions: [] });
            }
            throw new Error(`unexpected request ${request.method} ${url.pathname}`);
          }),
          env,
        },
      ),
    ).toBe(0);
    expect(guard).toBe("11");
    expect(body).toEqual({
      expected_revision: "ar_10",
      reason: "The principal supplied one correction",
    });
    expect(stdout).toContain("Action act_1 resumed for revision");
    expect(stdout).toContain('grp act complete act_1 --result-text="What happened"');
    expect(stdout).not.toContain("grp accept 1");
  });

  it("binds completion to the host's exact artifact result without asking the agent for hashes", async () => {
    const env = providerEnv(roomConfig());
    let completionBody: unknown;
    const active = {
      id: "act_1",
      revision: "ar_9",
      title: "Draft the term sheet",
      status: "active",
      holder_id: "p_northline",
      target_artifact_id: "doc_1",
      mode: "turn_taking",
    };
    const completed = {
      ...active,
      revision: "ar_10",
      status: "completed",
      result: {
        kind: "artifact_revision",
        reference: {
          artifact_id: "doc_1",
          revision_id: "rev_uuid_5",
          sha256: "d".repeat(64),
        },
      },
    };

    expect(
      await runRoomCli(["act", "complete", "act_1"], {
        stdout: () => {},
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const pathname = new URL(request.url).pathname;
          if (request.method === "GET" && pathname.endsWith("/actions/act_1")) {
            return jsonResponse({ action: active });
          }
          if (request.method === "POST" && pathname.endsWith("/actions/act_1/complete")) {
            completionBody = await request.json();
            return jsonResponse({ action: completed });
          }
          if (request.method === "GET" && pathname === "/api/rooms/abc123") {
            return jsonResponse({ participants, actions: [completed], decisions: [] });
          }
          throw new Error(`unexpected request ${request.method} ${pathname}`);
        },
        env,
      }),
    ).toBe(0);
    expect(completionBody).toEqual({ expected_revision: "ar_9" });
  });

  it("a filtered action watch returns on terminal state and stays one attention primitive", async () => {
    const env = providerEnv(roomConfig());
    const completed = {
      id: "act_1",
      revision: "ar_10",
      title: "Draft the term sheet",
      status: "completed",
      holder_id: "p_cobalt",
      mode: "turn_taking",
    };
    let stdout = "";
    const code = await runRoomCli(["watch", "--action=act_1", "--timeout=1"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith("/actions/act_1")) return jsonResponse({ action: completed });
        if (pathname === "/api/rooms/abc123") {
          return jsonResponse({ participants, actions: [completed], decisions: [] });
        }
        throw new Error(`unexpected request ${request.method} ${pathname}`);
      },
      env,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Action act_1 terminal.");
    expect(stdout).toContain("Read room changes");
  });

  it("renders one takeover path when an exact action watch finds recovery", async () => {
    const env = providerEnv(roomConfig());
    const recoverable = {
      id: "act_1",
      revision: "ar_11",
      title: "Check the shared draft",
      status: "in_progress",
      holder_id: "p_cobalt",
      holder_epoch: "3",
      mode: "turn_taking",
      lease_expires_at: "2026-08-22T03:00:00.000Z",
      recoverable: true,
    };
    let stdout = "";

    expect(
      await runRoomCli(["watch", "--action=act_1", "--timeout=1"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const pathname = new URL(request.url).pathname;
          if (pathname.endsWith("/actions/act_1")) {
            return jsonResponse({ action: recoverable });
          }
          if (pathname === "/api/rooms/abc123") {
            return jsonResponse({ participants, actions: [recoverable], decisions: [] });
          }
          if (pathname.endsWith("/next-action")) return jsonResponse({ status: "timeout" });
          throw new Error(`unexpected request ${request.method} ${pathname}`);
        },
        env,
      }),
    ).toBe(0);
    expect(stdout).toContain("Action act_1 recoverable.");
    expect(stdout).toContain(
      'grp act takeover act_1 --reason="Resuming after holder lease expiry"',
    );
    expect(stdout).not.toContain("grp watch --action=act_1");
  });

  it("makes broad watch wake on computed action recovery without a room event", async () => {
    const env = providerEnv(roomConfig({ token: "t_northline", lastSeenSeq: 12 }));
    const recoverable = {
      id: "act_research",
      revision: "ar_4",
      title: "Research the source data",
      status: "in_progress",
      holder_id: "p_cobalt",
      holder_epoch: "2",
      mode: "turn_taking",
      lease_expires_at: "2026-08-22T03:00:00.000Z",
      recoverable: true,
    };
    let stdout = "";
    let activityQuery: URLSearchParams | null = null;

    expect(
      await runRoomCli(["watch", "--timeout=30"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (url.pathname.endsWith("/events/stream")) return new Promise<Response>(() => {});
          if (url.pathname.endsWith("/next-action")) {
            activityQuery = url.searchParams;
            return jsonResponse({ status: "action_recovery", action: recoverable });
          }
          if (url.pathname === "/api/rooms/abc123") {
            return jsonResponse({ participants, actions: [recoverable], decisions: [] });
          }
          throw new Error(`unexpected request ${request.method} ${url.pathname}`);
        },
        env,
      }),
    ).toBe(0);
    expect(activityQuery?.get("for")).toBe("activity");
    expect(activityQuery?.get("since_seq")).toBe("12");
    expect(stdout).toContain("Action act_research recoverable.");
    expect(stdout).toContain("grp act takeover act_research");
    expect(stdout).not.toContain("no question is open");
  });

  it("projects recovery instead of decision-only copy when the broad timeout wins the race", async () => {
    vi.useFakeTimers();
    try {
      const env = providerEnv(roomConfig({ token: "t_northline", lastSeenSeq: 12 }));
      const recoverable = {
        id: "act_principal",
        revision: "ar_7",
        title: "Confirm instructions with the principal",
        status: "in_progress",
        holder_id: "p_cobalt",
        holder_epoch: "4",
        mode: "turn_taking",
        lease_expires_at: "2026-08-22T03:00:00.000Z",
        recoverable: true,
      };
      let stdout = "";
      const result = runRoomCli(["watch", "--timeout=1"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (url.pathname.endsWith("/events/stream") || url.pathname.endsWith("/next-action")) {
            return new Promise<Response>(() => {});
          }
          if (url.pathname === "/api/rooms/abc123") {
            return jsonResponse({
              slug: "abc123",
              decision: null,
              participants,
              actions: [recoverable],
            });
          }
          throw new Error(`unexpected request ${request.method} ${url.pathname}`);
        },
        env,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await result).toBe(0);
      expect(stdout).toContain("Action act_principal recoverable.");
      expect(stdout).toContain("grp act takeover act_principal");
      expect(stdout).not.toContain("no question is open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects retired workflow nouns and unsafe external references before network access", async () => {
    const env = providerEnv(roomConfig());
    for (const argv of [
      ["artifact", "wait", "doc_1"],
      ["artifact", "review", "doc_1", "rev_1"],
    ]) {
      let stderr = "";
      let fetches = 0;
      expect(
        await runRoomCli(argv, {
          stdout: () => {},
          stderr: (text) => {
            stderr += text;
          },
          fetch: async () => {
            fetches += 1;
            return jsonResponse({});
          },
          env,
        }),
      ).toBe(1);
      expect(stderr).toContain("use grp act and grp watch");
      expect(fetches).toBe(0);
    }

    let unsafeFetches = 0;
    let unsafeError = "";
    expect(
      await runRoomCli(
        [
          "artifact",
          "create",
          "--name=External",
          "--kind=external",
          "--action=act_1",
          "--external-provider=git",
          "--uri=https://secret@example.com/repo.git",
          "--path=terms.md",
          `--provider-revision=${"e".repeat(40)}`,
          `--sha256=${"f".repeat(64)}`,
        ],
        {
          stdout: () => {},
          stderr: (text) => {
            unsafeError += text;
          },
          fetch: async () => {
            unsafeFetches += 1;
            return jsonResponse({});
          },
          env,
        },
      ),
    ).toBe(1);
    expect(unsafeError).toContain("credential-free HTTPS");
    expect(unsafeFetches).toBe(0);
  });

  it("teaches the three action modes and rejects the retired defer flag", async () => {
    let help = "";
    expect(
      await runRoomCli(["act", "--help"], {
        stdout: (text) => {
          help += text;
        },
        stderr: () => {},
        fetch: async () => {
          throw new Error("help must not fetch");
        },
        env: providerEnv(roomConfig()),
      }),
    ).toBe(0);
    expect(help).toContain("single   one holder works; peers may continue");
    expect(help).toContain(
      "handoff  one current holder; holder-scoped transitions require that holder",
    );
    expect(help).toContain("all      every required participant reports");
    expect(help).toContain("all defaults to the joined participant roster");
    expect(help).toContain("holder: report done and complete the action");
    expect(help).toContain("group with an artifact: use request-review instead");
    expect(help).toContain("every other eligible participant reviews the same bytes");
    expect(help).toContain("unanimous exact-revision approval completes the action");
    expect(help).toContain("Retract your pending group-completion proposal");
    expect(help).toContain("grp artifact patch ARTIFACT_ID --action=ACTION_ID --file=changes.json");
    expect(help).toContain("grp act request-review ACTION_ID");
    expect(help).toContain("grp act review ACTION_ID --revision=REVISION_ID --approve");
    expect(help).not.toContain("grp act submit");
    expect(help).not.toContain("grp act withdraw");
    expect(help).not.toContain("--defer");

    let error = "";
    let fetches = 0;
    expect(
      await runRoomCli(["act", "start", "--title=Check constraints", "--defer"], {
        stdout: () => {},
        stderr: (text) => {
          error += text;
        },
        fetch: async () => {
          fetches += 1;
          return jsonResponse({});
        },
        env: providerEnv(roomConfig()),
      }),
    ).toBe(1);
    expect(error).toContain("grp act: unknown flag --defer");
    expect(fetches).toBe(0);
  });

  it("starts a handoff action with its initial native artifact in one CLI command", async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "grp-action-artifact-start-"));
    const file = pathJoin(dir, "plan.md");
    writeFileSync(file, "# Shared plan\n\nFirst exact version.\n", "utf8");
    const env = providerEnv(
      roomConfig({
        observedStateRevision: "41",
        coordinationStateCapability: "experimental",
      }),
    );
    const requests: Array<{ path: string; body: unknown; guard: string | null }> = [];
    let stdout = "";
    const fetch = withCoordinationDiscovery(async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      requests.push({
        path,
        body: await request.json(),
        guard: request.headers.get("x-grp-expected-room-revision"),
      });
      if (path.endsWith("/actions")) {
        return jsonResponse({
          action: {
            id: "act_1",
            revision: "ar_1",
            title: "Revise the shared plan",
            status: "in_progress",
            holder_id: "p_me",
            mode: "handoff",
            completion: "group",
          },
          state_revision: "42",
        });
      }
      if (path.endsWith("/artifacts")) {
        return jsonResponse({
          artifact: {
            id: "doc_1",
            revision: "rr_1",
            current_revision_id: "rev_1",
            name: "Shared plan",
            action_id: "act_1",
          },
          current_revision: { id: "rev_1", ordinal: 1, sha256: "a".repeat(64) },
          action: { id: "act_1", revision: "ar_2" },
          state_revision: "43",
        });
      }
      throw new Error(`unexpected request ${path}`);
    });

    expect(
      await runRoomCli(
        [
          "act",
          "start",
          "--title=Revise the shared plan",
          "--mode=handoff",
          "--completion=group",
          "--artifact-name=Shared plan",
          `--artifact-file=${file}`,
        ],
        {
          stdout: (text) => {
            stdout += text;
          },
          stderr: () => {},
          fetch,
          env,
        },
      ),
    ).toBe(0);

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      path: "/api/rooms/abc123/actions",
      guard: "41",
      body: {
        title: "Revise the shared plan",
        start: true,
        mode: "handoff",
        completion: "group",
      },
    });
    expect(requests[1]).toMatchObject({
      path: "/api/rooms/abc123/artifacts",
      guard: null,
      body: {
        name: "Shared plan",
        kind: "native",
        content: "# Shared plan\n\nFirst exact version.\n",
        action_id: "act_1",
        expected_action_revision: "ar_1",
      },
    });
    expect(stdout).toContain("Artifact doc_1 created and attached to action act_1.");
    expect(stdout).toContain("Revision: rev_1");
  });

  it("rejects invalid action-artifact convenience before any remote request", async () => {
    const cases = [
      {
        argv: ["act", "start", "--title=Draft", "--artifact-name=Draft"],
        message: "--artifact-name and --artifact-file must be used together",
      },
      {
        argv: [
          "act",
          "start",
          "--title=Draft",
          "--mode=all",
          "--artifact-name=Draft",
          "--artifact-file=draft.md",
        ],
        message: "--mode=all cannot own one artifact",
      },
      {
        argv: [
          "act",
          "start",
          "--title=Draft",
          "--artifact=doc_existing",
          "--artifact-name=Draft",
          "--artifact-file=draft.md",
        ],
        message: "either an existing --artifact target",
      },
    ];
    for (const testCase of cases) {
      let stderr = "";
      let fetches = 0;
      expect(
        await runRoomCli(testCase.argv, {
          stdout: () => {},
          stderr: (text) => {
            stderr += text;
          },
          fetch: async () => {
            fetches += 1;
            return jsonResponse({});
          },
          env: providerEnv(roomConfig()),
        }),
      ).toBe(1);
      expect(fetches).toBe(0);
      expect(stderr).toContain(testCase.message);
    }
  });

  it("preserves and explains an action when the composed artifact request fails", async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "grp-action-artifact-recovery-"));
    const file = pathJoin(dir, "plan.md");
    writeFileSync(file, "# Shared plan\n", "utf8");
    const env = providerEnv(
      roomConfig({
        observedStateRevision: "41",
        coordinationStateCapability: "experimental",
      }),
    );
    let writes = 0;
    let stderr = "";
    const fetch = withCoordinationDiscovery(async (input) => {
      const path = new URL(new Request(input).url).pathname;
      writes += 1;
      if (path.endsWith("/actions")) {
        return jsonResponse({
          action: { id: "act_1", revision: "ar_1" },
          state_revision: "42",
        });
      }
      return jsonResponse(
        { error: { code: "input.invalid", message: "artifact name is unavailable" } },
        400,
      );
    });

    expect(
      await runRoomCli(
        [
          "act",
          "start",
          "--title=Revise the shared plan",
          "--artifact-name=Shared plan",
          `--artifact-file=${file}`,
        ],
        {
          stdout: () => {},
          stderr: (text) => {
            stderr += text;
          },
          fetch,
          env,
        },
      ),
    ).toBe(1);
    expect(writes).toBe(2);
    expect(stderr).toContain("Action act_1 started, but its artifact was not created.");
    expect(stderr).toContain("The action remains in the room; nothing was silently canceled.");
    expect(stderr).toContain("grp artifact create");
    expect(stderr).toContain("--action=act_1");
    expect(stderr).toContain(file);
  });

  it("has no submit or withdraw compatibility command", async () => {
    for (const argv of [
      ["act", "submit", "act_1"],
      ["act", "withdraw", "act_1"],
      ["act", "submit", "--help"],
    ]) {
      let stderr = "";
      let fetches = 0;
      expect(
        await runRoomCli(argv, {
          stdout: () => {},
          stderr: (text) => {
            stderr += text;
          },
          fetch: async () => {
            fetches += 1;
            return jsonResponse({});
          },
          env: providerEnv(roomConfig()),
        }),
      ).toBe(1);
      if (argv.at(-1) === "act_1") {
        expect(stderr).toContain(`unknown act subcommand: ${argv[1]}`);
        expect(stderr).toContain("Did you mean: grp act read act_1");
      } else {
        expect(stderr).toContain(
          "usage: grp act start|read|reviews|take|handoff|request-review|review|review-note|complete|resume|fail|cancel|takeover",
        );
      }
      expect(fetches).toBe(0);
    }
  });

  it("explains the one completion verb on its focused help surfaces", async () => {
    let complete = "";
    expect(
      await runRoomCli(["act", "complete", "--help"], {
        stdout: (text) => {
          complete += text;
        },
        stderr: () => {},
        fetch: async () => {
          throw new Error("help must not fetch");
        },
        env: providerEnv(roomConfig()),
      }),
    ).toBe(0);
    expect(complete).toContain("Report that your action work is done.");
    expect(complete).toContain("For holder completion");
    expect(complete).toContain("For group completion");
    expect(complete).toContain("group completion without an artifact");
    expect(complete).toContain("provide exact --result-text");
    expect(complete).toContain("use grp act request-review instead");
    expect(complete).toContain("For all-participant actions");
    expect(complete).not.toContain("submit");
    expect(complete).not.toContain("withdraw");

    let resume = "";
    expect(
      await runRoomCli(["act", "resume", "--help"], {
        stdout: (text) => {
          resume += text;
        },
        stderr: () => {},
        fetch: async () => {
          throw new Error("help must not fetch");
        },
        env: providerEnv(roomConfig()),
      }),
    ).toBe(0);
    expect(resume).toContain(
      "Resume your action when its group-completion proposal needs revision.",
    );
    expect(resume).toContain("Only the current completion proposer");
    expect(resume).not.toContain("submit");
    expect(resume).not.toContain("withdraw");
  });

  it("keeps the normal artifact help laconic and action-centered", async () => {
    let stdout = "";
    expect(
      await runRoomCli(["artifact", "--help"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: async () => {
          throw new Error("help must not fetch");
        },
        env: providerEnv(roomConfig()),
      }),
    ).toBe(0);
    expect(stdout).toContain("--action=ID");
    expect(stdout).not.toContain("artifact wait");
    expect(stdout).not.toContain("artifact review");
    expect(stdout).not.toContain("artifact finalize");
    expect(stdout).not.toContain("claim");
  });
});

function providerEnv(config: unknown): Record<string, string | undefined> {
  const dir = mkdtempSync(pathJoin(tmpdir(), "grp-room-provider-test-"));
  const path = pathJoin(dir, "config.json");
  writeFileSync(path, `${JSON.stringify(config)}\n`, "utf8");
  return { GRP_CONFIG: path };
}

function operatorEnv(): Record<string, string | undefined> {
  return {
    ...providerEnv({ providers: {} }),
    GRP_BASE_URL: "https://operator.example",
  };
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
      fetch: withCoordinationDiscovery(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          ok: true,
          slug: "abc123",
          decision: { id: "d1", seq: 1, question: "Which package?", agreement: true },
        });
      }, false),
      env,
    });
    expect(code).toBe(0);
    expect(bodies[0]).toMatchObject({ question: "Which package?", agreement: true });
    expect(stdout).toContain('Question opened (agreement): "Which package?"');
    expect(stdout).toContain("resolves only when every voter accepts the same option");
    expect(stdout).not.toContain("Exact-document note");
  });

  it("cancels an open question behind a fresh room guard and preserves its record", async () => {
    const requests: Array<{
      method: string;
      path: string;
      body: unknown;
      revision: string | null;
    }> = [];
    const env = providerEnv({
      currentRoom: {
        baseUrl: "https://operator.example",
        slug: "abc123",
        token: "t_1",
        observedStateRevision: "41",
        coordinationStateCapability: "experimental",
      },
      providers: {},
    });
    let stdout = "";
    const code = await runRoomCli(["cancel", "1", "--reason=The signed source data changed"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: withCoordinationDiscovery(async (input, init) => {
        const request = new Request(input, init);
        requests.push({
          method: request.method,
          path: new URL(request.url).pathname,
          body: await request.json(),
          revision: request.headers.get("x-grp-expected-room-revision"),
        });
        return jsonResponse(
          {
            ok: true,
            canceled: true,
            slug: "abc123",
            state_revision: "44",
            decision: {
              id: "d1",
              seq: 1,
              question: "Approve exact artifact v3?",
              status: "resolved",
              resolved_outcome: "canceled",
            },
            reason: "The signed source data changed",
            receipt_hash: "sha256:canceled",
          },
          200,
        );
      }),
      env,
    });

    expect(code).toBe(0);
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/api/rooms/abc123/decisions/1/cancel",
        body: { reason: "The signed source data changed" },
        revision: "41",
      },
    ]);
    expect(stdout).toContain("Decision #1 canceled.");
    expect(stdout).toContain(
      "Its question, options, choices, and abstentions remain in the record",
    );
    expect(stdout).toContain("Open a corrected question as a new decision");
    expect(stdout).toContain("sha256:canceled");
    expect(JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8")).currentRoom).toMatchObject({
      observedStateRevision: "44",
    });
  });

  it("does not expose replacement or a stale-write bypass for decision cancellation", async () => {
    const env = providerEnv({
      currentRoom: {
        baseUrl: "https://operator.example",
        slug: "abc123",
        token: "t_1",
        observedStateRevision: "41",
      },
      providers: {},
    });
    let calls = 0;
    const errors: string[] = [];
    const io = {
      stdout: () => {},
      stderr: (text: string) => errors.push(text),
      fetch: async () => {
        calls += 1;
        return jsonResponse({});
      },
      env,
    };

    expect(await runRoomCli(["ask", "Changed premise?", "--replace"], io)).toBe(1);
    expect(await runRoomCli(["cancel", "1", "--reason=Changed", "--post-anyway"], io)).toBe(1);
    expect(calls).toBe(0);
    expect(errors.join("\n")).toContain("grp ask: unknown flag --replace");
    expect(errors.join("\n")).toContain("grp cancel: unknown flag --post-anyway");
  });

  it("does not advertise an unsupported bypass after a stale cancellation", async () => {
    const conflict = {
      error: {
        code: "state.precondition_failed",
        message: "room changed",
        details: {
          expected_state_revision: "41",
          current_state_revision: "45",
          posted: false,
        },
      },
    };
    const env = providerEnv({
      currentRoom: {
        baseUrl: "https://operator.example",
        slug: "abc123",
        token: "t_1",
        observedStateRevision: "41",
        coordinationStateCapability: "experimental",
      },
      providers: {},
    });
    let stderr = "";
    expect(
      await runRoomCli(["cancel", "1", "--reason=Changed"], {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch: withCoordinationDiscovery(async () => jsonResponse(conflict, 412)),
        env,
      }),
    ).toBe(1);
    expect(stderr).toContain("Nothing was changed");
    expect(stderr).toContain("Reading does not cancel your intended action");
    expect(stderr).toContain(
      "If the changed state does not affect the intended transition, rerun your original command",
    );
    expect(stderr).not.toContain("--post-anyway");

    let stdout = "";
    expect(
      await runRoomCli(["cancel", "1", "--reason=Changed", "--json"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        fetch: withCoordinationDiscovery(async () => jsonResponse(conflict, 412)),
        env,
      }),
    ).toBe(1);
    expect(JSON.parse(stdout)).not.toHaveProperty("bypass_flag");
  });

  it("requires a cancellation reason before contacting the room", async () => {
    const env = providerEnv({
      currentRoom: {
        baseUrl: "https://operator.example",
        slug: "abc123",
        token: "t_1",
        observedStateRevision: "41",
      },
      providers: {},
    });
    let calls = 0;
    let stderr = "";
    expect(
      await runRoomCli(["cancel", "1"], {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        fetch: async () => {
          calls += 1;
          return jsonResponse({});
        },
        env,
      }),
    ).toBe(1);
    expect(calls).toBe(0);
    expect(stderr).toContain('grp cancel <decision-number|id> --reason="..."');
  });

  it("points a colliding ask to authority-gated cancellation and a new decision", async () => {
    const env = providerEnv({
      currentRoom: {
        baseUrl: "https://operator.example",
        slug: "abc123",
        token: "t_1",
        observedStateRevision: "41",
        coordinationStateCapability: "experimental",
      },
      providers: {},
    });
    let stderr = "";
    const code = await runRoomCli(["ask", "Approve exact artifact v4?", "--option=Approve"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: withCoordinationDiscovery(
        async () => jsonResponse({ error: "a decision is already open (seq 1)" }, 409),
        true,
      ),
      env,
    });

    expect(code).toBe(1);
    expect(stderr).toContain("Questions are immutable");
    expect(stderr).toContain('grp cancel 1 --reason="Premise changed"');
    expect(stderr).toContain('grp ask "<corrected question>"');
    expect(stderr).not.toContain("--replace");
  });

  it("does not infer an artifact workflow from agreement-question vocabulary", async () => {
    const env = providerEnv({
      currentRoom: {
        baseUrl: "https://operator.example",
        slug: "abc123",
        token: "t_1",
        observedStateRevision: "17",
        coordinationStateCapability: "experimental",
      },
      providers: {},
    });
    let stdout = "";
    const question = "Adopt the term sheet clauses as posted in the room?";
    const code = await runRoomCli(["ask", question, "--agreement"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: withCoordinationDiscovery(async () =>
        jsonResponse({
          ok: true,
          slug: "abc123",
          state_revision: "18",
          decision: { id: "d1", seq: 1, question, agreement: true },
        }),
      ),
      env,
    });

    expect(code).toBe(0);
    expect(stdout).toContain('Question opened (agreement): "Adopt the term sheet clauses');
    expect(stdout).not.toContain("Exact-document note");
    expect(stdout).not.toContain("grp artifact create");
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

  it("--snapshot --ack advances the mark through current_through (WR11-1)", async () => {
    // Run 11's stale wakes: wake parks the mark at seq-1, the follow-up
    // `read --snapshot` used to leave it there, and the next bare watch
    // re-fired the same event. A full picture now advances the mark.
    const env = providerEnv(roomConfig({ lastSeenSeq: 30 }));
    let sinceParam: string | null = "unset";
    const code = await runRoomCli(["read", "--snapshot", "--ack"], {
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

  it("watch → read --snapshot → watch does not re-fire the pointer wake", async () => {
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
      await runRoomCli(["read", "--snapshot"], {
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

  it("an acknowledged first-contact snapshot sets the mark for the next delta", async () => {
    const env = providerEnv(roomConfig());
    const code = await runRoomCli(["read", "--ack"], {
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
    const code = await runRoomCli(["read", "--snapshot"], {
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
      observedStateRevision: "opaque-10",
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
      state_revision: "opaque-13",
      more: {},
    });
  };

  it("emits every complete event across local pages before advancing once", async () => {
    const env = providerEnv(roomConfig());
    let firstPage = "";
    expect(
      await runRoomCli(["read", "--ack"], {
        stdout: (text) => {
          firstPage += text;
        },
        stderr: () => {},
        fetch: deltaFetch,
        env,
      }),
    ).toBe(0);

    expect(firstPage).toContain("first complete event line 60");
    expect(firstPage).toContain("second complete event line 60");
    expect(firstPage).toContain("later event remains readable");
    expect(firstPage).toContain("Catch-up continues below.");
    expect(firstPage).toContain("PARTIAL CATCH-UP — 1 update shown, through event 11");
    expect(firstPage).toContain("COMPLETE CATCH-UP — 2 updates shown, through event 13");
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(13);
    expect(saved.currentRoom.observedStateRevision).toBe("opaque-13");
  });

  it("renders one oversized event whole and advances through it", async () => {
    const env = providerEnv(roomConfig());
    const oversized = Array.from(
      { length: 120 },
      (_, index) => `oversized event line ${index + 1}`,
    ).join("\n");
    let stdout = "";
    const code = await runRoomCli(["read", "--ack"], {
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
    const code = await runRoomCli(["read", "--ack"], {
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
    expect(stdout).toContain(`second-${"b".repeat(60_000)}`);
    expect(stdout).toContain("PARTIAL CATCH-UP — 1 update shown, through event 11");
    expect(stdout).toContain("Catch-up continues below.");
    expect(stdout).toContain("COMPLETE CATCH-UP — 1 update shown, through event 12");
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(12);
  });

  it("keeps JSON reads complete and acknowledges the host high-water mark", async () => {
    const env = providerEnv(roomConfig());
    let stdout = "";
    const code = await runRoomCli(["read", "--json", "--ack"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: deltaFetch,
      env,
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.new).toHaveLength(3);
    expect(parsed._cli).toMatchObject({
      schema: "grp.read.v1",
      kind: "catch_up",
      complete: true,
      cursor: { stored_before: 10, displayed_through: 13, advanced: true, stored_after: 13 },
    });
    const saved = JSON.parse(readFileSync(String(env.GRP_CONFIG), "utf8"));
    expect(saved.currentRoom.lastSeenSeq).toBe(13);
  });

  it("honors limit and since on the human timeline without moving the read mark", async () => {
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
      await runRoomCli(["timeline", "--since=11", "--limit=1"], {
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
      fetch: withCoordinationDiscovery(async (input, init) => {
        const request = new Request(input, init);
        requestedUrl = request.url;
        requestedBody = JSON.parse(String(init?.body));
        return jsonResponse({ id: "m1" });
      }, false),
      env,
    });

    expect(code).toBe(0);
    expect(requestedUrl).toBe("https://operator.example/api/rooms/nightroom2/discuss");
    expect(requestedBody).toEqual({ body: "I am ready" });
    expect(stdout).toContain("Discussion posted. Room: nightroom2.");
    expect(stdout).toContain("Read the room: grp read nightroom2");
    expect(stdout).toContain("Stay with the room: grp watch --timeout=300 nightroom2");
    expect(readProviderConfig(env).currentRoom?.slug).toBe("dayroom01");
  });

  it("accepts an unambiguous remembered-room-first text command", async () => {
    const env = providerEnv(multiRoomConfig());
    let requestedUrl = "";
    let requestedBody: Record<string, unknown> = {};
    const code = await runRoomCli(["discuss", "nightroom2", "I am ready"], {
      stdout: () => {},
      stderr: () => {},
      fetch: withCoordinationDiscovery(async (input, init) => {
        const request = new Request(input, init);
        requestedUrl = request.url;
        requestedBody = JSON.parse(String(init?.body));
        return jsonResponse({ id: "m1" });
      }, false),
      env,
    });

    expect(code).toBe(0);
    expect(requestedUrl).toBe("https://operator.example/api/rooms/nightroom2/discuss");
    expect(requestedBody).toEqual({ body: "I am ready" });
    expect(readProviderConfig(env).currentRoom?.slug).toBe("dayroom01");
  });

  it("keeps every next-action hint scoped after an explicit non-current read", async () => {
    const env = providerEnv(multiRoomConfig());
    let stdout = "";
    const code = await runRoomCli(["read", "nightroom2", "--snapshot"], {
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
      await runRoomCli(["read", "--snapshot", "nightroom2"], {
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

  it("surfaces a recoverable peer-recommended action in the inbox", async () => {
    const env = providerEnv(multiRoomConfig());
    let stdout = "";
    const code = await runRoomCli(["inbox", "--json"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname.includes("dayroom01")) {
          return jsonResponse({
            status: "action_recovery",
            action: {
              id: "action-lease-expired",
              title: "Check the revised model",
              holder_id: "participant-silica",
              mode: "turn_taking",
              recoverable: true,
            },
          });
        }
        return jsonResponse({ status: "timeout" });
      },
      env,
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout).rooms[0]).toMatchObject({
      slug: "dayroom01",
      status: "action_recovery",
      action_id: "action-lease-expired",
      title: "Check the revised model",
      holder_id: "participant-silica",
    });

    stdout = "";
    const textCode = await runRoomCli(["inbox"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        return url.pathname.includes("dayroom01")
          ? jsonResponse({
              status: "action_recovery",
              action: {
                id: "action-lease-expired",
                title: "Check the revised model",
                holder_id: "participant-silica",
              },
            })
          : jsonResponse({ status: "timeout" });
      },
      env,
    });
    expect(textCode).toBe(0);
    expect(stdout).toContain(
      'ACTION READY   dayroom01  "Check the revised model" — holder lease expired',
    );
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
