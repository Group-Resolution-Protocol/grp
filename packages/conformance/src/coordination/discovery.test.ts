import { afterEach, describe, expect, it, vi } from "vitest";
import { runConformance } from "../runner.js";
import { validateDiscoveryDocument } from "../vectors/discovery.js";
import { validateCoordinationDiscovery } from "./discovery.js";
const doc = {
  protocol_version: "0.2",
  transports: { rest: "https://example.test/api/rooms", mcp: "https://example.test/mcp" },
  metadata: {
    coordination: {
      version: "0.2",
      profile: "rest-token",
      status: "candidate",
      transports: ["rest"],
      mutation_auth: ["participant_token"],
      mcp_tools: false,
      mandate_mutations: false,
    },
  },
};
afterEach(() => vi.unstubAllGlobals());
describe("version-specific conformance", () => {
  it("rejects contradictory transport and authentication declarations", () => {
    for (const patch of [
      { transports: ["rest", "mcp"] },
      { mutation_auth: ["participant_token", "mandate"] },
      { mcp_tools: true },
      { mandate_mutations: true },
    ]) {
      expect(() =>
        validateCoordinationDiscovery({
          ...doc,
          metadata: { coordination: { ...doc.metadata.coordination, ...patch } },
        }),
      ).toThrow(/Unsupported coordination/);
    }
  });
  it("does not broaden the frozen base verdict", async () => {
    expect(() => validateDiscoveryDocument(doc)).toThrow(/grp\/0.1/);
    expect(() => validateCoordinationDiscovery(doc)).not.toThrow();
    await expect(runConformance({ protocolVersion: "0.2" })).rejects.toThrow(/only 0.1/);
    await expect(
      runConformance({ profile: "coordination-discovery", target: "https://example.test" }),
    ).rejects.toThrow(/protocol=0.2/);
  });
  it("labels a limited successful run honestly and performs only reads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        expect(init?.method ?? "GET").toBe("GET");
        return new Headers(init?.headers).get("x-grp-accept-protocol") === "0.2"
          ? Response.json(doc, { headers: { "x-grp-protocol-version": "0.2" } })
          : Response.json({ error: { code: "protocol.version_unsupported" } }, { status: 409 });
      }),
    );
    const report = await runConformance({
      profile: "coordination-discovery",
      protocolVersion: "0.2",
      target: "https://example.test",
    });
    expect(report.protocol_version).toBe("grp/0.2");
    expect(report.summary.pass).toBe(2);
    expect(report.conformance_statement).toContain("NOT base transport");
  });
});
