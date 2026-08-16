import type { ConformanceReport } from "../types.js";

export function renderMarkdownReport(report: ConformanceReport): string {
  const lines = [
    "# GRP Conformance Report",
    "",
    `- Protocol: \`${report.protocol_version}\``,
    `- Profile: \`${report.profile}\``,
    `- Target: ${report.target ? `\`${report.target}\`` : "offline"}`,
    `- Generated: ${report.generated_at}`,
    `- Vector set: \`${report.vector_set_digest}\``,
    `- Summary: ${report.summary.pass} passed, ${report.summary.fail} failed, ${report.summary.skip} skipped, ${report.summary.total} total`,
    `- Offline suite checks: ${report.summary.suite.pass} passed, ${report.summary.suite.fail} failed, ${report.summary.suite.skip} skipped`,
    `- Live target checks: ${report.summary.target.pass} passed, ${report.summary.target.fail} failed, ${report.summary.target.skip} skipped`,
    "",
    report.conformance_statement,
    "",
    "| Result | Subject | ID | Title | Elapsed | Diagnostic |",
    "|--------|---------|----|-------|---------|------------|",
  ];

  for (const result of report.results) {
    lines.push(
      `| ${result.status} | ${result.subject} | \`${result.id}\` | ${escapeCell(result.title)} | ${result.elapsed_ms}ms | ${escapeCell(result.diagnostic ?? "")} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
