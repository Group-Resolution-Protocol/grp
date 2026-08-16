import type { ConformanceReport } from "../types.js";

export function renderJsonReport(report: ConformanceReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
