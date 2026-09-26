import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runRoomCli } from "./room-cli.js";

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
const snapshot = (complete = false) => ({
  slug: "room",
  brief: "Room purpose",
  state: "no question open",
  state_revision: "50",
  current_through: 50,
  discussion: [],
  page: {
    complete: true,
    through_event: 50,
    room_event: 50,
    bodies_elided: false,
    content: { discussion_complete: complete, discussion_total: complete ? 1 : 21 },
  },
});
const delta = (body = "Complete contribution", complete = true) => ({
  slug: "room",
  state: "no question open",
  state_revision: "50",
  current_through: complete ? 50 : 25,
  new: [{ seq: complete ? 50 : 25, type: "discussion", who: "Peer", said: body }],
  page: { complete, through_event: complete ? 50 : 25, room_event: 50, bodies_elided: false },
});
function fixture(mark?: number) {
  const config = join(mkdtempSync(join(tmpdir(), "grp-cold-read-")), "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      providers: {},
      currentRoom: {
        baseUrl: "https://operator.example",
        slug: "room",
        token: "fake",
        participantId: "p1",
        coordinationStateCapability: "experimental",
        ...(mark === undefined ? {} : { lastSeenSeq: mark }),
        observations: { schema: 1, generation: "base", global: "5", conversation: "5" },
      },
    }),
  );
  const output: string[] = [];
  const errors: string[] = [];
  return {
    state: () => JSON.parse(readFileSync(config, "utf8")).currentRoom,
    output,
    errors,
    run: (args: string[], fetch: typeof globalThis.fetch) =>
      runRoomCli(args, {
        env: { GRP_CONFIG: config },
        fetch,
        stdin: Readable.from([]),
        isInteractive: false,
        stdout: (s) => output.push(s),
        stderr: (s) => errors.push(s),
      }),
  };
}
describe("cold and incomplete snapshot recovery", () => {
  it.each([[], ["--full"], ["--json"], ["--json", "--full"]])(
    "recovers an oversized cold snapshot without acknowledgment: %j",
    async (...flags) => {
      const f = fixture();
      const requests: string[] = [];
      const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).not.toBe("POST");
        const u = new URL(String(input));
        requests.push(u.search);
        return json(u.searchParams.has("since") ? delta() : snapshot());
      }) as typeof globalThis.fetch;
      expect(await f.run(["read", ...flags], fetch)).toBe(0);
      expect(requests).toEqual(["", "?since=0"]);
      expect(f.state().observations.conversation).toBe("50");
      expect(f.state().lastSeenSeq).toBeUndefined();
    },
  );
  it("preserves complete first-contact orientation with one request", async () => {
    const f = fixture();
    const fetch = vi.fn(async () => json(snapshot(true)));
    expect(await f.run(["read"], fetch)).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.output.join("")).toContain("Room purpose");
    expect(f.state().observations.conversation).toBe("50");
  });
  it("keeps existing bookmarks on the normal delta path", async () => {
    const f = fixture(20);
    const fetch = vi.fn(async (input) => {
      expect(new URL(String(input)).searchParams.get("since")).toBe("20");
      return json(delta());
    }) as typeof globalThis.fetch;
    expect(await f.run(["read"], fetch)).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.state().lastSeenSeq).toBe(20);
  });
  it.each([undefined, 20])(
    "keeps explicit snapshots non-consuming and gives covered recovery (%s)",
    async (mark) => {
      const f = fixture(mark);
      const fetch = vi.fn(async () => json(snapshot()));
      expect(await f.run(["read", "--snapshot", "--json", "--max-chars=4096"], fetch)).toBe(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      const page = JSON.parse(f.output.at(-1) ?? "");
      expect(page.fresh_fetch_argv.argv).toContain(`--since=${mark ?? 0}`);
      expect(page.ack_argv).toBeNull();
      expect(f.state().observations.conversation).toBe("5");
    },
  );
  it("unbounded explicit snapshot gives executable recovery without claiming completeness", async () => {
    const f = fixture();
    expect(await f.run(["read", "--snapshot", "--full"], async () => json(snapshot()))).toBe(0);
    expect(f.output.join("")).toContain("--since=0");
    expect(f.state().observations.conversation).toBe("5");
  });
  it("does not adopt a partial local delivery or auto-fetch every host batch", async () => {
    const f = fixture();
    const fetch = vi.fn(async (input) =>
      json(
        new URL(String(input)).searchParams.has("since")
          ? delta("generic paragraph\n".repeat(1500), false)
          : snapshot(),
      ),
    ) as typeof globalThis.fetch;
    expect(await f.run(["read", "--max-chars=2048"], fetch)).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(f.output.at(-1)?.length).toBeLessThanOrEqual(2048);
    expect(f.state().observations.conversation).toBe("5");
    expect(f.state().lastSeenSeq).toBeUndefined();
  });
  it("does not loop if a legacy host ignores the delta selector", async () => {
    const f = fixture();
    const fetch = vi.fn(async () => json(snapshot()));
    expect(await f.run(["read"], fetch)).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(f.state().observations.conversation).toBe("5");
    expect(f.output.join("")).toContain("--since=0");
  });
  it("does not certify skipped explicit ranges and recovers from the bookmark", async () => {
    const f = fixture(10);
    expect(
      await f.run(["read", "--since=40", "--json", "--max-chars=4096"], async () => json(delta())),
    ).toBe(0);
    expect(f.state().observations.conversation).toBe("5");
    expect(JSON.parse(f.output.at(-1) ?? "").fresh_fetch_argv.argv).toContain("--since=10");
  });
});

describe("pending review state is reversible", () => {
  it("describes a current blocker and removes it when dispositions change in the same round", async () => {
    const f = fixture();
    for (const blocked of [true, false]) {
      f.output.length = 0;
      expect(
        await f.run(["act", "read", "action-1"], async () =>
          json({
            action: {
              id: "action-1",
              title: "Work",
              status: "in_review",
              revision: "10",
              mode: "single",
              completion: "group",
              review: {
                state: "pending",
                artifact_revision_id: "same-revision",
                required_participant_ids: ["p1", "p2"],
                responded_participant_ids: ["p1"],
              },
            },
            review_round: { can_approve: !blocked, roster: [] },
          }),
        ),
      ).toBe(0);
      expect(f.output.join("")).not.toContain("can no longer approve");
      expect(f.output.join("").includes("currently blocked")).toBe(blocked);
      if (blocked)
        expect(f.output.join("")).toContain("Responses can be updated until the round closes");
    }
  });
});
