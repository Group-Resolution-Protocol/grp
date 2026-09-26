import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runRoomCli } from "./room-cli.js";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function fixture(response: Record<string, unknown>) {
  const path = join(mkdtempSync(join(tmpdir(), "grp-decision-context-")), "config.json");
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
  const errors: string[] = [];
  const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    json(response),
  );
  const run = (args: string[]) =>
    runRoomCli(args, {
      env: { GRP_CONFIG: path },
      fetch,
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
    });
  return {
    run,
    fetch,
    output,
    errors,
    state: () => JSON.parse(readFileSync(path, "utf8")).currentRoom,
    next: () => /Continue this exact delivery: .*--continue=(\S+)/.exec(output.at(-1) ?? "")?.[1],
  };
}

function delta(context: string | null, type = "decision_opened") {
  return {
    slug: "room",
    status: "open",
    state: "question open",
    current_through: 6,
    new: [{ seq: 6, type, who: "Peer", decision_seq: 1, question: "Which route?", context }],
    page: { through_event: 6, room_event: 6, complete: true, bodies_elided: false },
  };
}

describe("decision explanations on the ordinary recipient path", () => {
  it.each(["decision_opened", "decision_revised"])(
    "renders exact multiline %s context",
    async (type) => {
      const context = "Only the north route has accessible transit.\n\nReturn before 21:00. 🦋";
      const f = fixture(delta(context, type));
      expect(await f.run(["read"])).toBe(0);
      expect(f.output.at(-1)).toContain(
        "    Context:\n      Only the north route has accessible transit.\n      \n      Return before 21:00. 🦋",
      );
      expect(f.state().lastSeenSeq).toBe(5);
      expect(await f.run(["read", "--ack-through=6"])).toBe(0);
      expect(f.state().lastSeenSeq).toBe(6);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(new URL(String(f.fetch.mock.calls[0]?.[0])).searchParams.get("since")).toBe("5");
    },
  );

  it("distinguishes removed context from a legacy host that did not supply the field", async () => {
    const f = fixture(delta(null, "decision_revised"));
    expect(await f.run(["read"])).toBe(0);
    expect(f.output.at(-1)).toContain("Context: none.");
    const legacy = delta(null, "decision_revised");
    const event = legacy.new[0];
    if (!event) throw new Error("Missing fixture event");
    Reflect.deleteProperty(event, "context");
    const old = fixture(legacy);
    expect(await old.run(["read"])).toBe(0);
    expect(old.output.at(-1)).not.toContain("Context: none.");
  });

  it.each(["decision_opened", "decision_revised"])(
    "delivers complete %s JSON context",
    async (type) => {
      const context = "Exact JSON context\n\nwith whitespace.  \n";
      const f = fixture(delta(context, type));
      expect(await f.run(["read", "--json"])).toBe(0);
      expect(JSON.parse(f.output.at(-1) ?? "").new[0].context).toBe(context);
      expect(f.state().lastSeenSeq).toBe(5);
    },
  );

  it.each(["decision_opened", "decision_revised"])(
    "withholds acknowledgment until every %s context fragment is delivered",
    async (type) => {
      const lines = Array.from(
        { length: 230 },
        (_, i) => `Premise ${i}: ${"unique detail 🦋 ".repeat(3)}`,
      );
      const f = fixture(delta(lines.join("\n"), type));
      expect(await f.run(["read"])).toBe(0);
      const pages = [f.output.at(-1) ?? ""];
      expect(pages[0]).toContain("INCOMPLETE");
      expect(await f.run(["read", "--ack-through=6"])).toBe(1);
      for (let i = 0; f.next(); i++) {
        expect(i).toBeLessThan(20);
        expect(await f.run(["read", `--continue=${f.next()}`])).toBe(0);
        pages.push(f.output.at(-1) ?? "");
        expect(f.state().lastSeenSeq).toBe(5);
      }
      expect(pages.length).toBeGreaterThan(1);
      for (const page of pages) expect(page.length).toBeLessThanOrEqual(12000);
      for (const line of lines) expect(pages.join("\n")).toContain(line);
      expect(await f.run(["read", "--ack-through=6"])).toBe(0);
      expect(f.state().lastSeenSeq).toBe(6);
      expect(f.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(
    [[], ["--full"], ["--json"], ["--decision=1"], ["--decision=1", "--json"]].map((flags) => ({
      flags,
    })),
  )("includes context in options $flags", async ({ flags }) => {
    const context = "A premise available only in decision context.\n\nSecond premise.";
    const decision = {
      id: "d1",
      seq: 1,
      question: "Which route?",
      context,
      options: ["North", "South"],
      status: "voting",
    };
    const f = fixture({ slug: "room", decision, decisions: [decision], current_through: 6 });
    expect(await f.run(["options", ...flags])).toBe(0);
    const text = f.output.at(-1) ?? "";
    if (flags.includes("--json")) expect(JSON.parse(text).context).toBe(context);
    else
      expect(text).toContain(
        "Context:\n  A premise available only in decision context.\n  \n  Second premise.",
      );
    expect(f.state().lastSeenSeq).toBe(5);
  });
});
