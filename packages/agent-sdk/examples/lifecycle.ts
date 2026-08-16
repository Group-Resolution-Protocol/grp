import { GrpClient } from "@grp-protocol/sdk";

const operatorUrl = process.env.GRP_OPERATOR_URL ?? "https://grp.app";

const client = new GrpClient({ baseUrl: operatorUrl });

const discovery = await client.discover();
console.log(`Connected to GRP ${discovery.protocol_version} at ${discovery.name}`);

const room = await client.createRoom({
  question: "Where should the team meet on Friday?",
  options: [],
  config: {
    visibility: "public",
    mechanism: "simple_majority",
    option_proposal_authority: { kind: "any_participant" },
    max_options: 50,
    quorum: 1,
    early_close: true,
    settle_window: 0,
    creator_votes: false,
  },
});

const joined = await client.joinRoom({
  slug: room.slug,
  display_name: "calendar-agent",
});

const agent = new GrpClient({
  baseUrl: operatorUrl,
  ...(joined.participant_token ? { token: joined.participant_token } : {}),
});

await agent.discuss({
  slug: room.slug,
  body: "The cafe is closest to the train station and has indoor seating.",
  stance: "agree",
});

await agent.propose({
  slug: room.slug,
  option: "Cafe",
});

const choice = await agent.choose({
  slug: room.slug,
  choice: "Cafe",
  reason: "Shortest travel time for the most participants.",
});

console.log(`Room ${room.slug} status: ${choice.status ?? "open"}`);
