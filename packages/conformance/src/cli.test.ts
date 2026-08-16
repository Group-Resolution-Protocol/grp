import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readMandateFile, runCli } from "./cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("conformance CLI mandate input", () => {
  it("accepts one compact JWS from a protected file", async () => {
    const path = await mandateFile("header.payload.signature\n", 0o600);
    await expect(readMandateFile(path)).resolves.toBe("header.payload.signature");
  });

  it("rejects mandate files with broad permissions", async () => {
    const path = await mandateFile("header.payload.signature\n", 0o644);
    if (process.platform === "win32") return;
    await expect(readMandateFile(path)).rejects.toThrow(/group or other users/);
  });

  it("rejects empty, multiline, and non-operator mandate inputs", async () => {
    const empty = await mandateFile("\n", 0o600);
    const multiline = await mandateFile("header.payload.signature\nsecond.value.here\n", 0o600);
    await expect(readMandateFile(empty)).rejects.toThrow(/empty/);
    await expect(readMandateFile(multiline)).rejects.toThrow(/one compact JWS/);
    await expect(runCli(["--profile=core", `--mandate-file=${multiline}`])).rejects.toThrow(
      /only with --profile=operator/,
    );
  });
});

async function mandateFile(contents: string, mode: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "grp-conformance-mandate-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "mandate.jws");
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, mode);
  return path;
}
