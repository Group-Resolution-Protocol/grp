# Releasing GRP packages

GRP publishes five public npm packages from this clean-history repository:

1. `@grp-protocol/audit`
2. `@grp-protocol/engine`
3. `@grp-protocol/sdk`
4. `@grp-protocol/conformance`
5. `@grp-protocol/cli`

The order matters on the first release because later packages depend on the
earlier ones.

## Source ownership and unpublished preparation

This repository is the canonical source for these packages and public protocol
documentation. Make changes here through ordinary pull requests; there is no
private mirror, stripping step, or private-repository merge prerequisite.
Never import another repository's private history or operator evidence.

Before publishing, keep unpublished changes committed on a named branch in a
persistent independent checkout and verify an external all-ref Git bundle.
Testing an unpublished, checksum-pinned archive on private staging does not
publish it or make it a production dependency. Record source commit, package
hash, validation and rollback separately from release approval.

Package `repository.url` must remain
`git+https://github.com/Group-Resolution-Protocol/grp.git`; verify provenance
metadata against the actual public repository before release.

## Release gate

Run from a clean checkout on Node 22 or newer:

```bash
npm ci
npm run build
npm test
node scripts/verify-npm-packages.mjs --artifact-dir=.release-packages
```

With no package selector, the last command packs all five packages, checks
their contents, installs the exact tarballs into an empty project, imports
every public library, runs both installed executables, and retains those
verified archives with checksum and release manifests. It does not publish.
For a package-specific patch, use `--packages=cli` (or a comma-separated list
of `audit,engine,sdk,conformance,cli`) and bump only the selected package
manifests. Packages that did not change do not need synthetic version bumps.

## Prepared next release (unpublished)

The current patch candidate selects only CLI `0.2.1`. Verify its release archive
with `--packages=cli`. CLI `0.2.0` and SDK, engine and conformance `0.1.1` are
already published; audit remains at `0.1.0`. Do not republish those versions.
Check version availability again at the publication gate: a local check is not
a reservation.

Package versions and the negotiated protocol version are separate. These
clients support protocol `0.1` and `0.2`; installing a package does not switch
a host to `0.2`. Host adoption, staging verification and production promotion
remain separate operator actions. This candidate is not a published release.

## First publication

The manual v0.1.0 bootstrap publication is complete. All five package names
now exist on npm, so do not repeat the first-publication commands or attempt to
republish version `0.1.0`. Later versions use the staged trusted-publishing
path below.

## Later releases

After all five packages exist:

1. Permit the workflow's SHA-pinned `actions/upload-artifact` and
   `actions/download-artifact` actions in the GitHub organization allowlist.
2. Add `publish.yml` as the npm trusted publisher for each package.
3. Restrict that publisher to `npm stage publish` only.
4. Use the GitHub environment `npm-release`, require maintainer approval, and
   restrict deployment branches to `main` (not all protected branches). Verify
   these provider settings independently: workflow source does not configure
   the environment. Both workflow jobs and the staging script reject non-main,
   non-public-repository or unprotected-ref release contexts.
5. Disallow traditional publishing tokens once the trusted path is confirmed.
6. Bump and test only the changed package versions, merge the approved PR to
   protected public `main`, then manually run **Stage
   npm packages** with the exact package IDs and confirmation `STAGE`.
7. Inspect every selected staged tarball on npm and approve each one with 2FA.

The workflow's preparation job has no npm publishing identity. It builds,
tests, consumer-installs, and uploads only the selected exact tarballs plus a
machine-readable release manifest. Only the second job receives an OIDC
identity, verifies the downloaded hashes and manifest, and submits those
already-tested tarballs with lifecycle scripts disabled. The workflow can only
stage packages. Nothing becomes public until a maintainer separately approves
it on npm.

Public PR/merge approval, npm staging/publication approval, private adoption,
and production deployment are separate gates. Do not dispatch the release
workflow merely to test it. `npm run test:release` is offline; the stage script's
`--dry-run` validates a local bundle without invoking npm. Neither proves the
provider's environment or npm trusted-publisher configuration is correct.
