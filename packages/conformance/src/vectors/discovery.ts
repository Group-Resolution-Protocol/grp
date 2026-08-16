import type { ConformanceCase } from "../types.js";

/**
 * Mechanism identifiers a v0.1 GRP room host may honestly advertise. This is
 * the public URL-room enum (apps/api/src/url-room/config.ts
 * SUPPORTED_MECHANISMS), not the engine's internal generic_vote helper.
 */
export const KNOWN_MECHANISMS = [
  "simple_majority",
  "supermajority",
  "plurality",
  "approval",
  "ranked_choice",
  "ranked_pairwise",
  "score_vote",
  "quadratic_vote",
] as const;

const KNOWN_MECHANISM_SET = new Set<string>(KNOWN_MECHANISMS);

export const validDiscoveryVector = {
  protocol: "grp/0.1",
  room_id: "urn:grp:room:board",
  issuer: "https://room.example",
  jwks_uri: "https://room.example/.well-known/jwks.json",
  transports: {
    rest: "https://room.example/api/rooms",
    mcp: "https://room.example/mcp",
  },
  mechanisms: [
    "simple_majority",
    "supermajority",
    "plurality",
    "approval",
    "ranked_choice",
    "ranked_pairwise",
    "score_vote",
    "quadratic_vote",
  ],
  conformance: {
    self_attested: true,
    validated: false,
  },
} as const;

export const discoveryCases: ConformanceCase[] = [
  {
    id: "core.discovery.valid_vector_shape",
    title: "discovery vector includes protocol, JWKS, transports, mechanisms, and conformance",
    profile: "core",
    run: () => validateDiscoveryDocument(validDiscoveryVector),
  },
  {
    id: "transport.discovery.target_well_known",
    title: "target serves a valid /.well-known/grp.json discovery document",
    profile: "transport",
    run: async ({ target }) => {
      if (!target) {
        throw new Error("transport profile requires --target=<base-url>");
      }
      const discoveryUrl = new URL("/.well-known/grp.json", target);
      const response = await fetch(discoveryUrl);
      if (!response.ok) {
        throw new Error(`${discoveryUrl.toString()} returned ${response.status}`);
      }
      const body = (await response.json()) as unknown;
      validateDiscoveryDocument(body);
    },
  },
];

export function validateDiscoveryDocument(doc: unknown): void {
  if (!doc || typeof doc !== "object") {
    throw new Error("discovery document must be an object");
  }
  const d = doc as Record<string, unknown>;
  const protocol = d.protocol ?? d.protocol_version ?? d.grp_version;
  if (protocol !== "grp/0.1" && protocol !== "v0.1" && protocol !== "0.1") {
    throw new Error("discovery document must advertise grp/0.1 protocol compatibility");
  }
  if (typeof (d.jwks_uri ?? d.jwks_url) !== "string" && !("jwks" in d) && !Array.isArray(d.keys)) {
    throw new Error("discovery document must expose jwks_uri, jwks_url, embedded jwks, or keys");
  }
  if (!d.transports || typeof d.transports !== "object") {
    throw new Error("discovery document must include transports");
  }
  const transports = d.transports as Record<string, unknown>;
  if (typeof transports.rest !== "string" && typeof transports.mcp !== "string") {
    throw new Error("discovery document must advertise at least one rest or mcp transport URL");
  }
  const mechanisms = d.mechanisms ?? d.mechanisms_supported;
  if (
    !Array.isArray(mechanisms) ||
    mechanisms.length === 0 ||
    !mechanisms.every((m) => typeof m === "string")
  ) {
    throw new Error("discovery document must advertise at least one mechanism");
  }
  if (!mechanisms.some((m) => KNOWN_MECHANISM_SET.has(m))) {
    throw new Error(
      `discovery document must advertise at least one known GRP mechanism (got: ${mechanisms.join(", ")})`,
    );
  }
  if (!d.conformance || typeof d.conformance !== "object") {
    throw new Error("discovery document must include conformance metadata");
  }
}
