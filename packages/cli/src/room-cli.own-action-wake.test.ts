import { readFileSync } from "node:fs";
// reuse harness helpers from the main suite by inlining minimal versions
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runRoomCli } from "./room-cli.js";

function providerEnv(config: unknown): Record<string, string | undefined> {
  const dir = mkdtempSync(pathJoin(tmpdir(), "grp-watch-"));
  const file = pathJoin(dir, "config.json");
  writeFileSync(file, JSON.stringify(config));
  return { GRP_CONFIG: file, HOME: dir };
}
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function sseStream(frames: string[]): ReadableStream {
  return Readable.toWeb(Readable.from(frames)) as unknown as ReadableStream;
}

describe("watch — own start-choosing must not wake (full join flow)", () => {
  it("join persists participant_id, then own voting_phase_started is filtered", async () => {
    const env = providerEnv({ providers: {} });
    // 1. join exactly like Cobalt did
    const joinCode = await runRoomCli(
      ["join", "https://operator.example/r/abc123", "--invite", "it_x"],
      {
        stdout: () => {},
        stderr: () => {},
        fetch: async () =>
          jsonResponse({
            ok: true,
            slug: "abc123",
            participant_token: "t_me",
            participant_id: "p_me",
            role: "participant",
          }),
        env,
      },
    );
    expect(joinCode).toBe(0);
    const saved = JSON.parse(readFileSync(env.GRP_CONFIG as string, "utf8"));
    expect(saved.currentRoom.participantId).toBe("p_me");
    // set a mark so the watch baselines like Cobalt's did
    saved.currentRoom.lastSeenSeq = 78;
    writeFileSync(env.GRP_CONFIG as string, JSON.stringify(saved));
    // 2. watch with the stream emitting OWN voting_phase_started at seq 79
    let stdout = "";
    const code = await runRoomCli(["watch", "--timeout", "2"], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (!request.url.includes("/events/stream")) {
          return jsonResponse({ slug: "abc123", events: [] });
        }
        return new Response(
          sseStream([
            'id: e79\nevent: decision.voting_phase_started\ndata: {"id":"e79","seq":79,"event_type":"decision.voting_phase_started","occurred_at":"2026-07-08T21:00:00.000Z","decision_id":"d3","data":{"seq":3,"started_by":{"display_name":"Cobalt","participant_id":"p_me"},"voting_ends_at":"2026-07-08T22:00:00.000Z"}}\n\n',
          ]),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      env,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Nothing new after 2s");
    expect(stdout).not.toContain("Decision opened");
  });
});
