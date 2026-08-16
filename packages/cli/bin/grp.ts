#!/usr/bin/env node
// Canonical open-protocol CLI entry point; dispatch lives in src/cli.ts.

import { runCli } from "../src/cli.js";
import { exitAfterFlush } from "../src/exit.js";

runCli(process.argv.slice(2), { programName: "grp" })
  .then((code) => exitAfterFlush(code))
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    exitAfterFlush(1);
  });
