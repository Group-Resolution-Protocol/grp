import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  foregroundFromResponse,
  insertForegroundBlock,
  renderForegroundBlock,
} from "./foreground-cli.js";
import { runRoomCli } from "./room-cli.js";

const BASE_URL = "https://operator.example";
const SLUG = "phase-room";

function foreground(
  phase: "discussion" | "decision" | "action" | "review",
  epoch: string,
): Record<string, unknown> {
  const base = {
    policy: "phased_serial",
    epoch,
    phase,
    decision_id: phase === "decision" ? "d1" : null,
    action_id: phase === "action" || phase === "review" ? "a1" : null,
    artifact_id: phase === "review" ? "art1" : null,
    artifact_revision_id: phase === "review" ? "rev1" : null,
    return_action_id: null,
    your_obligation: null,
    available_transitions: ["watch"],
  };
  if (phase === "discussion") {
    return {
      ...base,
      available_transitions: ["room.discuss", "decision.open", "action.create", "watch"],
    };
  }
  if (phase === "decision") {
    return {
      ...base,
      your_obligation: { kind: "decision_response", required: false, decision_id: "d1" },
      available_transitions: ["decision.discuss", "decision.choose", "decision.abstain", "watch"],
      decision: {
        id: "d1",
        seq: 2,
        question: "Which route?",
        options: ["left", "right"],
        status: "voting",
        agreement: false,
      },
    };
  }
  const action = {
    id: "a1",
    revision: "1",
    title: "Prepare the record",
    status: phase === "review" ? "in_review" : "in_progress",
    mode: "single",
    completion: "holder",
    holder_id: "p1",
    target_artifact_id: phase === "review" ? "art1" : null,
    required_participant_ids: phase === "review" ? ["p2"] : null,
    responded_participant_ids: phase === "review" ? [] : null,
  };
  if (phase === "review") {
    return {
      ...base,
      your_obligation: {
        kind: "review",
        required: true,
        action_id: "a1",
        artifact_revision_id: "rev1",
      },
      available_transitions: ["action.review", "watch"],
      action,
      artifact: {
        id: "art1",
        exact_revision: { id: "rev1", ordinal: 3, sha256: "abc123" },
      },
    };
  }
  return {
    ...base,
    your_obligation: { kind: "action_holder", required: false, action_id: "a1" },
    available_transitions: ["action.complete", "action.fail", "action.handoff", "watch"],
    action,
  };
}

function roomSnapshot(foregroundProjection: Record<string, unknown>): Record<string, unknown> {
  return {
    slug: SLUG,
    status: "open",
    about: "Exercise one foreground state",
    brief: "",
    participant_count: 1,
    participants: [{ id: "p1", display_name: "Operator", role: "participant" }],
    decisions: [],
    actions: [],
    discussion: [],
    current_through: 0,
    state_revision: "s1",
    foreground: foregroundProjection,
  };
}

function testEnv(room: Record<string, unknown> = {}): Record<string, string> {
  const directory = mkdtempSync(pathJoin(tmpdir(), "grp-spec247-cli-"));
  const configPath = pathJoin(directory, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        providers: {},
        currentRoom: {
          baseUrl: BASE_URL,
          slug: SLUG,
          token: "t1",
          participantId: "p1",
          coordinationStateCapability: "absent",
          ...room,
        },
      },
      null,
      2,
    )}\n`,
  );
  return { GRP_CONFIG: configPath };
}

function emptyTestEnv(): Record<string, string> {
  const directory = mkdtempSync(pathJoin(tmpdir(), "grp-spec247-cli-empty-"));
  const configPath = pathJoin(directory, "config.json");
  writeFileSync(configPath, `${JSON.stringify({ providers: {} }, null, 2)}\n`);
  return { GRP_CONFIG: configPath };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function runIo(
  env: Record<string, string>,
  fetch: typeof globalThis.fetch,
): { io: Parameters<typeof runRoomCli>[1]; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      env,
      fetch,
      stdin: Readable.from([]),
      isInteractive: false,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

describe("spec 247 phased foreground CLI", () => {
  it.each([
    ["deferred", ["create", "--base", BASE_URL, "--about=Deferred room"], "discussion"],
    [
      "immediate question",
      ["create", "--base", BASE_URL, "--about=Question room", "--ask=Which route?"],
      "decision",
    ],
  ])("renders and stores the %s create-time foreground", async (_name, argv, phase) => {
    const env = emptyTestEnv();
    const projection = foreground(phase as "discussion" | "decision", "1");
    const { io, stdout } = runIo(
      env,
      vi.fn(async () =>
        jsonResponse({
          slug: SLUG,
          url: `${BASE_URL}/r/${SLUG}`,
          creator_token: "creator",
          participant_id: "p1",
          about: "Created room",
          config: { visibility: "unlisted" },
          foreground: projection,
        }),
      ) as typeof globalThis.fetch,
    );

    expect(await runRoomCli(argv, io)).toBe(0);
    expect(stdout.join("")).toContain(`Foreground: ${String(phase).toUpperCase()}`);
    expect(stdout.join("").match(/^Foreground:/gm)).toHaveLength(1);
    const stored = JSON.parse(readFileSync(env.GRP_CONFIG, "utf8"));
    expect(stored.currentRoom).toMatchObject({
      slug: SLUG,
      foregroundPolicy: "phased_serial",
      observedForegroundEpoch: "1",
    });
  });

  it.each(["discussion", "decision", "action", "review"] as const)(
    "renders a late join directly into %s",
    async (phase) => {
      const env = emptyTestEnv();
      const { io, stdout } = runIo(
        env,
        vi.fn(async () =>
          jsonResponse({
            participant_token: "joined",
            participant_id: "p2",
            role: "participant",
            foreground: foreground(phase, "6"),
          }),
        ) as typeof globalThis.fetch,
      );

      expect(await runRoomCli(["join", `${BASE_URL}/r/${SLUG}`], io)).toBe(0);
      const rendered = stdout.join("");
      expect(rendered).toMatch(
        new RegExp(`^Joined room ${SLUG}\\.\\nForeground: ${phase.toUpperCase()}`, "m"),
      );
      expect(rendered.match(/^Foreground:/gm)).toHaveLength(1);
      const stored = JSON.parse(readFileSync(env.GRP_CONFIG, "utf8"));
      expect(stored.currentRoom).toMatchObject({
        foregroundPolicy: "phased_serial",
        observedForegroundEpoch: "6",
      });
    },
  );

  it("renders one block before snapshot content and persists the authenticated epoch", async () => {
    const env = testEnv();
    const { io, stdout } = runIo(
      env,
      vi.fn(async () => jsonResponse(roomSnapshot(foreground("discussion", "4")))),
    );

    expect(await runRoomCli(["read", "--snapshot"], io)).toBe(0);
    const rendered = stdout.join("");
    expect(rendered.match(/^Foreground:/gm)).toHaveLength(1);
    expect(rendered.indexOf("Foreground: DISCUSSION")).toBeLessThan(rendered.indexOf("SNAPSHOT"));
    expect(rendered).toContain('grp discuss "..."');
    expect(rendered).not.toContain("Other commands:");
    const stored = JSON.parse(readFileSync(env.GRP_CONFIG, "utf8"));
    expect(stored.currentRoom).toMatchObject({
      foregroundPolicy: "phased_serial",
      observedForegroundEpoch: "4",
    });
  });

  it("binds a mutation to the observed epoch and renders its committed projection", async () => {
    const env = testEnv({
      foregroundPolicy: "phased_serial",
      observedForegroundEpoch: "4",
    });
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-grp-expected-foreground-epoch")).toBe("4");
      return jsonResponse({
        slug: SLUG,
        decision: {
          id: "d1",
          seq: 2,
          question: "Which route?",
          status: "voting",
        },
        foreground: foreground("decision", "5"),
      });
    });
    const { io, stdout } = runIo(env, fetch as typeof globalThis.fetch);

    expect(await runRoomCli(["ask", "Which route?"], io)).toBe(0);
    const rendered = stdout.join("");
    expect(rendered).toMatch(/^Question opened:.*\nForeground: DECISION 2/m);
    expect(rendered.match(/^Foreground:/gm)).toHaveLength(1);
    expect(rendered.match(/^Next:/gm) ?? []).toHaveLength(0);
    const stored = JSON.parse(readFileSync(env.GRP_CONFIG, "utf8"));
    expect(stored.currentRoom.observedForegroundEpoch).toBe("5");
  });

  it("renders action success directly from the committed response without a convenience read", async () => {
    const env = testEnv({
      foregroundPolicy: "phased_serial",
      observedForegroundEpoch: "4",
    });
    const action = (foreground("action", "5").action ?? {}) as Record<string, unknown>;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        return jsonResponse({
          action,
          state_revision: "s2",
          foreground: foreground("action", "5"),
        });
      }
      return jsonResponse(roomSnapshot(foreground("discussion", "6")));
    });
    const { io, stdout } = runIo(env, fetch as typeof globalThis.fetch);

    expect(await runRoomCli(["act", "start", "--title=Prepare the record"], io)).toBe(0);
    const rendered = stdout.join("");
    expect(rendered).toContain("Foreground: ACTION a1");
    expect(rendered).not.toContain("Foreground: DISCUSSION");
    expect(rendered.match(/^Foreground:/gm)).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(readFileSync(env.GRP_CONFIG, "utf8"));
    expect(stored.currentRoom.observedForegroundEpoch).toBe("5");
  });

  it("renders structured conflicts after NOT CHANGED and adopts their recovery epoch", async () => {
    const env = testEnv({
      foregroundPolicy: "phased_serial",
      observedForegroundEpoch: "4",
    });
    const details = foreground("review", "5");
    const { io, stderr } = runIo(
      env,
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: "foreground.conflict",
              message: "discussion is unavailable in review",
              details,
            },
          },
          409,
        ),
      ) as typeof globalThis.fetch,
    );

    expect(await runRoomCli(["discuss", "not now"], io)).toBe(1);
    const rendered = stderr.join("");
    expect(rendered).toMatch(/^NOT CHANGED.*\nForeground: REVIEW a1/m);
    expect(rendered).toContain("Required: grp act review a1");
    expect(rendered.match(/^Foreground:/gm)).toHaveLength(1);
    const stored = JSON.parse(readFileSync(env.GRP_CONFIG, "utf8"));
    expect(stored.currentRoom.observedForegroundEpoch).toBe("5");
  });

  it.each([
    ["the same phase", "discussion", "4"],
    ["a new phase", "review", "5"],
  ] as const)(
    "renders one catch-up block when a stale post reaches %s",
    async (_name, phase, epoch) => {
      const env = testEnv({
        foregroundPolicy: "phased_serial",
        observedForegroundEpoch: "4",
        coordinationStateCapability: "experimental",
        observedStateRevision: "s1",
      });
      const projection = foreground(phase, epoch);
      const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "POST") {
          return jsonResponse(
            {
              error: {
                code: "state.precondition_failed",
                message: "room state changed",
                details: {
                  expected_state_revision: "s1",
                  current_state_revision: "s2",
                  ...projection,
                },
              },
            },
            412,
          );
        }
        return jsonResponse({ ...roomSnapshot(projection), state_revision: "s2" });
      });
      const { io, stderr } = runIo(env, fetch as typeof globalThis.fetch);

      expect(await runRoomCli(["discuss", "stale payload"], io)).toBe(1);
      const rendered = stderr.join("");
      expect(rendered).toContain("NOT POSTED — the room changed since your last read.");
      expect(rendered).toContain("No automatic retry was attempted.");
      expect(rendered.match(/^Foreground:/gm)).toHaveLength(1);
      expect(rendered).toContain(`Foreground: ${phase.toUpperCase()}`);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("forces an authenticated read when phased policy is known but its epoch is absent", async () => {
    const env = testEnv({ foregroundPolicy: "phased_serial" });
    const requests: Array<{ method: string; epoch: string | null }> = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const method = String(init?.method ?? "GET");
      const epoch = new Headers(init?.headers).get("x-grp-expected-foreground-epoch");
      requests.push({ method, epoch });
      if (method === "GET") return jsonResponse(roomSnapshot(foreground("discussion", "7")));
      return jsonResponse({ id: "m1", foreground: foreground("discussion", "7") });
    });
    const { io, stdout } = runIo(env, fetch as typeof globalThis.fetch);

    expect(await runRoomCli(["discuss", "ready"], io)).toBe(0);
    expect(requests).toEqual([
      { method: "GET", epoch: null },
      { method: "POST", epoch: "7" },
    ]);
    expect(stdout.join("").match(/^Foreground:/gm)).toHaveLength(1);
  });

  it("keeps JSON structured without rendered foreground prose", async () => {
    const env = testEnv();
    const response = roomSnapshot(foreground("decision", "8"));
    const { io, stdout } = runIo(
      env,
      vi.fn(async () => jsonResponse(response)) as typeof globalThis.fetch,
    );

    expect(await runRoomCli(["read", "--snapshot", "--json"], io)).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ...response,
      _cli: {
        schema: "grp.read.v1",
        kind: "snapshot",
        complete: true,
        cursor: { advanced: false, displayed_through: 0 },
      },
    });
    expect(stdout.join("")).not.toContain("Foreground:");
  });
});

describe("spec 247 foreground copy matrix", () => {
  const decisionBase = foreground("decision", "9");
  const actionBase = foreground("action", "9");
  const reviewBase = foreground("review", "9");
  const actionRecord = actionBase.action as Record<string, unknown>;
  const fixtures: Array<[string, Record<string, unknown>]> = [
    ["discussion participant", foreground("discussion", "9")],
    ["discussion observer", { ...foreground("discussion", "9"), available_transitions: ["watch"] }],
    [
      "decision proposal collection",
      {
        ...decisionBase,
        your_obligation: null,
        available_transitions: [
          "decision.discuss",
          "decision.propose_option",
          "decision.start_choosing",
          "decision.cancel",
          "watch",
        ],
        decision: {
          ...(decisionBase.decision as Record<string, unknown>),
          status: "proposing",
          options: [],
        },
      },
    ],
    ["decision choice owed", decisionBase],
    ["decision choice recorded", { ...decisionBase, your_obligation: null }],
    [
      "decision ineligible",
      {
        ...decisionBase,
        your_obligation: null,
        available_transitions: ["decision.discuss", "watch"],
      },
    ],
    [
      "decision settling",
      {
        ...decisionBase,
        your_obligation: null,
        decision: { ...(decisionBase.decision as Record<string, unknown>), status: "settling" },
      },
    ],
    [
      "decision agreement",
      {
        ...decisionBase,
        available_transitions: ["decision.discuss", "decision.choose", "watch"],
        decision: { ...(decisionBase.decision as Record<string, unknown>), agreement: true },
      },
    ],
    [
      "decision returns to action",
      { ...decisionBase, return_action_id: "a1", action: actionRecord },
    ],
    ["single action holder", actionBase],
    [
      "single action peer",
      { ...actionBase, your_obligation: null, available_transitions: ["watch"] },
    ],
    ["handoff action holder", { ...actionBase, action: { ...actionRecord, mode: "handoff" } }],
    [
      "handoff action available",
      {
        ...actionBase,
        your_obligation: null,
        available_transitions: ["action.claim", "watch"],
        action: { ...actionRecord, mode: "handoff", holder_id: null, available: true },
      },
    ],
    [
      "handoff action recoverable",
      {
        ...actionBase,
        your_obligation: null,
        available_transitions: ["action.takeover", "watch"],
        action: { ...actionRecord, mode: "handoff", recoverable: true },
      },
    ],
    [
      "all action report required",
      {
        ...actionBase,
        your_obligation: { kind: "action_report", required: true, action_id: "a1" },
        available_transitions: ["action.report", "decision.open_blocking", "watch"],
        action: {
          ...actionRecord,
          mode: "all",
          holder_id: null,
          required_participant_ids: ["p1", "p2", "p3"],
          responded_participant_ids: ["p2"],
        },
      },
    ],
    [
      "all action report recorded",
      {
        ...actionBase,
        your_obligation: null,
        available_transitions: ["watch"],
        action: {
          ...actionRecord,
          mode: "all",
          holder_id: null,
          required_participant_ids: ["p1", "p2", "p3"],
          responded_participant_ids: ["p1", "p2"],
        },
      },
    ],
    ["review response required", reviewBase],
    [
      "review response recorded",
      { ...reviewBase, your_obligation: null, available_transitions: ["action.review", "watch"] },
    ],
    [
      "review requester",
      { ...reviewBase, your_obligation: null, available_transitions: ["action.cancel", "watch"] },
    ],
    [
      "review non-reviewer",
      { ...reviewBase, your_obligation: null, available_transitions: ["watch"] },
    ],
    [
      "changes requested returns to action",
      {
        ...actionBase,
        action: {
          ...actionRecord,
          status: "in_progress",
          target_artifact_id: "art1",
        },
        artifact_id: "art1",
        artifact_revision_id: "rev2",
      },
    ],
    ["unanimous review completion returns to discussion", foreground("discussion", "10")],
  ];

  for (const [name, value] of fixtures) {
    it(name, () => {
      const projection = foregroundFromResponse(value);
      expect(projection).not.toBeNull();
      expect(renderForegroundBlock(projection as NonNullable<typeof projection>)).toMatchSnapshot();
    });
  }

  it("places the block after a persona and result header without changing indented content", () => {
    const source = "You are Moss here.\n\nRoom phase-room\nSNAPSHOT\n  Next:\n    quoted content\n";
    const projection = foregroundFromResponse(foreground("discussion", "9"));
    const rendered = insertForegroundBlock(
      source,
      renderForegroundBlock(projection as NonNullable<typeof projection>),
    );
    expect(rendered).toMatch(
      /^You are Moss here\.\n\nRoom phase-room\nForeground: DISCUSSION[\s\S]*\nSNAPSHOT\n {2}Next:\n {4}quoted content\n$/,
    );
  });

  it("keeps every matrix literal free of experiment scenarios and behavioral coaching", () => {
    const forbidden =
      /\b(?:council|decree|colony|trolley|editor|incident|latency|rollback|concise|patient|quiet|decisive|collaborative|deferential)\b/i;
    for (const [, value] of fixtures) {
      const projection = foregroundFromResponse(value);
      expect(renderForegroundBlock(projection as NonNullable<typeof projection>)).not.toMatch(
        forbidden,
      );
    }
  });
});
