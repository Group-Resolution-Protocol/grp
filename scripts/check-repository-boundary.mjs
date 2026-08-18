#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_TRACKED_FILE_BYTES = 20 * 1024 * 1024;

const ALLOWED_ROOT_FILES = new Set([
  ".gitignore",
  "CONTRIBUTING.md",
  "GOVERNANCE.md",
  "LICENSE",
  "LICENSE-docs",
  "NOTICE",
  "README.md",
  "RELEASING.md",
  "SECURITY.md",
  "TRADEMARK.md",
  "biome.json",
  "package-lock.json",
  "package.json",
  "tsconfig.base.json",
]);

const ALLOWED_GITHUB_FILES = new Set([
  ".github/CODEOWNERS",
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/docs.yml",
  ".github/ISSUE_TEMPLATE/question.yml",
  ".github/pull_request_template.md",
  ".github/workflows/ci.yml",
  ".github/workflows/publish.yml",
]);

const ALLOWED_SCRIPTS = new Set([
  "scripts/check-npm-release-metadata.mjs",
  "scripts/check-public-docs.mjs",
  "scripts/check-repository-boundary.mjs",
  "scripts/check-repository-boundary.test.mjs",
  "scripts/regenerate-public-lockfile.mjs",
  "scripts/stage-npm-release.mjs",
  "scripts/verify-npm-packages.mjs",
]);

const ALLOWED_PUBLIC_TREES = [
  "apps/docs/",
  "docs/reference/openapi/",
  "examples/canonical-trials/",
  "examples/evidence-trials/",
  "packages/agent-sdk/",
  "packages/audit/",
  "packages/cli/",
  "packages/conformance/",
  "packages/engine/",
];

const ALLOWED_EXECUTABLES = new Set([
  "packages/cli/bin/grp.js",
  "packages/conformance/bin/grp-conformance.ts",
]);

const FORBIDDEN_PATH_SEGMENTS = new Set([
  ".fly",
  ".inngest",
  ".neon",
  ".terraform",
  ".vercel",
  "infra",
  "infrastructure",
  "internal",
  "migration",
  "migrations",
  "research",
  "runbook",
  "runbooks",
  "trial-workspaces",
]);

const FORBIDDEN_EXACT_PATHS = new Map([
  [".grp-public-sync.json", "legacy private-to-public sync manifest"],
  ["MIRROR-MANIFEST.json", "legacy private mirror manifest"],
  [".github/workflows/sync-integrity.yml", "legacy privileged sync workflow"],
  ["scripts/public-sync-policy.mjs", "legacy private mirror policy"],
  ["scripts/verify-public-sync.mjs", "legacy private sync verifier"],
]);

const FORBIDDEN_PROVIDER_FILES = [
  /^fly(?:\.[^.]+)?\.toml$/i,
  /^neon-project\.json$/i,
  /^serverless\.ya?ml$/i,
  /^terraform\.tfstate(?:\.backup)?$/i,
  /^wrangler\.toml$/i,
];

const FORBIDDEN_CONTENT = [
  { pattern: /\baltrul\b/i, reason: "private repository identifier" },
  {
    pattern: /\bapps\/(?:api|web)(?:\/|\b)/i,
    reason: "private application path prefix",
  },
  {
    pattern: /\bpackages\/shared(?:\/|\b)/i,
    reason: "private package path prefix",
  },
  {
    pattern: /\b(?:dpl|prj|team)_[A-Za-z0-9]{8,}\b/,
    reason: "provider state identifier",
  },
  {
    pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+\//,
    reason: "local absolute filesystem path",
  },
  { pattern: /\/private\/(?:tmp|var)\//, reason: "local absolute filesystem path" },
  {
    pattern: /\b[A-Za-z]:\\Users\\[^\\\r\n]+\\/i,
    reason: "local absolute filesystem path",
  },
];

export function validateTrackedEntries(entries) {
  const failures = [];

  for (const entry of entries) {
    const repoPath = entry.path;
    if (!isCanonicalRepoPath(repoPath)) {
      failures.push(`${displayPath(repoPath)}: non-canonical repository path`);
      continue;
    }

    const exactReason = FORBIDDEN_EXACT_PATHS.get(repoPath);
    if (exactReason) failures.push(`${displayPath(repoPath)}: ${exactReason} is forbidden`);

    if (!isAllowedPublicPath(repoPath)) {
      failures.push(`${displayPath(repoPath)}: outside the public tracked-path allowlist`);
    }

    const pathReason = forbiddenPathReason(repoPath);
    if (pathReason) failures.push(`${displayPath(repoPath)}: ${pathReason}`);

    if (entry.stage !== 0) {
      failures.push(`${displayPath(repoPath)}: unresolved Git index stage ${entry.stage}`);
    }

    if (entry.mode !== "100644" && entry.mode !== "100755") {
      failures.push(`${displayPath(repoPath)}: file mode ${entry.mode} is not a regular file`);
    } else if (entry.mode === "100755" && !ALLOWED_EXECUTABLES.has(repoPath)) {
      failures.push(`${displayPath(repoPath)}: unexpected executable file`);
    }

    const buffer = contentBuffer(entry.content);
    if (buffer.length > MAX_TRACKED_FILE_BYTES) {
      failures.push(
        `${displayPath(repoPath)}: exceeds the ${MAX_TRACKED_FILE_BYTES / (1024 * 1024)} MiB security-scan limit`,
      );
    }
    const content = buffer.toString("latin1");
    for (const { pattern, reason } of FORBIDDEN_CONTENT) {
      if (pattern.test(content)) failures.push(`${displayPath(repoPath)}: contains ${reason}`);
    }
  }

  return [...new Set(failures)].sort();
}

export function isAllowedPublicPath(repoPath) {
  return (
    ALLOWED_ROOT_FILES.has(repoPath) ||
    ALLOWED_GITHUB_FILES.has(repoPath) ||
    ALLOWED_SCRIPTS.has(repoPath) ||
    ALLOWED_PUBLIC_TREES.some((prefix) => repoPath.startsWith(prefix))
  );
}

function forbiddenPathReason(repoPath) {
  const segments = repoPath.toLowerCase().split("/");
  const basename = segments.at(-1);

  for (const segment of segments) {
    if (FORBIDDEN_PATH_SEGMENTS.has(segment)) {
      return `private/provider path segment ${JSON.stringify(segment)} is forbidden`;
    }
  }

  if (basename === ".npmrc") return "tracked npm credential configuration is forbidden";
  if (basename === ".env" || (basename.startsWith(".env.") && !isEnvExample(basename))) {
    return "tracked environment file is forbidden";
  }
  if (/\.(?:key|p12|pem|pfx)$/i.test(basename)) {
    return "tracked key or certificate container is forbidden";
  }
  if (/\.(?:tf|tfvars|tfstate)$/i.test(basename)) {
    return "tracked infrastructure state or configuration is forbidden";
  }
  if (FORBIDDEN_PROVIDER_FILES.some((pattern) => pattern.test(basename))) {
    return "tracked provider state or configuration is forbidden";
  }

  return null;
}

function isEnvExample(basename) {
  return basename === ".env.example" || /^\.env\..+\.example$/.test(basename);
}

function isCanonicalRepoPath(repoPath) {
  if (typeof repoPath !== "string" || repoPath.length === 0 || repoPath.startsWith("/")) {
    return false;
  }
  if (
    repoPath.includes("\\") ||
    [...repoPath].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    return false;
  }
  return repoPath
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function contentBuffer(content) {
  return Buffer.isBuffer(content) ? content : Buffer.from(content ?? "", "utf8");
}

function displayPath(repoPath) {
  return JSON.stringify(repoPath);
}

function readTrackedEntries() {
  const indexOutput = execFileSync("git", ["ls-files", "--stage", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const indexEntries = indexOutput
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d+) ([0-9a-f]+) (\d+)\t([\s\S]+)$/.exec(record);
      if (!match) return { path: record, mode: "unknown", stage: -1 };
      const [, mode, , stageText, repoPath] = match;
      return { path: repoPath, mode, stage: Number(stageText) };
    });

  const indexedByPath = new Map();
  for (const entry of indexEntries) {
    const existing = indexedByPath.get(entry.path) ?? [];
    existing.push(entry);
    indexedByPath.set(entry.path, existing);
  }

  const candidatePaths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
  const entries = [];

  for (const repoPath of [...new Set(candidatePaths)].sort()) {
    const resolved = isCanonicalRepoPath(repoPath) ? path.join(repoRoot, repoPath) : null;
    const indexed = indexedByPath.get(repoPath) ?? [];
    if (!resolved || !existsSync(resolved)) {
      entries.push(
        ...indexed.filter((entry) => entry.stage !== 0).map((entry) => ({ ...entry, content: "" })),
      );
      continue;
    }

    const stat = lstatSync(resolved);
    const fallbackMode = stat.isSymbolicLink()
      ? "120000"
      : stat.isFile() && (stat.mode & 0o111) !== 0
        ? "100755"
        : "100644";
    const content = stat.isFile() ? readFileSync(resolved) : "";

    if (indexed.some((entry) => entry.stage !== 0)) {
      entries.push(...indexed.map((entry) => ({ ...entry, content })));
    } else {
      entries.push({
        path: repoPath,
        mode: indexed[0]?.mode ?? fallbackMode,
        stage: indexed[0]?.stage ?? 0,
        content,
      });
    }
  }

  return entries;
}

function main() {
  const entries = readTrackedEntries();
  const failures = validateTrackedEntries(entries);

  if (failures.length > 0) {
    process.stderr.write(`Repository boundary check failed (${failures.length}):\n`);
    for (const failure of failures) process.stderr.write(`- ${failure}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Repository boundary check passed (${entries.length} tracked files).\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
