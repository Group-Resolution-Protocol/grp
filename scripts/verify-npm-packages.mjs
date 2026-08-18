#!/usr/bin/env node
// Specs 196/209/214 — pack the selected public packages exactly as npm would,
// reject archive drift, install those tarballs in an empty consumer, and
// exercise their public package names and binaries. This script never
// publishes. With no --packages flag it verifies all five packages.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const artifactDirFlag = process.argv.find((arg) => arg.startsWith("--artifact-dir="));
const artifactDirValue = artifactDirFlag?.slice("--artifact-dir=".length);
if (artifactDirFlag && !artifactDirValue) {
  console.error("[npm-release] --artifact-dir requires a non-empty path");
  process.exit(2);
}
const artifactDir = artifactDirValue ? resolve(repoRoot, artifactDirValue) : undefined;
if (artifactDir && existsSync(artifactDir) && readdirSync(artifactDir).length > 0) {
  console.error(`[npm-release] artifact output directory is not empty: ${artifactDir}`);
  process.exit(2);
}
// npm's tar writer is not byte-stable across major CLI versions. Use one
// explicit packer everywhere so the hosted installer digest proves the same
// source artifact on developer machines, CI runners, and the release host.
const canonicalPackNpmVersion = "11.11.0";
const packageCatalog = [
  { id: "audit", name: "@grp-protocol/audit", dir: "packages/audit" },
  { id: "engine", name: "@grp-protocol/engine", dir: "packages/engine" },
  { id: "sdk", name: "@grp-protocol/sdk", dir: "packages/agent-sdk" },
  { id: "conformance", name: "@grp-protocol/conformance", dir: "packages/conformance" },
  { id: "cli", name: "@grp-protocol/cli", dir: "packages/cli" },
];
for (const pkg of packageCatalog) {
  pkg.version = JSON.parse(readFileSync(join(repoRoot, pkg.dir, "package.json"), "utf8")).version;
}
const packagesFlag = process.argv.find((arg) => arg.startsWith("--packages="));
const requestedPackageIds = packagesFlag
  ? packagesFlag
      .slice("--packages=".length)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  : packageCatalog.map((pkg) => pkg.id);
const unknownPackageIds = requestedPackageIds.filter(
  (id) => !packageCatalog.some((pkg) => pkg.id === id || pkg.name === id),
);
if (requestedPackageIds.length === 0 || unknownPackageIds.length > 0) {
  console.error(
    `[npm-release] --packages must select one or more of ${packageCatalog
      .map((pkg) => pkg.id)
      .join(", ")}; unknown: ${unknownPackageIds.join(", ") || "empty selection"}`,
  );
  process.exit(2);
}
const packages = packageCatalog.filter((pkg) =>
  requestedPackageIds.some((id) => id === pkg.id || id === pkg.name),
);

const scratch = mkdtempSync(join(tmpdir(), "grp-npm-release-"));
const tarballDir = join(scratch, "tarballs");
const consumerDir = join(scratch, "consumer");
const canonicalNpmDir = join(scratch, "canonical-npm");
mkdirSync(tarballDir, { recursive: true });
mkdirSync(consumerDir, { recursive: true });
mkdirSync(canonicalNpmDir, { recursive: true });

let failed = false;
try {
  console.log(`[npm-release] installing canonical packer npm@${canonicalPackNpmVersion}`);
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--prefix",
      canonicalNpmDir,
      `npm@${canonicalPackNpmVersion}`,
    ],
    scratch,
    "inherit",
  );
  const canonicalNpmCli = join(canonicalNpmDir, "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(canonicalNpmCli)) {
    throw new Error(`canonical npm CLI was not installed: ${canonicalNpmCli}`);
  }

  const tarballs = [];
  const releaseEntries = [];
  let packedCli;
  for (const pkg of packages) {
    console.log(`[npm-release] packing ${pkg.name} with npm@${canonicalPackNpmVersion}`);
    const output = run(
      process.execPath,
      [canonicalNpmCli, "pack", "--json", "--pack-destination", tarballDir],
      join(repoRoot, pkg.dir),
      "pipe",
    );
    const packed = parsePackJson(output);
    if (packed.name !== pkg.name || packed.version !== pkg.version) {
      throw new Error(
        `${pkg.name}: npm pack reported ${packed.name}@${packed.version}, expected ${pkg.name}@${pkg.version}`,
      );
    }
    const tarball = join(tarballDir, packed.filename);
    inspectTarball(pkg.name, pkg.version, tarball);
    const tarballSha256 = sha256File(tarball);
    console.log(`[npm-release] tarball ${pkg.name}: sha256:${tarballSha256}`);
    tarballs.push(tarball);
    releaseEntries.push({
      id: pkg.id,
      name: pkg.name,
      version: pkg.version,
      filename: basename(tarball),
      sha256: tarballSha256,
    });
    if (pkg.name === "@grp-protocol/cli") packedCli = { tarball, version: pkg.version };
  }

  if (packedCli) verifyServedCliArtifact(packedCli.tarball, packedCli.version);

  writeFileSync(
    join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "grp-v0-1-consumer-smoke",
        version: "1.0.0",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );

  console.log("[npm-release] installing exact tarballs in an empty consumer");
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", ...tarballs],
    consumerDir,
    "inherit",
  );

  const smokeSource = consumerSmokeSource(new Set(packages.map((pkg) => pkg.id)));
  if (smokeSource) {
    const smokePath = join(consumerDir, "smoke.mjs");
    writeFileSync(smokePath, smokeSource);
    run("node", [smokePath], consumerDir, "inherit");
  }

  if (packedCli) {
    const grpOutput = run(installedBin("grp"), ["--version"], consumerDir, "pipe").trim();
    if (!grpOutput.includes(`grp ${packedCli.version}`)) {
      throw new Error(`installed grp --version returned ${JSON.stringify(grpOutput)}`);
    }
  }

  if (packages.some((pkg) => pkg.id === "conformance")) {
    const conformanceOutput = run(
      installedBin("grp-conformance"),
      ["--profile=core"],
      consumerDir,
      "pipe",
    );
    const conformance = JSON.parse(conformanceOutput);
    if (
      conformance.protocol_version !== "grp/0.1" ||
      conformance.summary?.fail !== 0 ||
      !(conformance.summary?.pass > 0)
    ) {
      throw new Error("installed grp-conformance did not pass the offline core profile");
    }
  }

  if (artifactDir) {
    mkdirSync(artifactDir, { recursive: true });
    const checksums = [];
    for (const tarball of tarballs) {
      const filename = basename(tarball);
      copyFileSync(tarball, join(artifactDir, filename));
      checksums.push(`${sha256File(tarball)}  ${filename}`);
    }
    writeFileSync(join(artifactDir, "SHA256SUMS"), `${checksums.sort().join("\n")}\n`);
    writeFileSync(
      join(artifactDir, "RELEASE-MANIFEST.json"),
      `${JSON.stringify({ schema_version: 1, packages: releaseEntries }, null, 2)}\n`,
    );
    console.log(`[npm-release] retained verified artifacts in ${artifactDir}`);
  }

  console.log(
    `[npm-release] PASS — ${packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ")} install and run cleanly`,
  );
} catch (error) {
  failed = true;
  console.error(`[npm-release] FAIL — ${error instanceof Error ? error.message : String(error)}`);
  console.error(`[npm-release] scratch kept for inspection: ${scratch}`);
} finally {
  if (!failed) rmSync(scratch, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);

function inspectTarball(expectedName, expectedVersion, tarball) {
  if (!existsSync(tarball)) throw new Error(`${expectedName}: tarball was not created`);
  const entries = run("tar", ["-tzf", tarball], repoRoot, "pipe")
    .split("\n")
    .filter(Boolean)
    .map((entry) => entry.replace(/^\.\//, ""));
  const entrySet = new Set(entries);
  const manifest = JSON.parse(
    run("tar", ["-xOf", tarball, "package/package.json"], repoRoot, "pipe"),
  );

  if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
    throw new Error(
      `${expectedName}: packed manifest is ${manifest.name}@${manifest.version}, expected ${expectedVersion}`,
    );
  }
  if (manifest.private === true || manifest.publishConfig?.access !== "public") {
    throw new Error(`${expectedName}: packed manifest is not configured as a public package`);
  }
  if (manifest.engines?.node !== ">=22.0.0") {
    throw new Error(`${expectedName}: packed manifest does not declare Node >=22.0.0`);
  }
  for (const dependencyGroup of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    for (const [name, range] of Object.entries(dependencyGroup ?? {})) {
      if (name.startsWith("@grp-protocol/") && range !== "^0.1.0") {
        throw new Error(`${expectedName}: ${name} uses ${range}, expected ^0.1.0`);
      }
      if (name.startsWith("@grp/")) {
        throw new Error(`${expectedName}: packed manifest depends on private package ${name}`);
      }
    }
  }

  const requiredPaths = [manifest.main, manifest.types, ...collectExportPaths(manifest.exports)];
  for (const binPath of Object.values(manifest.bin ?? {})) requiredPaths.push(binPath);
  for (const value of requiredPaths.filter(Boolean)) {
    const entry = `package/${String(value).replace(/^\.\//, "")}`;
    if (!entrySet.has(entry))
      throw new Error(`${expectedName}: packed entry point is missing: ${entry}`);
  }
  if (!entries.some((entry) => /^package\/README(?:\.md)?$/i.test(entry))) {
    throw new Error(`${expectedName}: README is missing from ${basename(tarball)}`);
  }
  if (!entries.some((entry) => entry.endsWith(".js"))) {
    throw new Error(`${expectedName}: tarball contains no compiled JavaScript`);
  }
  if (!entries.some((entry) => entry.endsWith(".d.ts"))) {
    throw new Error(`${expectedName}: tarball contains no TypeScript declarations`);
  }

  for (const entry of entries) {
    if (entry.startsWith("package/node_modules/")) continue;
    if (entry.startsWith("package/src/") || entry.startsWith("package/tests/")) {
      throw new Error(`${expectedName}: source/test directory leaked: ${entry}`);
    }
    if (
      /(?:^|\/)(?:tsconfig(?:\.[^/]*)?\.json|vitest(?:\.[^/]*)?\.[cm]?[jt]s|[^/]*\.test\.[^/]+|[^/]*\.spec\.[^/]+|[^/]*\.tsbuildinfo)$/.test(
        entry,
      )
    ) {
      throw new Error(`${expectedName}: development file leaked: ${entry}`);
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      throw new Error(`${expectedName}: raw TypeScript leaked: ${entry}`);
    }
    if (/(?:^|\/)(?:trials?|pilot-trials|research)(?:\/|$)/.test(entry)) {
      throw new Error(`${expectedName}: internal trial/research material leaked: ${entry}`);
    }
  }

  console.log(`[npm-release] inspected ${expectedName}: ${entries.length} entries`);
}

function verifyServedCliArtifact(packedCliTarball, expectedVersion) {
  if (!packedCliTarball) throw new Error("fresh CLI tarball was not created");
  const hostedWebRoot = join(repoRoot, "apps", "web");
  if (!existsSync(hostedWebRoot)) {
    // The history-free public mirror deliberately excludes the closed hosted
    // web application. It still packs/installs/executes this CLI below, while
    // the private release tree is the only context that can and must prove the
    // bytes served by grp.app are identical to current source.
    console.log("[npm-release] hosted CLI equality check not applicable in the open mirror");
    return;
  }
  const servedTarball = join(
    hostedWebRoot,
    "public",
    "grp",
    `grp-protocol-cli-${expectedVersion}.tgz`,
  );
  const installer = join(repoRoot, "apps", "web", "public", "grp", "install.sh");
  if (!existsSync(servedTarball)) {
    throw new Error(`served CLI tarball is missing for @grp-protocol/cli@${expectedVersion}`);
  }
  inspectTarball("@grp-protocol/cli", expectedVersion, servedTarball);

  const freshSha = sha256File(packedCliTarball);
  const servedSha = sha256File(servedTarball);
  const freshContentSha = sha256TarContent(packedCliTarball);
  const servedContentSha = sha256TarContent(servedTarball);
  if (servedContentSha !== freshContentSha) {
    throw new Error(
      `served CLI content does not match a fresh source pack: served=${servedContentSha} fresh=${freshContentSha}`,
    );
  }
  const installerSource = readFileSync(installer, "utf8");
  if (!installerSource.includes(`grp-protocol-cli-${expectedVersion}.tgz`)) {
    throw new Error(`installer does not select the ${expectedVersion} CLI artifact`);
  }
  if (!installerSource.includes(servedSha)) {
    throw new Error("installer does not pin the served CLI SHA-256");
  }
  if (!installerSource.includes("no SHA-256 implementation found")) {
    throw new Error("installer does not fail closed when SHA-256 tooling is unavailable");
  }
  console.log(`[npm-release] served CLI content matches source: tar-sha256:${servedContentSha}`);
  console.log(`[npm-release] installer pins served bytes: sha256:${servedSha}`);
  if (servedSha !== freshSha) {
    console.log(
      `[npm-release] gzip bytes differ across pack hosts as expected: served=${servedSha} fresh=${freshSha}`,
    );
  }
}

function collectExportPaths(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(collectExportPaths);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256TarContent(path) {
  return createHash("sha256")
    .update(gunzipSync(readFileSync(path)))
    .digest("hex");
}

function parsePackJson(output) {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error(`could not parse npm pack output: ${output}`);
  const parsed = JSON.parse(output.slice(start, end + 1));
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("npm pack did not report exactly one package");
  }
  return parsed[0];
}

function installedBin(name) {
  return join(consumerDir, "node_modules", ".bin", name);
}

function run(command, args, cwd, stdio) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", npm_config_cache: join(scratch, "npm-cache") },
  });
}

function consumerSmokeSource(selectedIds) {
  const imports = ['import assert from "node:assert/strict";'];
  const checks = [];
  if (selectedIds.has("audit")) {
    imports.push('import { AUDIT_VERSION, canonicalize } from "@grp-protocol/audit";');
    checks.push('assert.equal(AUDIT_VERSION, "0.1.0");');
    checks.push(`assert.equal(canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}');`);
  }
  if (selectedIds.has("engine")) {
    imports.push(
      'import { DEFAULT_PARAMETERS, ENGINE_VERSION, runGenericVote } from "@grp-protocol/engine";',
    );
    checks.push('assert.equal(ENGINE_VERSION, "0.2.0");');
    checks.push(`
const result = runGenericVote({
  parameters: DEFAULT_PARAMETERS,
  eligible_voters: 3,
  votes: [
    { voter_id: "a", choice: "yes" },
    { voter_id: "b", choice: "yes" },
    { voter_id: "c", choice: "no" },
  ],
  deterministic_seed: "deadbeef".repeat(8),
});
assert.equal(result.winner, "yes");`);
  }
  if (selectedIds.has("sdk")) {
    imports.push('import { GrpClient, SDK_VERSION } from "@grp-protocol/sdk";');
    checks.push('assert.equal(SDK_VERSION, "0.1.0");');
    checks.push('assert.equal(typeof GrpClient, "function");');
  }
  if (selectedIds.has("conformance")) {
    imports.push(
      'import { GRP_CONFORMANCE_VERSION, runConformance } from "@grp-protocol/conformance";',
    );
    checks.push('assert.equal(GRP_CONFORMANCE_VERSION, "grp/0.1");');
    checks.push(`
const conformance = await runConformance({ profile: "core" });
assert.equal(conformance.summary.fail, 0);
assert.ok(conformance.summary.pass > 0);`);
  }
  if (checks.length === 0) return "";
  return `${imports.join("\n")}\n\n${checks.join("\n")}\nconsole.log("[consumer] selected public package imports and representative behavior passed");\n`;
}
