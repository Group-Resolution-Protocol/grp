import * as ed25519 from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import {
  renderMarkdownReport,
  runConformance,
  signConformanceReport,
  validateConformanceTarget,
  vectorSetDigest,
  verifySignedConformanceReport,
} from "./index.js";

describe("@grp-protocol/conformance", () => {
  it("runs the offline core profile", async () => {
    const report = await runConformance({ profile: "core" });
    expect(report.protocol_version).toBe("grp/0.1");
    expect(report.summary.fail).toBe(0);
    expect(report.summary.pass).toBeGreaterThan(0);
    expect(report.results.every((r) => r.profile === "core")).toBe(true);
    expect(report.results.every((r) => r.subject === "suite")).toBe(true);
    expect(report.target).toBeNull();
    expect(report.conformance_statement).toContain("No live host was tested");
  });

  it("reports a stable vector set digest shape", () => {
    expect(vectorSetDigest()).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("renders markdown reports", async () => {
    const report = await runConformance({ profile: "core" });
    expect(renderMarkdownReport(report)).toContain("# GRP Conformance Report");
  });

  it("rejects a target on the offline core profile", async () => {
    await expect(
      runConformance({ profile: "core", target: "https://does-not-exist.invalid" }),
    ).rejects.toThrow(/offline and does not test --target/);
  });

  it("requires target and explicit write authorization for live profiles", async () => {
    await expect(runConformance({ profile: "transport" })).rejects.toThrow(/requires --target/);
    await expect(
      runConformance({ profile: "operator", target: "https://api.example" }),
    ).rejects.toThrow(/--allow-write/);
  });

  it("accepts supplied mandates only for the operator profile", async () => {
    await expect(
      runConformance({ profile: "core", mandate: "header.payload.signature" }),
    ).rejects.toThrow(/only by the operator profile/);
    await expect(
      runConformance({
        profile: "transport",
        target: "https://api.example",
        allowWrites: true,
        mandate: "header.payload.signature",
      }),
    ).rejects.toThrow(/only by the operator profile/);
    await expect(
      runConformance({
        profile: "operator",
        target: "https://api.example",
        allowWrites: true,
        mandate: " ",
      }),
    ).rejects.toThrow(/supplied mandate is empty/);
  });

  it("validates live target URLs", () => {
    expect(validateConformanceTarget("https://api.example/base")).toBe("https://api.example/base");
    expect(validateConformanceTarget("http://localhost:3000")).toBe("http://localhost:3000/");
    expect(() => validateConformanceTarget("http://api.example")).toThrow(/HTTPS/);
    expect(() => validateConformanceTarget("https://user:secret@api.example")).toThrow(
      /credentials/,
    );
    expect(() => validateConformanceTarget("https://api.example?token=secret")).toThrow(
      /query string/,
    );
  });

  it("signs and verifies a conformance report", async () => {
    const privateKey = new Uint8Array(32).fill(7);
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const report = await runConformance({ profile: "core" });
    const signed = await signConformanceReport({
      report,
      privateKey,
      kid: "test-key",
      signedAt: "2026-05-27T00:00:00.000Z",
    });

    expect(signed.kind).toBe("grp.conformance.signed_report");
    expect(signed.signature.report_digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const verified = await verifySignedConformanceReport({ signedReport: signed, publicKey });
    expect(verified.ok).toBe(true);
    expect(verified.trusted_public_key).toBe(true);
    expect(verified.report.summary.fail).toBe(0);
  });

  it("rejects a signed report whose envelope body was tampered", async () => {
    const privateKey = new Uint8Array(32).fill(9);
    const report = await runConformance({ profile: "core" });
    const signed = await signConformanceReport({
      report,
      privateKey,
      kid: "test-key",
      signedAt: "2026-05-27T00:00:00.000Z",
    });
    signed.report.conformance_statement = "tampered";

    await expect(verifySignedConformanceReport({ signedReport: signed })).rejects.toThrow(
      /report_digest/,
    );
  });
});
