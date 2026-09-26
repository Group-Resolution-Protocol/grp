import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runRoomCli } from "./room-cli.js";

const discovery = {
  protocol_version: "0.2",
  metadata: {
    coordination: {
      version: "0.2",
      status: "candidate",
      profile: "rest-token",
      transports: ["rest"],
      mutation_auth: ["participant_token"],
      mcp_tools: false,
      mandate_mutations: false,
    },
  },
};
function fixture() {
  const config = join(mkdtempSync(join(tmpdir(), "grp-protocol-")), "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      providers: {},
      currentRoom: {
        slug: "room",
        baseUrl: "https://operator.example",
        token: "fake",
        participantId: "p1",
        lastSeenSeq: 5,
        observations: { schema: 1, generation: "base", global: "9", conversation: "7" },
      },
    }),
  );
  const errors: string[] = [];
  return {
    errors,
    run: (fetch: typeof globalThis.fetch) =>
      runRoomCli(["discuss", "A contribution"], {
        env: { GRP_CONFIG: config },
        fetch,
        stdin: Readable.from([]),
        isInteractive: false,
        stdout: () => {},
        stderr: (s) => errors.push(s),
      }),
  };
}
describe("CLI protocol negotiation", () => {
  it("does not retry a version-refused write with weaker headers", async () => {
    const f = fixture();
    let writes = 0;
    const result = await f.run(async (input, init) => {
      if (String(input).endsWith("/.well-known/grp.json")) return Response.json(discovery);
      if (init?.method === "POST") {
        writes++;
        expect(new Headers(init.headers).get("x-grp-accept-protocol")).toBe("0.1, 0.2");
        return Response.json(
          { error: { code: "protocol.version_unsupported", message: "Upgrade required" } },
          { status: 409 },
        );
      }
      return Response.json({ slug: "room", new: [], current_through: 5, page: { complete: true } });
    });
    expect(result).not.toBe(0);
    expect(writes).toBe(1);
    expect(f.errors.join("\n")).toMatch(/Upgrade required/);
  });
  it.each(["0.1", "0.2"])("keeps scoped guards and negotiates %s", async (version) => {
    const f = fixture();
    let writes = 0;
    const result = await f.run(async (input, init) => {
      expect(new Headers(init?.headers).get("x-grp-accept-protocol")).toBe("0.1, 0.2");
      if (String(input).endsWith("/.well-known/grp.json"))
        return Response.json(
          version === "0.2"
            ? discovery
            : {
                protocol_version: "0.1",
                metadata: { experimental_coordination_state: { status: "experimental" } },
              },
        );
      if (init?.method === "POST") {
        writes++;
        expect(new Headers(init.headers).get("x-grp-expected-room-revision")).toBe("7");
        return Response.json({
          posted: true,
          state_revision: "10",
          conversation_state_revision: "8",
        });
      }
      return Response.json({ slug: "room", new: [], current_through: 5, page: { complete: true } });
    });
    expect(result, f.errors.join("\n")).toBe(0);
    expect(writes).toBe(1);
  });
  it.each([
    { protocol_version: "0.3" },
    { protocol_version: "0.2" },
    { ...discovery, metadata: { coordination: { version: "0.3" } } },
  ])("never writes after incompatible discovery %j", async (document) => {
    const f = fixture();
    let writes = 0;
    expect(
      await f.run(async (_input, init) => {
        if (init?.method === "POST") writes++;
        return Response.json(document);
      }),
    ).not.toBe(0);
    expect(writes).toBe(0);
  });
});
