import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { withExclusiveFileLock } from "./exclusive-file-lock.js";

// UTF-16 code units, not model-specific tokens. Framing has its own reserve.
export const OUTPUT_PAGE_CHARS = 12_000;
const BODY_CHARS = OUTPUT_PAGE_CHARS - 2_000;
export const DELIVERY_TTL_MS = 3_600_000;
export const MAX_DELIVERIES = 32;
export const MAX_DELIVERY_BYTES = 16_000_000;
export const MAX_CACHE_BYTES = 32_000_000;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const TOKEN = new RegExp(`^(${UUID}):(0|[1-9][0-9]*)$`);
const CACHE_FILE = new RegExp(`^${UUID}\\.json$`);
const CACHE_TEMP = new RegExp(`^${UUID}\\.json\\.${UUID}\\.tmp$`);

export interface OutputUnit {
  text: string;
  /** CLI-generated identity only; never arbitrary message text. */
  label?: string;
  /** A whole event ends here; only its last fragment exposes this. */
  through?: number;
}
export interface OutputPage {
  text: string;
  labels: string[];
  through?: number;
}
interface Delivery {
  schema: 2;
  id: string;
  scope: string;
  expires: number;
  next: number;
  pages: OutputPage[];
  completion: Record<string, unknown> | null;
  command: string;
}

function chunkEnd(text: string, offset: number, budget: number): number {
  let end = Math.min(offset + budget, text.length);
  if (end < text.length) {
    const window = text.slice(offset, end);
    const paragraph = window.lastIndexOf("\n\n");
    const line = window.lastIndexOf("\n");
    if (paragraph >= budget / 2) end = offset + paragraph + 2;
    else if (line >= budget / 2) end = offset + line + 1;
    if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end -= 1;
  }
  return end;
}

/** Lossless splitting: prefer paragraph/line boundaries; never split UTF-16 pairs. */
export function outputChunks(text: string, budget = BODY_CHARS): string[] {
  if (!Number.isSafeInteger(budget) || budget < 2) throw new Error("Invalid output budget");
  const pages: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const end = chunkEnd(text, offset, budget);
    pages.push(text.slice(offset, end));
    offset = end;
  }
  return pages.length ? pages : [""];
}

/** Pack whole units; only a unit exceeding the budget is fragmented. */
export function outputPages(units: OutputUnit[], budget = BODY_CHARS): OutputPage[] {
  if (!Number.isSafeInteger(budget) || budget < 2) throw new Error("Invalid output budget");
  const pages: OutputPage[] = [];
  let page: OutputPage = { text: "", labels: [] };
  const flush = () => {
    if (page.text) pages.push(page);
    page = { text: "", labels: [] };
  };
  for (const unit of units) {
    if (unit.text.length > budget) {
      if (budget - page.text.length < 2) flush();
      const firstEnd = chunkEnd(unit.text, 0, budget - page.text.length);
      const chunks = [
        unit.text.slice(0, firstEnd),
        ...outputChunks(unit.text.slice(firstEnd), budget),
      ];
      chunks.forEach((text, index) => {
        page.text += text;
        if (unit.label) page.labels.push(`${unit.label} fragment ${index + 1}/${chunks.length}`);
        if (index === chunks.length - 1) {
          if (unit.through !== undefined) page.through = unit.through;
        } else flush();
      });
    } else {
      if (page.text.length + unit.text.length > budget) flush();
      page.text += unit.text;
      if (unit.label) page.labels.push(unit.label);
      if (unit.through !== undefined) page.through = unit.through;
    }
  }
  flush();
  return pages.length ? pages : [{ text: "", labels: [] }];
}

function readDelivery(path: string): Delivery {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_DELIVERY_BYTES) throw new Error("Invalid delivery cache");
  const d = JSON.parse(readFileSync(path, "utf8")) as Delivery;
  if (
    d.schema !== 2 ||
    !TOKEN.test(`${d.id}:0`) ||
    !/^[a-f0-9]{64}$/.test(d.scope) ||
    !Number.isFinite(d.expires) ||
    !Number.isSafeInteger(d.next) ||
    !Array.isArray(d.pages) ||
    !d.pages.length ||
    d.next < 0 ||
    d.next > d.pages.length ||
    typeof d.command !== "string" ||
    d.command.length > 500 ||
    !(
      d.completion === null ||
      (typeof d.completion === "object" && !Array.isArray(d.completion))
    ) ||
    !d.pages.every(
      (p) =>
        typeof p.text === "string" &&
        p.text.length <= BODY_CHARS &&
        Array.isArray(p.labels) &&
        p.labels.every((l) => typeof l === "string" && l.length <= 150) &&
        (p.through === undefined || (Number.isSafeInteger(p.through) && p.through >= 0)),
    )
  ) {
    throw new Error("Invalid delivery cache");
  }
  return d;
}

export function writeBoundedOutput(options: {
  configPath: string;
  scope: string;
  command: string;
  text?: string | undefined;
  units?: OutputUnit[] | undefined;
  continuation?: string | undefined;
  completion?: Record<string, unknown> | undefined;
  stdout: (text: string) => void;
  complete: (completion: Record<string, unknown>) => void;
}): void {
  const scope = createHash("sha256").update(options.scope).digest("hex");
  // Legacy caches are never interpreted as replayable deliveries.
  const directory = `${options.configPath}.deliveries-v2`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
    throw new Error("Unsafe delivery directory");
  chmodSync(directory, 0o700);
  withExclusiveFileLock(join(directory, ".lock"), {}, () => {
    // Every cache writer holds this lock. Matching leftovers can only be
    // interrupted writes, never another live writer's temporary file.
    for (const file of readdirSync(directory).filter((name) => CACHE_TEMP.test(name)))
      unlinkSync(join(directory, file));
    let d: Delivery;
    let index = 0;
    if (options.continuation) {
      const match = TOKEN.exec(options.continuation);
      if (!match)
        throw new Error("Invalid continuation. Start a new read; no acknowledgment was advanced.");
      try {
        d = readDelivery(join(directory, `${match[1]}.json`));
      } catch {
        throw new Error(
          "Delivery unavailable, evicted, or incompatible. Start a new read; no acknowledgment was advanced.",
        );
      }
      index = Number(match[2]);
      if (d.scope !== scope || d.id !== match[1])
        throw new Error("Delivery unavailable for this identity or read surface.");
      if (d.expires <= Date.now())
        throw new Error("Expired delivery. Start a new read; no acknowledgment was advanced.");
      if (!Number.isSafeInteger(index) || index > d.next || index >= d.pages.length)
        throw new Error("Out-of-order continuation; retrieve the next sequential page first.");
    } else {
      d = {
        schema: 2,
        id: randomUUID(),
        scope,
        expires: Date.now() + DELIVERY_TTL_MS,
        next: 0,
        pages: outputPages(options.units ?? [{ text: options.text ?? "", label: options.command }]),
        completion: options.completion ?? null,
        command: options.command,
      };
    }
    const path = join(directory, `${d.id}.json`);
    const save = () => {
      const bytes = JSON.stringify(d);
      const size = Buffer.byteLength(bytes);
      if (size > MAX_DELIVERY_BYTES)
        throw new Error(
          "Delivery exceeds local cache bound; use explicit --full or --json bulk output.",
        );
      const retained: { path: string; size: number; expires: number }[] = [];
      for (const file of readdirSync(directory).filter((f) => CACHE_FILE.test(f))) {
        const other = join(directory, file);
        if (other === path) continue;
        try {
          const old = readDelivery(other);
          if (old.expires <= Date.now()) {
            unlinkSync(other);
            continue;
          }
          retained.push({ path: other, size: lstatSync(other).size, expires: old.expires });
        } catch {
          unlinkSync(other);
        }
      }
      retained.sort((a, b) => a.expires - b.expires || a.path.localeCompare(b.path));
      let total = size + retained.reduce((sum, file) => sum + file.size, 0);
      while (retained.length >= MAX_DELIVERIES || total > MAX_CACHE_BYTES) {
        const oldest = retained.shift();
        if (!oldest) throw new Error("Delivery exceeds aggregate cache bound");
        unlinkSync(oldest.path);
        total -= oldest.size;
      }
      const tmp = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(tmp, bytes, { mode: 0o600, flag: "wx" });
        renameSync(tmp, path);
      } finally {
        try {
          unlinkSync(tmp);
        } catch {
          /* Already renamed or never created. */
        }
      }
    };
    const replay = index < d.next;
    if (!replay) save();
    const final = index === d.pages.length - 1;
    const page = d.pages[index];
    if (!page) throw new Error("Invalid delivery page");
    const labels =
      page.labels.length <= 4
        ? page.labels.join(", ")
        : `${page.labels[0]} … ${page.labels.at(-1)}`;
    const through = d.pages
      .slice(0, index + 1)
      .reduce<number | undefined>((n, p) => p.through ?? n, undefined);
    const completion: Record<string, unknown> | null = d.completion
      ? {
          ...d.completion,
          _cli_delivery_id: d.id,
          _cli_delivery_page: index,
          _cli_delivery_expires: d.expires,
          ...(!final ? { _cli_prefix_through: through ?? null } : {}),
        }
      : null;
    const ack =
      completion &&
      (final || (through !== undefined && completion._cli_prefix_eligible === true)) &&
      completion._cli_ack_eligible === true
        ? `\nDelivered prefix available for acknowledgment: ${String(completion._cli_ack_command).replace("{through}", String(final ? completion.current_through : through))}`
        : final && completion && completion._cli_ack_eligible === false
          ? "\nNo acknowledgment available: required room content or contiguous coverage is missing."
          : "";
    const footer = final
      ? "END OF DELIVERY. Pinned read-time bytes, not a fresh state check."
      : `Continue this exact delivery: ${d.command} --continue=${d.id}:${index + 1}`;
    const output = `DELIVERY ${index + 1}/${d.pages.length} — ${final ? "FINAL fragment" : "INCOMPLETE"}.\n${labels ? `Content: ${labels}\n` : ""}Replay this page: ${d.command} --continue=${d.id}:${index}\nLong messages/diffs may span fragments; no text is omitted.\n\n${page.text}\n${footer}${ack}\n`;
    if (output.length > OUTPUT_PAGE_CHARS)
      throw new Error("Delivery framing exceeds output budget");
    options.stdout(output);
    // Callback is idempotent in the config transaction: a crash after it but
    // before save can repeat output, never coordination effects.
    if (!replay) {
      if (completion && (final || through !== undefined)) options.complete(completion);
      d.next = index + 1;
      save();
    }
  });
}
