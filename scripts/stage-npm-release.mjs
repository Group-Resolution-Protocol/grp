#!/usr/bin/env node

// Runs only inside the approval-gated public npm release environment. It
// stages exactly the tarballs retained by verify-npm-packages.mjs and never
// discovers packages or versions from mutable workflow text.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_PACKAGES = new Set([
  "@grp-protocol/audit",
  "@grp-protocol/engine",
  "@grp-protocol/sdk",
  "@grp-protocol/conformance",
  "@grp-protocol/cli",
]);

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function validateReleaseBundle(bundle) {
  const manifestPath = join(bundle, "RELEASE-MANIFEST.json");
  const checksumPath = join(bundle, "SHA256SUMS");
  if (!existsSync(manifestPath) || !existsSync(checksumPath)) {
    throw new Error("release bundle is missing its manifest or checksum list");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.packages)) {
    throw new Error("release manifest is malformed or unsupported");
  }
  if (manifest.packages.length === 0) throw new Error("release manifest selects no packages");

  const seenNames = new Set();
  const seenFiles = new Set();
  const checksumLines = [];
  for (const entry of manifest.packages) {
    if (!PUBLIC_PACKAGES.has(entry.name)) throw new Error(`unexpected package: ${entry.name}`);
    if (seenNames.has(entry.name)) throw new Error(`duplicate package: ${entry.name}`);
    seenNames.add(entry.name);
    if (basename(entry.filename) !== entry.filename || !entry.filename.endsWith(".tgz")) {
      throw new Error(`unsafe release filename: ${entry.filename}`);
    }
    if (seenFiles.has(entry.filename)) throw new Error(`duplicate tarball: ${entry.filename}`);
    seenFiles.add(entry.filename);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.version)) {
      throw new Error(`invalid package version for ${entry.name}: ${entry.version}`);
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`invalid SHA-256 for ${entry.filename}`);
    }
    const tarball = join(bundle, entry.filename);
    if (!existsSync(tarball)) throw new Error(`release tarball is missing: ${entry.filename}`);
    if (sha256(tarball) !== entry.sha256)
      throw new Error(`release hash mismatch: ${entry.filename}`);
    checksumLines.push(`${entry.sha256}  ${entry.filename}`);
  }

  const actualTarballs = readdirSync(bundle)
    .filter((entry) => entry.endsWith(".tgz"))
    .sort();
  const expectedTarballs = [...seenFiles].sort();
  if (JSON.stringify(actualTarballs) !== JSON.stringify(expectedTarballs)) {
    throw new Error("release bundle contains an undeclared tarball");
  }
  const expectedChecksums = `${checksumLines.sort().join("\n")}\n`;
  if (readFileSync(checksumPath, "utf8") !== expectedChecksums) {
    throw new Error("SHA256SUMS does not exactly match the release manifest");
  }
  return manifest.packages;
}

function run() {
  const bundleValue = option("bundle");
  const npmCliValue = option("npm-cli");
  if (!bundleValue || !npmCliValue) {
    console.error("[npm-stage] --bundle and --npm-cli are required");
    process.exit(2);
  }
  try {
    const bundle = resolve(bundleValue);
    const npmCli = resolve(npmCliValue);
    if (!existsSync(npmCli)) throw new Error(`npm CLI is missing: ${npmCli}`);
    const packages = validateReleaseBundle(bundle);
    for (const entry of packages) {
      const tarball = join(bundle, entry.filename);
      console.log(`[npm-stage] staging ${entry.name}@${entry.version}`);
      if (!process.argv.includes("--dry-run")) {
        execFileSync(process.execPath, [npmCli, "stage", "publish", "--ignore-scripts", tarball], {
          stdio: "inherit",
        });
      }
    }
    console.log(
      process.argv.includes("--dry-run")
        ? `[npm-stage] DRY RUN — validated ${packages.length} exact package(s)`
        : `[npm-stage] submitted ${packages.length} exact package(s) for maintainer review`,
    );
  } catch (error) {
    console.error(`[npm-stage] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
