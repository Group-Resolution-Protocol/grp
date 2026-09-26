import { createHash } from "node:crypto";
import type { ConformanceCaseResult, ConformanceReport } from "../types.js";

const vector = {
  version: "0.2",
  profile: "rest-token",
  status: "candidate",
  transports: ["rest"],
  mutation_auth: ["participant_token"],
  mcp_tools: false,
  mandate_mutations: false,
};

export function validateCoordinationDiscovery(value: unknown): void {
  const d = record(value);
  if (d.protocol_version !== "0.2") throw new Error("Expected protocol_version 0.2");
  const transports = record(d.transports);
  if (typeof transports.rest !== "string" || typeof transports.mcp !== "string")
    throw new Error("Both base transports are required");
  const c = record(record(d.metadata).coordination);
  for (const [key, expected] of Object.entries(vector)) {
    if (JSON.stringify(c[key]) !== JSON.stringify(expected))
      throw new Error(`Unsupported coordination ${key}`);
  }
}

/** Deliberately not a lifecycle, authorization or base-transport certification. */
export async function runCoordinationDiscovery(target: string): Promise<ConformanceReport> {
  const results: ConformanceCaseResult[] = [];
  for (const [id, title, run] of [
    [
      "coordination.discovery.declaration",
      "versioned REST/token declaration and response agree",
      async () => {
        const response = await fetch(new URL("/.well-known/grp.json", target), {
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: { "x-grp-accept-protocol": "0.2" },
        });
        if (!response.ok || response.headers.get("x-grp-protocol-version") !== "0.2")
          throw new Error("Discovery version response mismatch");
        validateCoordinationDiscovery(await response.json());
      },
    ],
    [
      "coordination.discovery.incompatible",
      "explicit incompatible version is refused without a mutation",
      async () => {
        const response = await fetch(new URL("/.well-known/grp.json", target), {
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: { "x-grp-accept-protocol": "9.9" },
        });
        const body = record(await response.json());
        if (response.status !== 409 || record(body.error).code !== "protocol.version_unsupported")
          throw new Error("Incompatible version was not refused");
      },
    ],
  ] as const) {
    const started = performance.now();
    try {
      await run();
      results.push({
        id,
        title,
        profile: "coordination-discovery",
        subject: "target",
        status: "pass",
        elapsed_ms: performance.now() - started,
      });
    } catch (e) {
      results.push({
        id,
        title,
        profile: "coordination-discovery",
        subject: "target",
        status: "fail",
        elapsed_ms: performance.now() - started,
        diagnostic: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const pass = results.filter((r) => r.status === "pass").length;
  const summary = { pass, fail: results.length - pass, skip: 0, total: results.length };
  return {
    schema_version: 1,
    protocol_version: "grp/0.2",
    profile: "coordination-discovery",
    target,
    generated_at: new Date().toISOString(),
    vector_set_digest: `sha256:${createHash("sha256").update(JSON.stringify(vector)).digest("hex")}`,
    summary: { ...summary, target: summary, suite: { pass: 0, fail: 0, skip: 0, total: 0 } },
    results,
    conformance_statement: `Passed ${pass}/${results.length} read-only discovery checks for grp/0.2. This is NOT base transport, coordination lifecycle, authorization or full protocol certification.`,
  };
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
