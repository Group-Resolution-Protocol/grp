import { GrpClient } from "@grp-protocol/sdk";

const mandate = process.env.GRP_MANDATE_JWS;
const slug = process.env.GRP_ROOM_SLUG;

if (!mandate) throw new Error("Set GRP_MANDATE_JWS before running this example.");
if (!slug) throw new Error("Set GRP_ROOM_SLUG before running this example.");

const agent = new GrpClient({
  baseUrl: process.env.GRP_OPERATOR_URL ?? "https://grp.app",
  mandate,
});

await agent.discuss({
  slug,
  body: "Mandate-bound agent supports the lowest-risk option.",
  stance: "agree",
});

await agent.choose({
  slug,
  choice: "approve",
  reason: "Within mandate scope and budget.",
});
