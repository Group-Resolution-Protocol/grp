import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OUTPUT_PAGE_CHARS, outputChunks, writeBoundedOutput } from "./bounded-output.js";

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
    token: () => /--continue=(\S+)/.exec(output)?.[1] ?? "",
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

  it("does not complete before every sequential fragment and removes completed bytes", () => {
    const f = fixture();
    writeBoundedOutput({ ...f.options, text: "abc\n".repeat(10_000), completion: { through: 8 } });
    const directory = `${f.options.configPath}.deliveries`;
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
    expect(f.complete).toHaveBeenCalledExactlyOnceWith({ through: 8 });
    expect(readdirSync(directory)).toEqual([]);
  });

  it("rejects skipped, cross-scope, and replaced continuations", () => {
    const f = fixture();
    writeBoundedOutput({ ...f.options, text: "x".repeat(40_000) });
    const token = f.token();
    expect(() =>
      writeBoundedOutput({ ...f.options, continuation: token.replace(/:1$/, ":2") }),
    ).toThrow("out-of-order");
    expect(() =>
      writeBoundedOutput({ ...f.options, scope: "different principal", continuation: token }),
    ).toThrow("unavailable");
    writeBoundedOutput({ ...f.options, text: "replacement short read" });
    expect(() => writeBoundedOutput({ ...f.options, continuation: token })).toThrow("unavailable");
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
});
