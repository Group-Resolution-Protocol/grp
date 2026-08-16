import type { ConformanceCase } from "../types.js";
import { discoveryCases, validDiscoveryVector } from "./discovery.js";
import { jwsCases, mandatePayloadVector, receiptPayloadVector } from "./jws.js";
import { mandateCases } from "./mandates.js";
import { mcpCases } from "./mcp.js";
import { mechanismCases, mechanismVectors } from "./mechanisms.js";
import { operatorCases } from "./operator.js";
import { receiptChainCases } from "./receipts.js";
import { restCases } from "./rest.js";

export const staticVectors = {
  mechanisms: mechanismVectors,
  mandates: [mandatePayloadVector],
  receipts: [receiptPayloadVector],
  discovery: [validDiscoveryVector],
};

export const allCases: ConformanceCase[] = [
  ...mechanismCases,
  ...jwsCases,
  ...mandateCases,
  ...receiptChainCases,
  ...discoveryCases,
  ...restCases,
  ...mcpCases,
  ...operatorCases,
];

// Spec 041 §4.2/§4.3 — builder-style vectors (deterministic, async signing).
export {
  buildMandateVerificationVectors,
  mandateVectorPublicKey,
  referenceVerifyMandate,
  MANDATE_VECTOR_NOW,
} from "./mandates.js";
export type { MandateRejection, MandateVerificationVector } from "./mandates.js";
export { buildReceiptChainVectors, receiptVectorPublicKey } from "./receipts.js";
export type { ReceiptChainVectors } from "./receipts.js";
