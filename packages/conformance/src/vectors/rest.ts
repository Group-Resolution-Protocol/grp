import {
  base64urlDecode,
  computeJwsReceiptHash,
  decodeCompactJwsUnverified,
  verifyCompactJws,
} from "@grp-protocol/audit";
import type { ConformanceCase } from "../types.js";

interface JsonResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}

interface RoomCreateResponse {
  slug: string;
  url: string;
  creator_token: string;
  config: Record<string, unknown>;
}

interface JoinResponse {
  participant_token: string;
  participant_id: string;
}

interface AgentRoomView {
  slug: string;
  status: string;
  brief: string;
  decision: { options: string[]; status?: string } | null;
  discussion: unknown[];
  roster: { joined: Array<{ name: string; role: string }> };
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
    receipt_jws: string | null;
  }>;
  verification: { jwks_url: string } | null;
}

export const restCases: ConformanceCase[] = [
  {
    id: "transport.rest.url_room_lifecycle",
    title:
      "REST URL-room lifecycle creates, joins, reads, discusses, proposes, chooses, and reads outcome",
    profile: "transport",
    run: async ({ target, allowWrites }) => {
      if (!target) {
        throw new Error("transport profile requires --target=<base-url>");
      }
      await runRestLifecycleProbe(target, { allowWrites });
    },
  },
  {
    id: "transport.rest.choice_revision_until_locked",
    title:
      "REST early-close room accepts choice revision while the outcome is undetermined and locks at resolve (spec 052 F12)",
    profile: "transport",
    run: async ({ target }) => {
      if (!target) {
        throw new Error("transport profile requires --target=<base-url>");
      }
      await runChoiceRevisionProbe(target);
    },
  },
  {
    id: "transport.rest.room_speech_and_verbatim_options",
    title:
      "REST deferred rooms accept discussion before the first decision, and option bytes round-trip verbatim (spec 052 §2.1/§2.5)",
    profile: "transport",
    run: async ({ target }) => {
      if (!target) {
        throw new Error("transport profile requires --target=<base-url>");
      }
      await runRoomSpeechProbe(target);
    },
  },
  {
    id: "transport.rest.close_lifecycle",
    title:
      "REST close is terminal — chain-terminating outcome, read-only room, self-healing rejections (spec 052 §2.2)",
    profile: "transport",
    run: async ({ target }) => {
      if (!target) {
        throw new Error("transport profile requires --target=<base-url>");
      }
      await runCloseProbe(target);
    },
  },
  {
    id: "transport.rest.slate_phase",
    title:
      "REST slate phase — proposing decision rejects ballots, start_choosing opens choosing, then choices resolve (spec 055)",
    profile: "transport",
    run: async ({ target }) => {
      if (!target) {
        throw new Error("transport profile requires --target=<base-url>");
      }
      await runSlatePhaseProbe(target);
    },
  },
  {
    id: "transport.rest.room_access_modes",
    title:
      "REST Public, Unlisted, and Private rooms enforce their canonical read and admission rules",
    profile: "transport",
    run: async ({ target }) => {
      if (!target) {
        throw new Error("transport profile requires --target=<base-url>");
      }
      await runRoomAccessModesProbe(target);
    },
  },
];

async function runRoomAccessModesProbe(target: string): Promise<void> {
  return withRestProbe(target, async (client) => {
    const suffix = new Date().toISOString();

    const publicRoom = await client.createRoom({
      about: `GRP conformance Public access ${suffix}`,
      config: { visibility: "public", auth: "token_only" },
    });
    await client.get(`/api/rooms/${publicRoom.slug}`);
    await client.post(`/api/rooms/${publicRoom.slug}/join`, { display_name: "public-probe" });

    const unlistedRoom = await client.createRoom({
      about: `GRP conformance Unlisted access ${suffix}`,
      config: { auth: "token_only" },
    });
    if (unlistedRoom.config.visibility !== "unlisted") {
      throw new Error(
        `expected omitted visibility to resolve to unlisted; got ${String(unlistedRoom.config.visibility)}`,
      );
    }
    const unlistedRead = await client.getRaw(`/api/rooms/${unlistedRoom.slug}`);
    assertWireError(unlistedRead, 403, "room.join_required");
    const unlistedJoin = await client.post<JoinResponse>(`/api/rooms/${unlistedRoom.slug}/join`, {
      display_name: "unlisted-probe",
    });
    await client.get(`/api/rooms/${unlistedRoom.slug}`, unlistedJoin.participant_token);

    const privateRoom = await client.createRoom({
      about: `GRP conformance Private invite access ${suffix}`,
      config: { visibility: "private", auth: "token_only" },
    });
    const privateRead = await client.getRaw(`/api/rooms/${privateRoom.slug}`);
    assertWireError(privateRead, 403, "room.join_required");
    assertRestrictedMetadata(privateRead.payload, "private", false);
    const deniedPrivateJoin = await client.postRaw(`/api/rooms/${privateRoom.slug}/join`, {
      display_name: "uninvited-probe",
    });
    assertWireError(deniedPrivateJoin, 403, "room.invite_required");
    const privateInvite = await client.post<{ invite_token: string }>(
      `/api/rooms/${privateRoom.slug}/invites`,
      { label: "invited-probe" },
      privateRoom.creator_token,
    );
    const privateJoin = await client.post<JoinResponse>(`/api/rooms/${privateRoom.slug}/join`, {
      invite: privateInvite.invite_token,
    });
    await client.get(`/api/rooms/${privateRoom.slug}`, privateJoin.participant_token);

    const password = "conformance-private-password";
    const passwordRoom = await client.createRoom({
      about: `GRP conformance Private password access ${suffix}`,
      config: { visibility: "private", auth: "token_only" },
      password,
    });
    const passwordRead = await client.getRaw(`/api/rooms/${passwordRoom.slug}`);
    assertWireError(passwordRead, 403, "room.join_required");
    assertRestrictedMetadata(passwordRead.payload, "private", true);
    await client.get(`/api/rooms/${passwordRoom.slug}`, undefined, undefined, {
      "x-room-password": password,
    });
    const missingPasswordJoin = await client.postRaw(`/api/rooms/${passwordRoom.slug}/join`, {
      display_name: "missing-password-probe",
    });
    assertWireError(missingPasswordJoin, 403, "room.invite_required");
    const wrongPasswordJoin = await client.postRaw(`/api/rooms/${passwordRoom.slug}/join`, {
      display_name: "wrong-password-probe",
      password: "definitely-wrong",
    });
    assertWireError(wrongPasswordJoin, 401, "auth.invalid_password");
    await client.post(`/api/rooms/${passwordRoom.slug}/join`, {
      display_name: "password-probe",
      password,
    });
    const passwordInvite = await client.post<{ invite_token: string }>(
      `/api/rooms/${passwordRoom.slug}/invites`,
      { label: "password-bypass-invite" },
      passwordRoom.creator_token,
    );
    await client.post(`/api/rooms/${passwordRoom.slug}/join`, {
      invite: passwordInvite.invite_token,
    });

    const removedVisibility = await client.postRaw("/api/rooms", {
      about: `GRP conformance removed visibility ${suffix}`,
      config: { visibility: "password" },
      password,
    });
    assertWireError(removedVisibility, 400, "input.invalid");
  });
}

function assertWireError(
  response: { status: number; payload: unknown },
  status: number,
  code: string,
): void {
  if (response.status !== status) {
    throw new Error(
      `expected HTTP ${status}; got ${response.status}: ${JSON.stringify(response.payload)}`,
    );
  }
  const payload = response.payload as { error?: { code?: unknown } } | null;
  if (payload?.error?.code !== code) {
    throw new Error(`expected error code ${code}; got ${JSON.stringify(response.payload)}`);
  }
}

function assertRestrictedMetadata(
  payload: unknown,
  visibility: "unlisted" | "private",
  passwordSupported: boolean,
): void {
  const details = (payload as { error?: { details?: Record<string, unknown> } } | null)?.error
    ?.details;
  if (
    details?.visibility !== visibility ||
    details?.join_required !== true ||
    details?.password_supported !== passwordSupported
  ) {
    throw new Error(`unexpected restricted metadata: ${JSON.stringify(payload)}`);
  }
}

async function runSlatePhaseProbe(target: string): Promise<void> {
  return withRestProbe(target, async (client) => {
    const suffix = new Date().toISOString();

    const room = await client.createRoom({
      question: `GRP conformance slate phase ${suffix}`,
      options: [],
      config: {
        type: "persistent",
        visibility: "unlisted",
        mechanism: "plurality",
        auth: "token_only",
        quorum: 1,
        voting_window: 120,
        settle_window: 0,
        early_close: true,
        creator_votes: false,
      },
      defer_first_decision: true,
    });
    const joined = await client.post<JoinResponse>(`/api/rooms/${room.slug}/join`, {
      display_name: "slate-probe",
    });

    // Open in a proposing phase (long proposal window so the timer won't flip).
    const opened = await client.post<{ ok: true; decision: { status: string } }>(
      `/api/rooms/${room.slug}/ask`,
      {
        question: "Which move?",
        options: ["a", "b"],
        proposal_window: 600,
      },
      room.creator_token,
    );
    if (opened.decision.status !== "proposing") {
      throw new Error(`expected status "proposing"; got ${opened.decision.status}`);
    }

    // Ballots are rejected while proposing.
    const earlyChoice = await client.postRaw(
      `/api/rooms/${room.slug}/choose`,
      { choice: "a" },
      joined.participant_token,
    );
    if (earlyChoice.ok) throw new Error("choice accepted during the proposing phase");

    // The agent view advertises the proposing phase via decision.status
    // (spec 106 — the one phase encoding).
    const view = await client.get<AgentRoomView>(
      `/api/rooms/${room.slug}`,
      joined.participant_token,
    );
    if (view.decision?.status !== "proposing") {
      throw new Error(`expected decision.status "proposing"; got ${String(view.decision?.status)}`);
    }

    // Start choosing — the choice window opens.
    const put = await client.post<{ ok: true; decision: { status: string } }>(
      `/api/rooms/${room.slug}/start-choosing`,
      {},
      room.creator_token,
    );
    if (put.decision.status !== "voting") {
      throw new Error(`expected status "voting" after start_choosing; got ${put.decision.status}`);
    }

    // Now a choice is accepted and the room resolves (lone eligible voter).
    await client.post<{ ok: true }>(
      `/api/rooms/${room.slug}/choose`,
      { choice: "b" },
      joined.participant_token,
    );
    const after = await client.get<AgentRoomView>(
      `/api/rooms/${room.slug}`,
      joined.participant_token,
    );
    if (after.decided.at(-1)?.winner !== "b") {
      throw new Error(`expected winner "b"; got ${String(after.decided.at(-1)?.winner)}`);
    }
  });
}

async function runCloseProbe(target: string): Promise<void> {
  return withRestProbe(target, async (client) => {
    const suffix = new Date().toISOString();

    const room = await client.createRoom({
      question: `GRP conformance close ${suffix}`,
      options: ["ship", "hold"],
      config: {
        type: "persistent",
        visibility: "unlisted",
        mechanism: "plurality",
        auth: "token_only",
        quorum: 1,
        voting_window: 120,
        settle_window: 0,
        early_close: true,
      },
    });

    // Resolve the lone decision (creator is the only eligible chooser).
    await client.post<{ ok: true }>(
      `/api/rooms/${room.slug}/choose`,
      { choice: "ship" },
      room.creator_token,
    );

    // Close with a closing statement (creator-only default authority).
    const closed = await client.post<{
      ok: true;
      concluded_at: string;
      receipt_hash: string;
      prev_hash: string | null;
    }>(
      `/api/rooms/${room.slug}/close`,
      { statement: "Shipped. Closing this room." },
      room.creator_token,
    );
    if (!closed.receipt_hash?.startsWith("sha256:")) {
      throw new Error("close did not return a sha256 receipt_hash");
    }

    // Status is terminal and the brief says so.
    const view = await client.get<AgentRoomView>(`/api/rooms/${room.slug}`, room.creator_token);
    if (view.status !== "concluded") {
      throw new Error(`expected status concluded; got ${view.status}`);
    }
    if (!view.brief.toLowerCase().includes("room closed") || !view.brief.includes("read-only")) {
      throw new Error("concluded room brief does not identify the room as closed and read-only");
    }

    // The outcome carries the conclusion block, chain-terminated.
    const outcome = await client.get<
      OutcomeResponse & {
        conclusion: { receipt_hash: string | null; prev_hash: string | null } | null;
      }
    >(`/api/rooms/${room.slug}/outcome`, room.creator_token);
    if (!outcome.conclusion) throw new Error("outcome missing conclusion block");
    if (outcome.conclusion.prev_hash !== outcome.decisions.at(-1)?.receipt_hash) {
      throw new Error("conclusion prev_hash does not chain to the final decision receipt_hash");
    }

    // Every mutating verb rejects with a self-healing message.
    for (const [path, body] of [
      [`/api/rooms/${room.slug}/discuss`, { body: "hello?" }],
      [`/api/rooms/${room.slug}/choose`, { choice: "hold" }],
      [`/api/rooms/${room.slug}/ask`, { question: "again?", options: ["a", "b"] }],
    ] as const) {
      const res = await client.postRaw(path, body, room.creator_token);
      if (res.ok) throw new Error(`expected concluded room to reject POST ${path}`);
    }
  });
}

async function runRoomSpeechProbe(target: string): Promise<void> {
  return withRestProbe(target, async (client) => {
    const suffix = new Date().toISOString();

    const room = await client.createRoom({
      question: `GRP conformance room speech ${suffix}`,
      options: [],
      config: {
        type: "persistent",
        visibility: "unlisted",
        mechanism: "plurality",
        auth: "token_only",
        quorum: 1,
        voting_window: 120,
        settle_window: 0,
        early_close: true,
        creator_votes: false,
      },
      defer_first_decision: true,
    });

    const joined = await client.post<JoinResponse>(`/api/rooms/${room.slug}/join`, {
      display_name: "speech-probe",
    });

    // Spec 052 §2.1 — a deferred room accepts discussion BEFORE its first
    // decision (room-scoped speech).
    await client.post<{ ok: true; id: string }>(
      `/api/rooms/${room.slug}/discuss`,
      { body: "Pre-ballot context: room speech works before the first decision." },
      joined.participant_token,
    );

    // Spec 052 §2.5 — send/receive: option bytes round-trip verbatim. The
    // protocol makes no comparison beyond byte equality: two options differing
    // only by case are two options.
    const opened = await client.post<{ ok: true; decision: { options: string[] } }>(
      `/api/rooms/${room.slug}/ask`,
      {
        question: "Which move?",
        options: ["Nd5", "nd5"],
      },
      room.creator_token,
    );
    if (opened.decision.options[0] !== "Nd5" || opened.decision.options[1] !== "nd5") {
      throw new Error("option bytes did not round-trip verbatim");
    }

    await client.post<{ ok: true }>(
      `/api/rooms/${room.slug}/choose`,
      { choice: "nd5" },
      joined.participant_token,
    );
    const after = await client.get<AgentRoomView>(
      `/api/rooms/${room.slug}`,
      joined.participant_token,
    );
    if (after.decided.at(-1)?.winner !== "nd5") {
      throw new Error(
        `expected the exact bytes voted to win; got ${String(after.decided.at(-1)?.winner)}`,
      );
    }
  });
}

async function runChoiceRevisionProbe(target: string): Promise<void> {
  return withRestProbe(target, async (client) => {
    const suffix = new Date().toISOString();

    const room = await client.createRoom({
      question: `GRP conformance choice revision ${suffix}`,
      options: ["x", "y"],
      config: {
        visibility: "unlisted",
        mechanism: "plurality",
        auth: "token_only",
        quorum: 2,
        voting_window: 120,
        settle_window: 0,
        early_close: true,
        creator_votes: false,
      },
    });

    const p1 = await client.post<JoinResponse>(`/api/rooms/${room.slug}/join`, {
      display_name: "revision-probe-1",
    });
    const p2 = await client.post<JoinResponse>(`/api/rooms/${room.slug}/join`, {
      display_name: "revision-probe-2",
    });

    // First-of-two choices determines nothing — revision must be accepted.
    await client.post<{ ok: true }>(
      `/api/rooms/${room.slug}/choose`,
      { choice: "x" },
      p1.participant_token,
    );
    await client.post<{ ok: true }>(
      `/api/rooms/${room.slug}/choose`,
      { choice: "y" },
      p1.participant_token,
    );

    // The second voter completes the electorate; the outcome locks and the
    // room resolves counting the REVISED ballot.
    await client.post<{ ok: true }>(
      `/api/rooms/${room.slug}/choose`,
      { choice: "y" },
      p2.participant_token,
    );
    const after = await client.get<AgentRoomView>(`/api/rooms/${room.slug}`, p1.participant_token);
    if (after.status !== "resolved") {
      throw new Error(`expected room resolved after locking choice; got ${after.status}`);
    }
    if (after.decided.at(-1)?.winner !== "y") {
      throw new Error(
        `expected revised ballot to count (winner y); got ${String(after.decided.at(-1)?.winner)}`,
      );
    }

    // Post-lock the choice set is immutable.
    const rejected = await client.postRaw(
      `/api/rooms/${room.slug}/choose`,
      { choice: "x" },
      p1.participant_token,
    );
    if (rejected.ok) {
      throw new Error("expected post-resolution choice revision to be rejected");
    }
  });
}

export async function runRestLifecycleProbe(
  target: string,
  options: { allowWrites?: boolean } = {},
): Promise<void> {
  if (options.allowWrites !== true) {
    throw new Error("REST lifecycle probe creates and deletes a room; set allowWrites: true");
  }
  return withRestProbe(target, async (client) => {
    const suffix = new Date().toISOString();

    const room = await client.createRoom({
      question: `GRP conformance REST lifecycle ${suffix}`,
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
    assertString(room.slug, "create response slug");
    assertString(room.creator_token, "create response creator_token");

    const joined = await client.post<JoinResponse>(`/api/rooms/${room.slug}/join`, {
      display_name: "grp-conformance-agent",
    });
    assertString(joined.participant_token, "join response participant_token");
    assertString(joined.participant_id, "join response participant_id");

    const initial = await client.get<AgentRoomView>(
      `/api/rooms/${room.slug}`,
      joined.participant_token,
    );
    if (initial.slug !== room.slug) throw new Error("room state slug mismatch");
    assertString(initial.brief, "agent view brief");
    if (typeof initial.rules?.how_to_choose !== "string") {
      throw new Error("agent view missing rules.how_to_choose");
    }
    const opts = initial.decision?.options ?? [];
    if (!opts.includes("approve") || !opts.includes("reject")) {
      throw new Error("agent view active decision missing initial options");
    }

    const discussionBody = { body: "Conformance probe discussion.", stance: "agree" };
    const idempotencyKey = `grp-conformance-${room.slug}`;
    const discussion = await client.post<{ ok: true; id: string }>(
      `/api/rooms/${room.slug}/discuss`,
      discussionBody,
      joined.participant_token,
      { "idempotency-key": idempotencyKey },
    );
    const replayed = await client.post<{ ok: true; id: string }>(
      `/api/rooms/${room.slug}/discuss`,
      discussionBody,
      joined.participant_token,
      { "idempotency-key": idempotencyKey },
    );
    if (replayed.id !== discussion.id) {
      throw new Error("Idempotency-Key replay created a second discussion record");
    }
    const conflict = await client.postRaw(
      `/api/rooms/${room.slug}/discuss`,
      { body: "Different body under the same idempotency key." },
      joined.participant_token,
      { "idempotency-key": idempotencyKey },
    );
    if (conflict.status !== 409) {
      throw new Error(`Idempotency-Key body conflict should return 409; got ${conflict.status}`);
    }

    const events = await client.get<{ events: Array<{ event_type: string }> }>(
      `/api/rooms/${room.slug}/events?since_seq=0`,
      joined.participant_token,
    );
    if (!events.events.some((event) => event.event_type === "discussion.posted")) {
      throw new Error("event replay did not include the posted discussion");
    }

    const proposed = await client.post<{ accepted: boolean; options: string[] }>(
      `/api/rooms/${room.slug}/options`,
      {
        option: "abstain",
      },
      joined.participant_token,
    );
    if (proposed.accepted !== true) {
      throw new Error("option proposal did not return accepted=true");
    }
    if (!proposed.options.includes("abstain")) {
      throw new Error("option proposal response missing proposed option");
    }

    const completion = client.get<{ status: string }>(
      `/api/rooms/${room.slug}/next-action?wait=5&for=completion`,
      joined.participant_token,
      8_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    const choice = await client.post<{
      ok: true;
      status?: string;
      resolved_winner?: string | null;
      resolved_outcome?: string | null;
    }>(
      `/api/rooms/${room.slug}/choose`,
      { choice: "approve", rationale: "Conformance probe choice." },
      joined.participant_token,
    );
    if (choice.ok !== true) throw new Error("choose did not return ok=true");
    if ((await completion).status !== "actionable") {
      throw new Error("long-poll completion wait did not wake as actionable");
    }

    const afterVote = await client.get<AgentRoomView>(
      `/api/rooms/${room.slug}`,
      joined.participant_token,
    );
    if (afterVote.status !== "resolved") {
      throw new Error(`expected early-close room to resolve after choice; got ${afterVote.status}`);
    }
    // Spec 051 F26 — a resolved decision must never present as live: the
    // decision block is for open ballots only and the brief must not say
    // "Deciding now" about a finished one.
    if (afterVote.decision !== null) {
      throw new Error("resolved room still presents an active decision block");
    }
    if (afterVote.brief.includes("Deciding now")) {
      throw new Error(`resolved room brief still says Deciding now: ${afterVote.brief}`);
    }
    const lastDecided = afterVote.decided.at(-1);
    if (lastDecided?.winner !== "approve") {
      throw new Error(`expected decided winner approve; got ${String(lastDecided?.winner)}`);
    }

    const outcome = await client.get<OutcomeResponse>(
      `/api/rooms/${room.slug}/outcome`,
      joined.participant_token,
    );
    if (outcome.status !== "resolved") {
      throw new Error(`expected resolved outcome; got ${outcome.status}`);
    }
    if (outcome.resolved_winner !== "approve") {
      throw new Error(`expected outcome winner approve; got ${String(outcome.resolved_winner)}`);
    }
    const head = outcome.decisions.at(-1);
    if (!head?.receipt_hash?.startsWith("sha256:")) {
      throw new Error("outcome missing sha256 receipt_hash");
    }
    await verifyOutcomeReceipt(client, outcome);

    const roomPage = await client.getTextUrl(room.url);
    const embedded = roomPage.match(
      /<script[^>]+type=["']application\/grp\+json["'][^>]*>([\s\S]*?)<\/script>/i,
    );
    if (!embedded?.[1]) {
      throw new Error("shared room URL is missing embedded application/grp+json state");
    }
    const embeddedState = JSON.parse(embedded[1]) as { slug?: unknown };
    if (embeddedState.slug !== room.slug) {
      throw new Error("embedded application/grp+json state has the wrong room slug");
    }
  });
}

class RestProbeClient {
  private readonly rooms: Array<{ slug: string; creatorToken: string }> = [];

  constructor(private readonly target: string) {}

  async get<T>(
    path: string,
    token?: string,
    timeoutMs?: number,
    headers?: Record<string, string>,
  ): Promise<T> {
    return this.request<T>("GET", path, undefined, token, headers, timeoutMs);
  }

  async getRaw(
    path: string,
    token?: string,
    headers: Record<string, string> = {},
  ): Promise<{ ok: boolean; status: number; payload: unknown }> {
    const response = await fetch(new URL(path, this.target), {
      headers: this.headers(token, headers),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, payload };
  }

  async post<T>(
    path: string,
    body: unknown,
    token?: string,
    headers?: Record<string, string>,
  ): Promise<T> {
    return this.request<T>("POST", path, body, token, headers);
  }

  async createRoom(body: unknown): Promise<RoomCreateResponse> {
    const room = await this.post<RoomCreateResponse>("/api/rooms", body);
    assertString(room.slug, "create response slug");
    assertString(room.creator_token, "create response creator_token");
    this.rooms.push({ slug: room.slug, creatorToken: room.creator_token });
    return room;
  }

  // Raw POST that does not throw on non-2xx — for probes asserting rejection.
  async postRaw(
    path: string,
    body: unknown,
    token?: string,
    headers: Record<string, string> = {},
  ): Promise<{ ok: boolean; status: number; payload: unknown }> {
    const response = await fetch(new URL(path, this.target), {
      method: "POST",
      headers: this.headers(token, headers),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, payload };
  }

  async getTextUrl(url: string): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`GET ${url} returned ${response.status}`);
    }
    return body;
  }

  async cleanup(): Promise<void> {
    const failures: string[] = [];
    for (const room of this.rooms.reverse()) {
      try {
        const response = await fetch(new URL(`/api/rooms/${room.slug}`, this.target), {
          method: "DELETE",
          headers: this.headers(room.creatorToken, { "x-confirm-delete": room.slug }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          failures.push(`${room.slug}: HTTP ${response.status}`);
        }
      } catch (error) {
        failures.push(`${room.slug}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`failed to delete conformance room(s): ${failures.join("; ")}`);
    }
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    token?: string,
    headers?: Record<string, string>,
    timeoutMs = 10_000,
  ): Promise<T> {
    const init: RequestInit = {
      method,
      headers: this.headers(token, headers),
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const response = (await fetch(new URL(path, this.target), init)) as JsonResponse;
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`${method} ${path} returned ${response.status}: ${JSON.stringify(payload)}`);
    }
    return payload as T;
  }

  private headers(token?: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    };
  }
}

async function withRestProbe<T>(
  target: string,
  run: (client: RestProbeClient) => Promise<T>,
): Promise<T> {
  const client = new RestProbeClient(target);
  let result: T | undefined;
  let primaryError: unknown;
  try {
    result = await run(client);
  } catch (error) {
    primaryError = error;
  }
  try {
    await client.cleanup();
  } catch (cleanupError) {
    if (primaryError) {
      throw new Error(
        `${primaryError instanceof Error ? primaryError.message : String(primaryError)}; cleanup also failed: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`,
      );
    }
    throw cleanupError;
  }
  if (primaryError) throw primaryError;
  return result as T;
}

async function verifyOutcomeReceipt(
  client: RestProbeClient,
  outcome: OutcomeResponse,
): Promise<void> {
  const head = outcome.decisions.at(-1);
  if (!head?.receipt_jws || !head.receipt_hash) {
    throw new Error("outcome does not contain a signed receipt");
  }
  if (computeJwsReceiptHash(head.receipt_jws) !== head.receipt_hash) {
    throw new Error("receipt_hash does not match the exact compact JWS bytes");
  }
  const jwksUrl = outcome.verification?.jwks_url;
  if (!jwksUrl) throw new Error("outcome is missing verification.jwks_url");
  const jwks = await client.get<{ keys?: Array<Record<string, unknown>> }>(jwksUrl);
  const decoded = decodeCompactJwsUnverified(head.receipt_jws);
  const kid = decoded.header.kid;
  const key = jwks.keys?.find((candidate) => candidate.kid === kid);
  if (
    !key ||
    key.kty !== "OKP" ||
    key.crv !== "Ed25519" ||
    key.alg !== "EdDSA" ||
    typeof key.x !== "string"
  ) {
    throw new Error(`verification JWKS is missing Ed25519 key ${String(kid)}`);
  }
  await verifyCompactJws({ jws: head.receipt_jws, publicKey: base64urlDecode(key.x) });
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}
