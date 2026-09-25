import assert from "node:assert/strict";
import { test } from "node:test";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import { coordinationContract as doc } from "./coordination-contract.mjs";

// OpenAPI annotations are not JSON Schema keywords. Compile only components
// under a JSON Schema root, with refs left identical to the OpenAPI document.
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "urn:grp:candidate", components: doc.components });
const validate = (name, value) => {
  const check = ajv.getSchema(`urn:grp:candidate#/components/schemas/${name}`);
  assert(check, name);
  return check(value);
};
const hash = "a".repeat(64);
const pointer = { id: "revision", ordinal: 1, sha256: hash };
const presentation = {
  mode: "full",
  fallback_reason: "first_revision",
  current: pointer,
  base: null,
  changed_blocks: null,
  round: 1,
  roster: [{ participant_id: "p", display_name: "Peer", responded: false }],
  your_obligation: "review",
  checkpoint: null,
};

test("every component compiles, path parameters match, operations have unique identities", () => {
  for (const name of Object.keys(doc.components.schemas)) {
    assert(ajv.getSchema(`urn:grp:candidate#/components/schemas/${name}`), name);
  }
  const ids = new Set();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const op of Object.values(item)) {
      assert(!ids.has(op.operationId));
      ids.add(op.operationId);
      assert.deepEqual(
        op.parameters
          .filter((p) => p.in === "path")
          .map((p) => p.name)
          .sort(),
        [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).sort(),
      );
      assert(op.responses["200"]);
      ajv.compile({
        components: doc.components,
        ...op.responses["200"].content["application/json"].schema,
      });
      assert.deepEqual(
        op.security,
        op.operationId.endsWith("WorkingSignal")
          ? [{ ParticipantToken: [] }, { Mandate: [] }]
          : [{ ParticipantToken: [] }],
      );
      for (const response of Object.values(op.responses)) {
        ajv.compile({ components: doc.components, ...response.content["application/json"].schema });
      }
    }
  }
  assert.equal(ids.size, 25);
  assert.equal(doc["x-grp-status"], "draft-unreleased");
});
test("turn operations preserve string epochs and separate fresh-ID semantics from shape", () => {
  for (const operation of ["request", "renew", "release"]) {
    assert(
      validate("TurnOperation", {
        operation,
        request_id: "1234567890123_00000000-0000-4000-8000-000000000000",
      }),
    );
  }
  assert(
    validate("TurnOperation", {
      operation: "renew",
      request_id: "known",
      epoch: "9007199254740993",
    }),
  );
  for (const value of [
    { operation: "contribute", request_id: "known" },
    { operation: "renew", request_id: "known", epoch: 1 },
    { operation: "renew", request_id: "known", epoch: "1".repeat(31) },
    { operation: "release", request_id: "invalid.id" },
    { operation: "request" },
  ])
    assert(!validate("TurnOperation", value));
  // Fresh ID age and held-versus-queued epoch requirements are state checks.
  assert(validate("TurnOperation", { operation: "request", request_id: "known" }));
});
test("turn operation responses cannot issue read observations", () => {
  const empty = {
    policy: "speaking_turns",
    revision: "0",
    concluded: false,
    holder: null,
    own: null,
    next_deadline_at: null,
  };
  assert(validate("SpeakingTurn", { ...empty, observation: null }));
  assert(validate("TurnMutation", { speaking_turn: empty }));
  assert(!validate("TurnMutation", { speaking_turn: { ...empty, observation: null } }));
  assert(!validate("TurnMutation", { speaking_turn: null }));
  const queued = {
    request_id: "known",
    status: "queued",
    queue_position: 1,
    expires_at: "2026-01-01T01:00:00Z",
  };
  assert(validate("SpeakingTurn", { ...empty, own: queued, next_deadline_at: queued.expires_at }));
  assert(!validate("SpeakingTurn", { ...empty, own: { ...queued, queue_position: null } }));
  assert(!validate("SpeakingTurn", { ...empty, concluded: true, own: queued }));
  assert(!validate("SpeakingTurn", { ...empty, revision: 0 }));
});
test("presence has a bounded TTL and typed same-room scope, not a grant", () => {
  const uuid = "00000000-0000-4000-8000-000000000000";
  for (const scope of [
    { kind: "room" },
    ...["decision", "action", "artifact"].map((kind) => ({ kind, id: uuid })),
  ]) {
    assert(validate("StartWorkingSignal", { scope, kind: "reviewing", ttl_seconds: 15 }));
  }
  for (const scope of [
    { kind: "room", id: uuid },
    { kind: "action" },
    { kind: "decision", id: "1" },
  ]) {
    assert(!validate("StartWorkingSignal", { scope, kind: "responding" }));
  }
  for (const ttl_seconds of [14, 301, 15.5, "120"]) {
    assert(!validate("Compose", { ttl_seconds }));
    assert(!validate("RenewWorkingSignal", { lease_token: "opaque", ttl_seconds }));
  }
  assert(validate("Compose", {}));
  assert(
    validate("StartWorkingSignal", { scope: { kind: "room" }, kind: "drafting", summary: "" }),
  );
  for (const summary of ["a".repeat(241), "line\nbreak"]) {
    assert(!validate("StartWorkingSignal", { scope: { kind: "room" }, kind: "drafting", summary }));
  }
  assert(!validate("RenewWorkingSignal", {}));
  assert(!validate("StopWorkingSignal", { lease_token: "" }));
});
test("presence authentication and foreground fences are not generalized to all operations", () => {
  const turn = doc.paths["/api/rooms/{slug}/turns"].post;
  const compose = doc.paths["/api/rooms/{slug}/composing"].post;
  const start = doc.paths["/api/rooms/{slug}/working-signals"].post;
  assert(!turn.parameters.some((p) => p.in === "header"));
  assert(!start.parameters.some((p) => p.in === "header"));
  assert(compose.parameters.some((p) => p.name === "X-GRP-Expected-Foreground-Epoch"));
  assert.equal(compose.requestBody.required, false);
  assert.equal(turn.requestBody.required, true);
  assert.deepEqual(start.security, [{ ParticipantToken: [] }, { Mandate: [] }]);
  for (const code of [400, 401, 403, 404, 409]) assert(turn.responses[code]);
  assert(compose.responses[412]);
});
test("error envelopes preserve stable codes and allow additive diagnostic fields", () => {
  assert(
    validate("Error", {
      error: {
        code: "turn.fenced",
        message: "Read current state",
        details: { current_epoch: "2" },
      },
    }),
  );
  assert(!validate("Error", { error: "turn.fenced" }));
  assert(!validate("Error", { error: { code: "turn.fenced" } }));
});
test("full artifact responses cannot pass through the metadata-only branch", () => {
  const operation = doc.paths["/api/rooms/{slug}/artifacts/{artifactId}"].get;
  const response = operation.responses["200"].content["application/json"].schema;
  const check = ajv.compile({ components: doc.components, ...response });
  assert(!check({ artifact: {}, revision: { content: "incomplete" } }));
  assert(operation.parameters.some((p) => p.name === "revision" && p.in === "query"));
  assert(operation.parameters.some((p) => p.name === "version" && p.in === "query"));
});
test("canonical action creation modes enforce distinct completion/roster inputs", () => {
  for (const value of [
    { title: "Write summary" },
    { title: "Work", mode: "handoff", completion: "group" },
    { title: "Report", mode: "all", participant_ids: ["a", "b"] },
    { title: "Work", description: "a\n\tb" },
  ]) {
    assert(validate("CreateAction", value));
  }
  for (const value of [
    {},
    { title: "bad\nheading" },
    { title: "Work", defer: true },
    { title: "Work", mode: "all", completion: "holder" },
    { title: "Work", mode: "all", start: false },
    { title: "Work", participant_ids: ["a"] },
    { title: "Work", mode: "all", participant_ids: ["a", "a"] },
  ]) {
    assert(!validate("CreateAction", value), JSON.stringify(value));
  }
});
test("resource counters are strings, lease ranges are bounded, handoff has one destination", () => {
  assert(validate("Claim", { expected_revision: "9007199254740993", ttl_seconds: 30 }));
  for (const value of [
    { expected_revision: 1 },
    { expected_revision: "0" },
    { expected_revision: "1", ttl_seconds: 901 },
  ])
    assert(!validate("Claim", value));
  assert(validate("Handoff", { expected_revision: "1", to_group: true }));
  assert(validate("Handoff", { expected_revision: "1", to_participant_id: "b" }));
  for (const value of [
    { expected_revision: "1" },
    { expected_revision: "1", to_group: true, to_participant_id: "b" },
  ])
    assert(!validate("Handoff", value));
});
test("result binds an exact artifact triple or bounded multiline text", () => {
  assert(validate("ActionResult", { kind: "text", reference: "Line1\nLine2" }));
  assert(
    validate("ActionResult", {
      kind: "artifact_revision",
      reference: { artifact_id: "a", revision_id: "r", sha256: hash },
    }),
  );
  assert(!validate("ActionResult", { kind: "text", reference: "report", note: "extra" }));
  for (const reference of [
    { artifact_id: "a", revision_id: "r" },
    { artifact_id: "a", revision_id: "r", sha256: hash.toUpperCase() },
    { artifact_id: "a", revision_id: "r", sha256: hash, url: "https://example.org" },
  ])
    assert(!validate("ActionResult", { kind: "artifact_revision", reference }));
});
test("exact review and non-dispositive notes are distinct input shapes", () => {
  const base = { expected_action_revision: "2", artifact_revision_id: "r" };
  assert(validate("ActionReview", { ...base, disposition: "approve" }));
  assert(
    validate("ActionReview", {
      ...base,
      disposition: "changes_requested",
      body: "a".repeat(32000),
    }),
  );
  assert(!validate("ActionReview", { ...base, disposition: "changes_requested" }));
  assert(!validate("ActionReview", { ...base, disposition: "comment" }));
  assert(
    validate("ReviewNoteInput", {
      artifact_revision_id: "r",
      kind: "correction",
      body: "Correction",
      corrects_review_id: "mine",
    }),
  );
  assert(
    !validate("ReviewNoteInput", {
      artifact_revision_id: "r",
      kind: "correction",
      body: "Correction",
    }),
  );
  assert(
    !validate("ReviewNoteInput", {
      artifact_revision_id: "r",
      kind: "late",
      body: "Note",
      corrects_review_id: "mine",
    }),
  );
});
test("native and external creation require different evidence", () => {
  assert(validate("CreateArtifact", { name: "Summary", kind: "native", content: "" }));
  assert(!validate("CreateArtifact", { name: "Summary", kind: "native" }));
  assert(
    !validate("CreateArtifact", { name: "Summary", kind: "native", content: "x", action_id: "a" }),
  );
  const external = {
    provider: "git",
    uri: "https://example.org/repo",
    provider_revision: "a".repeat(40),
    verification: "asserted",
  };
  assert(validate("CreateArtifact", { name: "File", kind: "external", external, sha256: hash }));
  assert(!validate("CreateArtifact", { name: "File", kind: "external", external }));
  assert(!validate("ExternalReference", { ...external, verification: "provider_verified" }));
});
test("revision publication pins the base and selects one update form", () => {
  const base = { expected_revision: "2", base_revision_id: "r" };
  for (const update of [
    { content: "x" },
    { sync_content: "x" },
    { operations: [{ op: "replace_text", find: "x", replace: "y", expected_matches: 1 }] },
  ])
    assert(validate("PublishRevision", { ...base, ...update }));
  for (const update of [
    {},
    { content: "x", sync_content: "x" },
    { content: "x", sha256: hash },
    { operations: [] },
    { operations: [{ op: "delete", block_id: "b" }] },
  ])
    assert(!validate("PublishRevision", { ...base, ...update }));
});

test("presentation requires a trusted base for diff and preserves explicit full fallbacks", () => {
  assert(validate("ReviewPresentation", presentation));
  const diff = {
    ...presentation,
    mode: "diff",
    fallback_reason: null,
    base: pointer,
    changed_blocks: [],
  };
  assert(validate("ReviewPresentation", diff));
  assert(
    validate("ReviewPresentation", {
      ...presentation,
      fallback_reason: "external_artifact",
      base: pointer,
    }),
  );
  for (const value of [
    { ...diff, base: null },
    { ...diff, changed_blocks: null },
    { ...diff, fallback_reason: "no_trusted_base" },
    { ...presentation, fallback_reason: null },
    { ...presentation, changed_blocks: [] },
    { ...presentation, current: { ...pointer, sha256: "wrong" } },
    { ...presentation, your_obligation: "approve" },
    { ...presentation, roster: [{ participant_id: "p", display_name: "Peer" }] },
  ])
    assert(!validate("ReviewPresentation", value), JSON.stringify(value));
});
test("changed block numbers distinguish insertion, deletion and modification", () => {
  for (const value of [
    { id: "b", change: "inserted", current_number: 2, base_number: null },
    { id: "b", change: "deleted", current_number: null, base_number: 1 },
    { id: "b", change: "modified", current_number: 3, base_number: 2 },
  ])
    assert(validate("ReviewChangedBlock", value));
  for (const value of [
    { id: "b", change: "inserted", current_number: 0, base_number: null },
    { id: "b", change: "deleted", current_number: 1, base_number: null },
    { id: "b", change: "modified", current_number: 1, base_number: null },
  ])
    assert(!validate("ReviewChangedBlock", value));
});
test("checkpoint allows shrinkage and unknown external byte counts, not invented closure", () => {
  const checkpoint = {
    threshold: 3,
    elapsed_seconds: 12,
    current_round: 3,
    total_rounds: 3,
    artifact_bytes: 10,
    growth_bytes: -100,
    changed_block_count: 2,
    prior_round: { approvals: 1, changes_requested: 1 },
    outstanding_participant_ids: ["p"],
  };
  assert(validate("ReviewCheckpoint", checkpoint));
  assert(
    validate("ReviewCheckpoint", {
      ...checkpoint,
      artifact_bytes: null,
      growth_bytes: null,
      changed_block_count: null,
    }),
  );
  assert(!validate("ReviewCheckpoint", { ...checkpoint, artifact_bytes: -1 }));
  assert(!validate("ReviewCheckpoint", { ...checkpoint, threshold: 4 }));
});
test("native changes distinguish write metadata from review diffs", () => {
  for (const kind of ["initial", "whole_snapshot", "legacy_snapshot"])
    assert(validate("NativeChange", { kind }));
  const op = { op: "replace_text", find: "old", replace: "new", expected_matches: 1 };
  assert(validate("NativeChange", { kind: "block_patch", operations: [op] }));
  assert(validate("NativeChange", { kind: "block_patch", operations: Array(50).fill(op) }));
  assert(
    validate("NativeChange", {
      kind: "block_sync",
      preserved: 1,
      replaced: 2,
      inserted: 0,
      deleted: 3,
      ambiguous_hunks: 1,
    }),
  );
  for (const value of [
    { kind: "block_patch", operations: [] },
    { kind: "block_patch", operations: Array(51).fill(op) },
    { kind: "block_patch", operations: [{ op: "delete", block_id: "b" }] },
    { kind: "block_sync", preserved: 1 },
    { kind: "modified" },
  ])
    assert(!validate("NativeChange", value));
});
test("correction history requires original review plus attributed non-dispositive notes", () => {
  const time = "2026-01-01T00:00:00Z";
  const note = {
    id: "n",
    action_id: "a",
    artifact_revision_id: "r",
    reviewer_id: "p",
    reviewer_name: "Peer",
    kind: "correction",
    corrects_review_id: "review",
    body: "Correction",
    non_dispositive: true,
    created_at: time,
  };
  const review = {
    id: "review",
    revision: "1",
    artifact_revision_id: "r",
    reviewer_id: "p",
    disposition: "approve",
    body: null,
    created_at: time,
    updated_at: time,
    reviewer_name: "Peer",
    later_corrected: true,
    corrections: [note],
  };
  assert(validate("HistoricalReview", review));
  assert(
    !validate("HistoricalReview", {
      ...review,
      corrections: [{ ...note, non_dispositive: false }],
    }),
  );
  const { later_corrected, ...missing } = review;
  assert(!validate("HistoricalReview", missing));
  const revision = {
    ...pointer,
    base_revision_id: null,
    source: "native",
    authored_by: "p",
    created_at: time,
  };
  // A history revision is metadata, not ArtifactRevision's full content payload.
  assert(!validate("ArtifactRevision", revision));
});
