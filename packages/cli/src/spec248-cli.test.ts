import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runRoomCli } from "./room-cli.js";

const BASE_URL = "https://operator.example";
const SLUG = "successor-room";

function testEnv(room: Record<string, unknown> = {}): Record<string, string> {
  const directory = mkdtempSync(pathJoin(tmpdir(), "grp-spec248-cli-"));
  const configPath = pathJoin(directory, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        providers: {},
        currentRoom: {
          baseUrl: BASE_URL,
          slug: SLUG,
          token: "participant-token",
          participantId: "p1",
          displayName: "Local Name",
          role: "participant",
          coordinationStateCapability: "absent",
          lastSeenSeq: 5,
          ...room,
        },
      },
      null,
      2,
    )}\n`,
  );
  return { GRP_CONFIG: configPath };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function snapshot(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: SLUG,
    status: "open",
    about: "Amend one reviewed result",
    brief: "No decision is open right now.",
    participant_count: 2,
    participants: [
      { id: "p1", display_name: "Server Name", role: "participant" },
      { id: "p2", display_name: "Reviewer", role: "participant" },
    ],
    decisions: [],
    actions: [],
    artifacts: [],
    discussion: [],
    current_through: 12,
    state_revision: "state-12",
    you: { participant_id: "p1", name: "Server Name", role: "participant" },
    ...extra,
  };
}

function action(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a-new",
    revision: "3",
    title: "Amend the reviewed result",
    status: "in_progress",
    mode: "single",
    completion: "group",
    holder_id: "p1",
    target_artifact_id: "artifact-1",
    ...extra,
  };
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

describe("spec 248 CLI projections and read economy", () => {
  it("shows the server-projected identity without consuming room position", async () => {
    const env = testEnv();
    const { io, stdout } = runIo(
      env,
      vi.fn(async () => jsonResponse(snapshot())) as typeof globalThis.fetch,
    );

    expect(await runRoomCli(["whoami"], io)).toBe(0);
    expect(stdout.join("")).toContain(`You are Server Name in room ${SLUG}.`);
    expect(stdout.join("")).toContain("Participant ID: p1");
    expect(stdout.join("")).toContain("position did not move");
    expect(JSON.parse(readFileSync(env.GRP_CONFIG, "utf8")).currentRoom.lastSeenSeq).toBe(5);
  });

  it("renders identity and the authoritative pointer while bodies and position stay untouched", async () => {
    const env = testEnv();
    const body = "exact private deliberation";
    const response = snapshot({
      discussion: [{ who: "Reviewer", said: body, about_action_id: "a-new" }],
      authoritative_result: {
        action_id: "a-old",
        artifact_id: "artifact-1",
        revision_id: "revision-7",
        sha256: "abc123",
        completed_at: "2026-08-27T20:00:00Z",
        open_successor_action_id: "a-new",
      },
    });
    const fetch = vi.fn(async () => jsonResponse(response)) as typeof globalThis.fetch;

    const first = runIo(env, fetch);
    expect(await runRoomCli(["read", "--snapshot"], first.io)).toBe(0);
    const compact = first.stdout.join("");
    expect(compact).toContain("You are Server Name (participant; p1).");
    expect(compact).toContain("Discussion:");
    expect(compact).toContain("Reviewer about action a-new");
    expect(compact).toContain(body);
    expect(compact).toContain("Authoritative result:");
    expect(compact).toContain(
      "Action a-old; artifact artifact-1; revision revision-7; SHA-256 abc123.",
    );
    expect(compact).toContain("Open successor a-new is amending this result.");
    expect(JSON.parse(readFileSync(env.GRP_CONFIG, "utf8")).currentRoom.lastSeenSeq).toBe(5);

    const expanded = runIo(env, fetch);
    expect(await runRoomCli(["read", "--snapshot", "--expand"], expanded.io)).toBe(0);
    expect(expanded.stdout.join("")).toContain(`Reviewer about action a-new: ${body}`);

    const acknowledged = runIo(env, fetch);
    expect(await runRoomCli(["read", "--ack-through=12"], acknowledged.io)).toBe(0);
    expect(JSON.parse(readFileSync(env.GRP_CONFIG, "utf8")).currentRoom.lastSeenSeq).toBe(12);
  });

  it("confirms the identity and action scope returned for discussion", async () => {
    const env = testEnv();
    const { io, stdout } = runIo(
      env,
      vi.fn(async () =>
        jsonResponse({
          id: "message-1",
          posted_as: { participant_id: "p1", name: "Server Name" },
          about_action_id: "a-new",
        }),
      ) as typeof globalThis.fetch,
    );

    expect(await runRoomCli(["discuss", "A scoped comment"], io)).toBe(0);
    expect(stdout.join("")).toContain("Discussion posted as Server Name.");
    expect(stdout.join("")).toContain("Commentary on action: a-new.");
  });

  it("starts a successor without replacing the inherited completion gate", async () => {
    const env = testEnv();
    let posted: Record<string, unknown> | null = null;
    const { io } = runIo(
      env,
      vi.fn(async (_input, init) => {
        posted = JSON.parse(String(init?.body));
        return jsonResponse({ action: action() });
      }) as typeof globalThis.fetch,
    );

    expect(
      await runRoomCli(
        ["act", "start", "--title=Amend the reviewed result", "--supersedes=a-old", "--json"],
        io,
      ),
    ).toBe(0);
    expect(posted).toMatchObject({
      title: "Amend the reviewed result",
      mode: "single",
      supersedes_action_id: "a-old",
    });
    expect(posted).not.toHaveProperty("completion");
  });

  it("renders successor and doomed-review projections on a focused action read", async () => {
    const env = testEnv();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith("/actions/a-old")) {
        return jsonResponse({
          action: action({ id: "a-old", status: "completed" }),
          superseded_by: { action_id: "a-new", status: "in_review" },
          review_round: { can_approve: false },
        });
      }
      return jsonResponse(snapshot());
    }) as typeof globalThis.fetch;
    const { io, stdout } = runIo(env, fetch);

    expect(await runRoomCli(["act", "read", "a-old"], io)).toBe(0);
    expect(stdout.join("")).toContain("Superseded by action a-new (in_review).");
    expect(stdout.join("")).toContain(
      "Review round for action a-old can no longer approve: a required reviewer requested changes.",
    );
  });

  it("suggests the focused read for unknown action subcommands", async () => {
    const env = testEnv();
    const { io, stderr } = runIo(
      env,
      vi.fn(async () => {
        throw new Error("must not fetch");
      }) as typeof globalThis.fetch,
    );

    expect(await runRoomCli(["act", "show", "a-new"], io)).toBe(1);
    expect(stderr.join("")).toContain("unknown act subcommand: show");
    expect(stderr.join("")).toContain("Did you mean: grp act read a-new");
  });

  it("keeps delta reads non-consuming until explicitly acknowledged", async () => {
    const env = testEnv();
    const response = {
      slug: SLUG,
      status: "open",
      state: "no question open",
      role: "participant",
      new: [{ seq: 6, type: "discussion", who: "Reviewer", said: "one update" }],
      current_through: 6,
      state_revision: "state-6",
      more: {},
    };
    const fetch = vi.fn(async () => jsonResponse(response)) as typeof globalThis.fetch;

    const first = runIo(env, fetch);
    expect(await runRoomCli(["read"], first.io)).toBe(0);
    expect(first.stdout.join("").match(/PINNED CATCH-UP/g)).toHaveLength(1);
    expect(first.stdout.join("")).toContain("Position unchanged;");
    expect(JSON.parse(readFileSync(env.GRP_CONFIG, "utf8")).currentRoom.lastSeenSeq).toBe(5);

    const second = runIo(env, fetch);
    expect(await runRoomCli(["read", "--ack-through=6"], second.io)).toBe(0);
    expect(second.stdout.join("")).not.toContain("CATCH-UP");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second.stdout.join("")).toContain("Position acknowledged through event 6.");
    expect(JSON.parse(readFileSync(env.GRP_CONFIG, "utf8")).currentRoom.lastSeenSeq).toBe(6);
  });

  it("does not fetch or adopt catch-up on rejection; a separate read delivers the bodies", async () => {
    const env = testEnv({
      coordinationStateCapability: "experimental",
      observedStateRevision: "state-5",
    });
    const secret = "full stale discussion body";
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        return jsonResponse(
          {
            error: {
              code: "state.precondition_failed",
              message: "room changed",
              details: {
                expected_state_revision: "state-5",
                current_state_revision: "state-6",
              },
            },
          },
          412,
        );
      }
      return jsonResponse({
        slug: SLUG,
        status: "open",
        state: "no question open",
        role: "participant",
        new: [{ seq: 6, type: "discussion", who: "Reviewer", said: secret }],
        current_through: 6,
        state_revision: "state-6",
        more: {},
      });
    }) as typeof globalThis.fetch;
    const { io, stderr, stdout } = runIo(env, fetch);

    expect(await runRoomCli(["discuss", "stale post"], io)).toBe(1);
    const rendered = stderr.join("");
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain("Read the changed conversation: grp read");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(env.GRP_CONFIG, "utf8")).currentRoom.observedStateRevision).toBe(
      "state-5",
    );
    expect(await runRoomCli(["read"], io)).toBe(0);
    expect(stdout.join("")).toContain("Reviewer: full stale discussion body");
    expect(stdout.join("")).toContain("grp read --ack-through=6");
    expect(JSON.parse(readFileSync(env.GRP_CONFIG, "utf8")).currentRoom.observedStateRevision).toBe(
      "state-6",
    );
    expect(JSON.parse(readFileSync(env.GRP_CONFIG, "utf8")).currentRoom.lastSeenSeq).toBe(5);
  });

  it("avoids the redundant full-room preflight for action-scoped watches", async () => {
    const env = testEnv();
    let fullReads = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/actions/a-new")) {
        return jsonResponse({ action: action({ status: "completed" }) });
      }
      if (url.pathname.endsWith("/next-action")) {
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(new DOMException("Aborted", "AbortError"));
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      if (url.pathname === `/api/rooms/${SLUG}` && url.searchParams.get("include") === "full") {
        fullReads += 1;
        return jsonResponse(snapshot());
      }
      throw new Error(`unexpected request: ${request.method} ${url}`);
    }) as typeof globalThis.fetch;
    const { io, stdout } = runIo(env, fetch);

    expect(await runRoomCli(["watch", "--action=a-new", "--timeout=1"], io)).toBe(0);
    expect(stdout.join("")).toContain("Action a-new terminal.");
    expect(fullReads).toBe(1);
  });
});
