import assert from "node:assert/strict";
import test from "node:test";

import { validateTrackedEntries } from "./check-repository-boundary.mjs";

function entry(repoPath, content = "public", mode = "100644") {
  return { path: repoPath, mode, stage: 0, content };
}

test("accepts the intended public source surface and synthetic env examples", () => {
  assert.deepEqual(
    validateTrackedEntries([
      entry("README.md"),
      entry("apps/docs/content/community/fix.mdx"),
      entry("packages/cli/src/example.ts"),
      entry("packages/agent-sdk/.env.local.example", "API_ORIGIN=https://example.test"),
      entry("packages/cli/bin/grp.js", "#!/usr/bin/env node", "100755"),
    ]),
    [],
  );
});

test("rejects private application and package roots", () => {
  const privateApiPath = ["apps", "api", "src/index.ts"].join("/");
  const privateWebPath = ["apps", "web", "app/page.tsx"].join("/");
  const privatePackagePath = ["packages", "shared", "src/env.ts"].join("/");
  const failures = validateTrackedEntries([
    entry(privateApiPath),
    entry(privateWebPath),
    entry(privatePackagePath),
  ]);
  assert.equal(failures.length, 3);
  assert.ok(failures.every((failure) => failure.includes("tracked-path allowlist")));
});

test("rejects internal, provider, migration, and credential-shaped paths", () => {
  const failures = validateTrackedEntries([
    entry("apps/docs/.vercel/project.json"),
    entry("apps/docs/research/notes.md"),
    entry("apps/docs/migrations/001.sql"),
    entry("packages/cli/.env.production"),
    entry("packages/engine/signing.pem"),
    entry("fly.toml"),
  ]);
  for (const expected of [
    ".vercel",
    "research",
    "migrations",
    ".env.production",
    "signing.pem",
    "fly.toml",
  ]) {
    assert.ok(
      failures.some((failure) => failure.includes(expected)),
      expected,
    );
  }
});

test("rejects the retired sync machinery", () => {
  const failures = validateTrackedEntries([
    entry(".grp-public-sync.json"),
    entry("MIRROR-MANIFEST.json"),
    entry(".github/workflows/sync-integrity.yml"),
    entry("scripts/public-sync-policy.mjs"),
    entry("scripts/verify-public-sync.mjs"),
  ]);
  assert.equal(failures.filter((failure) => failure.includes("legacy")).length, 5);
});

test("rejects private identifiers and paths without echoing content", () => {
  const privateRepositoryName = ["Alt", "rul"].join("");
  const workstationPath = ["/", "Users", "/example/work/grp/"].join("");
  const privateSourcePath = ["apps", "api", "src/config.ts"].join("/");
  const providerStateId = ["prj", "example123456"].join("_");
  const failures = validateTrackedEntries([
    entry("README.md", `See the ${privateRepositoryName} repository`),
    entry("CONTRIBUTING.md", `checkout: ${workstationPath}`),
    entry("NOTICE", Buffer.from(`source: ${privateSourcePath}\0state: ${providerStateId}`)),
  ]);
  assert.ok(failures.some((failure) => failure.includes("private repository identifier")));
  assert.ok(failures.some((failure) => failure.includes("local absolute filesystem path")));
  assert.ok(failures.some((failure) => failure.includes("private application path prefix")));
  assert.ok(failures.some((failure) => failure.includes("provider state identifier")));
  assert.ok(failures.every((failure) => !failure.includes(workstationPath)));
});

test("rejects symlinks, submodules, unexpected executables, and conflicted index stages", () => {
  const failures = validateTrackedEntries([
    { ...entry("README.md"), mode: "120000" },
    { ...entry("packages/cli/vendor"), mode: "160000" },
    entry("apps/docs/content/run.sh", "#!/bin/sh", "100755"),
    { ...entry("NOTICE"), stage: 2 },
  ]);
  assert.ok(failures.some((failure) => failure.includes("120000")));
  assert.ok(failures.some((failure) => failure.includes("160000")));
  assert.ok(failures.some((failure) => failure.includes("unexpected executable")));
  assert.ok(failures.some((failure) => failure.includes("index stage 2")));
});
