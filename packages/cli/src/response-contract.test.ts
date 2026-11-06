import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRoomCli } from "./room-cli.js";

// Fixed scaffolding budgets, not limits on user content. Change a budget only
// with a reviewed explanation; never truncate text to make this suite pass.
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("agent response contracts", () => {
  it("describes watch completion without promising one parseable wake phrase", async () => {
    let output = "";
    expect(
      await runRoomCli(["watch", "--help"], {
        stdout: (text) => {
          output += text;
        },
        stderr: (text) => {
          throw new Error(text);
        },
        fetch: async () => {
          throw new Error("Help must remain offline");
        },
        env: {},
      }),
    ).toBe(0);
    expect(output).toContain("By default, return once");
    expect(output).toContain("Exit 0 includes timeout");
    expect(output).toContain("reason text varies by event");
    expect(output).toContain("grp read after return");
    expect(output).toContain("does not acknowledge content");
    expect(output).not.toContain("grep");
  });
  it.each([
    ["read", 1500],
    ["discuss", 1200],
    ["watch", 1000],
    ["act", 5000],
    ["artifact", 1700],
    ["turn", 700],
  ] as const)(
    "keeps %s help bounded, offline and free of transport/schema internals",
    async (command, budget) => {
      let output = "";
      expect(
        await runRoomCli([command, "--help"], {
          stdout: (text) => {
            output += text;
          },
          stderr: (text) => {
            throw new Error(text);
          },
          fetch: async () => {
            throw new Error("Help must remain offline");
          },
          env: {},
        }),
      ).toBe(0);
      expect(output).toContain(`grp ${command}`);
      expect(bytes(output)).toBeLessThan(budget);
      expect(output).not.toMatch(/structuredContent|nativeBlocks|Bearer <token>|\[object Object\]/);
      // Long exact duplicated instruction lines usually indicate concatenated help.
      const lines = output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 100);
      expect(new Set(lines).size).toBe(lines.length);
    },
  );

  it("keeps read overhead bounded while preserving user text, recovery handles and ACK state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "grp-response-contract-"));
    directories.push(directory);
    const config = join(directory, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        providers: {},
        currentRoom: {
          baseUrl: "https://operator.example",
          slug: "fixture",
          participantId: "reader",
          token: "fixture-secret-token",
          lastSeenSeq: 5,
        },
      }),
    );
    async function read(said: string, json = false) {
      let output = "";
      expect(
        await runRoomCli(["read", ...(json ? ["--json"] : [])], {
          env: { GRP_CONFIG: config },
          stdout: (text) => {
            output += text;
          },
          stderr: (text) => {
            throw new Error(text);
          },
          fetch: async () =>
            new Response(
              JSON.stringify({
                slug: "fixture",
                state: "no question open",
                status: "open",
                current_through: 6,
                new: [{ seq: 6, type: "discussion", who: "Peer", said }],
                page: { complete: true, through_event: 6, room_event: 6 },
              }),
              { headers: { "content-type": "application/json" } },
            ),
        }),
      ).toBe(0);
      expect(JSON.parse(readFileSync(config, "utf8")).currentRoom.lastSeenSeq).toBe(5);
      expect(output).not.toContain("fixture-secret-token");
      return output;
    }
    // These strings must survive even when they look like internal field names.
    for (const body of [
      "A short message.",
      'nativeBlocks structuredContent 🦋 "quoted"\n'.repeat(60),
    ]) {
      const output = await read(body);
      // Human output indents continuation lines; that formatting is not loss.
      const rendered = body.replace(/\n/g, "\n    ");
      expect(output).toContain(rendered);
      expect(output.split(rendered)).toHaveLength(2);
      expect(bytes(output) - bytes(rendered)).toBeLessThan(1400);
      expect(output).toContain("--ack-through=6");
      expect(output).toContain("Saved read position unchanged");
      expect(output).not.toContain("Usage:");
    }
    const body = "Exact JSON content 🦋\n  preserved indent\r\n";
    const json = JSON.parse(await read(body, true));
    expect(Object.keys(json).sort()).toEqual([
      "_cli",
      "current_through",
      "new",
      "page",
      "slug",
      "state",
      "status",
    ]);
    expect(json.new[0].said).toBe(body);
    expect(json._cli.schema).toBe("grp.read.v1");
    expect(Object.keys(json._cli).sort()).toEqual([
      "bodies_elided",
      "complete",
      "cursor",
      "kind",
      "pages_fetched",
      "schema",
    ]);
    expect(Object.keys(json._cli.cursor).sort()).toEqual([
      "advanced",
      "displayed_through",
      "room_head",
      "stored_after",
      "stored_before",
    ]);
    expect(json._cli.cursor.advanced).toBe(false);
    expect(json._cli.cursor.stored_after).toBe(5);
    expect(bytes(JSON.stringify(json._cli))).toBeLessThan(400);
    expect(json.current_through).toBe(6);
    expect(json.page.complete).toBe(true);
  });
});
