// Candidate-only read/wait overlay. Reuse public-owned base structures without
// modifying the published base document or importing a host implementation.
import { readFileSync } from "node:fs";
const base = JSON.parse(
  readFileSync(new URL("../docs/reference/openapi/grp-v0.1.openapi.json", import.meta.url)),
);
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const s = { type: "string" };
const id = { ...s, minLength: 1 };
const n = { type: "integer", minimum: 0 };
const one = { type: "integer", minimum: 1 };
const b = { type: "boolean" };
const time = { ...s, format: "date-time" };
const counter = { ...s, pattern: "^[0-9]+$" };
const nil = { type: "null" };
const nullable = (schema) => ({ anyOf: [schema, nil] });
const array = (items) => ({ type: "array", items });
const en = (...values) => ({ type: "string", enum: values });
const obj = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
});
const role = en("participant", "observer");

export function addReadContracts(schemas) {
  function copy(name) {
    if (schemas[name]) return;
    const value = structuredClone(base.components.schemas[name]);
    if (!value) throw new Error(`Missing public base schema: ${name}`);
    schemas[name] = value;
    for (const [, dep] of JSON.stringify(value).matchAll(/#\/components\/schemas\/([^"\\]+)/g))
      copy(dep);
  }
  for (const name of ["AgentRoomView", "RoomDelta", "RoomState"]) copy(name);
  // Correct candidate representation mismatches explicitly; do not relax the
  // base contract in place. IDs/prose omitted by the host stay optional here.
  const agent = schemas.AgentRoomView;
  agent.required = [
    "slug",
    "status",
    "about",
    "agent",
    "brief",
    "decision",
    "discussion",
    "roster",
    "rules",
    "more",
    "current_through",
    "page",
  ];
  const decision = agent.properties.decision.oneOf[0];
  decision.required = decision.required.filter(
    (key) => !["context", "eligible", "eligible_participant_ids"].includes(key),
  );
  decision.required.push("response_state");
  decision.properties.option_proposers = array(nullable(s));
  decision.properties.settling = obj({ seals_in_seconds: n, presumptive: nullable(s) });
  const completion = obj({
    action_id: id,
    action_revision: nullable(counter),
    result: nullable(ref("ActionResult")),
    eligible: b,
    accepted_by_you: b,
  });
  decision.properties.action_completion = completion;
  agent.properties.choices = array({
    ...obj({ who: s, option: one, choice: {}, rationale: s, at: time }, ["who", "at"]),
    oneOf: [
      { required: ["option"], not: { required: ["choice"] } },
      { required: ["choice"], not: { required: ["option"] } },
    ],
  });
  agent.properties.choices.description =
    "Present only when visible; a known slate choice uses its option number, otherwise the underlying choice value. Omission is not an empty ballot.";
  agent.properties.discussion.items.properties.about_action_id = id;
  agent.properties.roster.properties.administrative_host = obj({
    name: s,
    voting_eligible: { const: false },
    participant_obligation: { const: false },
  });
  agent.properties.you = obj({ participant_id: id, name: s, role });
  agent.properties.current_through.description =
    "Snapshot head, not proof that the discussion tail includes every older body. Check page.content independently.";
  schemas.RoomConfig.properties.quorum = nullable(one);
  schemas.RoomConfig.properties.threshold = nullable({ type: "number", minimum: 0, maximum: 1 });
  schemas.RoomConfig.properties.conversation_policy = en("open", "speaking_turns");
  schemas.RoomConfig.properties.foreground_policy = en("open", "phased_serial");
  schemas.RoomReadPage = {
    ...obj(
      {
        displayed_from_event: nullable(n),
        displayed_through_event: nullable(n),
        through_event: n,
        room_event: n,
        complete: b,
        bodies_elided: { const: false },
        next_since: n,
        content: obj(
          { discussion_displayed: n, discussion_total: n, discussion_complete: b, expand: s },
          ["discussion_displayed", "discussion_total", "discussion_complete"],
        ),
      },
      [
        "displayed_from_event",
        "displayed_through_event",
        "through_event",
        "room_event",
        "complete",
        "bodies_elided",
      ],
    ),
    oneOf: [
      { properties: { complete: { const: true } }, not: { required: ["next_since"] } },
      { properties: { complete: { const: false } }, required: ["next_since"] },
    ],
    description:
      "Event scan coverage and snapshot discussion coverage are different. Cross-field ordering/equality must also be checked by a client; JSON Schema alone cannot prove completeness.",
  };
  schemas.RoomDelta.required.push("page");
  schemas.RoomDelta.properties.you = agent.properties.you;
  schemas.RoomDelta.properties.decision = decision;
  schemas.RoomDelta.properties.current_through.description =
    "Last scanned raw event, including filtered events. On empty input bounded by the room head; not the last displayed entry.";
  const entry = schemas.RoomDelta.properties.new.items;
  entry.properties.type = id; // Future event classes remain additive.
  entry.properties.seq = one;
  entry.allOf = [
    {
      if: { properties: { type: { const: "discussion" } }, required: ["type"] },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional.
      then: obj({ who: s, said: s, about_action_id: id }, ["who", "said"]),
    },
  ];
  const full = schemas.RoomState;
  full.required = Object.keys(full.properties);
  full.properties.voting_ends_at = time;
  full.properties.resolved_at = nullable(time);
  full.properties.concluded_at = nullable(time);
  full.properties.participants = array(
    obj({
      id,
      display_name: nullable(s),
      role,
      joined_at: time,
      last_seen_at: nullable(time),
      deliberated_at: nullable(time),
      voted_at: nullable(time),
      agent_did: nullable(s),
      mandate_id: nullable(s),
    }),
  );
  full.properties.discussion = array(
    obj(
      {
        id,
        participant_id: id,
        body: s,
        stance: nullable(s),
        posted_at: time,
        decision_id: nullable(id),
        about_action_id: id,
      },
      ["id", "participant_id", "body", "stance", "posted_at", "decision_id"],
    ),
  );
  full.properties.votes = nullable(
    array(obj({ participant_id: id, choice: {}, rationale: nullable(s), cast_at: time })),
  );
  full.properties.abstentions = array(obj({ participant_id: id, reason: s, declared_at: time }));
  schemas.DecisionSummary.properties.action_completion = obj({
    action_id: id,
    action_revision: nullable(counter),
    result: nullable(ref("ActionResult")),
  });
  schemas.AuthoritativeResult = obj({
    action_id: id,
    artifact_id: id,
    revision_id: id,
    sha256: { ...s, pattern: "^[0-9a-f]{64}$" },
    completed_at: nullable(time),
    open_successor_action_id: nullable(id),
  });
  schemas.Foreground = obj(
    {
      policy: { const: "phased_serial" },
      epoch: counter,
      phase: en("discussion", "decision", "action", "review"),
      decision_id: nullable(id),
      action_id: nullable(id),
      artifact_id: nullable(id),
      artifact_revision_id: nullable(id),
      return_action_id: nullable(id),
      your_obligation: nullable({
        oneOf: [
          obj({
            kind: { const: "decision_response" },
            required: { const: false },
            decision_id: id,
          }),
          obj({ kind: { const: "action_holder" }, required: { const: false }, action_id: id }),
          obj({ kind: { const: "action_report" }, required: { const: true }, action_id: id }),
          obj({
            kind: { const: "review" },
            required: { const: true },
            action_id: id,
            artifact_revision_id: id,
          }),
        ],
      }),
      available_transitions: { ...array(s), uniqueItems: true },
      decision: obj({
        id,
        seq: one,
        question: s,
        options: array(s),
        status: s,
        proposals_open: b,
        agreement: b,
        voting_ends_at: time,
        eligible_participant_ids: nullable(array(id)),
      }),
      action: obj({
        id,
        revision: counter,
        title: s,
        status: s,
        mode: s,
        completion: s,
        holder_id: nullable(id),
        target_artifact_id: nullable(id),
        blocking_decision_id: nullable(id),
        available: b,
        recoverable: b,
        required_participant_ids: nullable(array(id)),
        responded_participant_ids: nullable(array(id)),
      }),
      artifact: obj({
        id,
        revision: counter,
        name: s,
        kind: en("native", "external"),
        media_type: s,
        current_revision_id: nullable(id),
        exact_revision: ref("RevisionPointer"),
      }),
    },
    [
      "policy",
      "epoch",
      "phase",
      "decision_id",
      "action_id",
      "artifact_id",
      "artifact_revision_id",
      "return_action_id",
      "your_obligation",
      "available_transitions",
    ],
  );
  schemas.Foreground.description =
    "Retained phased experiment only; absent in ordinary open rooms. Not the recommended product policy and not a speaking-turn projection.";
  schemas.RoomCoordination = {
    ...obj(
      {
        state_revision: counter,
        speaking_turn: ref("SpeakingTurn"),
        composing: { ...array(ref("ComposingSignal")), maxItems: 100 },
        actions: { ...array(ref("Action")), maxItems: 100 },
        artifacts: { ...array(ref("Artifact")), maxItems: 100 },
        authoritative_results: { ...array(ref("AuthoritativeResult")), minItems: 1 },
        authoritative_result: ref("AuthoritativeResult"),
        foreground: ref("Foreground"),
      },
      [],
    ),
    dependentRequired: {
      state_revision: ["composing", "actions", "artifacts"],
      actions: ["state_revision"],
      artifacts: ["state_revision"],
      composing: ["state_revision"],
    },
    description:
      "Additive feature-gated fields. Active actions/artifacts are capped working sets, not an exhaustive archive. Singular authoritative_result appears only for one deliverable lineage. Read may reconcile expired leases; no write authority follows merely from receiving state.",
  };
  schemas.RoomRead = {
    allOf: [
      ref("RoomCoordination"),
      {
        oneOf: [
          {
            allOf: [
              ref("AgentRoomView"),
              { not: { anyOf: [{ required: ["new"] }, { required: ["config"] }] } },
            ],
          },
          { allOf: [ref("RoomDelta"), { not: { required: ["config"] } }] },
          ref("RoomState"),
        ],
      },
    ],
  };
  schemas.WaitDecision = obj(
    {
      id,
      seq: one,
      question: s,
      options: array(s),
      voting_ends_at: time,
      status: en("voting", "resolved", "expired", "proposing"),
      agreement: { const: true },
      completion_action_id: id,
    },
    ["id", "seq", "question", "options", "voting_ends_at", "status"],
  );
  schemas.WaitResponse = {
    ...obj(
      {
        foreground: ref("Foreground"),
        speaking_turn: { allOf: [ref("SpeakingTurn"), { not: { required: ["observation"] } }] },
      },
      [],
    ),
    oneOf: [
      obj({ status: { const: "concluded" } }),
      obj({
        status: { const: "speaking_turn" },
        speaking_turn: { allOf: [ref("SpeakingTurn"), { required: ["target"] }] },
      }),
      obj(
        {
          status: { const: "actionable" },
          for: en("my_choice", "completion", "activity"),
          decision: ref("WaitDecision"),
          also_actionable: {
            ...array({
              ...schemas.WaitDecision,
              required: schemas.WaitDecision.required.filter((key) => key !== "options"),
            }),
            minItems: 1,
          },
        },
        ["status", "for", "decision"],
      ),
      obj({ status: { const: "activity" }, event: obj({ seq: one, type: id, who: nullable(s) }) }),
      obj({
        status: { const: "working" },
        signal_change: obj({
          signal_id: id,
          participant_id: id,
          change: en("started", "changed", "stopped"),
        }),
        requires_read: { const: true },
        hint: s,
      }),
      ...["action_recovery", "action_required"].map((status) =>
        obj({ status: { const: status }, action: ref("Action"), hint: s }),
      ),
      obj({ status: { const: "timeout" }, next_poll_at: time, hint: s }),
    ],
    description:
      "A wake pointer, not full context or an observation authorizing a post. Timeout is not completion; concluded is opt-in. since_seq is a decision sequence for decision waits and an event sequence for activity waits.",
  };
}
