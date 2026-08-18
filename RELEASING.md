# Releasing GRP packages

GRP publishes five public npm packages from this clean-history repository:

1. `@grp-protocol/audit`
2. `@grp-protocol/engine`
3. `@grp-protocol/sdk`
4. `@grp-protocol/conformance`
5. `@grp-protocol/cli`

The order matters on the first release because later packages depend on the
earlier ones.

## Before the first commit

The private mirror builder must be given this repository's exact public URL:

```bash
node scripts/build-public-mirror.mjs \
  --repository=https://github.com/OWNER/REPOSITORY
```

That writes the same `repository.url` into every publishable package. Do not
replace it with a placeholder: npm provenance requires it to match the public
GitHub repository exactly.

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
4. Use the GitHub environment `npm-release` and require maintainer approval.
5. Disallow traditional publishing tokens once the trusted path is confirmed.
6. Bump and test only the changed package versions, then manually run **Stage
   npm packages** with the exact package IDs and confirmation `STAGE`.
7. Inspect every selected staged tarball on npm and approve each one with 2FA.

The workflow's preparation job has no npm publishing identity. It builds,
tests, consumer-installs, and uploads only the selected exact tarballs plus a
machine-readable release manifest. Only the second job receives an OIDC
identity, verifies the downloaded hashes and manifest, and submits those
already-tested tarballs with lifecycle scripts disabled. The workflow can only
stage packages. Nothing becomes public until a maintainer separately approves
it on npm.
