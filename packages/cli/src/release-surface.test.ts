import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";

afterEach(() => vi.restoreAllMocks());

describe("CLI release surface", () => {
  it("keeps local team setup available without the unpublished account bridge", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    expect(await runCli(["help", "advanced"])).toBe(0);
    const text = output.join("");
    for (const command of ["persona setup", "org create", "session create", "as NAME"])
      expect(text).toContain(command);
    expect(text).not.toMatch(/account --help|continue_agent|binding|--revision|--request-id/);
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.dependencies).not.toHaveProperty("@modelcontextprotocol/client");
  });

  it("does not dispatch the deferred account command", async () => {
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    await expect(runCli(["account", "--help"])).rejects.toThrow("exit");
    expect(errors.join("")).toMatch(/unknown command/i);
  });
});
