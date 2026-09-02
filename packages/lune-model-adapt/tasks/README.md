# effort-ab tasks

One JSON file per task: `{ "prompt": string, "cwd"?: string, "check": string }`.

- `cwd` is a directory relative to the task file; it is copied to a fresh temp directory for every run (omit it for an empty directory).
- `check` runs with `sh -c` inside that directory after the agent finishes; exit code 0 means the task passed.

Run: `npm run effort-ab -- --models openai-codex/gpt-5.6-sol --level high` from `packages/lune-model-adapt`.
