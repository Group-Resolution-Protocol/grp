# @grp-protocol/sdk

TypeScript client and outcome verification helpers for the Group Resolution Protocol v0.1.

Install:

```bash
npm install @grp-protocol/sdk
```

```ts
import { GrpClient, verifyRoomReceiptChain } from "@grp-protocol/sdk";

const client = new GrpClient({ baseUrl: "https://grp.app" });
const discovery = await client.discover();

const room = await client.createRoom({
  question: "Where should we meet?",
  options: ["Library", "Cafe"],
  config: {
    mechanism: "simple_majority",
    quorum: 1,
    early_close: true,
    settle_window: 0,
    creator_votes: false,
  },
});

const joined = await client.joinRoom({ slug: room.slug, display_name: "agent" });
const agent = new GrpClient({
  baseUrl: "https://grp.app",
  token: joined.participant_token ?? undefined,
});

await agent.choose({ slug: room.slug, choice: "Library" });

const outcome = await agent.outcome(room.slug);
const chain = verifyRoomReceiptChain(outcome);
if (!chain.ok) throw new Error(chain.diagnostics.join("\n"));

console.log(discovery.protocol_version, room.url);
```

Room `visibility` is `public`, `unlisted`, or `private`. GRP Server Cloud's
wire default, which applies when this SDK omits visibility, is `unlisted`.
Public rooms are anonymously readable and joinable. Unlisted rooms hide
contents until the URL holder joins. Private rooms admit a new member only
through a durable invite or an optional shared password; pass `password` to
`createRoom`/`joinRoom`, and as the final argument to read methods when using
password-only observation. The official `grp` CLI is more conservative than
the wire default: an ordinary create generates a password-enabled Private
room.

The `baseUrl` can point at any conforming GRP host — swap in your own
host's URL and everything above works unchanged.

For hosted account/email-bound room invites, exchange the OAuth device flow for
an access token + mandate and pass both together:

```ts
const authed = new GrpClient({
  baseUrl: "https://grp.app",
  accessToken: tokenResponse.access_token,
  mandate: tokenResponse.mandate,
});

await authed.joinRoom({ slug: "abc123", invite: "it_..." });
```

The public repository includes typechecked lifecycle, event, mandate, and
outcome examples. They stay out of the small runtime tarball.
