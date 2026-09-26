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

// Separate versioned subset. Never overwrite or relabel the frozen base file.
const versioned = structuredClone(coordinationContract);
versioned.info = {
  ...versioned.info,
  title: "GRP 0.2 coordination REST/token profile (unreleased)",
  version: "0.2",
  description:
    "Versioned coordination subset; inherits unchanged base decision/receipt contracts. Not full protocol certification. See /specification/coordination-v02.",
};
versioned["x-grp-profile"] = "coordination-rest-token";
versioned["x-grp-base-contract"] = "grp-v0.1.openapi.json";
for (const [route, item] of Object.entries(versioned.paths)) {
  if (route.includes("working-signals")) {
    delete versioned.paths[route];
    continue;
  }
  for (const [method, operation] of Object.entries(item)) {
    if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
    operation.parameters = [
      ...(operation.parameters ?? []),
      {
        name: "X-GRP-Accept-Protocol",
        in: "header",
        required: method !== "get",
        description:
          "Comma-separated protocol versions supported by the caller; must include 0.2. Missing on a mutation or incompatible yields 409 before dispatch.",
        schema: { type: "string", example: "0.1, 0.2" },
      },
    ];
    operation.responses["409"] = {
      description:
        "Protocol version not accepted, or resource conflict. Inspect error.code; version rejection dispatches no operation.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    };
    for (const response of Object.values(operation.responses)) {
      response.headers = {
        ...(response.headers ?? {}),
        "X-GRP-Protocol-Version": { schema: { const: "0.2" } },
      };
    }
  }
}
const versionedPath = new URL(
  "../docs/reference/openapi/grp-v0.2-coordination.openapi.json",
  import.meta.url,
);
const versionedContent = `${JSON.stringify(versioned, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(versionedPath, "utf8") !== versionedContent)
    throw new Error("Versioned coordination contract is stale");
} else writeFileSync(versionedPath, versionedContent);
