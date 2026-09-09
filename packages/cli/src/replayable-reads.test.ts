import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  setRoomObservedStateRevision,
  setRoomStaleWriteRecovery,
  updateProviderConfig,
} from "./provider-config.js";
import { runRoomCli } from "./room-cli.js";

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), "grp-replay-")), "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      providers: {},
      currentRoom: {
        baseUrl: "https://operator.example",
        slug: "room",
        participantId: "p1",
        token: "test-token",
        lastSeenSeq: 5,
        observedStateRevision: "opaque-base",
        observations: {
          schema: 1,
          generation: "fixture-read",
          global: "opaque-base",
          conversation: "opaque-base",
        },
        coordinationStateCapability: "experimental",
      },
    }),
  );
  const env = { GRP_CONFIG: path };
  const output: string[] = [];
  const errors: string[] = [];
  const state = () => JSON.parse(readFileSync(path, "utf8")).currentRoom;
  const run = (
    args: string[],
    fetch: typeof globalThis.fetch = async () => {
      throw new Error("Unexpected network request");
    },
  ) =>
    runRoomCli(args, {
      env,
      fetch,
      stdin: Readable.from([]),
      isInteractive: false,
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
    });
  const next = () =>
    /Continue this exact delivery: .*--continue=(\S+)/.exec(output.at(-1) ?? "")?.[1];
  const replay = () => /Replay this page: .*--continue=(\S+)/.exec(output.at(-1) ?? "")?.[1] ?? "";
  const finish = async (first = next()) => {
    let token = first;
    for (let i = 0; token && i < 30; i++) {
      expect(await run(["read", `--continue=${token}`])).toBe(0);
      token = next();
    }
    expect(token).toBeUndefined();
  };
  return { path, env, state, output, errors, run, next, replay, finish };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const delta = (through: number, said: string, state = `opaque-${through}`) => ({
  slug: "room",
  state: "no question open",
  state_revision: state,
  current_through: through,
  new: [{ seq: through, type: "discussion", who: "Peer", said }],
  page: { through_event: through, room_event: through, complete: true },
});

describe("replayable read coordination", () => {
  it("acknowledges complete event prefixes but not a partially emitted event or unseen head", async () => {
    const f = fixture();
    const response = {
      ...delta(7, "b".repeat(6_000)),
      new: [
        { seq: 6, type: "discussion", who: "First", said: "a".repeat(6_000) },
        { seq: 7, type: "discussion", who: "Second", said: "b".repeat(6_000) },
      ],
    };
    expect(await f.run(["read"], async () => json(response))).toBe(0);
    expect(f.output.at(-1)).toContain("INCOMPLETE");
    expect(f.output.at(-1)).not.toContain("COMPLETE CATCH-UP");
    expect(f.state().readDelivery.through).toBe(6);
    expect(f.state().observedStateRevision).toBe("opaque-base");
    expect(await f.run(["read", "--ack-through=7"])).toBe(1);
    const next = f.next();
    expect(await f.run(["read", "--ack-through=6"])).toBe(0);
    await f.finish(next);
    expect(f.state().observedStateRevision).toBe("opaque-7");
    expect(f.state().lastSeenSeq).toBe(6);
  });

  it("finishing an older delivery never replaces newer coverage or observation", async () => {
    const f = fixture();
    expect(await f.run(["read"], async () => json(delta(6, "x".repeat(25_000), "zzz-old")))).toBe(
      0,
    );
    const a = f.next();
    const firstReplay = f.replay();
    expect(await f.run(["read"], async () => json(delta(7, "newer", "aaa-new")))).toBe(0);
    await f.finish(a);
    expect(f.state().observedStateRevision).toBe("aaa-new");
    expect(f.state().readDelivery.through).toBe(7);
    const before = f.state();
    expect(await f.run(["read", `--continue=${firstReplay}`])).toBe(0);
    expect(f.state()).toEqual(before);
  });

  it("does not overwrite an observation changed while a network read was in flight", async () => {
    const f = fixture();
    const code = await f.run(["read"], async () => {
      // Simulates another successful local command while the request is in flight.
      updateProviderConfig((current) => {
        if (!current.currentRoom) throw new Error("Missing fixture room");
        return setRoomObservedStateRevision(
          current,
          "room",
          "https://operator.example",
          "intervening",
        );
      }, f.env);
      return json(delta(6, "response"));
    });
    expect(code).toBe(0);
    expect(f.state().observedStateRevision).toBe("intervening");
  });

  it("deduplicates completion after interrupted cache persistence and never refreshes new recovery", async () => {
    const f = fixture();
    expect(await f.run(["read"], async () => json(delta(6, "response")))).toBe(0);
    const token = f.replay();
    const cachePath = join(`${f.path}.deliveries-v2`, `${token.split(":")[0]}.json`);
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    cache.next = 0; // Crash after atomic config effects, before cache-progress save.
    writeFileSync(cachePath, JSON.stringify(cache));
    updateProviderConfig(
      (current) =>
        setRoomStaleWriteRecovery(current, "room", "https://operator.example", {
          operation: "discuss",
          requestBodySha256: "a".repeat(64),
          rejectedExpectedRevision: "opaque-6",
          rejectedCurrentRevision: "opaque-7",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      f.env,
    );
    const before = f.state();
    expect(await f.run(["read", `--continue=${token}`])).toBe(0);
    expect(f.state()).toEqual(before);
    expect(f.state().staleWriteRecovery).toBeUndefined();
  });

  it("retains separate state for incomplete or skipped catch-up and bulk reads", async () => {
    const f = fixture();
    expect(await f.run(["read", "--since=6"], async () => json(delta(7, "skipped")))).toBe(0);
    expect(f.state().readDelivery).toBeUndefined();
    expect(
      await f.run(["read"], async () =>
        json({ ...delta(7, ""), new: [{ seq: 7, type: "discussion", who: "Peer" }] }),
      ),
    ).toBe(0);
    expect(f.state().readDelivery).toBeUndefined();
    expect(f.state().observedStateRevision).toBe("opaque-base");
    expect(
      await f.run(["read"], async () =>
        json({ ...delta(7, "missing"), page: { complete: true, bodies_elided: true } }),
      ),
    ).toBe(0);
    expect(f.state().readDelivery).toBeUndefined();
    expect(await f.run(["read", "--json"], async () => json(delta(7, "bulk")))).toBe(0);
    expect(f.state().observedStateRevision).toBe("opaque-7");
    expect(f.output.at(-1)).not.toContain("_cli_observation_before");
  });

  it("an unfinished old delivery cannot authorize recovery for a newer rejection", async () => {
    const f = fixture();
    expect(await f.run(["read"], async () => json(delta(6, "x".repeat(20_000))))).toBe(0);
    const next = f.next();
    updateProviderConfig(
      (current) =>
        setRoomStaleWriteRecovery(current, "room", "https://operator.example", {
          operation: "discuss",
          requestBodySha256: "a".repeat(64),
          rejectedExpectedRevision: "opaque-base",
          rejectedCurrentRevision: "opaque-7",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      f.env,
    );
    await f.finish(next);
    expect(f.state().staleWriteRecovery).toBeUndefined();
    expect(await f.run(["read"], async () => json(delta(7, "fresh")))).toBe(0);
    expect(f.state().staleWriteRecovery).toBeUndefined();
    expect(f.state().observations.global).toBe("opaque-7");
  });
});

describe("truthful exact-review recovery", () => {
  it.each(["action.review_closed", "idempotency.in_progress"])(
    "uses error code %s when the round changes during submission",
    async (code) => {
      const f = fixture();
      let puts = 0;
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "PUT") {
          puts++;
          return json({ error: { code, message: "no pending exact artifact review" } }, 409);
        }
        if (request.url.includes("/actions/"))
          return json({
            action: {
              id: "a1",
              revision: "7",
              status: "in_review",
              completion: "group",
              target_artifact_id: "f1",
              review: { state: "pending", artifact_revision_id: "r1" },
            },
          });
        return json({
          artifact: { id: "f1", revision: "2", current_revision_id: "r1" },
          revision: { id: "r1", sha256: "b".repeat(64), blocks: [] },
          reviews: [],
        });
      };
      expect(await f.run(["act", "review", "a1", "--revision=r1", "--approve"], fetch)).toBe(1);
      expect(puts).toBe(1);
      expect(f.errors.join("").includes("round settled")).toBe(code === "action.review_closed");
      expect(f.errors.join("").includes("--kind=late")).toBe(code === "action.review_closed");
    },
  );
  it.each([
    { review: undefined, revision: "r1", expected: "has no pending", late: false },
    {
      review: { state: "approved", artifact_revision_id: "r1" },
      revision: "r1",
      expected: "round for this revision is closed",
      late: true,
    },
    {
      review: { state: "changes_requested", artifact_revision_id: "r1" },
      revision: "r1",
      expected: "round for this revision is closed",
      late: true,
    },
    {
      review: { state: "approved", artifact_revision_id: "r0" },
      revision: "r1",
      expected: "has no pending",
      late: false,
    },
    {
      review: { state: "unknown", artifact_revision_id: "r1" },
      revision: "r1",
      expected: "has no pending",
      late: false,
    },
    {
      review: { state: "pending", artifact_revision_id: "r2" },
      revision: "r1",
      expected: "revision mismatch",
      late: false,
    },
  ])(
    "reports $expected without changing the supplied endorsement",
    async ({ review, revision, expected, late }) => {
      const f = fixture();
      const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.method).toBe("GET");
        return json({
          action: {
            id: "a1",
            revision: "action-state",
            status: "in_progress",
            holder_id: "another-principal",
            target_artifact_id: "f1",
            review,
          },
        });
      });
      expect(
        await f.run(
          ["act", "review", "a1", `--revision=${revision}`, "--approve", "--body=Exact assessment"],
          fetch,
        ),
      ).toBe(1);
      const error = f.errors.join("");
      expect(error).toContain(expected);
      expect(error.includes("--kind=late")).toBe(late);
      if (!late) expect(error).not.toContain("no longer");
      expect(error).not.toContain("request-review");
    },
  );
});
