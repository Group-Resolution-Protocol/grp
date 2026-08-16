import { describe, expect, it } from "vitest";
import { CLI_VERSION, banner } from "./index.js";

describe("GRP CLI sentinel", () => {
  it("returns a banner including the version", () => {
    const b = banner();
    expect(b).toContain(CLI_VERSION);
    expect(b).toContain("grp");
  });
});
