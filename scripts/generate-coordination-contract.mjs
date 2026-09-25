import { readFileSync, writeFileSync } from "node:fs";
import { coordinationContract } from "./coordination-contract.mjs";
const path = new URL(
  "../docs/reference/openapi/grp-coordination-candidate.openapi.json",
  import.meta.url,
);
const content = `${JSON.stringify(coordinationContract, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== content)
    throw new Error("Candidate OpenAPI is stale; run npm run contract:candidate:generate");
} else {
  writeFileSync(path, content);
}
console.log("Candidate contract matches public source; this is not live host certification.");
