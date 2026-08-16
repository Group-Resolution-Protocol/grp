export const GRP_CONFORMANCE_VERSION = "grp/0.1" as const;

export type ConformanceProfile = "core" | "transport" | "operator";
export type TestStatus = "pass" | "fail" | "skip";
export type ConformanceSubject = "suite" | "target";

export interface ConformanceCase {
  id: string;
  title: string;
  profile: ConformanceProfile;
  run(ctx: ConformanceContext): Promise<void> | void;
}

export interface ConformanceContext {
  target?: string;
  allowWrites: boolean;
  /**
   * Optional short-lived mandate supplied by the operator for hosted targets
   * that intentionally reject self-issued did:key mandates.
   */
  mandate?: string;
}

export interface ConformanceCaseResult {
  id: string;
  title: string;
  profile: ConformanceProfile;
  subject: ConformanceSubject;
  status: TestStatus;
  elapsed_ms: number;
  diagnostic?: string;
}

export interface ConformanceReport {
  schema_version: 1;
  protocol_version: typeof GRP_CONFORMANCE_VERSION;
  profile: ConformanceProfile;
  target: string | null;
  generated_at: string;
  vector_set_digest: string;
  summary: {
    pass: number;
    fail: number;
    skip: number;
    total: number;
    suite: ConformanceResultSummary;
    target: ConformanceResultSummary;
  };
  results: ConformanceCaseResult[];
  conformance_statement: string;
}

export interface RunConformanceOptions {
  profile?: ConformanceProfile;
  target?: string;
  allowWrites?: boolean;
  /**
   * Short-lived mandate from an issuer trusted by the target. The CLI accepts
   * this value only through --mandate-file so it is not exposed in argv.
   */
  mandate?: string;
}

export interface ConformanceResultSummary {
  pass: number;
  fail: number;
  skip: number;
  total: number;
}

export interface ConformanceReportSignature {
  format: "compact-jws";
  alg: "EdDSA";
  kid: string;
  signed_at: string;
  report_digest: string;
  public_key_jwk: {
    kty: "OKP";
    crv: "Ed25519";
    alg: "EdDSA";
    kid: string;
    x: string;
  };
  jws: string;
}

export interface SignedConformanceReport {
  schema_version: 1;
  kind: "grp.conformance.signed_report";
  report: ConformanceReport;
  signature: ConformanceReportSignature;
}

export interface ConformanceReportSignaturePayload {
  schema_version: 1;
  kind: "grp.conformance.report_signature";
  signed_at: string;
  report_digest: string;
  report: ConformanceReport;
}
