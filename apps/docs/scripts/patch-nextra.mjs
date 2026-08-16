// Patch nextra-theme-docs's LayoutPropsSchema to make `children` optional.
//
// Background: nextra-theme-docs@4.5.x has a self-contradicting Layout schema —
// the Layout component destructures `children` out of its props before passing
// the rest to LayoutPropsSchema.safeParse(), but the schema requires `children`
// as a non-optional reactNode. Result: every page render throws
// "Invalid input: expected nonoptional, received undefined → at children".
//
// Tracking the upstream fix (likely landing in 5.x). Until then, this postinstall
// step rewrites the one offending line in the installed schemas.js. Idempotent;
// safe to re-run.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const schemasFile = resolve(here, "..", "node_modules", "nextra-theme-docs", "dist", "schemas.js");

if (!existsSync(schemasFile)) {
  console.log("[patch-nextra] schemas.js not found at", schemasFile, "- skipping");
  process.exit(0);
}

const contents = readFileSync(schemasFile, "utf8");
const before = "  children: reactNode,";
const after = "  children: reactNode.optional(),";

if (contents.includes(after)) {
  console.log("[patch-nextra] already patched");
  process.exit(0);
}
if (!contents.includes(before)) {
  console.warn(
    "[patch-nextra] expected pattern not found; skipping (Nextra version may have fixed the bug)",
  );
  process.exit(0);
}

writeFileSync(schemasFile, contents.replace(before, after));
console.log("[patch-nextra] applied: children is now optional in LayoutPropsSchema");
