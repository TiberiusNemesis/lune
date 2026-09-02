# lune

lune is upstream pi plus this package plus a few core patches.

- `packages/coding-agent/bin/lune.js` is the `lune` binary: pi with `PI_CODING_AGENT_DIR` pointed at `~/.lune/agent`.
- This package holds everything lune-specific: `extensions/` (branding, tools), `skills/`, `prompts/`, `themes/`.
- `agents/` is reserved for subagent definitions; pi's package manifest has no `agents` key, so an extension has to load them.

Install into the harness once:

```bash
lune install ./packages/lune
```

The package is referenced in place, so edits apply on the next start (or `/reload`).
