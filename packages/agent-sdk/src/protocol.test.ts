import { describe, expect, it, vi } from "vitest";
import { GrpClient } from "./index.js";
import { assertSupportedProtocol, coordinationCapability } from "./protocol.js";

const declaration = {
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

describe("protocol negotiation", () => {
  it("separates legacy, absent and versioned coordination", () => {
    expect(coordinationCapability({ protocol_version: "0.1" })).toBe("absent");
    expect(
      coordinationCapability({
        metadata: { experimental_coordination_state: { status: "experimental" } },
      }),
    ).toBe("experimental");
    expect(coordinationCapability(declaration)).toBe("coordination-0.2");
  });
  it("rejects missing, unknown or mismatched versioned declarations", () => {
    for (const version of [null, "0.20", "0.3", "grp/0.2", ""])
      expect(() => assertSupportedProtocol(version)).toThrow();
    expect(() => coordinationCapability({ protocol_version: "0.2" })).toThrow(/missing/);
    expect(() => coordinationCapability({ ...declaration, protocol_version: "0.1" })).toThrow(
      /Unsupported/,
    );
    for (const patch of [
      { version: "0.3" },
      { status: "unknown" },
      { transports: ["mcp"] },
      { transports: ["rest", "mcp"] },
      { mutation_auth: ["mandate"] },
      { mutation_auth: ["participant_token", "mandate"] },
    ]) {
      expect(() =>
        coordinationCapability({
          ...declaration,
          metadata: { coordination: { ...declaration.metadata.coordination, ...patch } },
        }),
      ).toThrow();
    }
  });
  it.each(["0.1", "0.2"])("SDK declares support and reads %s", async (version) => {
    const fetcher = vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).get("x-grp-accept-protocol")).toBe("0.1, 0.2");
      return Response.json(
        { protocol_version: version },
        { headers: { "x-grp-protocol-version": version } },
      );
    });
    expect(
      (await new GrpClient({ baseUrl: "https://example.test", fetch: fetcher }).discover())
        .protocol_version,
    ).toBe(version);
  });
  it("SDK refuses an unknown discovery version", async () => {
    const client = new GrpClient({
      baseUrl: "https://example.test",
      fetch: async () => Response.json({ protocol_version: "0.3" }),
    });
    await expect(client.discover()).rejects.toThrow(/Unsupported/);
  });
  it("SDK refuses an unknown response version without retrying", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ protocol_version: "0.2" }, { headers: { "x-grp-protocol-version": "0.3" } }),
    );
    const client = new GrpClient({ baseUrl: "https://example.test", fetch: fetcher });
    await expect(client.discover()).rejects.toThrow(/Unsupported/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
