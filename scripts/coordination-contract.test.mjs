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
      assert.deepEqual(op.security, [{ ParticipantToken: [] }]);
    }
  }
  assert.equal(ids.size, 20);
  assert.equal(doc["x-grp-status"], "draft-unreleased");
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
