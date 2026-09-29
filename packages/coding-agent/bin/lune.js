#!/usr/bin/env node
// lune: pi with its user config under ~/.lune/agent. Everything else is untouched.
import { homedir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR ??= join(homedir(), ".lune", "agent");
// lune runs from a source checkout; upstream release checks and self-updates would target the npm package.
process.env.PI_SKIP_VERSION_CHECK ??= "1";
process.env.PI_DISABLE_SELF_UPDATE ??= "1";
await import("../dist/bundle/cli.js");
process.title = "lune";
