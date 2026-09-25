// Public-owned candidate contract. Generate/check the JSON with the companion
// script; do not modify the published base contract or infer live conformance.
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const string = { type: "string" };
const id = { type: "string", minLength: 1 };
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const enumeration = (...values) => ({ type: "string", enum: values });
const array = (items) => ({ type: "array", items });
const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
});
const integer = { type: "integer", minimum: 0 };
const boolean = { type: "boolean" };
const timestamp = { type: "string", format: "date-time" };
const counter = { type: "string", pattern: "^[0-9]+$" };
const positive = { type: "string", pattern: "^[1-9][0-9]{0,63}$" };
const sha = { type: "string", pattern: "^[0-9a-f]{64}$" };
const ttl = { type: "integer", minimum: 30, maximum: 900, default: 300 };
const mode = enumeration("single", "handoff", "all");
const singleLine = (max) => ({
  type: "string",
  minLength: 1,
  maxLength: max,
  pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]*$",
});
const multiline = (max) => ({
  type: "string",
  minLength: 1,
  maxLength: max,
  pattern: "^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]*$",
});
const policy = enumeration("none", "advisory", "enforced");
const turnRequestId = { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$" };
const turnEpoch = { type: "string", pattern: "^[0-9]{1,30}$" };
const signalTtl = { type: "integer", minimum: 15, maximum: 300, default: 120 };
const schemas = {
  Error: object({
    error: object(
      { code: id, message: string, hint: string, request_id: string, details: { type: "object" } },
      ["code", "message"],
    ),
  }),
  TurnOperation: object(
    {
      operation: enumeration("request", "renew", "release"),
      request_id: turnRequestId,
      epoch: turnEpoch,
    },
    ["operation", "request_id"],
  ),
  SpeakingTurn: {
    ...object(
      {
        policy: { const: "speaking_turns" },
        revision: counter,
        concluded: boolean,
        holder: nullable(
          object({
            participant_id: id,
            request_id: turnRequestId,
            epoch: { type: "string", pattern: "^[1-9][0-9]*$" },
            expires_at: timestamp,
            max_until: timestamp,
          }),
        ),
        own: nullable({
          oneOf: [
            object({
              request_id: turnRequestId,
              status: { const: "queued" },
              queue_position: { type: "integer", minimum: 1 },
              expires_at: timestamp,
            }),
            object({
              request_id: turnRequestId,
              status: { const: "held" },
              queue_position: { type: "null" },
              expires_at: timestamp,
            }),
          ],
        }),
        next_deadline_at: nullable(timestamp),
        observation: nullable(id),
        target: object({
          request_id: turnRequestId,
          status: enumeration(
            "waiting",
            "granted",
            "completed",
            "released",
            "expired",
            "removed",
            "concluded",
            "missing",
          ),
        }),
      },
      ["policy", "revision", "concluded", "holder", "own", "next_deadline_at"],
    ),
    allOf: [
      {
        if: { properties: { concluded: { const: true } }, required: ["concluded"] },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword
        then: {
          properties: {
            holder: { type: "null" },
            own: { type: "null" },
            next_deadline_at: { type: "null" },
          },
        },
      },
    ],
  },
  TurnMutation: object({
    speaking_turn: {
      allOf: [ref("SpeakingTurn"), { not: { required: ["observation"] } }],
    },
  }),
  SignalScope: {
    oneOf: [
      { ...object({ kind: { const: "room" } }), not: { required: ["id"] } },
      object({
        kind: enumeration("decision", "action", "artifact"),
        id: {
          type: "string",
          pattern:
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
        },
      }),
    ],
  },
  WorkingSignal: object({
    id,
    participant_id: id,
    display_name: nullable(string),
    scope: ref("SignalScope"),
    kind: enumeration("responding", "drafting", "reviewing", "external_work"),
    summary: nullable(string),
    started_at: timestamp,
    expires_at: timestamp,
  }),
  StartWorkingSignal: object(
    {
      scope: ref("SignalScope"),
      kind: enumeration("responding", "drafting", "reviewing", "external_work"),
      summary: nullable({ ...singleLine(240), minLength: 0 }),
      ttl_seconds: signalTtl,
    },
    ["scope", "kind"],
  ),
  RenewWorkingSignal: object({ lease_token: id, ttl_seconds: signalTtl }, ["lease_token"]),
  StopWorkingSignal: object({ lease_token: id }),
  Compose: object({ ttl_seconds: signalTtl }, []),
  ComposingSignal: object({
    participant_id: id,
    display_name: nullable(string),
    started_at: timestamp,
    expires_at: timestamp,
  }),
  ActionResult: {
    oneOf: [
      {
        ...object({ kind: { const: "text" }, reference: multiline(4096) }),
        not: { required: ["note"] },
      },
      object(
        {
          kind: { const: "artifact_revision" },
          reference: {
            ...object({ artifact_id: id, revision_id: id, sha256: sha }),
            additionalProperties: false,
          },
          note: singleLine(4096),
        },
        ["kind", "reference"],
      ),
    ],
  },
  Review: object({
    id,
    revision: positive,
    artifact_revision_id: id,
    reviewer_id: id,
    disposition: enumeration("comment", "approve", "changes_requested"),
    body: nullable(string),
    created_at: timestamp,
    updated_at: timestamp,
  }),
  ReviewState: object({
    state: enumeration("pending", "approved", "changes_requested"),
    artifact_revision_id: id,
    requested_by_id: id,
    requested_at: timestamp,
    required_participant_ids: { ...array(id), uniqueItems: true, minItems: 1 },
    responded_participant_ids: { ...array(id), uniqueItems: true },
  }),
  Action: object({
    id,
    revision: positive,
    title: string,
    description: nullable(string),
    created_by: id,
    assignee_id: nullable(id),
    holder_id: nullable(id),
    previous_holder_id: nullable(id),
    target_artifact_id: nullable(id),
    handoff_note: nullable(string),
    holder_changed_at: nullable(timestamp),
    recovery_reason: nullable(string),
    recovery_override: boolean,
    status: enumeration(
      "open",
      "in_progress",
      "in_review",
      "awaiting_decision",
      "awaiting_completion",
      "completed",
      "failed",
      "cancelled",
    ),
    deadline_at: nullable(timestamp),
    mode,
    completion: enumeration("holder", "group", "all"),
    available: boolean,
    participants: array(
      object(
        {
          participant_id: id,
          status: enumeration("pending", "working", "completed", "failed"),
          started_at: timestamp,
          completed_at: timestamp,
          result: ref("ActionResult"),
        },
        ["participant_id", "status"],
      ),
    ),
    progress: object({ completed: integer, required: integer }),
    holder_epoch: counter,
    lease_expires_at: nullable(timestamp),
    recoverable: boolean,
    result: nullable(ref("ActionResult")),
    completion_decision_id: nullable(id),
    completion_proposed_by_id: nullable(id),
    completion_proposed_at: nullable(timestamp),
    review: nullable(ref("ReviewState")),
    supersedes_action_id: nullable(id),
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: nullable(timestamp),
  }),
  ExternalReference: object(
    {
      provider: { const: "git" },
      uri: { type: "string", format: "uri", pattern: "^https://", maxLength: 2048 },
      path: { type: "string", minLength: 1, maxLength: 1000 },
      provider_revision: { type: "string", pattern: "^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$" },
      verification: { const: "asserted" },
    },
    ["provider", "uri", "provider_revision", "verification"],
  ),
  Artifact: object({
    id,
    revision: positive,
    name: string,
    kind: enumeration("native", "external"),
    media_type: string,
    current_revision_id: id,
    created_by: id,
    baton_mode: policy,
    exclusive: boolean,
    claim: nullable(
      object({ holder_id: id, epoch: positive, acquired_at: timestamp, expires_at: timestamp }),
    ),
    claimable: boolean,
    review_status: object({
      current: array(ref("ReviewSummary")),
      superseded: array(ref("ReviewSummary")),
    }),
    created_at: timestamp,
    updated_at: timestamp,
  }),
  ReviewSummary: object({
    reviewer_id: id,
    display_name: nullable(string),
    revision_id: id,
    disposition: enumeration("comment", "approve", "changes_requested"),
    updated_at: timestamp,
  }),
  ArtifactRevision: {
    ...object({
      id,
      ordinal: { type: "integer", minimum: 1 },
      base_revision_id: nullable(id),
      source: enumeration("native", "external"),
      content: nullable(string),
      external: nullable(ref("ExternalReference")),
      blocks: nullable(
        array(
          object({
            id,
            number: { type: "integer", minimum: 1 },
            label: string,
            kind: string,
            content: string,
            content_sha256: sha,
          }),
        ),
      ),
      change: nullable(ref("NativeChange")),
      sha256: sha,
      authored_by: id,
      claim_epoch: nullable(positive),
      baton_overlap: boolean,
      created_at: timestamp,
    }),
    allOf: [
      {
        if: { properties: { source: { const: "native" } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional, not a thenable.
        then: { properties: { content: string, external: { type: "null" } } },
        else: { properties: { content: { type: "null" }, external: ref("ExternalReference") } },
      },
    ],
  },
  CreateAction: {
    ...object(
      {
        title: singleLine(200),
        description: nullable({ ...multiline(8000), minLength: 0 }),
        assignee_id: nullable(id),
        start: { ...boolean, default: true },
        mode: { ...mode, default: "single" },
        completion: enumeration("holder", "group"),
        participant_ids: { ...array(id), minItems: 1, uniqueItems: true },
        target_artifact_id: nullable(id),
        ttl_seconds: ttl,
        exclusive: boolean,
        baton_mode: policy,
        deadline_at: nullable(timestamp),
        supersedes_action_id: nullable(id),
      },
      ["title"],
    ),
    not: { anyOf: [{ required: ["defer"] }, { required: ["peer_guidance"] }] },
    allOf: [
      {
        if: { required: ["mode"], properties: { mode: { const: "all" } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional, not a thenable.
        then: {
          not: { required: ["completion"] },
          properties: {
            start: { const: true },
            assignee_id: { type: "null" },
            target_artifact_id: { type: "null" },
          },
        },
        else: { not: { required: ["participant_ids"] } },
      },
    ],
  },
  Claim: object({ expected_revision: positive, ttl_seconds: ttl }, ["expected_revision"]),
  Renew: object({ claim_epoch: positive, ttl_seconds: ttl }, ["claim_epoch"]),
  Release: object({ claim_epoch: positive }),
  Handoff: {
    ...object(
      {
        expected_revision: positive,
        to_participant_id: id,
        to_group: { const: true },
        note: nullable({ ...singleLine(2000), minLength: 0 }),
        ttl_seconds: ttl,
      },
      ["expected_revision"],
    ),
    oneOf: [
      { required: ["to_participant_id"], not: { required: ["to_group"] } },
      { required: ["to_group"], not: { required: ["to_participant_id"] } },
    ],
  },
  Takeover: object(
    { expected_revision: positive, reason: singleLine(2000), override: boolean, ttl_seconds: ttl },
    ["expected_revision", "reason"],
  ),
  Resume: object({ expected_revision: positive, reason: singleLine(500) }),
  Transition: object(
    { expected_revision: positive, claim_epoch: positive, result: nullable(ref("ActionResult")) },
    [],
  ),
  Cancel: object({ expected_revision: positive }),
  RequestReview: object({
    expected_action_revision: positive,
    expected_artifact_revision: positive,
    artifact_revision_id: id,
  }),
  ActionReview: {
    ...object(
      {
        expected_action_revision: positive,
        artifact_revision_id: id,
        disposition: enumeration("approve", "changes_requested"),
        body: nullable({ ...multiline(32000), minLength: 0 }),
        expected_review_revision: positive,
      },
      ["expected_action_revision", "artifact_revision_id", "disposition"],
    ),
    allOf: [
      {
        if: { properties: { disposition: { const: "changes_requested" } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional, not a thenable.
        then: { required: ["body"], properties: { body: multiline(32000) } },
      },
    ],
  },
  ArtifactReview: object(
    {
      disposition: enumeration("comment", "approve", "changes_requested"),
      body: nullable({ ...multiline(32000), minLength: 0 }),
      expected_review_revision: positive,
      historical: boolean,
    },
    ["disposition"],
  ),
  ReviewNoteInput: {
    ...object(
      {
        artifact_revision_id: id,
        kind: enumeration("late", "correction"),
        body: multiline(32000),
        corrects_review_id: id,
      },
      ["artifact_revision_id", "kind", "body"],
    ),
    allOf: [
      {
        if: { properties: { kind: { const: "correction" } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional, not a thenable.
        then: { required: ["corrects_review_id"] },
        else: { not: { required: ["corrects_review_id"] } },
      },
    ],
  },
  ReviewNote: object({
    id,
    action_id: id,
    artifact_revision_id: id,
    reviewer_id: id,
    kind: enumeration("late", "correction"),
    corrects_review_id: nullable(id),
    body: string,
    non_dispositive: { const: true },
    created_at: timestamp,
  }),
  CreateArtifact: {
    ...object(
      {
        name: singleLine(200),
        kind: enumeration("native", "external"),
        media_type: singleLine(200),
        exclusive: boolean,
        baton_mode: policy,
        content: string,
        external: ref("ExternalReference"),
        sha256: { type: "string", pattern: "^[0-9a-fA-F]{64}$" },
        action_id: id,
        expected_action_revision: positive,
        ttl_seconds: ttl,
      },
      ["name", "kind"],
    ),
    dependentRequired: { action_id: ["expected_action_revision"] },
    allOf: [
      {
        if: { properties: { kind: { const: "native" } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional, not a thenable.
        then: {
          required: ["content"],
          properties: { media_type: enumeration("text/markdown", "text/plain") },
        },
        else: { required: ["external", "sha256"], properties: { sha256: sha } },
      },
    ],
  },
  PatchOperation: {
    oneOf: [
      object({
        op: { const: "replace" },
        block_id: id,
        expected_content_sha256: sha,
        content: string,
      }),
      object({
        op: enumeration("insert_before", "insert_after"),
        anchor_block_id: id,
        content: string,
      }),
      object({ op: { const: "delete" }, block_id: id, expected_content_sha256: sha }),
      object({
        op: { const: "replace_text" },
        find: id,
        replace: string,
        expected_matches: { type: "integer", minimum: 1 },
      }),
    ],
  },
  PublishRevision: {
    ...object(
      {
        expected_revision: positive,
        base_revision_id: id,
        claim_epoch: positive,
        action_id: id,
        ttl_seconds: ttl,
        content: string,
        sync_content: string,
        operations: { ...array(ref("PatchOperation")), minItems: 1, maxItems: 50 },
        external: ref("ExternalReference"),
        sha256: sha,
      },
      ["expected_revision", "base_revision_id"],
    ),
    oneOf: [
      ...["content", "sync_content", "operations"].map((field) => ({
        required: [field],
        not: {
          anyOf: ["content", "sync_content", "operations", "external", "sha256"]
            .filter((other) => other !== field)
            .map((other) => ({ required: [other] })),
        },
      })),
      {
        required: ["external", "sha256"],
        not: {
          anyOf: ["content", "sync_content", "operations"].map((field) => ({ required: [field] })),
        },
      },
    ],
  },
  ActionMutation: object({ action: ref("Action"), state_revision: counter }),
  ArtifactMutation: object({ artifact: ref("Artifact"), state_revision: counter }),
  ReviewMutation: object({
    action: ref("Action"),
    artifact: ref("Artifact"),
    revision: ref("ArtifactRevision"),
    reviews: array(ref("Review")),
    state_revision: counter,
  }),
  ArtifactRead: object({
    artifact: ref("Artifact"),
    revision: ref("ArtifactRevision"),
    reviews: array(ref("Review")),
  }),
  NativeChange: {
    oneOf: [
      object({ kind: enumeration("initial", "whole_snapshot", "legacy_snapshot") }),
      object({
        kind: { const: "block_patch" },
        operations: { ...array(ref("PatchOperation")), minItems: 1, maxItems: 50 },
      }),
      object({
        kind: { const: "block_sync" },
        preserved: integer,
        replaced: integer,
        inserted: integer,
        deleted: integer,
        ambiguous_hunks: integer,
      }),
    ],
  },
  RevisionPointer: object({ id, ordinal: { type: "integer", minimum: 1 }, sha256: sha }),
  ReviewChangedBlock: {
    oneOf: [
      object({
        id,
        change: { const: "inserted" },
        current_number: { type: "integer", minimum: 1 },
        base_number: { type: "null" },
      }),
      object({
        id,
        change: { const: "modified" },
        current_number: { type: "integer", minimum: 1 },
        base_number: { type: "integer", minimum: 1 },
      }),
      object({
        id,
        change: { const: "deleted" },
        current_number: { type: "null" },
        base_number: { type: "integer", minimum: 1 },
      }),
    ],
  },
  ReviewCheckpoint: object({
    threshold: { type: "integer", enum: [3, 5, 8, 13] },
    elapsed_seconds: integer,
    current_round: { type: "integer", minimum: 1 },
    total_rounds: { type: "integer", minimum: 1 },
    artifact_bytes: nullable(integer),
    growth_bytes: nullable({ type: "integer" }),
    changed_block_count: nullable(integer),
    prior_round: nullable(object({ approvals: integer, changes_requested: integer })),
    outstanding_participant_ids: { ...array(id), uniqueItems: true },
  }),
  ReviewPresentation: {
    ...object({
      mode: enumeration("full", "diff"),
      fallback_reason: nullable(
        enumeration("first_revision", "no_trusted_base", "external_artifact"),
      ),
      current: ref("RevisionPointer"),
      base: nullable(ref("RevisionPointer")),
      changed_blocks: nullable(array(ref("ReviewChangedBlock"))),
      round: { type: "integer", minimum: 1 },
      roster: array(object({ participant_id: id, display_name: string, responded: boolean })),
      your_obligation: nullable({ const: "review" }),
      checkpoint: nullable(ref("ReviewCheckpoint")),
    }),
    oneOf: [
      {
        properties: {
          mode: { const: "diff" },
          fallback_reason: { type: "null" },
          base: ref("RevisionPointer"),
          changed_blocks: array(ref("ReviewChangedBlock")),
        },
      },
      {
        properties: {
          mode: { const: "full" },
          fallback_reason: enumeration("first_revision", "no_trusted_base", "external_artifact"),
          changed_blocks: { type: "null" },
        },
      },
    ],
    description:
      "Viewer-relative presentation of the latest requested round, not necessarily the artifact's newest draft. Base is the latest earlier round reviewed by this viewer. Diff is navigation, not approval or a complete text patch; retrieve exact content by revision ID.",
  },
  NamedReviewNote: {
    allOf: [ref("ReviewNote"), object({ reviewer_name: string })],
  },
  HistoricalReview: {
    allOf: [
      ref("Review"),
      object({
        reviewer_name: string,
        later_corrected: boolean,
        corrections: array(ref("NamedReviewNote")),
      }),
    ],
    description:
      "Later correction notes do not replace the recorded disposition or rewrite settled outcomes.",
  },
  ReviewRoundHistory: object({
    event: { type: "integer", minimum: 1 },
    artifact: ref("Artifact"),
    revision: object({
      id,
      ordinal: { type: "integer", minimum: 1 },
      base_revision_id: nullable(id),
      source: enumeration("native", "external"),
      sha256: sha,
      authored_by: id,
      created_at: timestamp,
    }),
    reviews: array(ref("HistoricalReview")),
    notes: array(ref("NamedReviewNote")),
  }),
  ActionReviewHistory: object(
    {
      action: ref("Action"),
      review_presentation: ref("ReviewPresentation"),
      rounds: array(ref("ReviewRoundHistory")),
    },
    ["action", "rounds"],
  ),
  ActionRead: {
    ...object(
      {
        action: ref("Action"),
        superseded_by: object({
          action_id: id,
          status: enumeration(
            "open",
            "in_progress",
            "in_review",
            "awaiting_decision",
            "awaiting_completion",
            "completed",
            "failed",
            "cancelled",
          ),
        }),
        review_round: {
          ...object({ can_approve: boolean }, []),
          anyOf: [
            ref("ReviewPresentation"),
            {
              required: ["can_approve"],
              not: {
                anyOf: [
                  "mode",
                  "fallback_reason",
                  "current",
                  "base",
                  "changed_blocks",
                  "round",
                  "roster",
                  "your_obligation",
                  "checkpoint",
                ].map((key) => ({ required: [key] })),
              },
            },
          ],
        },
      },
      ["action"],
    ),
    not: { required: ["rounds"] },
  },
};

const paths = {};
function operation(path, method, name, input, output, description, extra = {}) {
  const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: id,
  }));
  const responses = {
    200: {
      description: "Successful candidate response; additional fields may be present.",
      content: { "application/json": { schema: output } },
    },
    default: {
      description:
        "Base GRP error envelope. State/authority/precondition failures are not success; do not retry blindly. Exact error coverage is listed in the draft guide.",
      content: { "application/json": { schema: ref("Error") } },
    },
  };
  paths[path] ??= {};
  paths[path][method] = {
    operationId: name,
    summary: name,
    description,
    parameters,
    ...(input
      ? { requestBody: { required: true, content: { "application/json": { schema: ref(input) } } } }
      : {}),
    responses,
    security: [{ ParticipantToken: [] }],
    ...extra,
  };
}
const base = "/api/rooms/{slug}";
const action = `${base}/actions/{actionId}`;
const artifact = `${base}/artifacts/{artifactId}`;
operation(
  `${base}/turns`,
  "post",
  "operateSpeakingTurn",
  "TurnOperation",
  ref("TurnMutation"),
  "Participant-token only. Request, renew or release one speaking request. Fresh request IDs require a 13-digit Unix-millisecond prefix, underscore and 36 lowercase hex/hyphen characters; server checks retry age. Held renew/release requires the current epoch; queued operations need no epoch. No observation is issued. Reconciliation may commit even on denial.",
);
operation(
  `${base}/composing`,
  "post",
  "signalComposing",
  "Compose",
  object({ composing: ref("ComposingSignal") }),
  "Participant-token only. Ephemeral presence, not a speaking grant or work claim. Omitted body uses default TTL. No durable event or room revision advance.",
);
paths[`${base}/composing`].post.requestBody.required = false;
const workingAuth = { security: [{ ParticipantToken: [] }, { Mandate: [] }] };
operation(
  `${base}/working-signals`,
  "post",
  "startWorkingSignal",
  "StartWorkingSignal",
  object({ working_signal: ref("WorkingSignal"), lease_token: id }),
  "Retained experimental presence surface, not a recommended new workflow. Requires a joined non-observer. Mandate form requires react permission and an existing joined seat. Same participant/scope/kind replaces its lease; maximum eight active distinct signals per participant. Scope target must exist in this room. No speaking authority, durable history or room revision advance.",
  workingAuth,
);
operation(
  `${base}/working-signals/{signalId}`,
  "put",
  "renewWorkingSignal",
  "RenewWorkingSignal",
  object({ working_signal: ref("WorkingSignal") }),
  "Same participant plus exact live lease token; no token rotation. Does not grant speaking authority. Mandate form uses react permission and an existing joined seat.",
  workingAuth,
);
operation(
  `${base}/working-signals/{signalId}`,
  "delete",
  "stopWorkingSignal",
  "StopWorkingSignal",
  object({ stopped: { const: true }, signal_id: id }),
  "Same participant plus exact live lease token. May stop after conclusion; an absent, expired or replaced lease is a conflict, not success. Mandate form uses react permission and an existing joined seat.",
  workingAuth,
);
for (const path of [
  `${base}/turns`,
  `${base}/composing`,
  `${base}/working-signals`,
  `${base}/working-signals/{signalId}`,
]) {
  for (const op of Object.values(paths[path])) {
    for (const [status, description] of Object.entries({
      400: "Invalid input, missing credential, unsupported credential form or disabled host capability.",
      401: "Invalid participant token, auth-mode conflict or invalid mandate where supported.",
      403: "Ineligible observer, missing mandate seat or denied authority.",
      404: "Room not found.",
      409: "Turn disabled/conflicted/fenced/ended, or working_signal.lease_invalid; inspect current state.",
    }))
      op.responses[status] = {
        description,
        content: { "application/json": { schema: ref("Error") } },
      };
  }
}
paths[`${base}/composing`].post.responses[412] = {
  description: "Stale or missing foreground epoch in a separately configured phased room.",
  content: { "application/json": { schema: ref("Error") } },
};
operation(
  `${base}/actions`,
  "post",
  "createAction",
  "CreateAction",
  ref("ActionMutation"),
  "Starts by default; mode and completion are immutable. Successors are validated against room state.",
);
operation(
  action,
  "get",
  "readAction",
  null,
  { oneOf: [ref("ActionRead"), ref("ActionReviewHistory")] },
  "Focused current action; reviews=1 selects ordered exact-round history. Presentation is viewer-relative and can describe the last requested round while a newer draft exists. Corrections are non-dispositive. Presence of a valid shape does not prove authorization or agreement correctness.",
);
operation(
  `${action}/claim`,
  "post",
  "claimAction",
  "Claim",
  ref("ActionMutation"),
  "Claim an eligible open/unheld action; not takeover of an existing holder.",
);
operation(
  `${action}/claim`,
  "put",
  "renewActionClaim",
  "Renew",
  ref("ActionMutation"),
  "Renew the exact live holder epoch, without creating a new holder.",
);
operation(
  `${action}/handoff`,
  "post",
  "handoffAction",
  "Handoff",
  ref("ActionMutation"),
  "Current holder, mode=handoff only; transfer to one participant or offer to group.",
);
operation(
  `${action}/takeover`,
  "post",
  "takeoverAction",
  "Takeover",
  ref("ActionMutation"),
  "Active-holder recovery with reason; a live other lease requires explicit override=true. This is not blanket external authority.",
);
operation(
  `${action}/resume`,
  "post",
  "resumeActionCompletion",
  "Resume",
  ref("ActionMutation"),
  "Completion proposer may cancel its still-open completion decision and resume work. X-GRP-Expected-Room-Revision is required. Additional decision/receipt fields are outside this partial response schema.",
);
for (const transition of ["complete", "fail", "cancel"]) {
  operation(
    `${action}/${transition}`,
    "post",
    `${transition}Action`,
    transition === "cancel" ? "Cancel" : "Transition",
    ref("ActionMutation"),
    "Single-holder transitions require expected_revision; all-participant complete/fail updates the actor's fixed report. Group complete proposes an agreement decision, requires the room revision header, and does not immediately complete. A successor to a completed exact-reviewed artifact result must request exact review instead; complete rejects with 400. Cancellation abandons rather than approves.",
  );
}
operation(
  `${action}/request-review`,
  "post",
  "requestActionReview",
  "RequestReview",
  ref("ReviewMutation"),
  "Current holder of single/handoff group-completion action submits its current attached artifact and records its own approval; freezes the round.",
);
operation(
  `${action}/review`,
  "put",
  "reviewAction",
  "ActionReview",
  ref("ReviewMutation"),
  "Required reviewer pins the open round's artifact. Peer responses commute within the opening/current action-revision interval. All responses settle the round; a changes request prevents approval.",
);
operation(
  `${action}/review-notes`,
  "post",
  "appendActionReviewNote",
  "ReviewNoteInput",
  object({ review_note: ref("ReviewNote"), state_revision: counter }),
  "Round reviewers append non-dispositive late commentary or corrections to their own formal review; never rewrites a settled outcome.",
);
operation(
  `${base}/artifacts`,
  "post",
  "createArtifact",
  "CreateArtifact",
  object({
    artifact: ref("Artifact"),
    current_revision: ref("ArtifactRevision"),
    action: nullable(ref("Action")),
    state_revision: counter,
  }),
  "Native UTF-8 text max262144 bytes or asserted Git reference. Attaching requires current action holder and expected action revision.",
);
operation(
  artifact,
  "get",
  "readArtifact",
  null,
  {
    oneOf: [
      ref("ArtifactRead"),
      {
        ...object({ artifact: ref("Artifact") }),
        not: { anyOf: [{ required: ["revision"] }, { required: ["reviews"] }] },
      },
    ],
  },
  "Select revision ID or positive version, not both; view=metadata omits content. Metadata-only and history query parameters are described in the guide.",
);
operation(
  `${artifact}/claim`,
  "post",
  "claimArtifact",
  "Claim",
  ref("ArtifactMutation"),
  "Standalone edit claim; attached action authority remains separate.",
);
operation(
  `${artifact}/claim`,
  "put",
  "renewArtifactClaim",
  "Renew",
  ref("ArtifactMutation"),
  "Renew a live exact edit epoch.",
);
operation(
  `${artifact}/claim`,
  "delete",
  "releaseArtifactClaim",
  "Release",
  ref("ArtifactMutation"),
  "Release an exact edit epoch. This DELETE requires a JSON body.",
);
operation(
  `${artifact}/revisions`,
  "post",
  "publishArtifactRevision",
  "PublishRevision",
  object({ artifact: ref("Artifact"), revision: ref("ArtifactRevision"), state_revision: counter }),
  "Requires current artifact counter and exact base. Action-owned native writes may use action_id; otherwise enforced edits require claim_epoch. No publishing while pending exact review/completion freezes the target.",
);
operation(
  `${artifact}/revisions/{revisionId}/review`,
  "put",
  "reviewArtifactRevision",
  "ArtifactReview",
  object({ review: ref("Review"), state_revision: counter }),
  "Standalone revision review; does not discharge an action's required exact round. Historical=true explicitly selects superseded bytes.",
);

// Cross-parameter exclusions and mode-conditional room guards remain prose
// constraints; OpenAPI cannot express all of them at operation level.
paths[action].get.parameters.push({
  name: "reviews",
  in: "query",
  schema: { const: "1" },
  description: "Return exact round history.",
});
paths[artifact].get.parameters.push(
  {
    name: "revision",
    in: "query",
    schema: id,
    description: "Exact revision ID; mutually exclusive with version.",
  },
  {
    name: "version",
    in: "query",
    schema: { type: "integer", minimum: 1 },
    description: "Content ordinal; mutually exclusive with revision.",
  },
  {
    name: "view",
    in: "query",
    schema: { const: "metadata" },
    description: "Omit content and reviews.",
  },
);
for (const [path, item] of Object.entries(paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (
      method !== "get" &&
      !path.endsWith("/review-notes") &&
      op.operationId !== "operateSpeakingTurn" &&
      !op.operationId.endsWith("WorkingSignal")
    ) {
      op.parameters.push({
        name: "X-GRP-Expected-Foreground-Epoch",
        in: "header",
        schema: counter,
        description:
          "Conditional fence for separately configured phased rooms; not an instruction to enable phased policy.",
      });
    }
    if (
      [
        "createAction",
        "createArtifact",
        "publishArtifactRevision",
        "completeAction",
        "failAction",
        "cancelAction",
        "resumeActionCompletion",
        "reviewArtifactRevision",
      ].includes(op.operationId)
    ) {
      op.parameters.push({
        name: "X-GRP-Expected-Room-Revision",
        in: "header",
        required: op.operationId === "resumeActionCompletion",
        schema: counter,
        description:
          "Strict room-global observation when supplied; additionally required for group completion.",
      });
    }
  }
}

export const coordinationContract = {
  openapi: "3.1.0",
  jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
  info: {
    title: "GRP coordination candidate — draft",
    version: "0.0.0-draft",
    description:
      "Unreleased, non-normative review artifact. Not merged into the published base contract or live conformance verdict. Schemas constrain canonical client forms, not every ignored legacy field. State-dependent authority, Unicode/UTF-8 limits and cryptographic checks also require implementation tests.",
  },
  "x-grp-status": "draft-unreleased",
  "x-grp-remaining-gates": [
    "complete room-read/wait and foreground envelopes",
    "complete error/status and query/header contracts",
    "speaking-turn read/wait integration and exhaustive cross-field/error semantics",
    "live authorization/lifecycle and historical-host probes",
    "transport/versioning governance",
  ],
  paths,
  components: {
    securitySchemes: {
      ParticipantToken: {
        type: "http",
        scheme: "bearer",
        description:
          "Credential scoped to participant and room. Shared-resource/turn/composing mutations reject X-Mandate. Working-signal operations additionally support the separate Mandate form. Reads use room visibility policy; bearer security shown here is a supported read form, not a requirement on every public room.",
      },
      Mandate: {
        type: "apiKey",
        in: "header",
        name: "X-Mandate",
        description:
          "Verified mandate envelope; only the three working-signal operations in this draft accept it, requiring react scope and an existing joined seat. Not equivalent action/artifact/turn support.",
      },
    },
    schemas,
  },
};
