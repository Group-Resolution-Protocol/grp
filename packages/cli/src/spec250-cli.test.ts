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
  it("acknowledges a complete host-page prefix but withholds the room-head guard until the suffix is delivered", async () => {
    const f = fixture({ observedStateRevision: "state-5" });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const since = new URL(String(input)).searchParams.get("since");
      return json(
        since === "5"
          ? {
              ...delta(6),
              state_revision: "state-7",
              page: { complete: false, through_event: 6, room_event: 7, next_since: 6 },
            }
          : delta(7),
      );
    });
    expect(await runRoomCli(["read"], f.io(fetch))).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.state().readDelivery.through).toBe(6);
    expect(f.state().observedStateRevision).toBe("state-5");
    expect(await runRoomCli(["read", "--ack-through=7"], f.io(fetch))).toBe(1);
    expect(await runRoomCli(["read", "--ack-through=6"], f.io(fetch))).toBe(0);
    expect(await runRoomCli(["read"], f.io(fetch))).toBe(0);
    expect(f.state().observedStateRevision).toBe("state-7");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not rewrite user text that quotes delivery instructions", async () => {
    const f = fixture();
    const quoted =
      "Acknowledge this batch: this is quoted evidence, not a CLI instruction. COMPLETE CATCH-UP";
    expect(
      await runRoomCli(
        ["read"],
        f.io(async () => json(delta(6, quoted.repeat(200)))),
      ),
    ).toBe(0);
    expect(f.state().readDelivery).toBeUndefined();
    const token = /Continue this exact delivery: .*--continue=(\S+)/.exec(
      f.output.at(-1) ?? "",
    )?.[1];
    expect(
      await runRoomCli(
        ["read", `--continue=${token}`],
        f.io(async () => {
          throw new Error("No fresh fetch");
        }),
      ),
    ).toBe(0);
    expect(f.output.at(-1)).toContain(quoted);
  });
  it("pins a long delivery, withholds observation and acknowledgment, and ignores a newer head during continuation", async () => {
    const f = fixture({ observedStateRevision: "state-5" });
    let seq = 6;
    const fetch = vi.fn(async () => json(delta(seq, `${"long body\n".repeat(4_000)}END-BODY`)));
    expect(await runRoomCli(["read"], f.io(fetch))).toBe(0);
    expect(f.output.at(-1)).toContain("INCOMPLETE");
    expect(f.state().coordinationStateCapability).toBe("experimental");
    expect(f.state().observedStateRevision).toBe("state-5");
    expect(f.state().readDelivery).toBeUndefined();
    expect(await runRoomCli(["read", "--ack-through=6"], f.io(fetch))).toBe(1);
    seq = 7;
    let pages = 0;
    while (true) {
      const text = f.output.at(-1) ?? "";
      expect(text.length).toBeLessThanOrEqual(12_000);
      const token = /Continue this exact delivery: .*--continue=(\S+)/.exec(text)?.[1];
      if (!token) break;
      if (!f.state().readDelivery) expect(text).not.toContain("--ack-through=6");
      expect(f.state().observedStateRevision).toBe("state-5");
      expect(await runRoomCli(["read", `--continue=${token}`], f.io(fetch))).toBe(0);
      if (++pages > 10) throw new Error("nonterminating read");
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.state().observedStateRevision).toBe("state-6");
    expect(f.state().lastSeenSeq).toBe(5);
    expect(f.output.at(-1)).toContain("--ack-through=6");
    expect(await runRoomCli(["read", "--ack-through=6"], f.io(fetch))).toBe(0);
    expect(f.state().lastSeenSeq).toBe(6);
  });

  it("discovers the strict guard on a partial first read without inventing an observation", async () => {
    const f = fixture();
    const fetch = vi.fn(async () => json(delta(6, "x".repeat(30_000))));
    expect(await runRoomCli(["read"], f.io(fetch))).toBe(0);
    expect(await runRoomCli(["discuss", "not caught up"], f.io(fetch))).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.state().observedStateRevision).toBeUndefined();
  });

  it.each(["--full", "--json"])("keeps explicit bulk retrieval lossless (%s)", async (flag) => {
    const f = fixture();
    const said = "x".repeat(30_000);
    expect(
      await runRoomCli(
        ["read", flag],
        f.io(async () => json(delta(6, said))),
      ),
    ).toBe(0);
    expect(f.output.join("").includes(said)).toBe(true);
    expect(f.state().observedStateRevision).toBe("state-6");
  });

  it("does not advance on failed final output and can retry that fragment", async () => {
    const f = fixture({ observedStateRevision: "state-5" });
    const fetch = vi.fn(async () => json(delta(6, "x".repeat(13_000))));
    expect(await runRoomCli(["read"], f.io(fetch))).toBe(0);
    let token = "";
    for (let i = 0; i < 10; i++) {
      const text = f.output.at(-1) ?? "";
      token = /Continue this exact delivery: .*--continue=(\S+)/.exec(text)?.[1] ?? "";
      const total = Number(/DELIVERY \d+\/(\d+)/.exec(text)?.[1]);
      if (Number(token.split(":")[1]) === total - 1) break;
      expect(await runRoomCli(["read", `--continue=${token}`], f.io(fetch))).toBe(0);
    }
    expect(
      await runRoomCli(["read", `--continue=${token}`], {
        ...f.io(fetch),
        stdout: () => {
          throw new Error("broken pipe");
        },
      }),
    ).toBe(1);
    expect(f.state().observedStateRevision).toBe("state-5");
    // Complete event prefix may already be delivered, but the pinned state
    // suffix must succeed before the whole-room observation advances.
    expect(f.state().lastSeenSeq).toBe(5);
    expect(await runRoomCli(["read", `--continue=${token}`], f.io(fetch))).toBe(0);
    expect(f.state().observedStateRevision).toBe("state-6");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("labels artifact state counters separately and never describes one's own handoff as held by another", async () => {
    const f = fixture();
    expect(
      await runRoomCli(
        ["read"],
        f.io(async () =>
          json({
            ...delta(6),
            actions: [
              { ...action, status: "open", mode: "handoff", holder_id: "p1", title: "Draft" },
            ],
            artifacts: [{ id: "f1", name: "Terms", revision: "13", current_revision_id: "r2" }],
          }),
        ),
      ),
    ).toBe(0);
    const text = f.output.join("");
    expect(text).toContain("holder you");
    expect(text).not.toContain("held by another participant");
    expect(text).toContain("f1 [state revision 13]");
    expect(text).toContain("content revision r2");
  });

  it("does not invent a pending decision in a room with only action results", async () => {
    const f = fixture();
    expect(
      await runRoomCli(
        ["outcome"],
        f.io(async () =>
          json({
            slug: "room",
            status: "open",
            question: "",
            decisions: [],
            resolved_at: null,
            resolved_outcome: null,
          }),
        ),
      ),
    ).toBe(0);
    expect(f.output.join("")).toContain("Action results are separate");
    expect(f.output.join("")).not.toContain("Keep monitoring");
    expect(f.output.join("")).not.toContain("No outcome yet");
  });

  it("retrieves a marked exact block excerpt without adopting a room observation", async () => {
    const f = fixture();
    expect(
      await runRoomCli(
        ["artifact", "read", "f1", "--revision-id=r2", "--blocks=2:2"],
        f.io(async () =>
          json({
            artifact: { id: "f1" },
            revision: {
              id: "r2",
              ordinal: 2,
              blocks: [
                { number: 1, content: "unselected-secret-test-body" },
                { number: 2, content: "selected" },
              ],
            },
          }),
        ),
      ),
    ).toBe(0);
    expect(f.output.join("")).toContain("EXCERPT");
    expect(f.output.join("")).toContain("Revision: r2");
    expect(f.output.join("")).toContain("selected");
    expect(f.output.join("")).not.toContain("unselected-secret-test-body");
    expect(f.state().readDelivery).toBeUndefined();
  });

  it("explains missing content-version lookup without claiming the artifact itself is absent", async () => {
    const f = fixture();
    expect(
      await runRoomCli(
        ["artifact", "read", "f1", "--version=13"],
        f.io(async () =>
          json({ error: { code: "artifact.not_found", message: "Not found" } }, 404),
        ),
      ),
    ).toBe(1);
    expect(f.errors.join("")).toContain("requested content version v13");
    expect(f.errors.join("")).toContain("not artifact state revision counters");
  });

  it("leads with a long trusted diff even when the new artifact is short, and continues without rechecking or endorsing", async () => {
    const f = fixture();
    const revision = (id: string) => ({
      artifact: { id: "f1" },
      revision: {
        id,
        ordinal: id === "r1" ? 1 : 2,
        blocks: [
          {
            id: "b1",
            number: 1,
            kind: "paragraph",
            content: id === "r1" ? "old long text\n".repeat(2_000) : "new short text",
          },
        ],
      },
    });
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.method !== "GET") throw new Error("read must not endorse");
      if (req.url.includes("/artifacts/"))
        return json(revision(new URL(req.url).searchParams.get("revision") ?? "r2"));
      return json({
        action,
        review_presentation: {
          mode: "diff",
          round: 2,
          current: { id: "r2", ordinal: 2 },
          base: { id: "r1", ordinal: 1 },
        },
      });
    });
    expect(await runRoomCli(["act", "review", "a1"], f.io(fetch))).toBe(0);
    expect(f.output[0]).toContain("changes since your last formally reviewed revision");
    expect(f.output[0]).toContain("Current: v2; revision r2");
    expect(f.output[0]).toContain("Base: v1; revision r1");
    expect(f.output[0]).toContain("--- artifact v1");
    expect(f.output[0]).toContain("INCOMPLETE");
    const calls = fetch.mock.calls.length;
    const token = /--continue=(\S+)/.exec(f.output[0] ?? "")?.[1];
    expect(
      await runRoomCli(
        ["act", "review", "a1", `--continue=${token}`, "--approve", "--revision=r2"],
        f.io(fetch),
      ),
    ).toBe(1);
    expect(await runRoomCli(["act", "review", "a1", `--continue=${token}`], f.io(fetch))).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect(f.state().readDelivery).toBeUndefined();
    expect(f.state().observedStateRevision).toBeUndefined();
  });

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
    expect(f.state().readDelivery).toBeUndefined();
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
