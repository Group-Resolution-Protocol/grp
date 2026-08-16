# @grp-protocol/audit

Signing and verification primitives for GRP receipts: compact JWS
(RFC 7515) over JCS-canonicalized JSON with Ed25519, plus the audit-log
action vocabulary and Merkle-root helpers hosts use for daily
transparency publication.

Install:

```bash
npm install @grp-protocol/audit
```

```ts
import { verifyCompactJws } from "@grp-protocol/audit";

const result = await verifyCompactJws(receiptJws, hostJwks);
```

This is the package a verifier needs to check a GRP receipt standalone —
no trust in the issuing host required beyond its published JWKS. The
signing format is specified in the protocol's envelope spec at
[grp.dev](https://grp.dev/specification).

Apache-2.0.
