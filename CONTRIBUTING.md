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

Small documentation corrections do not need a prior issue or discussion.

Pull requests are reviewed and merged in this repository. Before opening one,
run the same repository checks used by CI:

```bash
npm run build
npm test
npm run release:verify-packages
npm run repository:check
```

Protocol-affecting changes (normative requirements, receipt format,
mechanism behavior, mandatory transports) follow the change process in
[GOVERNANCE.md](GOVERNANCE.md). Maintainer work may be reviewed locally;
there is no mandatory public discussion or waiting period.

## Documentation style and accuracy

Use room, discussion, decision, action and artifact as common nouns in prose.
Capitalize them at the start of a sentence or heading, not as product names.
Preserve code identifiers, protocol keywords and proper names such as GitHub Actions.
Describe room configuration in terms of what the group needs: conversation,
auditable choices, shared work or speaking turns.

When documenting a capability, check its current interface and authorization
path. Distinguish the protocol contract from hosted features, account MCP from
token-based catalogs, and CLI versions from protocol versions. Keep dated release
history clearly historical and link to current guidance. Run `npm run docs:check`
and build the docs to verify links, examples and generated metadata.

## Maintainer commit identity

Maintainers should use a repository-local GitHub noreply identity so public
commits do not expose a personal email address:

```bash
git config --local user.name "ctrl-malacan"
git config --local user.email "270225746+ctrl-malacan@users.noreply.github.com"
git config --local --get-regexp '^user\.(name|email)$'
```

## What we won't merge

- Protocol changes that break receipt verification of prior versions.
- Changes that introduce platform-side privilege — anything only a
  hosted operator could do or verify.
- Mechanisms that aren't pure functions.
- Loose typing in API surfaces.

## Code style

### Agent response contracts

Changes to CLI output must update representative response tests: help/empty
state, ordinary results, and large user content. Run
`npm run test:response-contract --workspace=@grp-protocol/cli` (also in CI).
Check both required information and unexpected additions. Fixed help and
metadata have explicit UTF-8 budgets; user messages and documents do not.
Preserve content, cursors, acknowledgment state, recovery handles and errors.
Do not truncate content or remove necessary metadata to satisfy a size check.
Changes to allowlists or budgets need a reviewed explanation of why the new
information is needed, not automatic snapshot regeneration. These guards
catch structural drift; reviewers must still assess usefulness.

- TypeScript, strict mode. No `any` outside generated code.
- Biome for linting and formatting (`npx biome check .`).
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).

## Security issues

Do **not** open a public issue for vulnerabilities — see
[SECURITY.md](SECURITY.md).
