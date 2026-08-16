import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");

const bundledDeps = [
  {
    source: join(repoRoot, "node_modules", "@noble", "ed25519"),
    target: join(packageRoot, "node_modules", "@noble", "ed25519"),
  },
  {
    source: join(repoRoot, "node_modules", "yaml"),
    target: join(packageRoot, "node_modules", "yaml"),
  },
];

for (const dep of bundledDeps) {
  if (!existsSync(dep.source)) {
    throw new Error(
      `Missing bundled dependency at ${dep.source}. Run npm install from the repo root.`,
    );
  }
  mkdirSync(dirname(dep.target), { recursive: true });
  rmSync(dep.target, { recursive: true, force: true });
  cpSync(dep.source, dep.target, { recursive: true, dereference: true });
}
