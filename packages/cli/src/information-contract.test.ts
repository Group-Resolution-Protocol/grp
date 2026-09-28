import { describe, expect, it } from "vitest";
import { renderForegroundBlock } from "./foreground-cli.js";
import { CLI_VERSION } from "./index.js";
import { renderReadyStatus, renderWelcome } from "./onboarding-cli.js";
import { SHARED_ROOM_GRAMMAR } from "./orientation-copy.js";
import { renderDefaultsHelp } from "./quickstart-cli.js";
import { runRoomCli } from "./room-cli.js";

async function help(...argv: string[]) {
  let out = "";
  const code = await runRoomCli([...argv, "--help"], {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      throw new Error(text);
    },
    fetch: async () => {
      throw new Error("Help must not contact a host");
    },
    env: {},
  });
  expect(code).toBe(0);
  return out;
}

describe("CLI information contract", () => {
  it("introduces choices, work and optional resources without prescribing a workflow", () => {
    const copy = SHARED_ROOM_GRAMMAR.join("\n");
    expect(copy).toContain("does not create a decision or a tracked task");
    expect(copy).toContain("choices resolve under the room's rules");
    expect(copy).toContain("an artifact is not required");
    expect(copy).toContain("optional versioned work products");
    expect(copy).toContain("does not read or acknowledge room content");
    expect(copy).not.toContain("must start an action");
    expect(copy).not.toContain("Google Docs");
  });

  it("uses the actual package identity in both setup banners", () => {
    const ready = renderReadyStatus({
      initialized: true,
      setupMode: "join_only",
      defaultProvider: null,
      currentRoom: null,
      displayName: null,
      loggedInHost: null,
      configPath: "unused",
      issues: [],
    });
    for (const text of [renderWelcome(), ready]) {
      expect(text).toContain(`v${CLI_VERSION}`);
      expect(text).not.toMatch(/\bv0\.1\b/);
    }
  });

  it("explains external work before detailed action reference", async () => {
    const text = await help("act");
    expect(text).toContain("No artifact is required");
    expect(text).toContain("not proof of external execution");
    expect(text.indexOf("Minimal work/report example:")).toBeLessThan(text.indexOf("Flags:"));
    expect(text).toContain("--completion=group");
    expect(text).toContain("request-review pinned to --revision=REVISION_ID");
    expect(text).toContain("All-participant mode completes when every required report is in");
  });

  it("keeps all completion paths explicit rather than telling every mode to complete", async () => {
    const defaults = renderDefaultsHelp();
    const complete = await help("act", "complete");
    expect(defaults).not.toContain("In every mode");
    expect(defaults).toContain("proposes the exact result for a group completion decision");
    expect(defaults).toContain("request-review ID");
    expect(defaults).toContain("all required reports are in");
    expect(complete).toContain("For holder completion");
    expect(complete).toContain("without an artifact");
    expect(complete).toContain("with an artifact, use grp act request-review instead");
  });

  it("does not promise immutable review or locks for live external documents", async () => {
    const text = await help("artifact");
    expect(text).toContain("currently identify pinned Git content");
    expect(text).toContain("A live document URL is not a pinned artifact revision");
    expect(text).toContain("does not lock or edit that external document");
    expect(text).toContain("freezes the GRP artifact revision, not the external system");
  });

  it("distinguishes an action holder from a speaking turn", async () => {
    expect(await help("turn")).toContain("separate from holding an action");
    expect(await help("turn")).toContain("consumes the turn; no release is then needed");
    expect(await help("act")).toContain("not a speaking turn");
  });

  it("emits revision-pinned review syntax in the phased presentation too", () => {
    const text = renderForegroundBlock({
      policy: "phased_serial",
      epoch: "1",
      phase: "action",
      action_id: "action_1",
      decision_id: null,
      artifact_id: "artifact_1",
      artifact_revision_id: "revision_1",
      return_action_id: null,
      your_obligation: { kind: "action_holder" },
      available_transitions: ["action.request_review", "watch"],
      action: { id: "action_1", completion: "group", target_artifact_id: "artifact_1" },
    });
    expect(text).toContain("grp act request-review action_1 --revision=REVISION_ID");
    expect(text).not.toContain("grp act complete action_1");
  });

  it("retains exact-review and late-correction qualifications", async () => {
    expect(await help("act", "request-review")).toContain("approval is recorded immediately");
    expect(await help("act", "request-review")).toContain("not proof of an external signature");
    expect(await help("act", "review-note")).toContain("non-dispositive");
    expect(await help("read")).toContain(
      "Acknowledgment is local and never fetches newer messages",
    );
  });
});
