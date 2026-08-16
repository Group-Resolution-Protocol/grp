import {
  GrpClient,
  publicKeyFromJwks,
  receiptKid,
  verifyCompactReceipt,
  verifyRoomReceiptChain,
} from "@grp-protocol/sdk";

const client = new GrpClient({
  baseUrl: process.env.GRP_OPERATOR_URL ?? "https://grp.app",
});

const slug = process.env.GRP_ROOM_SLUG;
if (!slug) throw new Error("Set GRP_ROOM_SLUG before running this example.");

const receipt = await client.outcome(slug);
const chain = verifyRoomReceiptChain(receipt);
if (!chain.ok) throw new Error(chain.diagnostics.join("\n"));

const compactReceipt = process.env.GRP_RECEIPT_JWS;
const expectedHash = process.env.GRP_RECEIPT_HASH;

if (compactReceipt && expectedHash) {
  const discovery = await client.discover();
  const kid = receiptKid(compactReceipt);
  if (!kid) throw new Error("Receipt JWS does not contain a kid header.");

  const publicKey = publicKeyFromJwks(discovery, kid);
  await verifyCompactReceipt({ jws: compactReceipt, publicKey, expectedHash });
}

console.log(`${slug} receipt chain verified`);
