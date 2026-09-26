import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runRoomCli } from "./room-cli.js";

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), "grp-read-clarity-")), "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      providers: {},
      currentRoom: {
        baseUrl: "https://operator.example",
        slug: "room",
        participantId: "reader",
        token: "test-token",
        lastSeenSeq: 5,
      },
    }),
  );
  const output: string[] = [];
  const requests: Array<string | null> = [];
  const state = () => JSON.parse(readFileSync(path, "utf8")).currentRoom;
  const run = (args: string[], said = "A peer update") =>
    runRoomCli(args, {
      env: { GRP_CONFIG: path },
      stdout: (s) => output.push(s),
      stderr: () => {},
      fetch: async (input, init) => {
        const since = new URL(new Request(input, init).url).searchParams.get("since");
        requests.push(since);
        return new Response(
          JSON.stringify({
            slug: "room",
            state: "no question open",
            status: "open",
            current_through: 6,
            new: Number(since) < 6 ? [{ seq: 6, type: "discussion", who: "Peer", said }] : [],
            page: { complete: true, through_event: 6, room_event: 6 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
  return { run, output, requests, state };
}

describe("read position clarity", () => {
  it("explains unchanged position while preserving repeated reads and explicit acknowledgment", async () => {
    const f = fixture();
    for (let i = 0; i < 2; i++) {
      expect(await f.run(["read"])).toBe(0);
      const text = f.output.at(-1) ?? "";
      expect(text).toContain("Updates in this fetched range:");
      expect(text).toContain(
        "Saved read position unchanged. Acknowledgment is a separate command.",
      );
      expect(text).toContain("Advance saved read position through 6");
      expect(text).toContain("delivery alone does not advance it");
      expect(text).not.toContain("New since your last read");
      expect(text).not.toContain("acknowledgment follows complete delivery");
      expect(f.state().lastSeenSeq).toBe(5);
    }
    expect(f.requests).toEqual(["5", "5"]);
    expect(await f.run(["read", "--ack-through=6"])).toBe(0);
    expect(f.requests).toHaveLength(2);
    expect(f.state().lastSeenSeq).toBe(6);
    expect(await f.run(["read"])).toBe(0);
    expect(f.requests).toEqual(["5", "5", "6"]);
    expect(f.output.at(-1)).not.toContain("A peer update");
  });

  it("does not mislabel explicit historical ranges as new since the saved position", async () => {
    const f = fixture();
    expect(await f.run(["read", "--since=0"])).toBe(0);
    expect(f.requests).toEqual(["0"]);
    expect(f.output.at(-1)).toContain("Updates in this fetched range:");
    expect(f.output.at(-1)).not.toContain("New since your last read");
    expect(f.state().lastSeenSeq).toBe(5);
  });

  it("keeps an unread fragment ineligible and final delivery distinct from acknowledgment", async () => {
    const f = fixture();
    expect(await f.run(["read"], "paragraph\n".repeat(3000))).toBe(0);
    expect(f.output.at(-1)).toContain("INCOMPLETE");
    expect(f.output.at(-1)).not.toContain("Advance saved read position through 6");
    expect(await f.run(["read", "--ack-through=6"])).toBe(1);
    let pages = 1;
    for (;;) {
      const token = /Continue this exact delivery: .*--continue=(\S+)/.exec(
        f.output.at(-1) ?? "",
      )?.[1];
      if (!token) break;
      expect(await f.run(["read", `--continue=${token}`])).toBe(0);
      expect(++pages).toBeLessThan(20);
      expect(f.state().lastSeenSeq).toBe(5);
    }
    expect(f.output.at(-1)).toContain("FINAL fragment");
    expect(f.output.at(-1)).toContain("Advance saved read position through 6");
    expect(f.requests).toHaveLength(1);
    expect(await f.run(["read", "--ack-through=6"])).toBe(0);
    expect(f.state().lastSeenSeq).toBe(6);
  });
});
