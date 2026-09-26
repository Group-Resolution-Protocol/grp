import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateReleaseBundle, validateReleaseContext } from "./stage-npm-release.mjs";

const allowed = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "Group-Resolution-Protocol/grp",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REF_PROTECTED: "true",
};

test("only a manual protected public-main context passes", () => {
  assert.doesNotThrow(() => validateReleaseContext(allowed));
  for (const key of Object.keys(allowed)) {
    const missing = { ...allowed };
    delete missing[key];
    assert.throws(() => validateReleaseContext(missing), /protected public main/);
  }
  for (const [key, value] of [
    ["GITHUB_ACTIONS", "false"],
    ["GITHUB_EVENT_NAME", "pull_request"],
    ["GITHUB_EVENT_NAME", "push"],
    ["GITHUB_REPOSITORY", "someone/grp"],
    ["GITHUB_REF", "refs/heads/release"],
    ["GITHUB_REF", "refs/tags/main"],
    ["GITHUB_REF", "refs/pull/1/merge"],
    ["GITHUB_REF_PROTECTED", "false"],
  ]) {
    assert.throws(
      () => validateReleaseContext({ ...allowed, [key]: value }),
      /protected public main/,
    );
  }
});

test("wrong-branch execution fails before opening bundle or invoking npm", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./stage-npm-release.mjs", import.meta.url)),
      "--bundle=/nonexistent-release-test-bundle",
      "--npm-cli=/nonexistent-release-test-npm",
    ],
    { encoding: "utf8", env: { ...process.env, ...allowed, GITHUB_REF: "refs/heads/release" } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /protected public main/);
  assert.doesNotMatch(result.stderr, /npm CLI is missing/);
});

test("offline dry run validates exact bundle without invoking npm", () => {
  const dir = mkdtempSync(join(tmpdir(), "grp-release-guard-"));
  try {
    const filename = "grp-protocol-cli-0.0.0-test.tgz";
    const bytes = Buffer.from("hash-validation fixture, not a publishable archive");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(dir, filename), bytes);
    writeFileSync(
      join(dir, "RELEASE-MANIFEST.json"),
      JSON.stringify({
        schema_version: 1,
        packages: [{ name: "@grp-protocol/cli", version: "0.0.0-test", filename, sha256 }],
      }),
    );
    writeFileSync(join(dir, "SHA256SUMS"), `${sha256}  ${filename}\n`);
    const fakeNpm = join(dir, "never-invoke.mjs");
    writeFileSync(fakeNpm, 'throw new Error("npm must not run in dry-run tests");\n');
    assert.equal(validateReleaseBundle(dir).length, 1);
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./stage-npm-release.mjs", import.meta.url)),
        `--bundle=${dir}`,
        `--npm-cli=${fakeNpm}`,
        "--dry-run",
      ],
      { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "false" } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DRY RUN/);
    writeFileSync(join(dir, filename), "changed");
    assert.throws(() => validateReleaseBundle(dir), /hash mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("both workflow jobs enforce repository, main ref and protection before running", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/publish.yml", import.meta.url),
    "utf8",
  );
  const jobGuards = [...workflow.matchAll(/^ {4}if: (.*)$/gm)].map((match) => match[1]);
  assert.equal(jobGuards.length, 2);
  for (const guard of jobGuards) {
    assert.match(guard, /inputs\.confirmation == 'STAGE'/);
    assert.match(guard, /github\.repository == 'Group-Resolution-Protocol\/grp'/);
    assert.match(guard, /github\.ref == 'refs\/heads\/main'/);
    assert.match(guard, /github\.ref_protected/);
  }
  assert.match(workflow, /environment: npm-release/);
  assert.match(workflow, /RELEASE_PACKAGES: \$\{\{ inputs\.packages \}\}/);
  assert.match(workflow, /--packages="\$RELEASE_PACKAGES"/);
  assert.doesNotMatch(workflow, /--packages="\$\{\{/);
});
