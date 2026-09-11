import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { parseRoomArgs, runRoomCli } from "./room-cli.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const id = "1800000000000_00000000-0000-4000-8000-000000000001";
const proof = `${id}.1.5.${"a".repeat(64)}`;
const turn = (held = true, epoch = "1") => ({
  policy: "speaking_turns",
  revision: "1",
  concluded: false,
  holder: {
    participant_id: held ? "p1" : "p2",
    request_id: held ? id : "other",
    epoch,
    expires_at: "2030-01-01T00:05:00Z",
    max_until: "2030-01-01T00:10:00Z",
  },
  own: {
    request_id: id,
    status: held ? "held" : "queued",
    queue_position: held ? null : 1,
    expires_at: "2030-01-01T00:05:00Z",
  },
});
const read = (said = "Complete current contribution") => ({
  slug: "room",
  state: "no question open",
  state_revision: "6",
  current_through: 6,
  new: [{ seq: 6, type: "discussion", who: "Peer", said }],
  page: { through_event: 6, room_event: 6, complete: true },
  speaking_turn: { ...turn(), observation: proof },
});
function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), "grp-turns-")), "config.json");
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
        observations: { schema: 1, generation: "base", global: "5", conversation: "5" },
      },
    }),
  );
  const output: string[] = [];
  const errors: string[] = [];
  const run = (
    args: string[],
    fetch: typeof globalThis.fetch = async () => {
      throw new Error("unexpected fetch");
    },
  ) =>
    runRoomCli(args, {
      env: { GRP_CONFIG: path },
      fetch,
      stdin: Readable.from([]),
      isInteractive: false,
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
    });
  const state = () => JSON.parse(readFileSync(path, "utf8")).currentRoom;
  return { run, state, output, errors };
}

describe("optional speaking turns", () => {
  it("does not offer observers an unavailable speaking request", async () => {
    const f = fixture();
    const response = {
      ...read(),
      you: { participant_id: "p1", role: "observer" },
      speaking_turn: { ...turn(), own: null, observation: null },
    };
    expect(await f.run(["read"], async () => json(response))).toBe(0);
    expect(f.output.join("")).toContain("observer; no speaking request");
    expect(f.output.join("")).not.toContain("grp turn request");
  });
  it("keeps the room positional after bare --turn", () => {
    expect(parseRoomArgs(["watch", "--turn", "room"]).positionals).toEqual(["watch", "room"]);
  });
  it("requests explicitly without reading, posting, or adopting an observation", async () => {
    const f = fixture();
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.operation).toBe("request");
      expect(body.request_id).toMatch(/^\d{13}_[a-f0-9-]{36}$/);
      return json({ speaking_turn: { ...turn(), observation: "must-not-adopt" } });
    });
    expect(await f.run(["turn", "request"], fetch)).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.state().speakingTurn).toMatchObject({ requestId: id, epoch: "1" });
    expect(f.state().speakingTurn.observation).toBeUndefined();
    expect(f.state().observations.conversation).toBe("5");
    expect(f.output.join("")).toContain("complete current room read");
  });
  it("carries the exact grant observation only after complete delivery and clears consumed authority", async () => {
    const f = fixture();
    expect(await f.run(["read"], async () => json(read()))).toBe(0);
    expect(f.state().speakingTurn.observation).toBe(proof);
    expect(f.state().lastSeenSeq).toBe(5);
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-grp-speaking-observation")).toBe(proof);
      return json({ id: "post", state_revision: "7" });
    });
    expect(await f.run(["discuss", "New contribution"], fetch)).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.state().speakingTurn.requestId).toBeUndefined();
    expect(f.state().speakingTurn.observation).toBeUndefined();
  });
  it("does not certify partial output, but certifies its exact completed continuation", async () => {
    const f = fixture();
    expect(await f.run(["read"], async () => json(read("text ".repeat(8000))))).toBe(0);
    expect(f.state().speakingTurn?.observation).toBeUndefined();
    for (let i = 0; i < 12 && !f.state().speakingTurn?.observation; i++) {
      const next = /Continue this exact delivery: .*--continue=(\S+)/.exec(
        f.output.at(-1) ?? "",
      )?.[1];
      expect(next).toBeTruthy();
      expect(await f.run(["read", `--continue=${next}`])).toBe(0);
    }
    expect(f.state().speakingTurn.observation).toBe(proof);
  });
  it("adopts complete bulk JSON observation without acknowledging the cursor", async () => {
    const f = fixture();
    expect(await f.run(["read", "--json", "--full"], async () => json(read()))).toBe(0);
    expect(f.state().speakingTurn.observation).toBe(proof);
    expect(f.state().lastSeenSeq).toBe(5);
  });
  it("never sends another credential's observation", async () => {
    const f = fixture();
    await f.run(["read"], async () => json(read()));
    const seen: (string | null)[] = [];
    await f.run(["discuss", "Other caller", "--token=different-token"], async (_input, init) => {
      seen.push(new Headers(init?.headers).get("x-grp-speaking-observation"));
      return json({ id: "other", state_revision: "7" });
    });
    expect(seen).not.toContain(proof);
  });
  it("retains the request ID across an uncertain request response", async () => {
    const f = fixture();
    const ids: string[] = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      ids.push(JSON.parse(String(init?.body)).request_id);
      throw new Error("connection closed");
    };
    expect(await f.run(["turn", "request"], fetch)).toBe(1);
    expect(await f.run(["turn", "request"], fetch)).toBe(1);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });
  it("watches the exact request, ignores timeouts, and does not certify the grant", async () => {
    const f = fixture();
    await f.run(["turn", "request"], async () => json({ speaking_turn: turn(false) }));
    let calls = 0;
    expect(
      await f.run(["watch", "--turn", "--timeout=2"], async (input) => {
        expect(new URL(String(input)).searchParams.get("turn_request")).toBe(id);
        calls++;
        return calls === 1
          ? json({ status: "timeout" })
          : json({
              status: "speaking_turn",
              speaking_turn: { ...turn(), target: { request_id: id, status: "granted" } },
            });
      }),
    ).toBe(0);
    expect(calls).toBe(2);
    expect(f.state().speakingTurn.observation).toBeUndefined();
    expect(f.state().lastSeenSeq).toBe(5);
    expect(f.output.join("")).toContain("granted");
  });
  it("uses explicit renewal with request and epoch, without sliding the observation", async () => {
    const f = fixture();
    await f.run(["read"], async () => json(read()));
    expect(
      await f.run(["turn", "renew"], async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          operation: "renew",
          request_id: id,
          epoch: "1",
        });
        return json({ speaking_turn: turn() });
      }),
    ).toBe(0);
    expect(f.state().speakingTurn.observation).toBe(proof);
  });
  it("does not silently retry a rejected contribution or reacquire a turn", async () => {
    const f = fixture();
    await f.run(["read"], async () => json(read()));
    const fetch = vi.fn(async () =>
      json({ error: { code: "turn.read_required", message: "Read current context" } }, 409),
    );
    expect(await f.run(["discuss", "Expired grant"], fetch)).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.errors.join("")).toContain("Read current context");
  });
});
