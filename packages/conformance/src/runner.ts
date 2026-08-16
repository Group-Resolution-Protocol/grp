import { createHash } from "node:crypto";
import { canonicalize } from "@grp-protocol/audit";
import {
  type ConformanceCase,
  type ConformanceCaseResult,
  type ConformanceProfile,
  type ConformanceReport,
  GRP_CONFORMANCE_VERSION,
  type RunConformanceOptions,
} from "./types.js";
import { allCases, staticVectors } from "./vectors/index.js";

const profileOrder: Record<ConformanceProfile, number> = {
  core: 0,
  transport: 1,
  operator: 2,
};

export async function runConformance(opts: RunConformanceOptions = {}): Promise<ConformanceReport> {
  const profile = opts.profile ?? "core";
  const target = validateRunOptions(profile, opts);
  const mandate = validateMandate(profile, opts.mandate);
  const selected = selectCases(profile, allCases);
  const results: ConformanceCaseResult[] = [];

  for (const testCase of selected) {
    const started = performance.now();
    const subject = testCase.profile === "core" ? "suite" : "target";
    try {
      await testCase.run({
        ...(target ? { target } : {}),
        allowWrites: opts.allowWrites === true,
        ...(mandate ? { mandate } : {}),
      });
      results.push({
        id: testCase.id,
        title: testCase.title,
        profile: testCase.profile,
        subject,
        status: "pass",
        elapsed_ms: elapsed(started),
      });
    } catch (err) {
      results.push({
        id: testCase.id,
        title: testCase.title,
        profile: testCase.profile,
        subject,
        status: "fail",
        elapsed_ms: elapsed(started),
        diagnostic: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const suite = summarize(results.filter((result) => result.subject === "suite"));
  const targetSummary = summarize(results.filter((result) => result.subject === "target"));
  const summary = { ...summarize(results), suite, target: targetSummary };

  return {
    schema_version: 1,
    protocol_version: GRP_CONFORMANCE_VERSION,
    profile,
    target,
    generated_at: new Date().toISOString(),
    vector_set_digest: vectorSetDigest(),
    summary,
    results,
    conformance_statement: conformanceStatement(profile, target, summary),
  };
}

function validateMandate(profile: ConformanceProfile, mandate: string | undefined): string | null {
  if (mandate === undefined) return null;
  if (profile !== "operator") {
    throw new Error("a supplied mandate is accepted only by the operator profile");
  }
  const value = mandate.trim();
  if (!value) throw new Error("the supplied mandate is empty");
  if (/\s/.test(value)) throw new Error("the supplied mandate must be one compact JWS value");
  return value;
}

export function validateConformanceTarget(target: string): string {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error("--target must be an absolute URL");
  }
  if (url.username || url.password) {
    throw new Error("--target must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("--target must not contain a query string or fragment");
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("--target must use HTTPS (HTTP is allowed only for loopback development)");
  }
  return url.toString();
}

export function vectorSetDigest(): string {
  return `sha256:${createHash("sha256").update(canonicalize(staticVectors)).digest("hex")}`;
}

function selectCases(profile: ConformanceProfile, cases: ConformanceCase[]): ConformanceCase[] {
  return cases.filter((testCase) => profileOrder[testCase.profile] <= profileOrder[profile]);
}

function validateRunOptions(
  profile: ConformanceProfile,
  opts: RunConformanceOptions,
): string | null {
  if (profile === "core") {
    if (opts.target) {
      throw new Error(
        "the core profile is offline and does not test --target; use transport or operator",
      );
    }
    return null;
  }
  if (!opts.target) {
    throw new Error(`${profile} profile requires --target=<base-url>`);
  }
  if (opts.allowWrites !== true) {
    throw new Error(
      `${profile} profile creates and deletes test rooms; rerun with --allow-write to authorize live mutations`,
    );
  }
  return validateConformanceTarget(opts.target);
}

function summarize(results: ConformanceCaseResult[]) {
  return {
    pass: results.filter((result) => result.status === "pass").length,
    fail: results.filter((result) => result.status === "fail").length,
    skip: results.filter((result) => result.status === "skip").length,
    total: results.length,
  };
}

function conformanceStatement(
  profile: ConformanceProfile,
  target: string | null,
  summary: ConformanceReport["summary"],
): string {
  if (profile === "core") {
    return summary.fail === 0
      ? `The GRP reference suite passed ${summary.suite.pass} offline core checks for ${GRP_CONFORMANCE_VERSION}. No live host was tested.`
      : `The GRP reference suite failed ${summary.fail} offline core check(s) for ${GRP_CONFORMANCE_VERSION}. No live host was tested.`;
  }
  const subject = target ?? "live target";
  return summary.fail === 0
    ? `${subject} passed ${summary.target.pass} live ${profile} target checks; ${summary.suite.pass} offline suite checks also passed for ${GRP_CONFORMANCE_VERSION}.`
    : `${subject} failed ${summary.target.fail} live ${profile} target check(s); ${summary.suite.fail} offline suite check(s) also failed for ${GRP_CONFORMANCE_VERSION}.`;
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}
