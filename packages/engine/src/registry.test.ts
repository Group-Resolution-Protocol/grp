import { describe, expect, it } from "vitest";
import { ENGINE_VERSION, registry, runGenericVote } from "./index.js";

describe("@grp-protocol/engine registry", () => {
  it("exposes the generic_vote mechanism", () => {
    expect(registry.generic_vote).toBeDefined();
    expect(registry.generic_vote.kind).toBe("generic_vote");
    expect(registry.generic_vote.version).toBe("1.0.0");
  });

  it("registry.generic_vote.run is the same function as runGenericVote", () => {
    const input = {
      parameters: {
        options: ["a", "b"],
        ballot_mode: "single_choice" as const,
        quorum: 0.5,
        pass_threshold: 0.5,
        tie_break: "no_pass" as const,
      },
      eligible_voters: 2,
      votes: [
        { voter_id: "x", choice: "a" },
        { voter_id: "y", choice: "a" },
      ],
      deterministic_seed: "0".repeat(64),
    };
    const a = registry.generic_vote.run(input);
    const b = runGenericVote(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("ENGINE_VERSION is exported", () => {
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
