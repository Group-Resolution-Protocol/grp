import * as ed25519 from "@noble/ed25519";

export {
  type AgreementReceiptVerification,
  verifyAgreementReceiptSemantics,
} from "./agreement-receipt.js";

export const SDK_VERSION = "0.1.0";

export type GrpAuth =
  | { kind: "token"; token: string }
  | { kind: "mandate"; mandate: string }
  | { kind: "bearer"; token: string }
  | { kind: "hosted"; accessToken: string; mandate: string };

export interface GrpClientOptions {
  baseUrl: string;
  token?: string;
  mandate?: string;
  accessToken?: string;
  fetch?: typeof fetch;
  /** End-to-end request deadline, including response body. Default 45s. */
  requestTimeoutMs?: number;
  /** Maximum JSON response body. Default 2 MiB. */
  maxResponseBytes?: number;
}

export interface ClientOptions {
  baseUrl: string;
  /** Capability-scoped human key (`ak_*`) or restricted agent key (`rk_*`). */
  apiKey: string;
}

export interface DiscoveryDocument {
  protocol_version: string;
  issuer_id: string;
  name: string;
  purpose: string;
  transports: {
    rest: string;
    mcp: string;
    mcp_protocol_versions?: string[];
    a2a?: string;
  };
  keys: Array<{ kid: string; kty: "OKP"; crv: "Ed25519"; alg: "EdDSA"; x: string }>;
  conformance?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  checks: Record<string, "ok" | "skipped" | "error">;
}

export interface AuthorityConfig {
  kind: "none" | "operator" | "designated" | "any_participant";
  participant_ids?: string[];
}

export interface RoomConfig {
  visibility?: "public" | "unlisted" | "private";
  mechanism?: "simple_majority" | "approval" | "ranked_choice" | string;
  invite_authority?: AuthorityConfig;
  option_proposal_authority?: AuthorityConfig;
  decision_opening_authority?: AuthorityConfig;
  conclusion_authority?: AuthorityConfig;
  auth?: "token_only" | "mandate_required" | "either";
  quorum?: number | null;
  threshold?: number;
  voting_window?: number;
  deliberation_mode?: "optional" | "disabled";
  max_participants?: number | null;
  max_options?: number;
  max_deliberation_messages_per_participant?: number;
  max_total_deliberation_messages?: number;
  read_receipts?: boolean;
  choice_visibility?: "after_decided" | "live" | "never";
  early_close?: boolean;
  /** Spec 115 — seconds a determined outcome settles before sealing (0 = instant). */
  settle_window?: number;
  /** Spec 142 — concurrent open decisions the room may hold (default 1; host ceiling applies). */
  max_open_decisions?: number;
  creator_votes?: boolean;
  [key: string]: unknown;
}

export interface RoomSettingsPatch {
  invite_authority?: AuthorityConfig;
  option_proposal_authority?: AuthorityConfig;
  decision_opening_authority?: AuthorityConfig;
  conclusion_authority?: AuthorityConfig;
  auth?: "token_only" | "mandate_required" | "either";
  quorum?: number | null;
  voting_window?: number;
  deliberation_mode?: "optional" | "disabled";
  max_participants?: number | null;
  max_options?: number;
  max_deliberation_messages_per_participant?: number;
  max_total_deliberation_messages?: number;
  read_receipts?: boolean;
  choice_visibility?: "after_decided" | "live" | "never";
  early_close?: boolean;
  /** Spec 115 — seconds a determined outcome settles before sealing (0 = instant). */
  settle_window?: number;
  /** Spec 142 — concurrent open decisions the room may hold (default 1; host ceiling applies). */
  max_open_decisions?: number;
  creator_votes?: boolean;
}

export interface CreateRoomRequest {
  about?: string | null;
  question?: string;
  context?: string | null;
  options?: string[];
  config?: RoomConfig;
  password?: string;
  defer_first_decision?: boolean;
}

export interface CreateRoomResponse {
  slug: string;
  url: string;
  creator_token: string;
  about?: string | null;
  voting_ends_at: string | null;
  config: RoomConfig;
  owner_principal_id: string | null;
  expires_at: string | null;
}

export interface JoinRoomRequest {
  slug: string;
  /** How the room and other agents refer to you. */
  display_name?: string;
  password?: string;
  invite?: string;
  auth?: GrpAuth;
}

export interface JoinRoomResponse {
  participant_id: string;
  /** Null for mandate-bound joins — the mandate is the credential. */
  participant_token: string | null;
  agent_did?: string;
  role?: InviteRole;
}

export type InviteRole = "participant" | "observer";
export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";
export type InviteBindingKind = "token" | "email" | "account" | "principal" | "sso_subject";

export interface InviteBinding {
  kind: InviteBindingKind;
  value: string | null;
}

export interface RoomInvite {
  code: string;
  label: string;
  role: InviteRole;
  expected: boolean;
  status: InviteStatus;
  created_at: string;
  expires_at: string | null;
  accepted_at: string | null;
  accepted_participant_id: string | null;
  revoked_at: string | null;
  /** Spec 106 — the one wire shape for invite bindings. */
  binding: InviteBinding;
}

export interface CreateInviteRequest {
  slug: string;
  label: string;
  role?: InviteRole;
  expected?: boolean;
  expires_at?: string;
  /** Spec 106 — the one binding input shape. */
  binding?: InviteBinding;
  auth?: GrpAuth;
}

export interface CreateInviteResponse {
  slug: string;
  about?: string | null;
  invite: RoomInvite;
  invite_token: string;
  join_url: string;
  join_command: string;
  /** Spec 111 — self-grounding invite artifact; relay to the recipient intact. */
  paste_block?: string;
}

export interface UpdateRoomSettingsRequest {
  slug: string;
  token?: string;
  settings: RoomSettingsPatch;
  auth?: GrpAuth;
}

export interface UpdateRoomSettingsResponse {
  slug: string;
  config: RoomConfig;
  changed: string[];
}

export interface DecisionSummary {
  id: string;
  seq: number;
  question: string;
  context: string | null;
  options: string[];
  eligible_participant_ids?: string[] | null;
  voting_opens_at?: string | null;
  voting_ends_at: string;
  resolved_at: string | null;
  resolved_outcome?: string | null;
  resolved_winner: string | null;
  prev_hash: string | null;
  receipt_hash: string | null;
  status: string;
  /** Resolves only when every eligible voter accepts the same option. */
  agreement?: boolean;
  /** Spec 118 — the propose guard's truth: fluid decisions keep taking
   * proposals while choices are open; slate decisions freeze at voting. */
  proposals_open?: boolean;
  /** Spec 118 — proposer display names aligned with `options`; null entries
   * are creator-seeded. Present on full room reads. */
  option_proposers?: (string | null)[] | null;
}

export interface RoomState {
  slug: string;
  about?: string | null;
  question: string;
  context: string | null;
  options: string[];
  voting_ends_at: string;
  created_at: string;
  resolved_at: string | null;
  resolved_outcome: string | null;
  resolved_winner: string | null;
  resolution_payload: unknown;
  config: RoomConfig;
  participant_count: number;
  /** Spec 128 — how many participants' choices the active decision counts. */
  eligible_voters: number;
  vote_count: number;
  status: "open" | "proposing" | "voting" | "resolved" | "expired" | "concluded";
  /** Spec 052 — set when the room concluded and its receipt chain terminated. */
  concluded_at: string | null;
  closing_statement: string | null;
  /** Spec 119 — the room's head event seq at read time: this read is a
   * complete picture through this seq (advance any delta mark here). */
  current_through?: number;
  active_decision_id: string | null;
  decisions: DecisionSummary[];
  participants: Array<{
    id: string;
    display_name: string | null;
    joined_at: string;
    last_seen_at: string | null;
    deliberated_at: string | null;
    voted_at: string | null;
    agent_did: string | null;
    mandate_id: string | null;
    role?: InviteRole;
  }>;
  invites?: RoomInvite[];
  /** Spec 174 — the wire key is `discussion` (the SDK previously declared a
   * phantom `deliberation` field that no response ever carried). */
  discussion: Array<{
    id: string;
    participant_id: string;
    body: string;
    stance: string | null;
    posted_at: string;
    decision_id: string | null;
  }>;
  votes_visible_during: boolean;
  votes: Array<{
    participant_id: string;
    choice: string;
    rationale: string | null;
    cast_at: string;
  }> | null;
  /** Spec 167 — deliberate abstentions on the active decision. */
  abstentions: Array<{
    participant_id: string;
    reason: string;
    declared_at: string;
  }>;
}

/** Spec 113 — one rendered activity entry in a delta read (`new`). */
export interface RoomDeltaEntry {
  seq: number;
  type:
    | "discussion"
    | "option_proposed"
    | "decision_opened"
    | "choosing_started"
    | "choice_submitted"
    | "abstained"
    | "decision_resolved"
    | "joined"
    | "role_updated"
    | "invite_created"
    | "room_concluded";
  at: string;
  [key: string]: unknown;
}

/** Spec 113 — the anchored delta returned by GET /api/rooms/{slug}?since=N.
 * Spec 174 — brought in line with the wire: the delta diet (spec 117) serves
 * one thin `state` line, not the agent view's `about`/`brief`, and
 * `your_status` rides only when the room owes the viewer a choice. */
export interface RoomDelta {
  slug: string;
  status: "open" | "proposing" | "voting" | "resolved" | "expired" | "concluded";
  /** Present only when the viewer's role is not the participant default. */
  role?: InviteRole;
  agent: string;
  /** Spec 117 — the one-line live state (progress + clock). */
  state: string;
  /** Present only when the room currently owes the viewer a choice. */
  your_status?: string;
  new: RoomDeltaEntry[];
  current_through: number;
  more: Record<string, string>;
}

export interface AskRequest {
  slug: string;
  question: string;
  context?: string | null;
  options: string[];
  eligible?: string[];
  eligible_participant_ids?: string[];
  voting_window?: number;
  proposal_window?: number;
  /** Resolve only on unanimous acceptance; disagreement stays open. */
  agreement?: boolean;
  auth?: GrpAuth;
}

export interface AskResponse {
  ok: true;
  slug: string;
  decision: {
    id: string;
    seq: number;
    question: string;
    context: string | null;
    options: string[];
    eligible_participant_ids?: string[] | null;
    voting_opens_at?: string | null;
    voting_ends_at: string;
    prev_hash: string | null;
    status: string;
    agreement?: boolean;
  };
}

export interface StartChoosingRequest {
  slug: string;
  decision_id?: string;
  auth?: GrpAuth;
}

export interface StartChoosingResponse {
  ok: true;
  slug: string;
  decision: {
    id: string;
    seq: number;
    options: string[];
    voting_opens_at: string | null;
    voting_ends_at: string;
    status: string;
  };
}

export interface CloseRoomRequest {
  slug: string;
  statement?: string | null;
  auth?: GrpAuth;
}

export interface CloseRoomResponse {
  ok: true;
  slug: string;
  concluded_at: string;
  receipt_hash: string;
  prev_hash: string | null;
}

export interface AwaitNextActionRequest {
  slug: string;
  token?: string;
  wait?: number;
  since_seq?: number;
  /** Spec 106 — `my_choice` is canonical (`my_vote` remains a server-side compat alias). */
  /**
   * Spec 114 — `activity` (with `since_seq` as an EVENT-seq cursor) returns
   * on the first substantive event by someone else, or the instant a
   * decision needs your choice, whichever comes first.
   */
  for?: "my_choice" | "completion" | "activity";
}

export type AwaitNextActionResponse =
  | {
      status: "actionable";
      for: "my_choice" | "completion" | "activity";
      decision: {
        id: string;
        seq: number;
        question: string;
        options: string[];
        voting_ends_at: string;
        status: string;
        agreement?: boolean;
      };
      /** Spec 142 (D8) — the caller's other owed decisions in this room
       * (present only when max_open_decisions > 1 and more than one is owed). */
      also_actionable?: Array<{
        id: string;
        seq: number;
        question: string;
        voting_ends_at: string;
        status: string;
        agreement?: boolean;
      }>;
    }
  | {
      status: "activity";
      /** Pointer to the waking event; follow with readDelta for the content. */
      event: { seq: number; type: string; who: string | null };
    }
  | { status: "timeout"; next_poll_at: string };

export interface DiscussRequest {
  slug: string;
  body: string;
  stance?: string;
  /** Spec 141 — optional decision selector: the room-local decision number (seq). */
  decision?: number;
  auth?: GrpAuth;
}

export interface ProposeRequest {
  slug: string;
  option: string;
  /** Spec 141 — optional decision selector: the room-local decision number (seq). */
  decision?: number;
  auth?: GrpAuth;
}

export interface ChooseRequest {
  slug: string;
  choice: string | string[] | Record<string, number>;
  /** Optional explanation for this choice. */
  reason?: string;
  rationale?: string;
  /** Spec 141 — optional decision selector: the room-local decision number (seq). */
  decision?: number;
  auth?: GrpAuth;
}

export interface ChooseResponse {
  ok: true;
  slug: string;
  cast_choice: string | string[] | Record<string, number>;
  status?: string;
  resolved_winner: string | null;
  resolved_outcome: string | null;
  agreement?: boolean;
}

export interface AbstainRequest {
  slug: string;
  reason: string;
  /** Spec 141 — optional room-local decision number. */
  decision?: number;
  auth?: GrpAuth;
}

export interface AbstainResponse {
  ok: true;
  slug: string;
  abstained: true;
  reason: string;
  status?: string;
  resolved_winner: string | null;
  resolved_outcome: string | null;
}

export interface RoomReceipt {
  slug: string;
  question: string;
  context?: string | null;
  options: string[];
  status: string;
  resolved_at: string | null;
  resolved_outcome: string | null;
  resolved_winner: string | null;
  resolution_payload: unknown;
  created_at: string;
  /** Where a verifier finds the operator JWKS. Null on unsigned deployments. */
  verification?: { jwks_url: string } | null;
  /** Chain-terminating conclusion when the room has closed. Null otherwise. */
  conclusion?: {
    concluded_at: string;
    closing_statement: string | null;
    receipt_hash: string | null;
    prev_hash: string | null;
    receipt_jws: string | null;
  } | null;
  decisions: Array<{
    seq: number;
    question: string;
    context?: string | null;
    resolved_winner: string | null;
    prev_hash: string | null;
    receipt_hash: string | null;
    receipt_jws?: string | null;
    agreement?: boolean;
  }>;
}

export type RoomOutcome = RoomReceipt;

export interface RoomEvent {
  id: string;
  seq: number;
  event_type: "decision.opened" | "decision.voting_phase_started" | "decision.completed" | string;
  occurred_at: string;
  decision_id: string | null;
  data: Record<string, unknown>;
}

export interface RegisterWebhookRequest {
  slug: string;
  url: string;
  event_types?: string[];
  auth?: GrpAuth;
}

export class GrpError extends Error {
  /** Optional next-action hint from the canonical error envelope (spec 106). */
  readonly hint?: string;

  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
    hint?: string,
  ) {
    super(message);
    this.name = "GrpError";
    if (hint !== undefined) this.hint = hint;
  }
}

export class GrpTransportError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GrpTransportError";
  }
}

export class GrpClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultAuth?: GrpAuth;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: GrpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs = positiveBound(options.requestTimeoutMs, 45_000);
    this.maxResponseBytes = positiveBound(options.maxResponseBytes, 2 * 1024 * 1024);
    if (options.accessToken && options.mandate) {
      this.defaultAuth = {
        kind: "hosted",
        accessToken: options.accessToken,
        mandate: options.mandate,
      };
    } else if (options.mandate) {
      this.defaultAuth = { kind: "mandate", mandate: options.mandate };
    } else if (options.token) {
      this.defaultAuth = { kind: "token", token: options.token };
    }
  }

  discover(): Promise<DiscoveryDocument> {
    return this.request("/.well-known/grp.json");
  }

  health(): Promise<HealthResponse> {
    return this.request("/healthz");
  }

  createRoom(input: CreateRoomRequest): Promise<CreateRoomResponse> {
    return this.request("/api/rooms", { method: "POST", body: input });
  }

  joinRoom(input: JoinRoomRequest): Promise<JoinRoomResponse> {
    return this.request(`/api/rooms/${encodeURIComponent(input.slug)}/join`, {
      method: "POST",
      auth: input.auth,
      body: withoutUndefined({
        display_name: input.display_name,
        password: input.password,
        invite: input.invite,
      }),
    });
  }

  createInvite(input: CreateInviteRequest): Promise<CreateInviteResponse> {
    return this.request(`/api/rooms/${encodeURIComponent(input.slug)}/invites`, {
      method: "POST",
      auth: input.auth,
      body: withoutUndefined({
        label: input.label,
        role: input.role,
        expected: input.expected,
        expires_at: input.expires_at,
        binding: input.binding,
      }),
    });
  }

  listInvites(input: { slug: string; token?: string; auth?: GrpAuth }): Promise<{
    slug: string;
    invites: RoomInvite[];
  }> {
    return this.request(`/api/rooms/${encodeURIComponent(input.slug)}/invites`, {
      auth: tokenOverride(input.token, input.auth),
    });
  }

  revokeInvite(input: {
    slug: string;
    code: string;
    token?: string;
    auth?: GrpAuth;
  }): Promise<{ slug: string; invite: RoomInvite }> {
    return this.request(
      `/api/rooms/${encodeURIComponent(input.slug)}/invites/${encodeURIComponent(input.code)}`,
      {
        method: "DELETE",
        auth: tokenOverride(input.token, input.auth),
      },
    );
  }

  updateRoomSettings(input: UpdateRoomSettingsRequest): Promise<UpdateRoomSettingsResponse> {
    return this.request(`/api/rooms/${encodeURIComponent(input.slug)}/settings`, {
      method: "PATCH",
      auth: tokenOverride(input.token, input.auth),
      body: {
        settings: input.settings,
      },
    });
  }

  getRoom(slug: string, token?: string, password?: string): Promise<RoomState> {
    // Spec 106 — the default read is the windowed agent view; the SDK's typed
    // RoomState is the complete state, so request it explicitly.
    return this.request(`/api/rooms/${encodeURIComponent(slug)}`, {
      auth: tokenOverride(token),
      headers: roomPasswordHeaders(password),
      query: { include: "full" },
    });
  }

  /** Spec 113 — anchored delta read: everything substantive after event seq
   * `since`, plus the room brief and the caller's own standing. Stateless —
   * pass the response's `current_through` as the next `since`. */
  readDelta(slug: string, since: number, token?: string, password?: string): Promise<RoomDelta> {
    return this.request(`/api/rooms/${encodeURIComponent(slug)}`, {
      auth: tokenOverride(token),
      headers: roomPasswordHeaders(password),
      query: { since },
    });
  }

  ask(input: AskRequest): Promise<AskResponse> {
    return this.request(`/api/rooms/${encodeURIComponent(input.slug)}/ask`, {
      method: "POST",
      auth: input.auth,
      body: withoutUndefined({
        question: input.question,
        context: input.context,
        options: input.options,
        eligible: input.eligible,
        eligible_participant_ids: input.eligible_participant_ids,
        voting_window: input.voting_window,
        proposal_window: input.proposal_window,
        agreement: input.agreement,
      }),
    });
  }

  startChoosing(input: StartChoosingRequest): Promise<StartChoosingResponse> {
    return this.request(`/api/rooms/${encodeURIComponent(input.slug)}/start-choosing`, {
      method: "POST",
      auth: input.auth,
      body: withoutUndefined({
        decision_id: input.decision_id,
      }),
    });
  }

  closeRoom(input: CloseRoomRequest): Promise<CloseRoomResponse> {
    return this.request(`/api/rooms/${encodeURIComponent(input.slug)}/close`, {
      method: "POST",
      auth: input.auth,
      body: withoutUndefined({
        statement: input.statement,
      }),
    });
  }

  listDecisions(
    slug: string,
    token?: string,
    password?: string,
  ): Promise<{ slug: string; decisions: DecisionSummary[] }> {
    return this.request(`/api/rooms/${encodeURIComponent(slug)}/decisions`, {
      auth: tokenOverride(token),
      headers: roomPasswordHeaders(password),
    });
  }

  awaitNextAction(input: AwaitNextActionRequest): Promise<AwaitNextActionResponse> {
    return this.request(`/api/rooms/${encodeURIComponent(input.slug)}/next-action`, {
      auth: tokenOverride(input.token),
      query: withoutUndefined({
        wait: input.wait,
        since_seq: input.since_seq,
        for: input.for,
      }),
    });
  }

  discuss(input: DiscussRequest): Promise<{ ok: true; id: string }> {
    return this.request(`/api/rooms/${encodeURIComponent(input.slug)}/discuss`, {
      method: "POST",
      auth: input.auth,
      body: withoutUndefined({
        body: input.body,
        stance: input.stance,
        decision: input.decision,
      }),
    });
  }

  propose(
    input: ProposeRequest,
  ): Promise<{ accepted: boolean; options: string[]; choosing_open?: boolean }> {
    return this.request(`/api/rooms/${encodeURIComponent(input.slug)}/options`, {
      method: "POST",
      auth: input.auth,
      body: withoutUndefined({
        option: input.option,
        decision: input.decision,
      }),
    });
  }

  choose(input: ChooseRequest): Promise<ChooseResponse> {
    const rationale = input.reason ?? input.rationale;
    return this.request(`/api/rooms/${encodeURIComponent(input.slug)}/choose`, {
      method: "POST",
      auth: input.auth,
      body: withoutUndefined({
        choice: input.choice,
        rationale,
        decision: input.decision,
      }),
    });
  }

  abstain(input: AbstainRequest): Promise<AbstainResponse> {
    return this.request(`/api/rooms/${encodeURIComponent(input.slug)}/abstain`, {
      method: "POST",
      auth: input.auth,
      body: withoutUndefined({
        reason: input.reason,
        decision: input.decision,
      }),
    });
  }

  outcome(slug: string, token?: string, password?: string): Promise<RoomOutcome> {
    // Spec 106 — outcome reads follow the same visibility rules as room
    // reads: public rooms need no credential; unlisted/private rooms accept a
    // joined seat; password-enabled private rooms also accept the password.
    return this.request(`/api/rooms/${encodeURIComponent(slug)}/outcome`, {
      auth: tokenOverride(token),
      headers: roomPasswordHeaders(password),
    });
  }

  listEvents(input: {
    slug: string;
    token?: string;
    password?: string;
    since_seq?: number;
    since_event_id?: string;
    limit?: number;
    auth?: GrpAuth;
  }): Promise<{ slug: string; events: RoomEvent[] }> {
    return this.request(`/api/rooms/${encodeURIComponent(input.slug)}/events`, {
      auth: tokenOverride(input.token, input.auth),
      headers: roomPasswordHeaders(input.password),
      query: withoutUndefined({
        since_seq: input.since_seq,
        since_event_id: input.since_event_id,
        limit: input.limit,
      }),
    });
  }

  registerWebhook(input: RegisterWebhookRequest): Promise<{
    ok: true;
    webhook_id: string;
    signing_secret: string;
    url: string;
    event_types: string[];
  }> {
    return this.request(`/api/rooms/${encodeURIComponent(input.slug)}/webhooks`, {
      method: "POST",
      auth: input.auth,
      body: withoutUndefined({
        url: input.url,
        event_types: input.event_types,
      }),
    });
  }

  listWebhooks(input: {
    slug: string;
    token?: string;
    auth?: GrpAuth;
  }): Promise<{
    slug: string;
    webhooks: Array<{
      id: string;
      url: string;
      event_types: string[];
      created_at: string;
      disabled_at: string | null;
    }>;
  }> {
    return this.request(`/api/rooms/${encodeURIComponent(input.slug)}/webhooks`, {
      auth: tokenOverride(input.token, input.auth),
    });
  }

  unregisterWebhook(input: { slug: string; webhookId: string; token?: string; auth?: GrpAuth }) {
    return this.request<{ ok: true }>(
      `/api/rooms/${encodeURIComponent(input.slug)}/webhooks/${encodeURIComponent(input.webhookId)}`,
      {
        method: "DELETE",
        auth: tokenOverride(input.token, input.auth),
      },
    );
  }

  startDeviceAuthorization(input: {
    client_id: string;
    agent_slug?: string;
    from?: string;
    resource?: string;
    scope?: string;
  }): Promise<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  }> {
    return this.request("/oauth/device_authorization", { method: "POST", form: input });
  }

  pollDeviceToken(input: { device_code: string }): Promise<{
    access_token: string;
    token_type: "Bearer";
    scope: string;
    resource: string | null;
    mandate: string;
    public_id?: string;
  }> {
    return this.request("/oauth/token", {
      method: "POST",
      form: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: input.device_code,
      },
    });
  }

  private async request<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    const auth = init.auth ?? this.defaultAuth;
    if (auth?.kind === "token") {
      headers.set("authorization", `Bearer ${auth.token}`);
    } else if (auth?.kind === "mandate") {
      headers.set("x-mandate", auth.mandate);
    } else if (auth?.kind === "bearer") {
      headers.set("authorization", `Bearer ${auth.token}`);
    } else if (auth?.kind === "hosted") {
      headers.set("authorization", `Bearer ${auth.accessToken}`);
      headers.set("x-mandate", auth.mandate);
    }

    let body: string | undefined;
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.body);
    } else if (init.form !== undefined) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(stringRecord(init.form)).toString();
    }

    let response: Response;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`request timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
    });
    try {
      const requestInit: RequestInit = {
        method: init.method ?? "GET",
        headers,
        signal: controller.signal,
        // Never follow a server-controlled redirect with credentials attached.
        redirect: "manual",
      };
      if (body !== undefined) requestInit.body = body;
      response = await Promise.race([this.fetchImpl(url, requestInit), deadline]);
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new Error("redirect response refused");
      }
      const text = await Promise.race([
        readResponseTextBounded(response, this.maxResponseBytes),
        deadline,
      ]);
      const payload = text ? safeJson(text) : null;
      if (!response.ok) {
        throw protocolError(response.status, payload);
      }
      return payload as T;
    } catch (err) {
      if (err instanceof GrpError) throw err;
      throw new GrpTransportError(`request failed for ${safeRequestTarget(url)}`, err);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function positiveBound(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

async function readResponseTextBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response exceeded ${maxBytes} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`response exceeded ${maxBytes} bytes`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function safeRequestTarget(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  form?: Record<string, unknown>;
  query?: Record<string, unknown> | undefined;
  headers?: ConstructorParameters<typeof Headers>[0];
  auth?: GrpAuth | undefined;
}

function tokenOverride(token: string | undefined, auth?: GrpAuth): GrpAuth | undefined {
  return auth ?? (token ? { kind: "token", token } : undefined);
}

function roomPasswordHeaders(password: string | undefined): Record<string, string> | undefined {
  return password ? { "x-room-password": password } : undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function protocolError(status: number, payload: unknown): GrpError {
  if (payload && typeof payload === "object") {
    const body = payload as Record<string, unknown>;
    const error = body.error;
    if (typeof error === "string") {
      return new GrpError(
        error,
        typeof body.message === "string" ? body.message : error,
        status,
        payload,
      );
    }
    if (error && typeof error === "object") {
      const err = error as Record<string, unknown>;
      const code = typeof err.code === "string" ? err.code : `http.${status}`;
      const message = typeof err.message === "string" ? err.message : code;
      const hint = typeof err.hint === "string" ? err.hint : undefined;
      return new GrpError(code, message, status, payload, hint);
    }
  }
  return new GrpError(`http.${status}`, `HTTP ${status}`, status, payload);
}

function withoutUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(input) as Array<[keyof T, T[keyof T]]>) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function stringRecord(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) out[key] = String(value);
  }
  return out;
}

export function verifyRoomReceiptChain(receipt: RoomReceipt): {
  ok: boolean;
  diagnostics: string[];
} {
  const diagnostics: string[] = [];
  let previous: string | null = null;
  for (const decision of receipt.decisions) {
    if (decision.prev_hash !== previous) {
      diagnostics.push(
        `decision seq ${decision.seq} prev_hash ${decision.prev_hash ?? "null"} did not match previous receipt_hash ${previous ?? "null"}`,
      );
    }
    previous = decision.receipt_hash;
  }
  if (receipt.status === "resolved") {
    const head = receipt.decisions.at(-1);
    if (!head?.receipt_hash?.startsWith("sha256:")) {
      diagnostics.push("resolved receipt is missing a sha256 receipt_hash on the head decision");
    }
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

export async function verifyCompactReceipt(input: {
  jws: string;
  publicKey: Uint8Array;
  expectedHash?: string;
}): Promise<{ ok: true; header: unknown; payload: unknown; receipt_hash: string }> {
  const decoded = await verifyCompactJws(input.jws, input.publicKey);
  const receiptHash = await sha256String(input.jws);
  if (input.expectedHash && input.expectedHash !== receiptHash) {
    throw new GrpError("receipt.hash_mismatch", "receipt hash does not match expected hash", 400, {
      expected: input.expectedHash,
      actual: receiptHash,
    });
  }
  return { ok: true, header: decoded.header, payload: decoded.payload, receipt_hash: receiptHash };
}

export function publicKeyFromJwks(jwks: { keys?: unknown[] }, kid: string): Uint8Array {
  const key = jwks.keys?.find((candidate) => (candidate as { kid?: unknown })?.kid === kid);
  if (!key || typeof key !== "object") throw new GrpError("jwks.kid_missing", `missing kid ${kid}`);
  const jwk = key as Record<string, unknown>;
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new GrpError("jwks.invalid_key", `kid ${kid} is not an Ed25519 OKP public key`);
  }
  try {
    return base64urlDecode(jwk.x);
  } catch (err) {
    throw new GrpError(
      "jwks.invalid_key",
      `kid ${kid} has a noncanonical base64url public key: ${(err as Error).message}`,
    );
  }
}

export function receiptKid(jws: string): string | undefined {
  const decoded = decodeCompactJwsUnverified(jws);
  return typeof decoded.header.kid === "string" ? decoded.header.kid : undefined;
}

async function verifyCompactJws(
  jws: string,
  publicKey: Uint8Array,
): Promise<{ header: Record<string, unknown>; payload: unknown }> {
  const decoded = decodeCompactJwsUnverified(jws);
  if (decoded.header.alg !== "EdDSA") {
    throw new GrpError("jws.alg_unsupported", "only EdDSA JWS receipts are supported");
  }
  if (Object.hasOwn(decoded.header, "crit")) {
    throw new GrpError(
      "jws.critical_header_unsupported",
      "critical JWS header parameters are not supported",
    );
  }
  const dotIx = jws.lastIndexOf(".");
  let sig: Uint8Array;
  try {
    sig = base64urlDecode(jws.slice(dotIx + 1));
  } catch (err) {
    throw new GrpError(
      "jws.bad_shape",
      `receipt signature is not canonical base64url: ${(err as Error).message}`,
    );
  }
  const input = new TextEncoder().encode(jws.slice(0, dotIx));
  const ok = await ed25519.verifyAsync(sig, input, publicKey);
  if (!ok) {
    throw new GrpError("receipt.signature_invalid", "receipt signature did not verify");
  }
  return decoded;
}

function decodeCompactJwsUnverified(jws: string): {
  header: Record<string, unknown>;
  payload: unknown;
} {
  const parts = jws.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new GrpError("jws.bad_shape", "compact JWS must have three segments");
  }
  const [encodedHeader, encodedPayload] = parts as [string, string, string];
  try {
    return {
      header: JSON.parse(base64urlDecodeToString(encodedHeader)) as Record<string, unknown>,
      payload: JSON.parse(base64urlDecodeToString(encodedPayload)) as unknown,
    };
  } catch (err) {
    if (err instanceof GrpError) throw err;
    throw new GrpError(
      "jws.bad_json",
      `compact JWS JSON could not be decoded: ${(err as Error).message}`,
    );
  }
}

function base64urlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error("only the unpadded base64url alphabet is allowed");
  }
  if (value.length % 4 === 1) throw new Error("invalid base64url length");
  const bytes = new Uint8Array(Buffer.from(value, "base64url"));
  if (Buffer.from(bytes).toString("base64url") !== value) {
    throw new Error("non-canonical base64url encoding");
  }
  return bytes;
}

function base64urlDecodeToString(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

async function sha256String(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}
