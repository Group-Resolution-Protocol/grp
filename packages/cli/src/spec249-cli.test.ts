import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runRoomCli } from "./room-cli.js";

const BASE_URL = "https://operator.example";
const SLUG = "review-room";

function testEnv(lastSeenSeq = 5): Record<string, string> {
  const directory = mkdtempSync(pathJoin(tmpdir(), "grp-spec249-cli-"));
  const configPath = pathJoin(directory, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify({
      providers: {},
      currentRoom: {
        baseUrl: BASE_URL,
        slug: SLUG,
        token: "participant-token",
        participantId: "p1",
        displayName: "Cobalt",
        role: "participant",
        coordinationStateCapability: "absent",
        lastSeenSeq,
      },
    })}\n`,
  );
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
  stdin: NodeJS.ReadableStream = Readable.from([]),
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      env,
      fetch,
      stdin,
      isInteractive: false,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

function action(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "action-1",
    revision: "action-rev-7",
    title: "Review the charter",
    status: "in_review",
    mode: "handoff",
    completion: "group",
    target_artifact_id: "artifact-1",
    review: {
      state: "pending",
      artifact_revision_id: "revision-2",
      requested_by_id: "p2",
      required_participant_ids: ["p1", "p2"],
      responded_participant_ids: ["p2"],
    },
    ...extra,
  };
}

function artifactRevision(
  id: string,
  ordinal: number,
  changedText: string,
): Record<string, unknown> {
  const unchanged = "Unchanged context. ".repeat(150);
  return {
    artifact: {
      id: "artifact-1",
      revision: `resource-${ordinal}`,
      name: "Charter",
      current_revision_id: "revision-2",
      review_status: { current: [], superseded: [] },
    },
    revision: {
      id,
      ordinal,
      sha256: ordinal === 1 ? "a".repeat(64) : "b".repeat(64),
      blocks: [
        {
          id: "stable-1",
          number: 1,
          kind: "paragraph",
          content: unchanged,
          content_sha256: "same",
        },
        {
          id: "stable-2",
          number: 2,
          kind: "paragraph",
          content: changedText,
          content_sha256: ordinal === 1 ? "before" : "after",
        },
      ],
    },
    reviews: [],
  };
}

describe("spec 249 CLI review convergence", () => {
  it("shows the complete frozen bytes when no trusted reviewer base exists", async () => {
    const env = testEnv();
    const firstAction = action({
      review: {
        state: "pending",
        artifact_revision_id: "revision-1",
        requested_by_id: "p2",
        required_participant_ids: ["p1", "p2"],
        responded_participant_ids: [],
      },
    });
    const presentation = {
      mode: "full",
      fallback_reason: "first_revision",
      current: { id: "revision-1", ordinal: 1, sha256: "a".repeat(64) },
      base: null,
      changed_blocks: null,
      round: 1,
      roster: [{ participant_id: "p1", display_name: "Cobalt", responded: false }],
      your_obligation: "review",
      checkpoint: null,
    };
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/actions/action-1") && url.searchParams.get("reviews") === "1") {
        return jsonResponse({ action: firstAction, review_presentation: presentation, rounds: [] });
      }
      if (url.pathname.endsWith("/actions/action-1")) {
        return jsonResponse({ action: firstAction, review_round: presentation });
      }
      if (url.pathname.endsWith("/artifacts/artifact-1")) {
        return jsonResponse(artifactRevision("revision-1", 1, "First complete draft."));
      }
      throw new Error(`unexpected request ${request.method} ${url}`);
    }) as typeof globalThis.fetch;
    const { io, stdout } = runIo(env, fetch);

    expect(await runRoomCli(["act", "review", "action-1"], io)).toBe(0);
    const rendered = stdout.join("");
    expect(rendered).toContain("Review round 1 — full exact revision");
    expect(rendered).toContain("Full-revision basis: first revision.");
    expect(rendered).toContain("First complete draft.");
    expect(rendered).not.toContain("changes since your last formally reviewed revision");
  });

  it("leads later review rounds with the reviewer-relative diff and exact metadata", async () => {
    const env = testEnv();
    const currentAction = action();
    const reviewRound = {
      mode: "diff",
      fallback_reason: null,
      current: { id: "revision-2", ordinal: 2, sha256: "b".repeat(64) },
      base: { id: "revision-1", ordinal: 1, sha256: "a".repeat(64) },
      changed_blocks: [{ id: "stable-2", change: "modified", current_number: 2, base_number: 2 }],
      round: 3,
      roster: [
        { participant_id: "p1", display_name: "Cobalt", responded: false },
        { participant_id: "p2", display_name: "Argon", responded: true },
      ],
      your_obligation: "review",
      checkpoint: {
        threshold: 3,
        elapsed_seconds: 600,
        total_rounds: 3,
        artifact_bytes: 3100,
        growth_bytes: 12,
        changed_block_count: 1,
        prior_round: { approvals: 1, changes_requested: 1 },
      },
    };
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/actions/action-1") && url.searchParams.get("reviews") === "1") {
        return jsonResponse({
          action: currentAction,
          review_presentation: reviewRound,
          rounds: [],
        });
      }
      if (url.pathname.endsWith("/actions/action-1")) {
        return jsonResponse({ action: currentAction, review_round: reviewRound });
      }
      if (url.pathname.endsWith("/artifacts/artifact-1")) {
        return jsonResponse(
          url.searchParams.get("revision") === "revision-1"
            ? artifactRevision("revision-1", 1, "Old clause.")
            : artifactRevision("revision-2", 2, "New clause."),
        );
      }
      throw new Error(`unexpected request ${request.method} ${url}`);
    }) as typeof globalThis.fetch;
    const { io, stdout } = runIo(env, fetch);

    expect(await runRoomCli(["act", "review", "action-1"], io)).toBe(0);
    const rendered = stdout.join("");
    expect(rendered).toContain(
      "Review round 3 — changes since your last formally reviewed revision",
    );
    expect(rendered).toContain("Current: v2; revision revision-2; SHA-256");
    expect(rendered).toContain("Base: v1; revision revision-1; SHA-256");
    expect(rendered).toContain("stable-2 — modified; current ¶2; base ¶2");
    expect(rendered).toContain("-Old clause.");
    expect(rendered).toContain("+New clause.");
    expect(rendered).toContain("grp artifact read artifact-1 --revision-id=revision-2");
    expect(rendered).toContain("Cobalt — outstanding");
    expect(rendered).toContain("Convergence checkpoint — round 3");
    expect(rendered).toContain("neutral state information only");
  });

  it("pins a formal disposition and preserves supplements as non-dispositive notes", async () => {
    const env = testEnv();
    const currentAction = action();
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/actions/action-1/review") && request.method === "PUT") {
        bodies.push((await request.json()) as Record<string, unknown>);
        return jsonResponse({ action: action({ status: "completed" }) });
      }
      if (url.pathname.endsWith("/actions/action-1/review-notes") && request.method === "POST") {
        bodies.push((await request.json()) as Record<string, unknown>);
        return jsonResponse({
          review_note: {
            id: "note-1",
            artifact_revision_id: "revision-2",
            kind: "correction",
            non_dispositive: true,
          },
        });
      }
      if (url.pathname.endsWith("/actions/action-1"))
        return jsonResponse({ action: currentAction });
      if (url.pathname.endsWith("/artifacts/artifact-1")) {
        return jsonResponse(artifactRevision("revision-2", 2, "New clause."));
      }
      if (url.pathname === `/api/rooms/${SLUG}`) {
        return jsonResponse({ participants: [], actions: [], artifacts: [] });
      }
      throw new Error(`unexpected request ${request.method} ${url}`);
    }) as typeof globalThis.fetch;

    const formal = runIo(env, fetch);
    expect(
      await runRoomCli(
        ["act", "review", "action-1", "--revision=revision-2", "--approve"],
        formal.io,
      ),
    ).toBe(0);
    expect(bodies[0]).toMatchObject({
      artifact_revision_id: "revision-2",
      disposition: "approve",
    });

    const correction = runIo(env, fetch);
    expect(
      await runRoomCli(
        [
          "act",
          "review-note",
          "action-1",
          "--revision=revision-2",
          "--kind=correction",
          "--corrects=review-1",
          "--body=I retract the earlier approval.",
        ],
        correction.io,
      ),
    ).toBe(0);
    expect(bodies[1]).toEqual({
      artifact_revision_id: "revision-2",
      kind: "correction",
      corrects_review_id: "review-1",
      body: "I retract the earlier approval.",
    });
    expect(correction.stdout.join("")).toContain("non-dispositive");
  });

  it("auto-pages host catch-up and advances only after all content is emitted", async () => {
    const env = testEnv();
    const seenSince: number[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      const since = Number(url.searchParams.get("since"));
      seenSince.push(since);
      if (since === 5) {
        return jsonResponse({
          slug: SLUG,
          status: "open",
          state: "no question open",
          new: [{ seq: 6, type: "discussion", who: "Argon", said: "first" }],
          current_through: 6,
          page: { through_event: 6, room_event: 8, complete: false, next_since: 6 },
        });
      }
      return jsonResponse({
        slug: SLUG,
        status: "open",
        state: "no question open",
        new: [
          { seq: 7, type: "discussion", who: "Neon", said: "second" },
          { seq: 8, type: "discussion", who: "Silica", said: "third" },
        ],
        current_through: 8,
        page: { through_event: 8, room_event: 8, complete: true },
      });
    }) as typeof globalThis.fetch;
    const { io, stdout } = runIo(env, fetch);

    expect(await runRoomCli(["read", "--ack"], io)).toBe(0);
    expect(seenSince).toEqual([5, 6]);
    expect(stdout.join("")).toContain("first");
    expect(stdout.join("")).toContain("second");
    expect(stdout.join("")).toContain("third");
    expect(JSON.parse(readFileSync(env.GRP_CONFIG, "utf8")).currentRoom.lastSeenSeq).toBe(8);
  });

  it("does not advance an acknowledged catch-up when the complete output cannot be emitted", async () => {
    const env = testEnv();
    const fetch = vi.fn(async () =>
      jsonResponse({
        slug: SLUG,
        status: "open",
        state: "no question open",
        new: [{ seq: 6, type: "discussion", who: "Argon", said: "must be delivered" }],
        current_through: 6,
        page: { through_event: 6, room_event: 6, complete: true },
      }),
    ) as typeof globalThis.fetch;
    const output: string[] = [];
    const errors: string[] = [];

    expect(
      await runRoomCli(["read", "--ack"], {
        env,
        fetch,
        stdin: Readable.from([]),
        isInteractive: false,
        stdout: (text) => {
          output.push(text);
          throw new Error("output sink closed");
        },
        stderr: (text) => errors.push(text),
      }),
    ).toBe(1);
    expect(output.join("")).toContain("must be delivered");
    expect(errors.join("")).toContain("output sink closed");
    expect(JSON.parse(readFileSync(env.GRP_CONFIG, "utf8")).currentRoom.lastSeenSeq).toBe(5);
  });

  it("accepts multiline decision context and renders response state without ballot contents", async () => {
    const env = testEnv();
    const directory = mkdtempSync(pathJoin(tmpdir(), "grp-context-"));
    const contextPath = pathJoin(directory, "context.md");
    const context = "First premise.\n\nSecond premise.";
    writeFileSync(contextPath, context);
    let posted: Record<string, unknown> | null = null;
    const askFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      posted = (await new Request(_input, init).json()) as Record<string, unknown>;
      return jsonResponse({ decision: { question: "Which path?", context } });
    }) as typeof globalThis.fetch;
    const asked = runIo(env, askFetch);
    expect(
      await runRoomCli(["ask", "Which path?", `--context-file=${contextPath}`, "--json"], asked.io),
    ).toBe(0);
    expect(posted).toMatchObject({ question: "Which path?", context });

    const response = {
      slug: SLUG,
      status: "open",
      about: "Decision state",
      brief: "A choice is open.",
      decisions: [],
      actions: [],
      artifacts: [],
      discussion: [],
      current_through: 9,
      you: { participant_id: "p1", name: "Cobalt", role: "participant" },
      decision: {
        id: "decision-1",
        question: "Which path?",
        context,
        options: ["North", "South"],
        status: "voting",
        response_state: {
          eligible_count: 2,
          eligible: ["Cobalt", "Argon"],
          responded_count: 1,
          responded: ["Argon"],
          outstanding_count: 1,
          outstanding: ["Cobalt"],
          quorum: { required: 2, met: false },
          threshold: { kind: "share", value: 0.5, comparison: "strict" },
          closes_at: "2026-08-31T18:00:00.000Z",
          caller: { eligible: true, responded: false, may_submit: true, may_revise: false },
        },
      },
    };
    const read = runIo(env, vi.fn(async () => jsonResponse(response)) as typeof globalThis.fetch);
    expect(await runRoomCli(["read", "--snapshot"], read.io)).toBe(0);
    const rendered = read.stdout.join("");
    expect(rendered).toContain("Context:\n  First premise.\n  \n  Second premise.");
    expect(rendered).toContain("Responses: 1/2 received; 1 outstanding.");
    expect(rendered).toContain("Outstanding: Cobalt.");
    expect(rendered).toContain("Your response is outstanding; you may submit.");
    expect(rendered).not.toContain("Cobalt chose");
  });

  it("sets and revokes an exact-state floor release", async () => {
    const env = testEnv();
    const methods: string[] = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      return method === "DELETE"
        ? jsonResponse({ floor_release: null, changed: true, state_revision: "10" })
        : jsonResponse({
            floor_release: {
              id: "release-1",
              participant_id: "p1",
              display_name: "Cobalt",
              scope: {
                conversation_state_revision: "8",
                foreground_epoch: "3",
                decision_id: null,
                action_id: "action-1",
                artifact_revision_id: "revision-2",
              },
            },
            changed: true,
            state_revision: "9",
          });
    }) as typeof globalThis.fetch;

    const set = runIo(env, fetch);
    expect(await runRoomCli(["yield"], set.io)).toBe(0);
    expect(set.stdout.join("")).toContain("Floor released by Cobalt at this exact state.");
    expect(set.stdout.join("")).toContain("does not approve work");

    const revoke = runIo(env, fetch);
    expect(await runRoomCli(["yield", "--revoke"], revoke.io)).toBe(0);
    expect(revoke.stdout.join("")).toContain("Floor release revoked.");
    expect(methods).toEqual(["PUT", "DELETE"]);
  });
});
