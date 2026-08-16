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
npm run release:verify-packages
```

The last command packs all five packages, checks their contents, installs the
exact tarballs into an empty project, imports every public library, and runs
both installed executables. It does not publish.

## First publication only

npm does not allow a brand-new package to enter through staged publishing.
The first version of each package therefore needs a maintainer present and
authenticated with 2FA. Confirm the npm account, the `grp-protocol` org, and
the package list before running any publish command. Immediately before the
first publish, confirm that all five exact names are still unclaimed with
`npm view <package> version`; a not-found response is expected.

From the clean, tested public checkout, publish in the order at the top of this
file:

```bash
(cd packages/audit && npm publish --access public)
(cd packages/engine && npm publish --access public)
(cd packages/agent-sdk && npm publish --access public)
(cd packages/conformance && npm publish --access public)
(cd packages/cli && npm publish --access public)
```

Each command is a public registry action. Stop and inspect the package page and
a clean registry install after each one. Never put an npm token in this
repository.

Only after all five registry installs pass should the private docs remove the
temporary "not in the registry yet" notices and merge that docs-only change.
The docs site deploys automatically from private `main`, so changing those
notices before registry propagation would publish broken installation advice.

## Later releases

After all five packages exist:

1. Permit the workflow's SHA-pinned `actions/upload-artifact` and
   `actions/download-artifact` actions in the GitHub organization allowlist.
2. Add `publish.yml` as the npm trusted publisher for each package.
3. Restrict that publisher to `npm stage publish` only.
4. Use the GitHub environment `npm-release` and require maintainer approval.
5. Disallow traditional publishing tokens once the trusted path is confirmed.
6. Bump and test the package versions, then manually run **Stage npm packages**
   with the confirmation `STAGE`.
7. Inspect every staged tarball on npm and approve each one with 2FA.

The workflow's preparation job has no npm publishing identity. It builds,
tests, consumer-installs, and uploads the exact five tarballs. Only the second
job receives an OIDC identity, verifies the downloaded checksums, and submits
those already-tested tarballs with lifecycle scripts disabled. The workflow
can only stage packages. Nothing becomes public until a maintainer separately
approves it on npm.
