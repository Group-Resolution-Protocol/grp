import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadOrganizationManifest,
  manifestMechanismWarnings,
  parseOrganizationManifest,
  unsupportedMechanisms,
} from "./organization-manifest.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(pathJoin(tmpdir(), "grp-org-manifest-"));
  roots.push(root);
  mkdirSync(pathJoin(root, "personas"));
  writeFileSync(pathJoin(root, "personas", "mara.md"), "You are Mara.\n");
  writeFileSync(pathJoin(root, "first-day.md"), "Begin the work.\n");
  return root;
}

describe("organization manifest", () => {
  it("loads a strict YAML v1 organization", () => {
    const root = fixture();
    const path = pathJoin(root, "organization.yaml");
    writeFileSync(
      path,
      [
        "version: 1",
        "name: sample-company",
        "base_url: https://grp.example",
        "personas:",
        "  - id: mara",
        "    display_name: Mara Publisher",
        "    instructions: personas/mara.md",
        "    first_day: first-day.md",
        "    runtime:",
        "      command: claude",
        "      args: [--model, opus]",
        "      prompt: first_day",
        "  - id: cobalt",
        "rooms:",
        "  - id: greenlight",
        "    creator: mara",
        "    about: Choose a project",
        "    type: persistent",
        "    mechanism: score_vote",
        "    settings:",
        "      creator_votes: false",
        "      settle_window: 60",
        "    members:",
        "      - mara",
        "      - persona: cobalt",
        "        role: observer",
        "",
      ].join("\n"),
    );

    const loaded = loadOrganizationManifest(path);

    expect(loaded.manifest.name).toBe("sample-company");
    expect(loaded.manifest.personas[0]).toMatchObject({
      id: "mara",
      displayName: "Mara Publisher",
      runtime: { command: "claude", args: ["--model", "opus"], prompt: "first_day" },
    });
    expect(loaded.manifest.rooms[0]?.members).toEqual([
      { persona: "mara", role: "participant" },
      { persona: "cobalt", role: "observer" },
    ]);
    expect(loaded.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.topologyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts the same schema as JSON", () => {
    const manifest = parseOrganizationManifest(
      JSON.stringify({
        version: 1,
        name: "writers-room",
        personas: [{ id: "old-editor" }, { id: "writer" }],
        rooms: [
          {
            id: "drafting",
            creator: "old-editor",
            about: "Draft together",
            members: ["old-editor", "writer"],
          },
        ],
      }),
    );

    expect(manifest.personas.map((persona) => persona.displayName)).toEqual([
      "Old Editor",
      "Writer",
    ]);
    expect(manifest.rooms[0]).toMatchObject({
      type: "persistent",
      mechanism: "simple_majority",
    });
  });

  it.each([
    [
      "unknown root key",
      "version: 1\nname: sample\npersonas: [{id: mara}]\nscheduler: true\n",
      'unknown field "scheduler"',
    ],
    [
      "duplicate persona",
      "version: 1\nname: sample\npersonas: [{id: Mara}, {id: mara}]\n",
      'duplicate identifier "mara"',
    ],
    [
      "unknown member",
      "version: 1\nname: sample\npersonas: [{id: mara}]\nrooms:\n  - id: room\n    creator: mara\n    about: Work\n    members: [mara, cobalt]\n",
      'unknown persona "cobalt"',
    ],
    [
      "creator omitted",
      "version: 1\nname: sample\npersonas: [{id: mara}, {id: cobalt}]\nrooms:\n  - id: room\n    creator: mara\n    about: Work\n    members: [cobalt]\n",
      "creator must appear in members",
    ],
    [
      "unsupported setting",
      "version: 1\nname: sample\npersonas: [{id: mara}]\nrooms:\n  - id: room\n    creator: mara\n    about: Work\n    settings: {scheduler: true}\n    members: [mara]\n",
      'unknown field "scheduler"',
    ],
    [
      "credential URL",
      "version: 1\nname: sample\nworkspace:\n  repository: https://user:secret@example.com/repo.git\n  clone: per_persona\npersonas: [{id: mara}]\n",
      "must not contain URL credentials",
    ],
    [
      "missing first-day source for the runtime prompt",
      "version: 1\nname: sample\npersonas:\n  - id: mara\n    runtime: {command: claude, prompt: first_day}\n",
      "first_day is not declared",
    ],
    [
      "out-of-range room setting",
      "version: 1\nname: sample\npersonas: [{id: mara}]\nrooms:\n  - id: room\n    creator: mara\n    about: Work\n    settings: {max_open_decisions: 99}\n    members: [mara]\n",
      "between 1 and 5",
    ],
  ])("rejects %s", (_name, source, message) => {
    expect(() => parseOrganizationManifest(source)).toThrow(message);
  });

  // Spec 174 — an unknown-but-well-formed mechanism parses (the host is the
  // authority on support) and surfaces as a warning; malformed slugs still
  // hard-fail, and the discovery check names offenders precisely.
  it("accepts an unknown mechanism slug with a warning instead of an error", () => {
    const manifest = parseOrganizationManifest(
      [
        "version: 1",
        "name: sample",
        "personas: [{id: mara}]",
        "rooms:",
        "  - id: lab",
        "    creator: mara",
        "    about: Try the new mechanism",
        "    mechanism: liquid_democracy",
        "    members: [mara]",
      ].join("\n"),
    );
    expect(manifest.rooms[0]?.mechanism).toBe("liquid_democracy");
    const warnings = manifestMechanismWarnings(manifest);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("liquid_democracy");
    expect(warnings[0]).toContain("--host");

    expect(unsupportedMechanisms(manifest, ["liquid_democracy"])).toEqual([]);
    expect(unsupportedMechanisms(manifest, ["simple_majority"])).toEqual([
      { roomId: "lab", mechanism: "liquid_democracy" },
    ]);
  });

  it("rejects a malformed mechanism value", () => {
    expect(() =>
      parseOrganizationManifest(
        [
          "version: 1",
          "name: sample",
          "personas: [{id: mara}]",
          "rooms:",
          "  - id: lab",
          "    creator: mara",
          "    about: Bad mechanism",
          "    mechanism: 'Not A Slug!'",
          "    members: [mara]",
        ].join("\n"),
      ),
    ).toThrow(/mechanism must be a lowercase mechanism slug/);
  });

  it("rejects packet paths that escape the manifest directory", () => {
    const root = fixture();
    const path = pathJoin(root, "organization.yaml");
    writeFileSync(
      path,
      "version: 1\nname: sample\npersonas:\n  - id: mara\n    instructions: ../outside.md\n",
    );

    expect(() => loadOrganizationManifest(path)).toThrow("escapes the manifest directory");
  });

  it("rejects packet symlinks", () => {
    const root = fixture();
    symlinkSync(pathJoin(root, "personas", "mara.md"), pathJoin(root, "linked.md"));
    const path = pathJoin(root, "organization.yaml");
    writeFileSync(
      path,
      "version: 1\nname: sample\npersonas:\n  - id: mara\n    instructions: linked.md\n",
    );

    expect(() => loadOrganizationManifest(path)).toThrow("regular non-symlink file");
  });
});
