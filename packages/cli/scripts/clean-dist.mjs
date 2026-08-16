import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

rmSync(join(root, "dist"), { recursive: true, force: true });
rmSync(join(root, ".tsbuild", "tsconfig.tsbuildinfo"), { force: true });
