import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const exitModuleUrl = pathToFileURL(join(__dirname, "exit.ts")).href;
const PAYLOAD_BYTES = 200_000; // well past the ~64 KiB pipe buffer

function runChild(script: string): Promise<{ code: number | null; stdoutBytes: number }> {
  const dir = mkdtempSync(join(tmpdir(), "grp-exit-test-"));
  const file = join(dir, "child.ts");
  writeFileSync(file, script);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", file], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdoutBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdoutBytes }));
  });
}

// Spec 127 (TS4-1) — a >64 KiB `grp outcome --json` export truncated at
// exactly 65,536 bytes because the bin stubs called process.exit() before the
// piped stdout drained.
describe("exitAfterFlush", () => {
  it("drains >64 KiB of piped stdout before exiting", async () => {
    const result = await runChild(
      [
        `import { exitAfterFlush } from ${JSON.stringify(exitModuleUrl)};`,
        `process.stdout.write("x".repeat(${PAYLOAD_BYTES}));`,
        "exitAfterFlush(0);",
      ].join("\n"),
    );
    expect(result.code).toBe(0);
    expect(result.stdoutBytes).toBe(PAYLOAD_BYTES);
  });

  it("control: bare process.exit() can truncate the same payload (the TS4-1 bug)", async () => {
    const result = await runChild(
      [`process.stdout.write("x".repeat(${PAYLOAD_BYTES}));`, "process.exit(0);"].join("\n"),
    );
    // Truncation here is environment-dependent: it happens when the payload
    // outruns the pipe buffer before exit, but a fast-enough reader can drain
    // all 200 KB first (observed on GitHub-hosted runners). The control
    // documents the TS4-1 failure mode; the actual guarantee lives in the
    // two exitAfterFlush cases above/below, which must ALWAYS see the full
    // payload. So: bounded, not strictly truncated.
    expect(result.stdoutBytes).toBeLessThanOrEqual(PAYLOAD_BYTES);
    expect(result.stdoutBytes).toBeGreaterThan(0);
  });

  it("propagates the exit code", async () => {
    const result = await runChild(
      [
        `import { exitAfterFlush } from ${JSON.stringify(exitModuleUrl)};`,
        `process.stdout.write("x".repeat(${PAYLOAD_BYTES}));`,
        "exitAfterFlush(3);",
      ].join("\n"),
    );
    expect(result.code).toBe(3);
    expect(result.stdoutBytes).toBe(PAYLOAD_BYTES);
  });
});
