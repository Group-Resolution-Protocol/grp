#!/usr/bin/env node

// Regenerate the public workspace lockfile without letting npm encode the
// CLI's pack-only bundledDependencies field as a workspace file dependency.
// Existing lock selections are preserved where they still satisfy manifests.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function packageManifests(repo) {
  const packagesRoot = join(repo, "packages");
  if (!existsSync(packagesRoot)) return [];
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesRoot, entry.name, "package.json"))
    .filter(existsSync);
}

function exactRootOverrides(repo) {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  return Object.entries(pkg.overrides ?? {}).filter(
    ([, version]) => typeof version === "string" && EXACT_VERSION.test(version),
  );
}

function lockSelectionMatchesPackage(lockPath, packageName) {
  return (
    lockPath === `node_modules/${packageName}` || lockPath.endsWith(`/node_modules/${packageName}`)
  );
}

export function pruneStaleRootOverrideSelections(repo) {
  const lockPath = join(repo, "package-lock.json");
  if (!existsSync(lockPath)) return [];

  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const packages = lock.packages ?? {};
  const pruned = [];
  for (const [packageName, requiredVersion] of exactRootOverrides(repo)) {
    for (const [selectionPath, selection] of Object.entries(packages)) {
      if (!lockSelectionMatchesPackage(selectionPath, packageName)) continue;
      if (selection?.version === requiredVersion) continue;
      delete packages[selectionPath];
      pruned.push(`${selectionPath}@${selection?.version ?? "unknown"}`);
    }
  }

  if (pruned.length > 0) writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return pruned.sort();
}

function assertRootOverrideSelections(repo) {
  const lock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8"));
  const packages = lock.packages ?? {};
  for (const [packageName, requiredVersion] of exactRootOverrides(repo)) {
    for (const [selectionPath, selection] of Object.entries(packages)) {
      if (!lockSelectionMatchesPackage(selectionPath, packageName)) continue;
      if (selection?.version !== requiredVersion) {
        throw new Error(
          `${selectionPath} resolved to ${selection?.version ?? "unknown"}; expected root override ${requiredVersion}`,
        );
      }
    }
  }
}

export function regeneratePublicLockfile(repo, options = {}) {
  const restoredManifests = [];
  for (const packagePath of packageManifests(repo)) {
    const raw = readFileSync(packagePath, "utf8");
    const pkg = JSON.parse(raw);
    if (pkg.bundledDependencies === undefined && pkg.bundleDependencies === undefined) continue;
    restoredManifests.push([packagePath, raw]);
    pkg.bundledDependencies = undefined;
    pkg.bundleDependencies = undefined;
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  try {
    pruneStaleRootOverrideSelections(repo);
    execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
      cwd: repo,
      stdio: options.stdio ?? "inherit",
    });
    assertRootOverrideSelections(repo);
  } finally {
    for (const [packagePath, raw] of restoredManifests) writeFileSync(packagePath, raw);
  }
}

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function run() {
  const repo = resolve(option("repo") ?? fileURLToPath(new URL("..", import.meta.url)));
  try {
    regeneratePublicLockfile(repo);
    console.log("[public-lockfile] package-lock.json regenerated");
  } catch (error) {
    console.error(
      `[public-lockfile] regeneration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
