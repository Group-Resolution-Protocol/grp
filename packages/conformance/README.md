# @grp-protocol/conformance

The GRP conformance harness: run it against any host implementation to
check protocol behavior — discovery, room lifecycle, decision semantics,
mechanism outcomes (via offline vectors generated against
[`@grp-protocol/engine`](https://www.npmjs.com/package/@grp-protocol/engine)),
and receipt verifiability.

Registry commands, after the first v0.1 publish:

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
and `operator` profiles create and permanently delete public test rooms, so
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
