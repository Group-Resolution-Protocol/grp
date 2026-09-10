import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runRoomCli } from "./room-cli.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const delta = (said: string) => ({
  slug: "room",
  state: "no question open",
  state_revision: "fresh",
  current_through: 6,
  new: [{ seq: 6, type: "discussion", who: "Peer", said }],
  page: { through_event: 6, room_event: 6, complete: true },
});
const reject = () =>
  json(
    {
      error: {
        code: "state.precondition_failed",
        message: "changed",
        details: { expected_state_revision: "old", current_state_revision: "new", posted: false },
      },
    },
    412,
  );

function fixture(observed = true) {
  const path = join(mkdtempSync(join(tmpdir(), "grp-default-recovery-")), "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      providers: {},
      currentRoom: {
        baseUrl: "https://operator.example",
        slug: "room",
        token: "test-token",
        participantId: "p1",
        lastSeenSeq: 5,
        coordinationStateCapability: "experimental",
        ...(observed
          ? { observations: { schema: 1, generation: "base", global: "old", conversation: "old" } }
          : {}),
      },
    }),
  );
  const output: string[] = [];
  const errors: string[] = [];
  const run = (
    args: string[],
    fetch: typeof globalThis.fetch = async () => {
      throw Error("Unexpected fetch");
    },
  ) =>
    runRoomCli(args, {
      env: { GRP_CONFIG: path },
      fetch,
      stdin: Readable.from([]),
      isInteractive: false,
      stdout: (s) => output.push(s),
      stderr: (s) => errors.push(s),
    });
  const state = () => JSON.parse(readFileSync(path, "utf8")).currentRoom;
  const next = () =>
    /Continue this exact delivery: .*--continue=(\S+)/.exec(output.at(-1) ?? "")?.[1];
  return { path, output, errors, run, state, next };
}

describe("default read recovery", () => {
  it("does not reject otherwise valid speech just because a newer read is incomplete", async () => {
    const f = fixture();
    expect(await f.run(["read"], async () => json(delta("x".repeat(30000))))).toBe(0);
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-grp-expected-room-revision")).toBe("old");
      return json({ id: "post", state_revision: "after-speech" });
    });
    expect(await f.run(["discuss", "valid against conversation"], fetch)).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.state().observations.global).toBe("old");
    expect(f.state().lastSeenSeq).toBe(5);
  });

  it("does not resurrect older unfinished delivery after a newer completed read", async () => {
    const f = fixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
    try {
      expect(await f.run(["read"], async () => json(delta("x".repeat(30000))))).toBe(0);
      clock.mockReturnValue(2_000_000_000_100);
      expect(await f.run(["read"], async () => json(delta("short complete read")))).toBe(0);
      expect(await f.run(["discuss", "hello", "--json"], async () => reject())).toBe(1);
      expect(JSON.parse(f.output.at(-1) ?? "").read_recovery.continue_argv).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it("preserves the old framing on pre-upgrade caches without bookended controls", async () => {
    const f = fixture();
    expect(await f.run(["read"], async () => json(delta("x".repeat(30000))))).toBe(0);
    const first = f.output.at(-1) ?? "";
    const replay = /Replay this page: .*--continue=(\S+)/.exec(first)?.[1];
    if (!replay) throw new Error("Missing replay");
    const path = join(`${f.path}.deliveries-v2`, `${replay.split(":")[0]}.json`);
    const cache = JSON.parse(readFileSync(path, "utf8"));
    cache.bookendedControls = undefined;
    writeFileSync(path, JSON.stringify(cache));
    expect(await f.run(["read", `--continue=${replay}`])).toBe(0);
    const legacy = f.output.at(-1) ?? "";
    expect(legacy.match(/Continue this exact delivery:/g)).toHaveLength(1);
    expect(legacy).not.toContain("Room observation not established by this partial delivery");
    expect(await f.run(["read", `--continue=${replay}`])).toBe(0);
    expect(f.output.at(-1)).toBe(legacy);
  });

  it("places exact next commands at both boundaries, preserves replay and withholds partial observations", async () => {
    const f = fixture();
    const read = vi.fn(async () => json(delta("long generic paragraph\n".repeat(1200))));
    expect(await f.run(["read"], read)).toBe(0);
    const first = f.output.at(-1) ?? "";
    expect(first.split("\n")[1]).toContain("Continue this exact delivery:");
    expect(first.match(/Continue this exact delivery:/g)).toHaveLength(2);
    expect(first).toContain("Room observation not established by this partial delivery.");
    expect(first.length).toBeLessThanOrEqual(12000);
    expect(f.state().observations.conversation).toBe("old");
    const replay = /Replay this page: .*--continue=(\S+)/.exec(first)?.[1];
    expect(await f.run(["read", `--continue=${replay}`])).toBe(0);
    expect(f.output.at(-1)).toBe(first);
    const pending = f.next();
    const before = readFileSync(f.path, "utf8");
    const write = vi.fn(async () => reject());
    expect(await f.run(["discuss", "A contribution"], write)).toBe(1);
    expect(f.errors.at(-1)).toContain(`--continue=${pending}`);
    expect(f.errors.at(-1)).toContain("Latest saved room read is unfinished");
    expect(f.errors.at(-1)).toContain("grp read room --base=https://operator.example");
    expect(readFileSync(f.path, "utf8")).toBe(before);
    expect(write).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("recovers a missing initial observation locally without making a mutation request", async () => {
    const f = fixture(false);
    expect(await f.run(["read"], async () => json(delta("x".repeat(30000))))).toBe(0);
    const pending = f.next();
    const fetch = vi.fn(async () => reject());
    expect(await f.run(["discuss", "hello", "--json"], fetch)).toBe(1);
    const error = JSON.parse(f.output.at(-1) ?? "").error;
    expect(error.posted).toBe(false);
    expect(error.read_recovery.continue_argv).toContain(`--continue=${pending}`);
    expect(error.message).toContain("No mutation was sent");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("offers an explicit incorporated-prefix acknowledgment and a separate pinned-destination fresh read", async () => {
    const f = fixture();
    expect(await f.run(["read"], async () => json(delta("new contribution")))).toBe(0);
    const before = readFileSync(f.path, "utf8");
    expect(await f.run(["discuss", "hello", "--json"], async () => reject())).toBe(1);
    const result = JSON.parse(f.output.at(-1) ?? "");
    expect(result.error.details.posted).toBe(false);
    expect(result.read_recovery).toEqual({
      credential_flags_required: [],
      continue_argv: null,
      fresh_read_argv: ["read", "room", "--base=https://operator.example"],
      acknowledge_if_incorporated_argv: [
        "read",
        "room",
        "--base=https://operator.example",
        "--ack-through=6",
      ],
    });
    expect(readFileSync(f.path, "utf8")).toBe(before);
    expect(f.state().lastSeenSeq).toBe(5);
    expect(await f.run(result.read_recovery.acknowledge_if_incorporated_argv)).toBe(0);
    expect(await f.run(["discuss", "hello", "--json"], async () => reject())).toBe(1);
    expect(
      JSON.parse(f.output.at(-1) ?? "").read_recovery.acknowledge_if_incorporated_argv,
    ).toBeNull();
  });

  it.each(["expired", "corrupt", "other_identity"])(
    "does not offer unusable %s cached continuation",
    async (kind) => {
      const f = fixture();
      expect(await f.run(["read"], async () => json(delta("x".repeat(30000))))).toBe(0);
      const dir = `${f.path}.deliveries-v2`;
      const filename = readdirSync(dir).find((name) => name.endsWith(".json"));
      if (!filename) throw new Error("Missing delivery cache");
      const path = join(dir, filename);
      const cache = JSON.parse(readFileSync(path, "utf8"));
      if (kind === "expired") cache.expires = 1;
      if (kind === "other_identity") cache.scope = "other";
      writeFileSync(path, kind === "corrupt" ? "{" : JSON.stringify(cache));
      expect(await f.run(["discuss", "hello", "--json"], async () => reject())).toBe(1);
      const result = JSON.parse(f.output.at(-1) ?? "");
      expect(result.error.code).toBe("state.precondition_failed");
      expect(result.read_recovery.continue_argv).toBeNull();
    },
  );

  it("never substitutes the saved current room for an explicitly targeted other operator", async () => {
    const f = fixture();
    const config = JSON.parse(readFileSync(f.path, "utf8"));
    config.rooms = [{ ...config.currentRoom, slug: "other", baseUrl: "https://second.example" }];
    writeFileSync(f.path, JSON.stringify(config));
    const fetch = vi.fn(async () => reject());
    expect(
      await f.run(["discuss", "hello", "other", "--base=https://second.example", "--json"], fetch),
    ).toBe(1);
    const result = JSON.parse(f.output.at(-1) ?? "");
    expect(result.read_recovery.fresh_read_argv).toEqual([
      "read",
      "other",
      "--base=https://second.example",
    ]);
    expect(result.read_recovery.continue_argv).toBeNull();
  });

  it("does not use remembered acknowledgment eligibility for explicit credential overrides", async () => {
    const f = fixture();
    expect(await f.run(["read"], async () => json(delta("new contribution")))).toBe(0);
    expect(
      await f.run(["discuss", "hello", "--token=other-token", "--json"], async () => reject()),
    ).toBe(1);
    const result = JSON.parse(f.output.at(-1) ?? "");
    expect(result.read_recovery.acknowledge_if_incorporated_argv).toBeNull();
    expect(result.read_recovery.continue_argv).toBeNull();
    expect(JSON.stringify(result.read_recovery)).not.toContain("other-token");
  });

  it("distinguishes snapshot head from the actual unchanged acknowledgment position", async () => {
    const f = fixture();
    expect(
      await f.run(["read", "--snapshot"], async () =>
        json({
          slug: "room",
          brief: "No decision is open.",
          current_through: 20,
          state_revision: "head",
          discussion: [],
          page: { room_event: 20, complete: true },
        }),
      ),
    ).toBe(0);
    expect(f.output.at(-1)).toContain(
      "captured through event 20. Acknowledged position: 5 (unchanged)",
    );
    expect(f.state().lastSeenSeq).toBe(5);
  });
});
