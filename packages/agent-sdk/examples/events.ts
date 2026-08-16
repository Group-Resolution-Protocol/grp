import { GrpClient } from "@grp-protocol/sdk";

const client = new GrpClient({
  baseUrl: process.env.GRP_OPERATOR_URL ?? "https://grp.app",
  ...(process.env.GRP_PARTICIPANT_TOKEN ? { token: process.env.GRP_PARTICIPANT_TOKEN } : {}),
});

const slug = process.env.GRP_ROOM_SLUG;
if (!slug) throw new Error("Set GRP_ROOM_SLUG before running this example.");

const next = await client.awaitNextAction({
  slug,
  wait: 25,
  for: "my_choice",
});

if (next.status === "actionable") {
  console.log(`Decision ${next.decision.seq} is ready for your choice.`);
}

const events = await client.listEvents({
  slug,
  since_seq: 0,
  limit: 50,
});

for (const event of events.events) {
  console.log(`${event.seq}: ${event.event_type}`);
}
