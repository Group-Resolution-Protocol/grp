import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// Output characters, not model-specific tokens. Reserve space for the envelope.
export const OUTPUT_PAGE_CHARS = 12_000;
const BODY_CHARS = OUTPUT_PAGE_CHARS - 1_000;
const MAX_CACHE_CHARS = 16_000_000;
const TTL_MS = 60 * 60 * 1000;

interface Delivery {
  id: string;
  expires: number;
  next: number;
  pages: string[];
  completion: Record<string, unknown> | null;
}

/** Lossless splitting: favor paragraphs/lines; never split a surrogate pair. */
export function outputChunks(text: string): string[] {
  const pages: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + BODY_CHARS, text.length);
    if (end < text.length) {
      const paragraph = text.lastIndexOf("\n\n", end - 1);
      const line = text.lastIndexOf("\n", end - 1);
      if (paragraph >= offset + BODY_CHARS / 2) end = paragraph + 2;
      else if (line >= offset + BODY_CHARS / 2) end = line + 1;
      else if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end -= 1;
    }
    pages.push(text.slice(offset, end));
    offset = end;
  }
  return pages.length ? pages : [""];
}

export function writeBoundedOutput(options: {
  configPath: string;
  scope: string;
  command: string;
  text?: string | undefined;
  continuation?: string | undefined;
  completion?: Record<string, unknown> | undefined;
  stdout: (text: string) => void;
  complete: (completion: Record<string, unknown>) => void;
}): void {
  const key = createHash("sha256").update(options.scope).digest("hex");
  // One file per scope: a new delivery replaces the old one; never an unbounded
  // file per page. No credentials or user-controlled paths in continuation IDs.
  const directory = `${options.configPath}.deliveries`;
  const path = join(directory, `${key}.json`);
  let delivery: Delivery;
  let index = 0;
  if (options.continuation) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
      if (raw.length > MAX_CACHE_CHARS) throw new Error("oversized cache");
      delivery = JSON.parse(raw) as Delivery;
    } catch {
      throw new Error("Delivery unavailable. Start a new read; no acknowledgment was advanced.");
    }
    const [id, page] = options.continuation.split(":");
    index = Number(page);
    if (
      delivery.expires < Date.now() ||
      delivery.id !== id ||
      !Number.isSafeInteger(index) ||
      index !== delivery.next ||
      !Array.isArray(delivery.pages) ||
      index < 0 ||
      index >= delivery.pages.length ||
      !delivery.pages.every((text) => typeof text === "string" && text.length <= BODY_CHARS)
    ) {
      throw new Error(
        "Expired, replaced, or out-of-order continuation. Start a new read; no acknowledgment was advanced.",
      );
    }
  } else {
    const text = options.text ?? "";
    if (text.length <= OUTPUT_PAGE_CHARS) {
      if (existsSync(path)) unlinkSync(path);
      options.stdout(text);
      if (options.completion) options.complete(options.completion);
      return;
    }
    delivery = {
      id: randomUUID(),
      expires: Date.now() + TTL_MS,
      next: 0,
      pages: outputChunks(text),
      completion: options.completion ?? null,
    };
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const save = () => {
    const bytes = JSON.stringify(delivery);
    if (bytes.length > MAX_CACHE_CHARS)
      throw new Error(
        "Delivery exceeds local cache bound; use explicit --full or --json bulk output.",
      );
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  };
  // Save before output, but advance only after the sink accepts the page.
  save();
  const final = index === delivery.pages.length - 1;
  const heading = `DELIVERY ${index + 1}/${delivery.pages.length} — ${final ? "FINAL fragment" : "INCOMPLETE; no acknowledgment or write observation advanced"}.`;
  const footer = final
    ? "END OF DELIVERY. These are pinned read-time bytes, not a fresh state check."
    : `Continue this exact delivery: ${options.command} --continue=${delivery.id}:${index + 1}`;
  options.stdout(
    `${heading}\nLong messages/diffs may span fragments; no text is omitted.\n\n${delivery.pages[index]}\n${footer}\n`,
  );
  if (final && delivery.completion) options.complete(delivery.completion);
  delivery.next = index + 1;
  if (final) unlinkSync(path);
  else save();
}
