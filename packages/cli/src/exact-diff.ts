import { createHash } from "node:crypto";

export interface LineChange {
  kind: "equal" | "remove" | "add";
  text: string;
}
const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Exact line records include their terminators. Bounded LCS; on exhaustion,
 * replace the middle region rather than silently omitting/normalizing changes. */
export function exactLineChanges(
  before: string,
  after: string,
  cells = 1_000_000,
): {
  changes: LineChange[];
  fallback: boolean;
} {
  const a = lines(before);
  const b = lines(after);
  let prefix = 0;
  let suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const left = a.slice(prefix, a.length - suffix);
  const right = b.slice(prefix, b.length - suffix);
  const changes: LineChange[] = a.slice(0, prefix).map((text) => ({ kind: "equal", text }));
  const fallback = (left.length + 1) * (right.length + 1) > cells;
  if (fallback) {
    for (const text of left) changes.push({ kind: "remove", text });
    for (const text of right) changes.push({ kind: "add", text });
  } else {
    const width = right.length + 1;
    const dp = new Uint32Array((left.length + 1) * width);
    for (let i = left.length - 1; i >= 0; i--)
      for (let j = right.length - 1; j >= 0; j--)
        dp[i * width + j] =
          left[i] === right[j]
            ? 1 + (dp[(i + 1) * width + j + 1] ?? 0)
            : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + j + 1] ?? 0);
    let i = 0;
    let j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) {
        changes.push({ kind: "equal", text: left[i++] ?? "" });
        j++;
      } else if (
        j < right.length &&
        (i === left.length || (dp[i * width + j + 1] ?? 0) > (dp[(i + 1) * width + j] ?? 0))
      ) {
        changes.push({ kind: "add", text: right[j++] ?? "" });
      } else changes.push({ kind: "remove", text: left[i++] ?? "" });
    }
  }
  for (const text of a.slice(a.length - suffix)) changes.push({ kind: "equal", text });
  return { changes, fallback };
}

export function verifiedNativeContent(revision: Record<string, unknown>): string | null {
  if (typeof revision.content !== "string") return null;
  if (
    revision.sha256 !== undefined &&
    revision.sha256 !== null &&
    revision.sha256 !== createHash("sha256").update(revision.content).digest("hex")
  )
    throw new Error(
      "Artifact integrity mismatch: content does not match its SHA-256; no trusted diff was rendered.",
    );
  return revision.content;
}

export function renderExactDiff(before: string, after: string, from: string, to: string): string {
  const output = [`--- artifact ${from}`, `+++ artifact ${to}`];
  if (before === after) return `${output.join("\n")}\n(no content changes)\n`;
  // Bound rendering allocations too: the host byte limit alone permits very
  // many empty lines. Exact JSON strings retain every byte without millions
  // of per-line objects; the normal output delivery still enforces cache bounds.
  let lineCount = 0;
  for (const text of [before, after])
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineCount++;
  if (lineCount > 100000)
    return `${output.join("\n")}\nDiff rendering work limit reached; exact before/after content follows as JSON strings, not an approximate diff.\nBEFORE (${Buffer.byteLength(before)} UTF-8 bytes):\n${JSON.stringify(before)}\nAFTER (${Buffer.byteLength(after)} UTF-8 bytes):\n${JSON.stringify(after)}\n`;
  const { changes, fallback } = exactLineChanges(before, after);
  output.push("Source-line hunks; unshown context is byte-identical, not certified correct.");
  if (fallback)
    output.push("Diff work limit reached: exact replacement of the middle region follows.");
  const positions: { old: number; next: number }[] = [];
  let old = 1;
  let next = 1;
  for (const change of changes) {
    positions.push({ old, next });
    if (change.kind !== "add") old++;
    if (change.kind !== "remove") next++;
  }
  const ranges: { start: number; end: number }[] = [];
  changes.forEach((change, i) => {
    if (change.kind === "equal") return;
    const start = Math.max(0, i - 3);
    const end = Math.min(changes.length, i + 4);
    const prior = ranges.at(-1);
    if (prior && start <= prior.end) prior.end = Math.max(prior.end, end);
    else ranges.push({ start, end });
  });
  for (const range of ranges) {
    const selected = changes.slice(range.start, range.end);
    const oldCount = selected.filter((c) => c.kind !== "add").length;
    const newCount = selected.filter((c) => c.kind !== "remove").length;
    const position = positions[range.start];
    output.push(
      `@@ -${(position?.old ?? 1) - (oldCount ? 0 : 1)},${oldCount} +${(position?.next ?? 1) - (newCount ? 0 : 1)},${newCount} @@`,
    );
    for (const change of selected) {
      const prefix = change.kind === "equal" ? " " : change.kind === "add" ? "+" : "-";
      const body = change.text.endsWith("\n") ? change.text.slice(0, -1) : change.text;
      output.push(prefix + body);
      if (!change.text.endsWith("\n")) output.push("\\ No newline at end of file");
      if (change.kind !== "equal" && (/\r|\t|[ \t]$/.test(body) || !body.trim()))
        output.push(`\\ Exact ${change.kind} line bytes (JSON): ${JSON.stringify(change.text)}`);
    }
  }
  return `${output.join("\n")}\n`;
}
