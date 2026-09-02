#!/usr/bin/env node
// lune: pi with its user config under ~/.lune/agent. Everything else is untouched.
import { homedir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR ??= join(homedir(), ".lune", "agent");
await import("../dist/bundle/cli.js");
process.title = "lune";
