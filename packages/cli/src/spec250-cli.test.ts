import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runRoomCli } from "./room-cli.js";

function fixture(extra: Record<string, unknown> = {}) {
  const config = join(mkdtempSync(join(tmpdir(), "grp-coordination-")), "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      providers: {},
      currentRoom: {
        baseUrl: "https://operator.example",
        slug: "room",
        participantId: "p1",
        token: "test-token",
        lastSeenSeq: 5,
        coordinationStateCapability: "absent",
        ...extra,
      },
    }),
  );
  const env = { GRP_CONFIG: config };
  const state = () => JSON.parse(readFileSync(config, "utf8")).currentRoom;
  const output: string[] = [];
  const errors: string[] = [];
  const io = (fetch: typeof globalThis.fetch) => ({
    env,
    fetch,
    stdin: Readable.from([]),
    isInteractive: false,
    stdout: (text: string) => output.push(text),
    stderr: (text: string) => errors.push(text),
  });
  return { env, state, output, errors, io };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const delta = (seq: number, said = `message ${seq}`) => ({
  slug: "room",
  status: "open",
  state: "no question open",
  state_revision: `state-${seq}`,
  current_through: seq,
  new: [{ seq, type: "discussion", who: "Peer", said }],
  page: { through_event: seq, room_event: seq, complete: true },
});
const action = {
  id: "a1",
  revision: "7",
  status: "in_review",
  completion: "group",
  target_artifact_id: "f1",
  review: {
    state: "pending",
    artifact_revision_id: "r2",
    required_participant_ids: ["p1", "p2"],
    responded_participant_ids: ["p2"],
  },
};

describe("coordination correctness", () => {
  it("acknowledges delivered bytes without fetching a newer message", async () => {
    const f = fixture();
    let newest = 6;
    const since: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      since.push(new URL(new Request(input, init).url).searchParams.get("since") ?? "");
      return json(delta(newest));
    });
    expect(await runRoomCli(["read"], f.io(fetch))).toBe(0);
    expect(f.state().lastSeenSeq).toBe(5);
    newest = 7;
    expect(await runRoomCli(["read", "--ack-through=6"], f.io(fetch))).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.state().lastSeenSeq).toBe(6);
    expect(await runRoomCli(["read"], f.io(fetch))).toBe(0);
    expect(since).toEqual(["5", "6"]);
    expect(f.output.join("")).toContain("message 7");
    expect(f.state().lastSeenSeq).toBe(6);
  });

  it("rejects bare ack and undelivered positions without network requests", async () => {
    const f = fixture();
    const fetch = vi.fn(async () => {
      throw new Error("unexpected network request");
    });
    expect(await runRoomCli(["read", "--ack"], f.io(fetch))).toBe(1);
    expect(await runRoomCli(["read", "--ack-through=6"], f.io(fetch))).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(f.state().lastSeenSeq).toBe(5);
  });

  it("does not let an explicit since gap acknowledge omitted events", async () => {
    const f = fixture({ observedStateRevision: "state-5" });
    const fetch = vi.fn(async () => json(delta(11)));
    expect(await runRoomCli(["read", "--since=10"], f.io(fetch))).toBe(0);
    expect(await runRoomCli(["read", "--ack-through=11"], f.io(fetch))).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.state().lastSeenSeq).toBe(5);
    expect(f.state().observedStateRevision).toBe("state-5");
  });

  it("does not hide earlier-page body elision behind a complete final page", async () => {
    const f = fixture({ observedStateRevision: "state-5" });
    let calls = 0;
    const fetch = vi.fn(async () =>
      ++calls === 1
        ? json({ ...delta(6), page: { complete: false, next_since: 6, bodies_elided: true } })
        : json(delta(7)),
    );
    expect(await runRoomCli(["read"], f.io(fetch))).toBe(0);
    expect(f.state().observedStateRevision).toBe("state-5");
    expect(f.state().readDelivery).toBeUndefined();
  });

  it.each([undefined, "old-revision"])(
    "never endorses latest bytes for an absent or stale pin (%s)",
    async (pin) => {
      const f = fixture();
      let writes = 0;
      const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method !== "GET") writes++;
        return request.url.includes("/actions/")
          ? json({ action: { ...action, status: "in_progress" } })
          : json({
              artifact: { id: "f1", revision: "2", current_revision_id: "r2" },
              revision: { id: "r2" },
            });
      });
      expect(
        await runRoomCli(
          ["act", "request-review", "a1", ...(pin ? [`--revision=${pin}`] : [])],
          f.io(fetch),
        ),
      ).toBe(1);
      expect(writes).toBe(0);
      expect(f.errors.join("")).toContain(
        pin ? "no approval was recorded" : "records your approval",
      );
    },
  );

  it("renders independent result lineages without moving an amendment to another result", async () => {
    const f = fixture();
    const fetch = vi.fn(async () =>
      json({
        slug: "room",
        brief: "No open decision",
        discussion: [],
        authoritative_results: [
          {
            action_id: "A",
            artifact_id: "fA",
            revision_id: "rA",
            sha256: "a",
            open_successor_action_id: "amend-A",
          },
          { action_id: "B", artifact_id: "fB", revision_id: "rB", sha256: "b" },
        ],
      }),
    );
    expect(await runRoomCli(["read", "--snapshot"], f.io(fetch))).toBe(0);
    const results = f.output.join("").split("Authoritative result:").slice(1);
    expect(results).toHaveLength(2);
    expect(results[0]).toContain("Action A;");
    expect(results[0]).toContain("Open successor amend-A");
    expect(results[1]).toContain("Action B;");
    expect(results[1]).not.toContain("amend-A");
  });

  it("does not adopt a write token or acknowledge an incomplete snapshot", async () => {
    const f = fixture({ observedStateRevision: "state-5" });
    const fetch = vi.fn(async () =>
      json({
        slug: "room",
        brief: "Room open",
        discussion: [],
        current_through: 20,
        state_revision: "state-20",
        page: { complete: false, content: { discussion_complete: false } },
      }),
    );
    expect(await runRoomCli(["read", "--snapshot"], f.io(fetch))).toBe(0);
    expect(f.state().observedStateRevision).toBe("state-5");
    expect(f.state().readDelivery).toBeUndefined();
    expect(await runRoomCli(["read", "--ack-through=20"], f.io(fetch))).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["idempotency", "network"])(
    "preserves %s review failure without inventing a closed round",
    async (failure) => {
      const f = fixture();
      let puts = 0;
      const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const req = new Request(input, init);
        if (req.method === "PUT") {
          puts++;
          if (failure === "network") throw new Error("response connection lost");
          return json(
            { error: { code: "idempotency.in_progress", message: "request still running" } },
            409,
          );
        }
        if (req.url.includes("/actions/")) return json({ action });
        if (req.url.includes("/artifacts/"))
          return json({
            artifact: { id: "f1", revision: "2", current_revision_id: "r2" },
            revision: { id: "r2", sha256: "b".repeat(64), blocks: [] },
            reviews: [],
          });
        throw new Error(`unexpected request ${req.url}`);
      });
      expect(
        await runRoomCli(["act", "review", "a1", "--revision=r2", "--approve"], f.io(fetch)),
      ).toBe(1);
      expect(puts).toBe(1);
      expect(f.errors.join("")).not.toContain("round settled");
      expect(f.errors.join("")).not.toContain("review-note");
      expect(f.errors.join("")).toContain(
        failure === "network" ? "Mutation outcome unknown" : "request still running",
      );
    },
  );

  it("leaves the old observation when stale-write recovery cannot be displayed", async () => {
    const f = fixture({
      coordinationStateCapability: "experimental",
      observedStateRevision: "state-5",
    });
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST"
        ? json(
            {
              error: {
                code: "state.precondition_failed",
                message: "room changed",
                details: { expected_state_revision: "state-5", current_state_revision: "state-6" },
              },
            },
            412,
          )
        : json(delta(6)),
    );
    const io = {
      ...f.io(fetch),
      stderr: () => {
        throw new Error("closed output sink");
      },
    };
    await expect(runRoomCli(["discuss", "composed earlier"], io)).rejects.toThrow(
      "closed output sink",
    );
    expect(f.state().observedStateRevision).toBe("state-5");
    expect(f.state().readDelivery).toBeUndefined();
  });

  it("starts watch beyond delivered content without acknowledging that content", async () => {
    const f = fixture();
    expect(
      await runRoomCli(
        ["read"],
        f.io(async () => json(delta(6))),
      ),
    ).toBe(0);
    let watchSince: string | null = null;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith("/next-action")) return new Promise<Response>(() => {});
      if (url.pathname.endsWith("/events/stream")) {
        watchSince = url.searchParams.get("since_seq");
        const event = {
          id: "e7",
          seq: 7,
          event_type: "discussion.posted",
          occurred_at: new Date().toISOString(),
          data: { participant_id: "p2", display_name: "Peer" },
        };
        return new Response(
          `id: e7\nevent: discussion.posted\ndata: ${JSON.stringify(event)}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      throw new Error(`unexpected request ${url}`);
    });
    expect(await runRoomCli(["watch", "--timeout=1"], f.io(fetch))).toBe(0);
    expect(watchSince).toBe("6");
    expect(f.state().lastSeenSeq).toBe(5);
    expect(f.state().lastNotifiedSeq).toBe(7);
  });
});
