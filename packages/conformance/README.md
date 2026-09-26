# @grp-protocol/conformance

The GRP conformance harness: run it against any host implementation to
check protocol behavior — discovery, room lifecycle, decision semantics,
mechanism outcomes (via offline vectors generated against
[`@grp-protocol/engine`](https://www.npmjs.com/package/@grp-protocol/engine)),
and receipt verifiability.

Install and run:

```bash
npx @grp-protocol/conformance --profile=core
npx @grp-protocol/conformance --profile=operator --target=https://your-host.example --allow-write
npx @grp-protocol/conformance --profile=operator --target=https://your-host.example --allow-write --mandate-file=/secure/path/mandate.jws
```

```ts
import { runConformance, renderMarkdownReport } from "@grp-protocol/conformance";

const report = await runConformance({
  profile: "operator",
  target: "https://your-host.example",
  allowWrites: true,
  mandate: shortLivedMandate,
});
console.log(renderMarkdownReport(report));
```

`core` is offline and never tests a host. It rejects `target`. The `transport`
and `operator` profiles create and permanently delete Private test rooms, so
they require explicit `--allow-write` / `allowWrites: true` authorization. A
live profile pass is evidence only for the behaviors listed in that profile;
it is not a security, availability, or external webhook-delivery
certification.

The operator profile uses an ephemeral `did:key` mandate by default for local
development hosts. A hosted operator that intentionally trusts only approved
HTTPS issuers must supply a short-lived mandate with join, discuss, choose,
and propose authority for synthetic rooms. Put the compact JWS alone in a
mode-`0600` file and use `--mandate-file`; the value is never copied into the
report. Delete the file after the run. The implementer's guide lives at
[grp.dev/docs/build-a-host](https://grp.dev/docs/build-a-host).

Apache-2.0.

## Unreleased coordination candidate

The unreleased `--protocol=0.2 --profile=coordination-discovery --target=<base-url>`
profile performs only two read-only checks: the versioned capability declaration
and refusal of an incompatible version. It accepts no mandate and needs no
`--allow-write`. Its report explicitly does **not** certify base transports,
authorization or coordination lifecycles. Existing full profiles still identify
only `grp/0.1`; changing the version flag cannot relabel their verdicts.

`validateSpeakingTurnProjection(value, { surface: "read" | "operation" | "wait" })`
is a draft, offline wire validator. It checks required projection fields, string
revision/epoch representation, lease consistency, own/holder/target relationships
and that operations/waits do not issue read observations. It allows additive
unknown fields. It performs no network access and accepts no credential.

It is not added to `core`, `transport` or `operator` verdicts. Those profiles do
not yet certify action, artifact or speaking-turn behavior. A valid projection
alone cannot prove authorization, FIFO ordering, atomic consumption, observation
verification, expiry recovery or wake delivery. Live candidate conformance and
the complete public contract remain release gates. This helper is not available
in previously published package versions.
