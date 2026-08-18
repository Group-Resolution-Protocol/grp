# Contributing to GRP

Thanks for helping. Contributions are welcome to the protocol
specification, the open packages (CLI, SDK, audit, conformance, and engine),
and the documentation — the docs source lives in this repository
(`apps/docs/`), so "improve the docs" is an ordinary pull request.

Every change is reviewed and approved by a maintainer before merge.

## Getting started

```bash
npm ci
npm run build
npm test
```

Node 22+ is required. Each package also runs standalone:
`npm test --workspace=@grp-protocol/engine`, etc. The docs site runs
locally with `npm run dev --workspace=@grp-protocol/docs`.

## Contribution flow

1. **Raise it first** for non-trivial changes — open an issue or
   discussion before writing a large PR. We'd rather discuss the shape
   than review something that doesn't fit the protocol's direction.
2. **Branch + PR.** Standard fork and pull-request flow.
3. **Test coverage required** for behavior changes.
4. **Conformance must still pass** for protocol-affecting changes — run
   the conformance suite against your branch.
5. **Credit yourself** in the PR description.

GRP currently uses a separate canonical development repository and publishes
reviewed open-source changes here through verified synchronization PRs. A
community pull request is therefore a proposal: after accepting it, a
maintainer integrates the change into the canonical source and returns an
exact, manifest-backed synchronization. The original pull request may be
closed rather than merged directly even though its change is accepted. The
`sync-integrity` check deliberately distinguishes proposal PRs from mergeable
maintainer syncs; ordinary build and test results remain useful during review.

Protocol-affecting proposals (normative requirements, receipt format,
mechanism behavior, mandatory transports) follow the change process in
[GOVERNANCE.md](GOVERNANCE.md), including a public discussion phase.

## What we won't merge

- Protocol changes that break receipt verification of prior versions.
- Changes that introduce platform-side privilege — anything only a
  hosted operator could do or verify.
- Mechanisms that aren't pure functions.
- Loose typing in API surfaces.

## Code style

- TypeScript, strict mode. No `any` outside generated code.
- Biome for linting and formatting (`npx biome check .`).
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).

## Security issues

Do **not** open a public issue for vulnerabilities — see
[SECURITY.md](SECURITY.md).
