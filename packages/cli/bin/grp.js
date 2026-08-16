#!/usr/bin/env node
// Canonical open-protocol CLI entry point for installed packages.

import { runCli } from "../dist/cli/src/cli.js";
import { exitAfterFlush } from "../dist/cli/src/exit.js";

runCli(process.argv.slice(2), { programName: "grp" })
  .then((code) => exitAfterFlush(code))
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    exitAfterFlush(1);
  });
