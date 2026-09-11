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
  maxChars?: number;
  format?: "text" | "json";
  argv?: string[];
  metadata?: Record<string, unknown>;
  capturedAt?: string;
  bookendedControls?: boolean;
}

export class OutputDeliveryError extends Error {
  constructor(
    message: string,
    public code: string,
    public recovery: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function navigation(d: Delivery, index: number): string[] {
  return [
    ...(d.argv ?? [d.command]),
    ...(d.format === "json" ? ["--json"] : []),
    `--continue=${d.id}:${index}`,
  ];
}

/** Local metadata only. No cache creation, pruning, acknowledgment or fetching. */
export function inspectOutputDeliveries(options: {
  configPath: string;
  scope: string;
  continuation?: string;
}): Record<string, unknown>[] {
  const directory = `${options.configPath}.deliveries-v2`;
  const scope = createHash("sha256").update(options.scope).digest("hex");
  const match = options.continuation ? TOKEN.exec(options.continuation) : null;
  if (options.continuation && !match)
    throw new OutputDeliveryError("Invalid continuation token", "delivery.invalid");
  let names: string[];
  try {
    if (lstatSync(directory).isSymbolicLink()) throw new Error("Unsafe delivery directory");
    names = match ? [`${match[1]}.json`] : readdirSync(directory).filter((f) => CACHE_FILE.test(f));
  } catch {
    if (match)
      throw new OutputDeliveryError(
        "Delivery unavailable for this identity or read surface",
        "delivery.unavailable",
      );
    return [];
  }
  const found: Delivery[] = [];
  for (const name of names) {
    try {
      const d = readDelivery(join(directory, name));
      if (d.scope === scope) found.push(d);
    } catch {
      /* Unavailable. */
    }
  }
  if (match && !found.length)
    throw new OutputDeliveryError(
      "Delivery unavailable for this identity or read surface",
      "delivery.unavailable",
    );
  return found
    .sort((a, b) => b.expires - a.expires)
    .slice(0, 6)
    .map((d) => ({
      id: d.id,
      captured_at: d.capturedAt ?? null,
      expires_at: new Date(d.expires).toISOString(),
      expired: d.expires <= Date.now(),
      delivered_pages: d.next,
      pages: d.pages.length,
      complete: d.next === d.pages.length,
      max_chars: d.maxChars ?? OUTPUT_PAGE_CHARS,
      format: d.format ?? "text",
      next_argv: d.expires > Date.now() && d.next < d.pages.length ? navigation(d, d.next) : null,
      surface: d.metadata?.surface ?? null,
      room_read: d.completion !== null,
    }));
}

function frame(d: Delivery, index: number, prefix?: { through: number | undefined }): string {
  const final = index === d.pages.length - 1;
  const page = d.pages[index];
  if (!page) throw new Error("Invalid delivery page");
  const through = prefix
    ? prefix.through
    : d.pages.slice(0, index + 1).reduce<number | undefined>((n, p) => p.through ?? n, undefined);
  const c = d.completion;
  const eligible =
    c?._cli_ack_eligible === true &&
    (final || (through !== undefined && c._cli_prefix_eligible === true));
  const ackThrough = eligible ? (final ? c?.current_through : through) : null;
  const metadata = d.metadata ?? {};
  const sourcePage = c?.page as Record<string, unknown> | undefined;
  const sourceHead =
    sourcePage?.room_event ??
    (sourcePage?.complete === false ? null : (c?.current_through ?? null));
  const sourceHasMore =
    typeof sourceHead === "number" && typeof c?.current_through === "number"
      ? c.current_through < sourceHead
      : sourcePage?.complete === false
        ? null
        : false;
  const fresh =
    final && c && (sourceHasMore !== false || c._cli_ack_eligible === false)
      ? {
          argv: [
            "read",
            ...(Array.isArray(metadata.room_argv) ? metadata.room_argv : []),
            ...(c._cli_ack_eligible === false && typeof metadata.recovery_since === "number"
              ? [`--since=${metadata.recovery_since}`]
              : []),
          ],
          requires_ack_through: eligible ? c.current_through : null,
          reason:
            c._cli_ack_eligible === false
              ? "missing_content_or_noncontiguous_source"
              : "next_host_batch",
        }
      : null;
  if (d.format === "json") {
    return `${JSON.stringify({
      schema: "grp.output-page.v1",
      ...metadata,
      text: page.text,
      delivery: {
        id: d.id,
        page: index + 1,
        pages: d.pages.length,
        complete: final,
        captured_at: d.capturedAt,
        max_chars: d.maxChars ?? OUTPUT_PAGE_CHARS,
        replay_argv: navigation(d, index),
        next_argv: final ? null : navigation(d, index + 1),
      },
      coverage: c
        ? {
            source_from_event: c._cli_delivery_from ?? null,
            source_through_event: c.current_through ?? null,
            source_head_event: sourceHead,
            source_has_more: sourceHasMore,
            content_complete: metadata.content_complete === true,
            delivered_through_event: through ?? (final && eligible ? c.current_through : null),
            eligible_ack_through_event: ackThrough,
            eligible_observation_scopes_on_completion: metadata.observation_scopes ?? [],
          }
        : null,
      ack_argv:
        ackThrough === null
          ? null
          : [
              "read",
              ...(Array.isArray(metadata.room_argv) ? metadata.room_argv : []),
              `--ack-through=${ackThrough}`,
            ],
      fresh_fetch_argv: fresh,
    })}\n`;
  }
  const labels =
    page.labels.length <= 4 ? page.labels.join(", ") : `${page.labels[0]} … ${page.labels.at(-1)}`;
  const ack = eligible
    ? `\nDelivered prefix available for acknowledgment: ${String(c?._cli_ack_command).replace("{through}", String(ackThrough))}`
    : final && c && c._cli_ack_eligible === false
      ? "\nNo acknowledgment available: required room content or contiguous coverage is missing."
      : "";
  const footer = final
    ? "END OF DELIVERY. Pinned read-time bytes, not a fresh state check."
    : `Continue this exact delivery: ${d.command} --continue=${d.id}:${index + 1}`;
  const identity = metadata.room
    ? `Source: room ${String(metadata.room)} at ${String(metadata.operator)}; participant ${String(metadata.participant ?? "unknown")}.\n`
    : "";
  const coverage = c
    ? `Source events: after ${String(c._cli_delivery_from ?? "snapshot")} through ${String(c.current_through ?? "unknown")}; head ${String(sourceHead ?? "unknown")}; bodies complete: ${metadata.content_complete === true}; room-head observation eligible on completion: ${Array.isArray(metadata.observation_scopes) && metadata.observation_scopes.length > 0}.\n`
    : "";
  const more = fresh
    ? fresh.requires_ack_through === null
      ? `\nCatch up from the covered position: grp ${fresh.argv.join(" ")}. This source cannot authorize acknowledgment and has no further local page.`
      : "\nThe captured head is not fully covered. Finish incorporating and acknowledge this delivered prefix, then fetch a fresh room read. This delivery has no further local page."
    : "";
  // Navigation is outside user content at both boundaries. A shell may expose
  // only a prefix or suffix; neither should require constructing a page index.
  const progress =
    d.bookendedControls && !final && c
      ? "Room observation not established by this partial delivery.\n"
      : "";
  return `DELIVERY ${index + 1}/${d.pages.length} — ${final ? "FINAL fragment" : "INCOMPLETE"}.\n${d.bookendedControls ? `${footer}\n` : ""}${progress}${labels ? `Content: ${labels}\n` : ""}${identity}${coverage}Replay this page: ${d.command} --continue=${d.id}:${index}\nSource captured: ${d.capturedAt ?? "legacy capture"}. Local delivery is not a fresh state check.\n\n${page.text}\n${footer}${ack}${more}\n`;
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
    (d.maxChars !== undefined &&
      (!Number.isSafeInteger(d.maxChars) || d.maxChars < 2048 || d.maxChars > OUTPUT_PAGE_CHARS)) ||
    (d.format !== undefined && d.format !== "text" && d.format !== "json") ||
    (d.argv !== undefined &&
      (!Array.isArray(d.argv) ||
        !d.argv.every((a) => typeof a === "string" && a.length <= 1000))) ||
    (d.metadata !== undefined &&
      (!d.metadata || typeof d.metadata !== "object" || Array.isArray(d.metadata))) ||
    !(
      d.completion === null ||
      (typeof d.completion === "object" && !Array.isArray(d.completion))
    ) ||
    !d.pages.every(
      (p) =>
        typeof p.text === "string" &&
        p.text.length <= OUTPUT_PAGE_CHARS &&
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
  maxChars?: number;
  format?: "text" | "json";
  argv?: string[];
  metadata?: Record<string, unknown>;
}): void {
  if (
    options.maxChars !== undefined &&
    (!Number.isSafeInteger(options.maxChars) ||
      options.maxChars < 2048 ||
      options.maxChars > OUTPUT_PAGE_CHARS)
  )
    throw new OutputDeliveryError(
      "--max-chars must be an integer from 2048 through 12000",
      "output.invalid_budget",
    );
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
        throw new OutputDeliveryError(
          "Invalid continuation. Start a new read; no acknowledgment was advanced.",
          "delivery.invalid",
        );
      try {
        d = readDelivery(join(directory, `${match[1]}.json`));
      } catch {
        throw new OutputDeliveryError(
          "Delivery unavailable, evicted, or incompatible. Start a new read; no acknowledgment was advanced.",
          "delivery.unavailable",
        );
      }
      index = Number(match[2]);
      if (d.scope !== scope || d.id !== match[1])
        throw new OutputDeliveryError(
          "Delivery unavailable for this identity or read surface.",
          "delivery.unavailable",
        );
      if (d.expires <= Date.now())
        throw new OutputDeliveryError(
          "Expired delivery. Start a new read; no acknowledgment was advanced.",
          "delivery.expired",
        );
      if (
        (options.maxChars !== undefined &&
          options.maxChars !== (d.maxChars ?? OUTPUT_PAGE_CHARS)) ||
        (options.format !== undefined && options.format !== (d.format ?? "text"))
      )
        throw new OutputDeliveryError(
          "Continuation format and budget must match the pinned delivery",
          "delivery.format_mismatch",
        );
      if (!Number.isSafeInteger(index) || index > d.next || index >= d.pages.length)
        throw new OutputDeliveryError(
          d.next === d.pages.length
            ? "Delivery complete; no next page exists. Replay a valid page if needed."
            : `Out-of-order continuation; next page: ${d.command} --continue=${d.id}:${d.next}`,
          d.next === d.pages.length ? "delivery.complete" : "delivery.out_of_order",
          {
            next_argv: d.next === d.pages.length ? null : navigation(d, d.next),
            pages: d.pages.length,
          },
        );
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
        maxChars: options.maxChars ?? OUTPUT_PAGE_CHARS,
        format: options.format ?? "text",
        argv: options.argv ?? [options.command],
        metadata: options.metadata ?? {},
        capturedAt: new Date().toISOString(),
        bookendedControls: true,
      };
      let budget = (d.maxChars ?? OUTPUT_PAGE_CHARS) - 512;
      for (;;) {
        d.pages = outputPages(
          options.units ?? [{ text: options.text ?? "", label: options.command }],
          budget,
        );
        let excess = 0;
        let through: number | undefined;
        for (let i = 0; i < d.pages.length; i++) {
          through = d.pages[i]?.through ?? through;
          excess = Math.max(
            excess,
            frame(d, i, { through }).length - (d.maxChars ?? OUTPUT_PAGE_CHARS),
          );
        }
        if (excess <= 0) break;
        budget = Math.min(budget - Math.max(excess, 32), Math.floor(budget * 0.8));
        if (budget < 2)
          throw new OutputDeliveryError(
            "Delivery metadata cannot fit this output budget",
            "output.framing_too_large",
          );
      }
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
    const output = frame(d, index);
    if (output.length > (d.maxChars ?? OUTPUT_PAGE_CHARS))
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
