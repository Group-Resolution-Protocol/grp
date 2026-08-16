import {
  Client as CurrentMcpClient,
  StreamableHTTPClientTransport as CurrentMcpTransport,
} from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ConformanceCase } from "../types.js";

interface ToolResult {
  isError?: boolean;
  content: unknown;
}

interface McpClientLike {
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

type McpEra = "2026-07-28" | "2025-11-25";

interface RoomCreateResponse {
  ok: boolean;
  slug: string;
  creator_token: string;
  config: Record<string, unknown>;
}

interface JoinResponse {
  ok: boolean;
  participant_token: string;
  participant_id: string;
}

interface AgentRoomView {
  ok: boolean;
  slug: string;
  status: string;
  brief: string;
  decision: { options: string[] } | null;
  discussion: unknown[];
  participants: string[];
  decided: Array<{ winner: string | null; outcome: string | null }>;
  rules: { how_to_choose: string; can_propose: boolean };
}

interface OutcomeResponse {
  slug: string;
  status: string;
  resolved_winner: string | null;
  decisions: Array<{
    seq: number;
    receipt_hash: string | null;
  }>;
}

const participantTools = [
  "join_room",
  "read_room",
  "propose",
  "discuss",
  "choose",
  "wait",
  "outcome",
  "ask",
  "start_choosing",
  "close_room",
] as const;
const hostTools = ["create_room", "ask", "list_decisions", "wait_outcome", "close_room"] as const;
const hostOnlyTools = [
  "create_room",
  "list_decisions",
  "wait_outcome",
  "register_webhook",
] as const;

export const mcpCases: ConformanceCase[] = [
  {
    id: "transport.mcp.modern_2026_07_28_lifecycle",
    title:
      "MCP 2026-07-28 lifecycle creates, joins, reads, discusses, proposes, chooses, and reads outcome with REST parity",
    profile: "transport",
    run: async ({ target, allowWrites }) => {
      if (!target) {
        throw new Error("transport profile requires --target=<base-url>");
      }
      await runMcpLifecycleProbe(target, { allowWrites, era: "2026-07-28" });
    },
  },
  {
    id: "transport.mcp.legacy_2025_11_25_lifecycle",
    title:
      "MCP 2025-11-25 compatibility lifecycle creates, joins, reads, discusses, proposes, chooses, and reads outcome with REST parity",
    profile: "transport",
    run: async ({ target, allowWrites }) => {
      if (!target) {
        throw new Error("transport profile requires --target=<base-url>");
      }
      await runMcpLifecycleProbe(target, { allowWrites, era: "2025-11-25" });
    },
  },
];

export async function runMcpLifecycleProbe(
  target: string,
  options: { allowWrites?: boolean; era?: McpEra } = {},
): Promise<void> {
  if (options.allowWrites !== true) {
    throw new Error("MCP lifecycle probe creates and deletes a room; set allowWrites: true");
  }
  const era = options.era ?? "2026-07-28";
  // Two role-scoped surfaces (agent-surface principles §3): the participant
  // catalog at /mcp, the host catalog at /mcp/host.
  const host = await connectMcpClient(target, "/mcp/host", era, "grp-conformance-host");
  const client = await connectMcpClient(target, "/mcp", era, "grp-conformance");
  let createdRoom: { slug: string; creatorToken: string } | undefined;

  try {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    for (const name of participantTools) {
      if (!names.has(name)) {
        throw new Error(`participant MCP catalog missing ${name}`);
      }
    }
    for (const name of hostOnlyTools) {
      if (names.has(name)) {
        throw new Error(`participant MCP catalog must not expose host-only tool ${name}`);
      }
    }
    const hostCatalog = new Set((await host.listTools()).tools.map((tool) => tool.name));
    for (const name of hostTools) {
      if (!hostCatalog.has(name)) {
        throw new Error(`host MCP catalog missing ${name}`);
      }
    }

    const suffix = new Date().toISOString();
    const room = await callTool<RoomCreateResponse>(host, "create_room", {
      question: `GRP conformance MCP lifecycle ${suffix}`,
      options: ["approve", "reject"],
      config: {
        visibility: "unlisted",
        mechanism: "simple_majority",
        option_proposal_authority: { kind: "any_participant" },
        auth: "token_only",
        quorum: 1,
        voting_window: 60,
        settle_window: 0,
        max_participants: 3,
        early_close: true,
        creator_votes: false,
      },
    });
    if (room.ok !== true) throw new Error("create_room did not return ok=true");
    assertString(room.slug, "create_room response slug");
    assertString(room.creator_token, "create_room response creator_token");
    createdRoom = { slug: room.slug, creatorToken: room.creator_token };

    const joined = await callTool<JoinResponse>(client, "join_room", {
      slug: room.slug,
      display_name: "grp-conformance-mcp-agent",
    });
    if (joined.ok !== true) throw new Error("join_room did not return ok=true");
    assertString(joined.participant_token, "join_room response participant_token");
    assertString(joined.participant_id, "join_room response participant_id");

    const initial = await callTool<AgentRoomView>(client, "read_room", {
      slug: room.slug,
      token: joined.participant_token,
    });
    if (initial.ok !== true) throw new Error("read_room did not return ok=true");
    if (initial.slug !== room.slug) throw new Error("MCP room view slug mismatch");
    const opts = initial.decision?.options ?? [];
    if (!opts.includes("approve") || !opts.includes("reject")) {
      throw new Error("MCP room view active decision missing initial options");
    }
    if (typeof initial.rules?.how_to_choose !== "string") {
      throw new Error("MCP room view missing rules.how_to_choose");
    }

    const discussion = await callTool<{ ok: boolean; id: string }>(client, "discuss", {
      slug: room.slug,
      token: joined.participant_token,
      body: "Conformance probe discussion over MCP.",
      stance: "agree",
    });
    if (discussion.ok !== true) {
      throw new Error("discuss did not return ok=true");
    }

    const proposed = await callTool<{ accepted: boolean; options: string[] }>(client, "propose", {
      slug: room.slug,
      token: joined.participant_token,
      option: "abstain",
    });
    if (proposed.accepted !== true) {
      throw new Error("propose did not return accepted=true");
    }
    if (!proposed.options.includes("abstain")) {
      throw new Error("propose response missing proposed option");
    }

    const choice = await callTool<{ ok: boolean; choice: string }>(client, "choose", {
      slug: room.slug,
      token: joined.participant_token,
      choice: "approve",
      rationale: "Conformance probe choice over MCP.",
    });
    if (choice.ok !== true) throw new Error("choose did not return ok=true");

    const afterVote = await callTool<AgentRoomView>(client, "read_room", {
      slug: room.slug,
      token: joined.participant_token,
    });
    if (afterVote.status !== "resolved") {
      throw new Error(
        `expected early-close MCP room to resolve after choice; got ${afterVote.status}`,
      );
    }
    const lastDecided = afterVote.decided.at(-1);
    if (lastDecided?.winner !== "approve") {
      throw new Error(`expected decided winner approve; got ${String(lastDecided?.winner)}`);
    }

    const outcome = await callTool<OutcomeResponse>(client, "outcome", {
      slug: room.slug,
      token: joined.participant_token,
    });
    if (outcome.status !== "resolved") {
      throw new Error(`expected MCP resolved outcome; got ${outcome.status}`);
    }
    if (outcome.resolved_winner !== "approve") {
      throw new Error(
        `expected MCP outcome winner approve; got ${String(outcome.resolved_winner)}`,
      );
    }
    const head = outcome.decisions.at(-1);
    if (!head?.receipt_hash?.startsWith("sha256:")) {
      throw new Error("MCP outcome missing sha256 receipt_hash");
    }

    const restView = await fetchJson<{
      slug: string;
      status: string;
      decided: Array<{ winner: string | null }>;
    }>(new URL(`/api/rooms/${room.slug}`, target), joined.participant_token);
    if (
      restView.slug !== room.slug ||
      restView.status !== afterVote.status ||
      restView.decided.at(-1)?.winner !== lastDecided.winner
    ) {
      throw new Error(`${era} MCP state does not match the REST representation`);
    }
  } finally {
    await client.close().catch(() => undefined);
    await host.close().catch(() => undefined);
    if (createdRoom) {
      await deleteRoom(target, createdRoom.slug, createdRoom.creatorToken);
    }
  }
}

async function callTool<T>(
  client: McpClientLike,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  const payload = parseJsonContent(result.content);
  if (result.isError) {
    throw new Error(`${name} returned MCP error: ${JSON.stringify(payload)}`);
  }
  return payload as T;
}

async function connectMcpClient(
  target: string,
  path: "/mcp" | "/mcp/host",
  era: McpEra,
  name: string,
): Promise<McpClientLike> {
  if (era === "2026-07-28") {
    const client = new CurrentMcpClient(
      { name, version: "0.1.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(new CurrentMcpTransport(new URL(path, target)));
    if (client.getProtocolEra() !== "modern") {
      await client.close().catch(() => undefined);
      throw new Error("MCP client did not negotiate the required 2026-07-28 modern era");
    }
    return client as unknown as McpClientLike;
  }

  const client = new Client({ name, version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(path, target)) as unknown as Transport,
  );
  return client as unknown as McpClientLike;
}

async function fetchJson<T>(url: URL, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `GET ${url.toString()} returned ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload as T;
}

async function deleteRoom(target: string, slug: string, creatorToken: string): Promise<void> {
  const response = await fetch(new URL(`/api/rooms/${slug}`, target), {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${creatorToken}`,
      "x-confirm-delete": slug,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(
      `failed to delete MCP conformance room ${slug}: HTTP ${response.status} ${JSON.stringify(payload)}`,
    );
  }
}

function parseJsonContent(content: unknown): unknown {
  const arr = content as Array<{ type: string; text: string }>;
  const first = arr[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("MCP tool response missing text JSON content");
  }
  try {
    return JSON.parse(first.text);
  } catch (err) {
    throw new Error(
      `MCP tool response was not JSON: ${first.text}; ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}
