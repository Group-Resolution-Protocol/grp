import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_CACHE_BYTES,
  MAX_DELIVERIES,
  OUTPUT_PAGE_CHARS,
  outputChunks,
  outputPages,
  writeBoundedOutput,
} from "./bounded-output.js";

function fixture() {
  const configPath = join(mkdtempSync(join(tmpdir(), "grp-pages-")), "config.json");
  let output = "";
  const complete = vi.fn();
  const options = {
    configPath,
    scope: "room/person/read",
    command: "grp read",
    complete,
    stdout: (text: string) => {
      output = text;
    },
  };
  return {
    options,
    complete,
    output: () => output,
    token: () => /Continue this exact delivery: .*--continue=(\S+)/.exec(output)?.[1] ?? "",
    replay: () => /Replay this page: .*--continue=(\S+)/.exec(output)?.[1] ?? "",
  };
}

describe("bounded output custody", () => {
  it("splits without losing whitespace, paragraph boundaries, or Unicode", () => {
    const text = `${"a".repeat(8_000)}\n\n${"🦋".repeat(12_000)}\nlast\n`;
    const chunks = outputChunks(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks[0]?.endsWith("\n\n")).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThan(OUTPUT_PAGE_CHARS);
      expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk)).toBe(false);
    }
  });

  it("does not complete before every sequential fragment and retains completed bytes", () => {
    const f = fixture();
    writeBoundedOutput({ ...f.options, text: "abc\n".repeat(10_000), completion: { through: 8 } });
    const directory = `${f.options.configPath}.deliveries-v2`;
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    for (const file of readdirSync(directory))
      expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
    let count = 0;
    while (f.token()) {
      expect(f.complete).not.toHaveBeenCalled();
      expect(f.output().length).toBeLessThanOrEqual(OUTPUT_PAGE_CHARS);
      writeBoundedOutput({ ...f.options, continuation: f.token() });
      if (++count > 10) throw new Error("nonterminating delivery");
    }
    expect(f.complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ through: 8 }));
    expect(readdirSync(directory)).toHaveLength(1);
    const final = f.output();
    writeBoundedOutput({ ...f.options, continuation: f.replay() });
    expect(f.output()).toBe(final);
    expect(f.complete).toHaveBeenCalledOnce();
  });

  it("rejects skipped and cross-scope pages but retains overlapping deliveries", () => {
    const f = fixture();
    writeBoundedOutput({ ...f.options, text: "x".repeat(40_000) });
    const token = f.token();
    expect(() =>
      writeBoundedOutput({ ...f.options, continuation: token.replace(/:1$/, ":2") }),
    ).toThrow("Out-of-order");
    expect(() =>
      writeBoundedOutput({ ...f.options, scope: "different principal", continuation: token }),
    ).toThrow("unavailable");
    writeBoundedOutput({ ...f.options, text: "replacement short read" });
    expect(() => writeBoundedOutput({ ...f.options, continuation: token })).not.toThrow();
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("does not record delivery when the output sink fails; permits retry of that page", () => {
    const f = fixture();
    writeBoundedOutput({ ...f.options, text: "x".repeat(13_000), completion: { through: 8 } });
    const token = f.token();
    expect(() =>
      writeBoundedOutput({
        ...f.options,
        continuation: token,
        stdout: () => {
          throw new Error("broken pipe");
        },
      }),
    ).toThrow("broken pipe");
    expect(f.complete).not.toHaveBeenCalled();
    writeBoundedOutput({ ...f.options, continuation: token });
    expect(f.complete).toHaveBeenCalledOnce();
  });

  it("expires continuations instead of silently replacing them with new content", () => {
    const f = fixture();
    writeBoundedOutput({ ...f.options, text: "x".repeat(13_000) });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 3_600_001);
    try {
      expect(() => writeBoundedOutput({ ...f.options, continuation: f.token() })).toThrow(
        "Expired",
      );
    } finally {
      clock.mockRestore();
    }
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("replays first, middle, final and single pages byte-for-byte without repeating effects", () => {
    for (const length of [0, 40, 25_000]) {
      const f = fixture();
      writeBoundedOutput({ ...f.options, text: "a".repeat(length), completion: { through: 9 } });
      const pages: { token: string; text: string }[] = [];
      for (let i = 0; i < 10; i++) {
        pages.push({ token: f.replay(), text: f.output() });
        const next = f.token();
        if (!next) break;
        writeBoundedOutput({ ...f.options, continuation: next });
      }
      for (const page of pages.reverse()) {
        writeBoundedOutput({ ...f.options, continuation: page.token });
        expect(f.output()).toBe(page.text);
      }
      expect(f.complete).toHaveBeenCalledOnce();
    }
  });

  it("packs complete units and preserves bytes across budgets and fragment boundaries", () => {
    for (const budget of [2, 7, 29, 101, 1000]) {
      const units = [
        { text: "header\n" },
        { text: "a🦋\n\n".repeat(61), label: "Event 6", through: 6 },
        { text: "second message\n", label: "Event 7", through: 7 },
        { text: "state\n" },
      ];
      const pages = outputPages(units, budget);
      expect(pages.map((p) => p.text).join("")).toBe(units.map((u) => u.text).join(""));
      for (const page of pages) {
        expect(page.text.length).toBeLessThanOrEqual(budget);
        expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(page.text)).toBe(false);
      }
      const boundary = pages.findIndex((p) => (p.through ?? 0) >= 6);
      expect(
        pages
          .slice(0, boundary + 1)
          .map((p) => p.text)
          .join(""),
      ).toContain(units[1]?.text);
    }
    expect(
      outputPages([{ text: "a".repeat(7) }, { text: "b".repeat(7) }], 10).map((p) => p.text),
    ).toEqual(["a".repeat(7), "b".repeat(7)]);
  });

  it("enforces count and aggregate-byte retention without substituting content", () => {
    const f = fixture();
    writeBoundedOutput({ ...f.options, text: "old" });
    const old = f.replay();
    for (let i = 0; i < MAX_DELIVERIES; i++) writeBoundedOutput({ ...f.options, text: String(i) });
    const directory = `${f.options.configPath}.deliveries-v2`;
    expect(readdirSync(directory)).toHaveLength(MAX_DELIVERIES);
    expect(() => writeBoundedOutput({ ...f.options, continuation: old })).toThrow("evicted");
    for (let i = 0; i < 3; i++) writeBoundedOutput({ ...f.options, text: "x".repeat(11_000_000) });
    expect(
      readdirSync(directory).reduce((n, file) => n + statSync(join(directory, file)).size, 0),
    ).toBeLessThanOrEqual(MAX_CACHE_BYTES);
  });

  it("rejects malformed tokens, corrupted caches and old schemas without effects", () => {
    const f = fixture();
    writeBoundedOutput({ ...f.options, text: "a".repeat(20_000), completion: { through: 9 } });
    for (const token of ["../../config.json:0", "not-a-token", `${f.replay()}junk`])
      expect(() => writeBoundedOutput({ ...f.options, continuation: token })).toThrow(
        "Invalid continuation",
      );
    const token = f.token();
    const path = join(`${f.options.configPath}.deliveries-v2`, `${token.split(":")[0]}.json`);
    writeFileSync(path, JSON.stringify({ schema: 1 }));
    expect(() => writeBoundedOutput({ ...f.options, continuation: token })).toThrow("incompatible");
    writeFileSync(path, "{");
    expect(() => writeBoundedOutput({ ...f.options, continuation: token })).toThrow("unavailable");
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("serializes identical final-page requests from independent processes", async () => {
    const f = fixture();
    writeBoundedOutput({ ...f.options, text: "a".repeat(13_000), completion: { through: 9 } });
    const effects = `${f.options.configPath}.effects`;
    const source = new URL("./bounded-output.ts", import.meta.url).href;
    const code = `import {writeBoundedOutput} from ${JSON.stringify(source)}; import {appendFileSync} from 'node:fs'; writeBoundedOutput(${JSON.stringify({ configPath: f.options.configPath, scope: f.options.scope, command: f.options.command, continuation: f.token() }).slice(0, -1)},stdout:()=>{},complete:()=>appendFileSync(${JSON.stringify(effects)},'effect\\n')});`;
    await Promise.all(
      [0, 1, 2].map(
        () =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, [
              "--import",
              "tsx/esm",
              "--input-type=module",
              "-e",
              code,
            ]);
            let errors = "";
            child.stderr.on("data", (bytes) => {
              errors += bytes;
            });
            child.on("error", reject);
            child.on("exit", (status) => (status === 0 ? resolve() : reject(new Error(errors))));
          }),
      ),
    );
    expect(readFileSync(effects, "utf8")).toBe("effect\n");
  });

  it("does not equate a successful sink with model exposure", () => {
    const f = fixture();
    const file = `${f.options.configPath}.redirected`;
    writeBoundedOutput({
      ...f.options,
      text: "caller may never display this",
      completion: { through: 1 },
      stdout: (text) => appendFileSync(file, text),
    });
    expect(f.output()).toBe("");
    expect(readFileSync(file, "utf8")).toContain("caller may never display this");
    expect(f.complete).toHaveBeenCalledOnce();
  });

  it("retries after output succeeds but coordination persistence fails", () => {
    const f = fixture();
    writeBoundedOutput({ ...f.options, text: "x".repeat(13_000), completion: { through: 9 } });
    const token = f.token();
    expect(() =>
      writeBoundedOutput({
        ...f.options,
        continuation: token,
        complete: () => {
          throw new Error("config persistence failed");
        },
      }),
    ).toThrow("config persistence failed");
    const emitted = f.output();
    expect(f.complete).not.toHaveBeenCalled();
    writeBoundedOutput({ ...f.options, continuation: token });
    expect(f.output()).toBe(emitted);
    expect(f.complete).toHaveBeenCalledOnce();
  });
});
