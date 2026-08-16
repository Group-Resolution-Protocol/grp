#!/usr/bin/env node
// Spec 196 — the public release workflow must publish from the same GitHub
// repository named in each package's provenance metadata. The private source
// tree intentionally has no public-repository URL, so callers provide the
// expected public URL explicitly.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const repositoryFlag = process.argv.find((arg) => arg.startsWith("--repository="));
const repository = repositoryFlag?.slice("--repository=".length).replace(/\.git$/, "");

if (!repository || !/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repository)) {
  console.error(
    "usage: node scripts/check-npm-release-metadata.mjs --repository=https://github.com/OWNER/REPO",
  );
  process.exit(2);
}

const expected = `git+${repository}.git`;
const packageDirs = ["audit", "engine", "agent-sdk", "conformance", "cli"];
const errors = [];

for (const dir of packageDirs) {
  const path = join(repoRoot, "packages", dir, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  if (pkg.repository?.type !== "git" || pkg.repository?.url !== expected) {
    errors.push(`${pkg.name}: repository.url must be ${expected}`);
  }
}

for (const error of errors) console.error(`[npm-metadata] ${error}`);
if (errors.length > 0) process.exit(1);
console.log(`[npm-metadata] PASS — all five packages bind provenance to ${repository}`);
