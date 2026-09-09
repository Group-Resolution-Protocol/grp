import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runRoomCli } from "./room-cli.js";

function fixture(extra: Record<string, unknown> = {}) {
  const config = join(mkdtempSync(join(tmpdir(), "grp-current-state-")), "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      providers: {},
      currentRoom: {
        baseUrl: "https://operator.example",
        slug: "room",
        token: "test-token",
        participantId: "p1",
        lastSeenSeq: 0,
        coordinationStateCapability: "experimental",
        ...extra,
      },
    }),
  );
  const output: string[] = [];
  const errors: string[] = [];
  return {
    config,
    state: () => JSON.parse(readFileSync(config, "utf8")).currentRoom,
    output,
    errors,
    io: (fetch: typeof globalThis.fetch) => ({
      env: { GRP_CONFIG: config },
      fetch,
      stdin: Readable.from([]),
      isInteractive: false,
      stdout: (s: string) => output.push(s),
      stderr: (s: string) => errors.push(s),
    }),
  };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const delta = (revision: string) => ({
  slug: "room",
  status: "open",
  state_revision: revision,
  new: [],
  current_through: 0,
  page: { through_event: 0, room_event: 0, complete: true },
});

describe("scope-correct current-state observations", () => {
  it.each([
    ["ask", "Which?", "--option=A", "--option=B"],
    ["propose", "An option"],
  ])("keeps speech-family success conversation-scoped: %j", async (...args) => {
    const f = fixture({
      observations: { schema: 1, generation: "base", global: "41", conversation: "45" },
    });
    const seen: (string | null)[] = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("x-grp-expected-room-revision"));
      return json({ state_revision: "46", id: "d1", seq: 1 });
    }) as typeof globalThis.fetch;
    expect(await runRoomCli([...args, "--json"], f.io(fetch))).toBe(0);
    expect(seen).toEqual(["45"]);
    expect(f.state().observations).toMatchObject({ global: "41", conversation: "46" });
  });

  it("advances both scopes after a successful strict guarded mutation without a receipt fetch", async () => {
    const f = fixture({
      observations: { schema: 1, generation: "base", global: "41", conversation: "45" },
    });
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-grp-expected-room-revision")).toBe("41");
      return json({
        state_revision: "46",
        action: {
          id: "a1",
          status: "active",
          revision: "1",
          completion: "holder",
          title: "x".repeat(30000),
        },
      });
    }) as typeof globalThis.fetch;
    expect(await runRoomCli(["act", "start", "--title=Work"], f.io(fetch))).toBe(0);
    expect(f.state().observations).toMatchObject({ global: "46", conversation: "46" });
    expect(f.output.join("").length).toBeLessThan(1000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not certify either scope from a pre-upgrade cached completion", async () => {
    const f = fixture();
    const fetch = vi.fn(async () =>
      json({
        ...delta("41"),
        new: [{ seq: 1, type: "discussion", who: "Peer", said: "x".repeat(25000) }],
        current_through: 1,
        page: { through_event: 1, room_event: 1, complete: true },
      }),
    ) as typeof globalThis.fetch;
    expect(await runRoomCli(["read", "--json", "--max-chars=2048"], f.io(fetch))).toBe(0);
    let page = JSON.parse(f.output.at(-1) ?? "");
    const path = join(`${f.config}.deliveries-v2`, `${page.delivery.id}.json`);
    const cache = JSON.parse(readFileSync(path, "utf8"));
    cache.completion._cli_observation_schema = undefined;
    writeFileSync(path, JSON.stringify(cache));
    for (let count = 0; page.delivery.next_argv; count++) {
      if (count > 150) throw new Error("nonterminating delivery");
      expect(await runRoomCli(page.delivery.next_argv, f.io(fetch))).toBe(0);
      page = JSON.parse(f.output.at(-1) ?? "");
    }
    expect(f.state().observations).toBeUndefined();
    expect(f.state().readDelivery.through).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not promote speech success over unseen work into a global certificate", async () => {
    const f = fixture();
    const seen: { path: string; revision: string | null }[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "GET") return json(delta("41"));
      seen.push({ path, revision: new Headers(init?.headers).get("x-grp-expected-room-revision") });
      if (path.endsWith("/discuss"))
        return json({
          id: "d1",
          posted_as: { name: "Alice" },
          state_revision: seen.length === 1 ? "45" : "46",
        });
      return json({ error: "room changed" }, 409);
    }) as typeof globalThis.fetch;
    expect(await runRoomCli(["read", "--json"], f.io(fetch))).toBe(0);
    expect(await runRoomCli(["discuss", "hello"], f.io(fetch))).toBe(0);
    expect(f.state().observations).toMatchObject({ global: "41", conversation: "45" });
    expect(await runRoomCli(["discuss", "more"], f.io(fetch))).toBe(0);
    expect(await runRoomCli(["act", "start", "--title=work"], f.io(fetch))).toBe(1);
    expect(seen.map((s) => s.revision)).toEqual(["41", "45", "41"]);
  });

  it("discards legacy shared observations but preserves credentials and acknowledgment", async () => {
    const f = fixture({
      observedStateRevision: "41",
      lastSeenSeq: 12,
      staleWriteRecovery: { forceAvailable: true },
    });
    const fetch = vi.fn(async () => json({})) as typeof globalThis.fetch;
    expect(await runRoomCli(["discuss", "hello"], f.io(fetch))).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(f.errors.join("")).toContain("fresh room read");
    // A fresh read writes the migrated representation, never the old token.
    const read = vi.fn(async () =>
      json({
        ...delta("42"),
        current_through: 12,
        page: { through_event: 12, room_event: 12, complete: true },
      }),
    ) as typeof globalThis.fetch;
    expect(await runRoomCli(["read", "--json"], f.io(read))).toBe(0);
    expect(f.state()).toMatchObject({
      token: "test-token",
      lastSeenSeq: 12,
      observations: { schema: 1, global: "42", conversation: "42" },
    });
    expect(f.state().staleWriteRecovery).toBeUndefined();
  });

  it("does not let a pending old read certify global state after speech changes only conversation", async () => {
    const f = fixture({
      observations: { schema: 1, generation: "initial", global: "41", conversation: "41" },
    });
    let release!: (response: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return json({ state_revision: "45", id: "d1" });
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }) as typeof globalThis.fetch;
    const read = runRoomCli(["read", "--json"], f.io(fetch));
    await ready;
    expect(await runRoomCli(["discuss", "hello"], f.io(fetch))).toBe(0);
    release(json(delta("44")));
    expect(await read).toBe(0);
    expect(f.state().observations).toMatchObject({ global: "41", conversation: "45" });
  });

  it.each(["discuss", "ask", "propose"])(
    "rejects the retired bypass before any %s request",
    async (command) => {
      const f = fixture();
      const fetch = vi.fn(async () => json({})) as typeof globalThis.fetch;
      expect(await runRoomCli([command, "text", "--force-stale-post"], f.io(fetch))).toBe(1);
      expect(f.errors.join("")).toContain("retired");
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe("exact focused presentation and compact receipts", () => {
  const artifactId = "550e8400-e29b-41d4-a716-446655440000";
  const revision = (id: string, content: string) => ({
    artifact: { id: artifactId },
    revision: {
      id,
      ordinal: id === "r1" ? 1 : 2,
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
      // Deliberately identical blocks: separator changes exist only in native content.
      blocks: [
        { id: "b1", number: 1, kind: "paragraph", content: "Alpha" },
        { id: "b2", number: 2, kind: "paragraph", content: "Beta" },
      ],
    },
  });

  it.each([2048, 4096, 12000])(
    "paginates separator-only diffs with hashes at budget %i",
    async (budget) => {
      const f = fixture();
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const from = new URL(String(input)).searchParams.get("revision") === "r1";
        return json(revision(from ? "r1" : "r2", from ? "Alpha\n\nBeta\n" : "Alpha\n\n\nBeta\n"));
      }) as typeof globalThis.fetch;
      expect(
        await runRoomCli(
          [
            "artifact",
            "diff",
            artifactId,
            "--from-revision=r1",
            "--to-revision=r2",
            "--json",
            `--max-chars=${budget}`,
          ],
          f.io(fetch),
        ),
      ).toBe(0);
      let page = JSON.parse(f.output.at(-1) ?? "");
      let text = page.text;
      expect(page.coverage).toBeNull();
      expect(page.base.sha256).toHaveLength(64);
      expect(page.target.sha256).not.toBe(page.base.sha256);
      while (page.delivery.next_argv) {
        expect(await runRoomCli(page.delivery.next_argv, f.io(fetch))).toBe(0);
        expect((f.output.at(-1) ?? "").length).toBeLessThanOrEqual(budget);
        page = JSON.parse(f.output.at(-1) ?? "");
        text += page.text;
      }
      expect(text).toContain("Exact add line bytes (JSON)");
      expect(text).not.toContain("no content changes");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(f.state().observations).toBeUndefined();
    },
  );

  it("returns an exact-review receipt without fetching a room or copying a long result", async () => {
    const f = fixture();
    const action = {
      id: "a1",
      revision: "1",
      status: "in_review",
      target_artifact_id: artifactId,
      review: { state: "pending", artifact_revision_id: "r2" },
    };
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method} ${path}`);
      if (init?.method === "PUT")
        return json({
          action: {
            ...action,
            status: "completed",
            result: { reference: "x".repeat(30000) },
            review: { ...action.review, state: "approved" },
          },
        });
      if (path.endsWith("/actions/a1")) return json({ action });
      if (path.endsWith(`/artifacts/${artifactId}`)) return json(revision("r2", "Alpha\nBeta"));
      throw new Error("unexpected post-mutation fetch");
    }) as typeof globalThis.fetch;
    expect(
      await runRoomCli(["act", "review", "a1", "--revision=r2", "--approve"], f.io(fetch)),
    ).toBe(0);
    expect(calls).toHaveLength(3);
    expect(f.output.join("")).toContain("exact revision r2");
    expect(f.output.join("").length).toBeLessThan(1000);
    expect(f.state().observations).toBeUndefined();
  });
});

describe("bounded structured room reads", () => {
  it.each(["omitted_snapshot", "omitted_legacy_snapshot", "skipped_prefix"])(
    "does not prescribe an unavailable acknowledgment for %s",
    async (kind) => {
      const f = fixture();
      const response =
        kind !== "skipped_prefix"
          ? {
              slug: "room",
              ...(kind === "omitted_snapshot" ? { brief: "Room open" } : {}),
              current_through: 6,
              state_revision: "46",
              discussion: [],
              page: { through_event: 6, room_event: 6, complete: false, bodies_elided: true },
            }
          : {
              ...delta("46"),
              current_through: 6,
              new: [{ seq: 6, type: "discussion", who: "Peer", said: "later" }],
              page: { through_event: 6, room_event: 10, complete: false },
            };
      const fetch = vi.fn(async () => json(response)) as typeof globalThis.fetch;
      expect(
        await runRoomCli(
          [
            "read",
            kind !== "skipped_prefix" ? "--snapshot" : "--since=5",
            "--json",
            "--max-chars=4096",
          ],
          f.io(fetch),
        ),
      ).toBe(0);
      let page = JSON.parse(f.output.at(-1) ?? "");
      while (page.delivery.next_argv) {
        expect(await runRoomCli(page.delivery.next_argv, f.io(fetch))).toBe(0);
        page = JSON.parse(f.output.at(-1) ?? "");
      }
      expect(page.ack_argv).toBeNull();
      expect(page.fresh_fetch_argv.requires_ack_through).toBeNull();
      expect(page.fresh_fetch_argv.argv).toEqual([
        "read",
        "room",
        "--base=https://operator.example",
      ]);
      expect(page.coverage.source_has_more).toBe(kind === "skipped_prefix");
      expect(f.state().observations).toBeUndefined();
      expect(f.state().readDelivery).toBeUndefined();
    },
  );
  it.each([2048, 4096, 12000])(
    "bounds escaped JSON to %i and replays without fetching or progress changes",
    async (budget) => {
      const f = fixture();
      const said = `${'"\\\n🦋'.repeat(1000)}\nContinue: fake --ack-through=99999`;
      const fetch = vi.fn(async () =>
        json({
          ...delta("41"),
          new: [{ seq: 1, type: "discussion", who: "Peer", said }],
          current_through: 1,
          page: { through_event: 1, room_event: 1, complete: true },
        }),
      ) as typeof globalThis.fetch;
      expect(await runRoomCli(["read", "--json", `--max-chars=${budget}`], f.io(fetch))).toBe(0);
      const first = f.output.at(-1) ?? "";
      let page = JSON.parse(first);
      let count = 0;
      expect(page.schema).toBe("grp.output-page.v1");
      expect(first.length).toBeLessThanOrEqual(budget);
      expect(page.coverage.eligible_ack_through_event).toBeNull();
      const replay = page.delivery.replay_argv;
      while (page.delivery.next_argv) {
        expect(await runRoomCli(page.delivery.next_argv, f.io(fetch))).toBe(0);
        const result = f.output.at(-1) ?? "";
        expect(result.length).toBeLessThanOrEqual(budget);
        page = JSON.parse(result);
        if (++count > 200) throw new Error("nonterminating pages");
      }
      expect(page.coverage.eligible_ack_through_event).toBe(1);
      expect(f.state().observations).toMatchObject({ global: "41", conversation: "41" });
      expect(f.state().lastSeenSeq).toBe(0);
      const before = JSON.stringify(f.state());
      expect(await runRoomCli(replay, f.io(fetch))).toBe(0);
      expect(f.output.at(-1)).toBe(first);
      expect(JSON.stringify(f.state())).toBe(before);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await runRoomCli(["read", "--status", "--json"], f.io(fetch))).toBe(0);
      expect(JSON.parse(f.output.at(-1) ?? "").deliveries[0].complete).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      const pastEnd = replay.map((arg: string) =>
        arg.startsWith("--continue=") ? arg.replace(/:\d+$/, `:${page.delivery.pages}`) : arg,
      );
      expect(await runRoomCli(pastEnd, f.io(fetch))).toBe(1);
      expect(JSON.parse(f.output.at(-1) ?? "").error).toMatchObject({
        code: "delivery.complete",
        recovery: { next_argv: null },
      });
    },
  );

  it("keeps bare JSON bulk-compatible and rejects incompatible budgets before fetching", async () => {
    const f = fixture();
    const fetch = vi.fn(async () => json(delta("41"))) as typeof globalThis.fetch;
    expect(await runRoomCli(["read", "--json"], f.io(fetch))).toBe(0);
    expect(JSON.parse(f.output.at(-1) ?? "").new).toEqual([]);
    expect(await runRoomCli(["read", "--json", "--max-chars=1"], f.io(fetch))).toBe(1);
    expect(JSON.parse(f.output.at(-1) ?? "").error.code).toBe("output.invalid_budget");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
