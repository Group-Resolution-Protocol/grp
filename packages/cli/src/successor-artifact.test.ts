import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runRoomCli } from "./room-cli.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "grp-successor-artifact-"));
  const config = join(directory, "config.json");
  const file = join(directory, "revised draft.md");
  writeFileSync(file, "# Revised draft\n");
  writeFileSync(
    config,
    JSON.stringify({
      providers: {},
      currentRoom: {
        baseUrl: "https://operator.example",
        slug: "test-room",
        token: "test-token",
        participantId: "p1",
        role: "participant",
        coordinationStateCapability: "absent",
        lastSeenSeq: 5,
      },
    }),
  );
  return {
    config,
    file,
    env: { GRP_CONFIG: config },
    argv: [
      "act",
      "start",
      "--title=Amend draft",
      "--supersedes=old-action",
      "--artifact-name=Revised draft",
      `--artifact-file=${file}`,
    ],
  };
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

describe("successor artifact creation", () => {
  it("rejects reviewed inheritance before any write without advancing read position", async () => {
    const f = fixture();
    const before = readFileSync(f.config, "utf8");
    const requests: string[] = [];
    let error = "";
    const result = await runRoomCli(f.argv, {
      env: f.env,
      stdout: () => {},
      stderr: (text) => {
        error += text;
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(`${request.method} ${new URL(request.url).pathname}`);
        return json({
          action: {
            id: "old-action",
            status: "completed",
            review: { state: "approved" },
            target_artifact_id: "existing-doc",
          },
          state_revision: "unseen-newer-state",
        });
      },
    });
    expect(result).toBe(1);
    expect(requests).toEqual(["GET /api/rooms/test-room/actions/old-action"]);
    expect(error).toContain("inherits artifact existing-doc");
    expect(error).toContain("Nothing was written");
    expect(error).toContain("Start the successor without those two flags");
    expect(error).not.toContain("artifact create");
    expect(readFileSync(f.config, "utf8")).toBe(before);
  });

  it.each([
    { status: "cancelled", review: { state: "approved" }, target_artifact_id: "old-doc" },
    { status: "failed", target_artifact_id: "old-doc" },
    { status: "completed", review: null, target_artifact_id: "old-doc" },
    { status: "completed", review: { state: "approved" }, target_artifact_id: null },
  ])("preserves creation for a non-inheriting predecessor: %j", async (predecessor) => {
    const f = fixture();
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const result = await runRoomCli(f.argv, {
      env: f.env,
      stdout: () => {},
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        requests.push({
          method: request.method,
          path,
          body: request.method === "GET" ? null : await request.json(),
        });
        if (request.method === "GET") return json({ action: predecessor });
        if (path.endsWith("/actions"))
          return json({
            action: {
              id: "new-action",
              revision: "action-rev",
              target_artifact_id: null,
            },
          });
        return json({
          artifact: { id: "new-doc", current_revision_id: "revision-1", action_id: "new-action" },
          current_revision: { id: "revision-1", ordinal: 1 },
        });
      },
    });
    expect(result).toBe(0);
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/rooms/test-room/actions/old-action",
      "POST /api/rooms/test-room/actions",
      "POST /api/rooms/test-room/artifacts",
    ]);
    expect(requests[1].body).toMatchObject({ supersedes_action_id: "old-action" });
    expect(requests[1].body).not.toHaveProperty("completion");
    expect(requests[2].body).toMatchObject({
      action_id: "new-action",
      expected_action_revision: "action-rev",
      content: "# Revised draft\n",
    });
  });

  it.each([true, false])(
    "handles a host-returned target without creation or overwrite (successor=%s)",
    async (successor) => {
      const f = fixture();
      const argv = successor ? f.argv : f.argv.filter((arg) => !arg.startsWith("--supersedes="));
      const mutations: string[] = [];
      let error = "";
      const result = await runRoomCli(argv, {
        env: f.env,
        stdout: () => {},
        stderr: (text) => {
          error += text;
        },
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (request.method === "GET") return json({ action: { status: "completed" } });
          mutations.push(`${request.method} ${path}`);
          return json({
            action: { id: "new-action", revision: "action-rev", target_artifact_id: "host-target" },
          });
        },
      });
      expect(result).toBe(1);
      expect(mutations).toEqual(["POST /api/rooms/test-room/actions"]);
      expect(error).toContain("Action new-action started and already targets artifact host-target");
      expect(error).toContain("No artifact was created or published");
      expect(error).toContain("do not start it again");
      expect(error).toContain("grp act read new-action");
      expect(error).toContain(
        `grp artifact publish host-target --action=new-action --file=${JSON.stringify(f.file)}`,
      );
      expect(error).not.toContain("artifact create");
    },
  );

  it("checks local file existence before the predecessor lookup", async () => {
    const f = fixture();
    let requests = 0;
    const result = await runRoomCli(
      f.argv.map((arg) =>
        arg.startsWith("--artifact-file=") ? `--artifact-file=${f.file}.missing` : arg,
      ),
      {
        env: f.env,
        stdout: () => {},
        stderr: () => {},
        fetch: async () => {
          requests++;
          return json({});
        },
      },
    );
    expect(result).toBe(1);
    expect(requests).toBe(0);
  });
});
