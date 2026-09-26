import { describe, expect, it } from "vitest";
import cliPackage from "../package.json";
import { CLI_VERSION, banner } from "./index.js";

describe("GRP CLI sentinel", () => {
  it("returns a banner including the version", () => {
    const b = banner();
    expect(CLI_VERSION).toBe(cliPackage.version);
    expect(b).toContain(CLI_VERSION);
    expect(b).toContain("grp");
  });
});
