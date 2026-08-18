#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_GENERATED_PATHS,
  PUBLIC_SYNC_MANIFEST_PATH,
  isAllowedPublicDestination,
} from "./public-sync-policy.mjs";

const SECRET_PATTERNS = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key block"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "sk- API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\b(?:t|pt|it)_[A-Za-z0-9_-]{32,}/, "GRP room or invite credential"],
  [/\b(?:ak|rk)_(?:live|test)_[A-Za-z0-9_-]{32,}/, "GRP hosted API key"],
  [/\b(?:whsec|dc)_[A-Za-z0-9_-]{32,}/, "GRP webhook or OAuth device secret"],
  [
    /postgres(?:ql)?:\/\/[^\s"'`]*:[^\s"'`@]{8,}@(?!localhost|127\.0\.0\.1)/,
    "database URL with password",
  ],
];
const TEXT_LIKE = /\.(?:md|mdx|ts|tsx|js|mjs|cjs|json|yaml|yml|sh|txt|html|css)$/;
const expectedGeneratedPaths = new Set(PUBLIC_GENERATED_PATHS);

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function git(repo, args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: repo, encoding });
}

function gitFile(repo, ref, path) {
  return git(repo, ["show", `${ref}:${path}`], null);
}

function gitPathExists(repo, ref, path) {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}:${path}`], {
      cwd: repo,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function changedPaths(repo, base, head) {
  return git(repo, [
    "diff",
    "--no-renames",
    "--name-only",
    "--diff-filter=ACDMRTUXB",
    "-z",
    `${base}...${head}`,
  ])
    .split("\0")
    .filter(Boolean)
    .sort();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertUniqueAllowed(paths, label) {
  const seen = new Set();
  for (const path of paths) {
    if (seen.has(path)) throw new Error(`${label} contains a duplicate path: ${path}`);
    seen.add(path);
    if (!isAllowedPublicDestination(path)) {
      throw new Error(`${label} contains a path outside the public allowlist: ${path}`);
    }
  }
}

function verifyManifest(repo, base, head, changed) {
  if (!changed.includes(PUBLIC_SYNC_MANIFEST_PATH)) {
    throw new Error(
      `no ${PUBLIC_SYNC_MANIFEST_PATH} change: this is a proposal PR and cannot merge directly; a maintainer must import it into the source of truth and return a verified sync`,
    );
  }
  const manifest = JSON.parse(gitFile(repo, head, PUBLIC_SYNC_MANIFEST_PATH).toString("utf8"));
  const expectedKeys = [
    "bundle_sha256",
    "deletions",
    "exact_files",
    "generated_files",
    "public_base",
    "schema_version",
    "sync_id",
  ];
  if (
    manifest.schema_version !== 1 ||
    !/^[a-z0-9][a-z0-9._-]{2,80}$/.test(manifest.sync_id ?? "") ||
    !Array.isArray(manifest.exact_files) ||
    !Array.isArray(manifest.deletions) ||
    !Array.isArray(manifest.generated_files) ||
    typeof manifest.public_base !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.bundle_sha256 ?? "") ||
    JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(expectedKeys)
  ) {
    throw new Error("public sync manifest is malformed or uses an unsupported schema");
  }
  const resolvedBase = git(repo, ["rev-parse", base]).trim();
  if (manifest.public_base !== resolvedBase) {
    throw new Error(
      `manifest public_base ${manifest.public_base} does not match PR base ${resolvedBase}`,
    );
  }

  for (const entry of manifest.exact_files) {
    if (
      !entry ||
      JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["path", "sha256"])
    ) {
      throw new Error("exact_files contains a malformed entry");
    }
  }
  const exactPaths = manifest.exact_files.map((entry) => entry.path);
  assertUniqueAllowed(exactPaths, "exact_files");
  assertUniqueAllowed(manifest.deletions, "deletions");
  assertUniqueAllowed(manifest.generated_files, "generated_files");
  for (const path of manifest.generated_files) {
    if (!expectedGeneratedPaths.has(path)) {
      throw new Error(`generated_files contains an undeclared generated path: ${path}`);
    }
  }
  const acrossSections = [
    ...exactPaths,
    ...manifest.deletions,
    ...manifest.generated_files,
    PUBLIC_SYNC_MANIFEST_PATH,
  ];
  if (new Set(acrossSections).size !== acrossSections.length) {
    throw new Error("the same path appears in more than one manifest section");
  }

  const digestInput = JSON.stringify({
    schema_version: 1,
    sync_id: manifest.sync_id,
    public_base: manifest.public_base,
    exact_files: manifest.exact_files,
    deletions: manifest.deletions,
    generated_files: manifest.generated_files,
  });
  if (sha256(digestInput) !== manifest.bundle_sha256) {
    throw new Error("manifest bundle_sha256 does not match its canonical contents");
  }

  for (const entry of manifest.exact_files) {
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`invalid SHA-256 for exact file: ${entry.path}`);
    }
    if (!gitPathExists(repo, head, entry.path)) {
      throw new Error(`exact file is absent at PR head: ${entry.path}`);
    }
    const actual = sha256(gitFile(repo, head, entry.path));
    if (actual !== entry.sha256) throw new Error(`exact file hash mismatch: ${entry.path}`);
  }
  for (const path of manifest.deletions) {
    if (gitPathExists(repo, head, path)) throw new Error(`declared deletion still exists: ${path}`);
  }
  for (const path of manifest.generated_files) {
    if (!gitPathExists(repo, head, path)) throw new Error(`generated file is absent: ${path}`);
  }

  const required = new Set([
    ...exactPaths,
    ...manifest.deletions,
    ...manifest.generated_files,
    PUBLIC_SYNC_MANIFEST_PATH,
  ]);
  const allowed = required;
  for (const path of required) {
    if (!changed.includes(path)) throw new Error(`manifest path is not changed in the PR: ${path}`);
  }
  for (const path of changed) {
    if (!allowed.has(path)) throw new Error(`PR contains an undeclared changed path: ${path}`);
  }

  return manifest;
}

function scanChangedText(repo, head, changed) {
  for (const path of changed) {
    if (!gitPathExists(repo, head, path) || !TEXT_LIKE.test(path)) continue;
    const content = gitFile(repo, head, path).toString("utf8");
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(content))
        throw new Error(`changed file contains possible ${label}: ${path}`);
    }
  }
}

function run() {
  const repo = resolve(option("repo") ?? fileURLToPath(new URL("../..", import.meta.url)));
  const base = option("base");
  const head = option("head") ?? "HEAD";
  if (!base) {
    console.error("[verify-public-sync] --base=<git-ref> is required");
    process.exit(2);
  }
  try {
    const changed = changedPaths(repo, base, head);
    if (changed.length === 0) throw new Error("PR contains no changed files");
    const manifest = verifyManifest(repo, base, head, changed);
    scanChangedText(repo, head, changed);
    console.log(
      `[verify-public-sync] PASS ${manifest.sync_id}: ${changed.length} declared changed file(s), bundle sha256:${manifest.bundle_sha256}`,
    );
  } catch (error) {
    console.error(
      `[verify-public-sync] FAIL: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
