/** API protocol negotiation is independent of package and receipt versions. */
export const GRP_ACCEPT_PROTOCOL = "0.1, 0.2";
export const GRP_ACCEPT_PROTOCOL_HEADER = "x-grp-accept-protocol";
export const GRP_PROTOCOL_HEADER = "x-grp-protocol-version";

/** Not a transient transport failure; an attempted mutation must not be replayed. */
export class GrpProtocolVersionError extends Error {
  constructor(version: unknown) {
    super(`Unsupported GRP protocol version ${JSON.stringify(version)}; supported: 0.1, 0.2`);
    this.name = "GrpProtocolVersionError";
  }
}

export function assertSupportedProtocol(version: unknown): asserts version is "0.1" | "0.2" {
  if (version !== "0.1" && version !== "0.2") {
    throw new GrpProtocolVersionError(version);
  }
}

export type CoordinationCapability = "experimental" | "coordination-0.2" | "absent";

/** A malformed/unknown declaration must never downgrade a guarded write. */
export function coordinationCapability(discovery: Record<string, unknown>): CoordinationCapability {
  // Missing versions are tolerated only for legacy experimental discovery.
  if (discovery.protocol_version !== undefined) assertSupportedProtocol(discovery.protocol_version);
  const metadata = record(discovery.metadata);
  if (metadata.coordination !== undefined) {
    const c = record(metadata.coordination);
    if (
      discovery.protocol_version !== "0.2" ||
      c.version !== "0.2" ||
      c.status !== "candidate" ||
      c.profile !== "rest-token" ||
      !Array.isArray(c.transports) ||
      c.transports.length !== 1 ||
      !c.transports.includes("rest") ||
      !Array.isArray(c.mutation_auth) ||
      c.mutation_auth.length !== 1 ||
      !c.mutation_auth.includes("participant_token") ||
      c.mcp_tools !== false ||
      c.mandate_mutations !== false
    )
      throw new Error("Unsupported coordination capability; refusing to disable write guards");
    return "coordination-0.2";
  }
  if (discovery.protocol_version === "0.2") {
    throw new Error("GRP 0.2 coordination declaration is missing; refusing unguarded fallback");
  }
  const legacy = metadata.experimental_coordination_state;
  if (legacy === undefined) return "absent";
  if (record(legacy).status !== "experimental") {
    throw new Error("Unsupported experimental coordination capability");
  }
  return "experimental";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
