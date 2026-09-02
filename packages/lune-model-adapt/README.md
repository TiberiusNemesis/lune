# lune-model-adapt

Three pi extensions that adapt pi to the selected model, without touching pi's core packages.

- `extensions/model-prompts.ts`: picks a prompt family per model (`codex`, `gpt`, `beast`, `gemini`, `anthropic`, `kimi`, `default`) using OpenCode's substring rules, and replaces pi's identity paragraph with the family prompt (`prompts/<family>.md`, each under 250 words) plus an OpenCode-style `<env>` block. Everything else in pi's system prompt is preserved verbatim.
- `extensions/apply-patch.ts`: an `apply_patch` tool in the Codex `*** Begin Patch` format. For GPT models (`gpt-` but not `oss`/`gpt-4`) it replaces `edit` and `write`; other models keep pi's tools. The swap is re-evaluated on `/model`.
- `extensions/effort-policy.ts`: adapts the thinking level per run and per turn. See [Effort policy](#effort-policy).

## Use

```bash
# ad hoc
pi -e ./packages/lune-model-adapt/extensions/model-prompts.ts -e ./packages/lune-model-adapt/extensions/apply-patch.ts
# or install the package
pi install /path/to/packages/lune-model-adapt
```

Commands and flags: `/prompt-family` prints the active family, its file and word count; `--prompt-family <family|path.md>` forces one.

## Config

Stored under the `lune` key of pi's `settings.json` (global `~/.pi/agent/settings.json`, or project `.pi/settings.json`, merged the way pi merges settings):

```json
{
  "lune": {
    "modelPrompts": { "overrides": { "^openai/gpt-5.6": "codex", "^ollama/": "./prompts/local.md" } },
    "applyPatch": { "models": ["^openai/", "^openai-codex/"], "allowOutsideWorkspace": false }
  }
}
```

Keys of `overrides` are regexes on `provider/id`; values are a family name or a markdown path (relative to the working directory). `applyPatch.models` replaces the built-in GPT rule.

## Effort policy

Reasoning effort is the biggest lever on agentic coding scores and it is not monotonic (Artificial Analysis Coding Agent Index, Sep 2026: GPT-5.6 Sol scores 55.2 at `low`, 61.6 at `medium`, 64.1 at `high`, 63.3 at `xhigh`, 65.1 at `max`, at 1.2× to 4.6× the cost of `low`). The policy targets a fixed-`high` baseline's pass rate at lower cost, with a rescue path above it when a run is failing.

The decision is the pure function `decide(state, signals, options)` in `src/effort/policy.ts`; the extension only wires pi hooks to it.

**Ladder.** `getSupportedThinkingLevels(model)` minus `off` (set `allowOff` to keep it). `floor` is the lowest remaining level. `baseline`, `ceiling` and `rescue` come from a table keyed by regex on `provider/id`, clamped to the model's levels; moving up or down always means the next level *this* model supports (`high → max` on GLM-5.3). The policy is inactive when a model exposes fewer than two levels or the table disables it.

| pattern | baseline | ceiling | rescue |
|---|---|---|---|
| `grok-build` | disabled (xAI rejects explicit effort; pi's catalog still lists low/medium/high) | | |
| `gpt-5.6-luna`, `-terra`, `-mini`, `-nano` | high | xhigh | max |
| `*codex*` (model id) | high | xhigh | max (drops to none where `max` is unsupported) |
| `gpt-5.5`, `gpt-5.6`, `gpt-5.6-sol` | medium | high | xhigh |
| `grok-4.6` | high | xhigh | |
| `grok-4.5` | high | high | |
| `glm-5.3*` | high | max | |
| `glm-5.2` | high | max | |
| anything else | medium | high | |

**Per run.** `before_agent_start` classifies the prompt: `investigate` (opens at ceiling) when it is over 80 words or mentions design / architecture / why / investigate / debug / root cause / refactor / plan / migrate; `mechanical` (opens at floor) when it is at most 30 words and mentions rename / bump / typo / add a test for / update copy / format / lint fix; otherwise baseline.

**Per turn.** A turn fails when a tool result is an error, bash output matches a test-failure pattern (`\bFAIL(ED)?\b`, `AssertionError`, `error TS\d+`, `✗`, `Tests:\s+\d+ failed`, `ERR!`), an `apply_patch`/`edit` result says `verification failed` / `Could not find` / `Found N occurrences`, the same tool call repeats within the last three calls, or the response was truncated. A failed turn steps up one level to ceiling; a second consecutive failure at ceiling steps to rescue. Three consecutive clean turns with tool calls step down toward baseline. At most one change per two turns. Guards apply after the ladder and ignore hysteresis: context above 70% caps at baseline, above 85% at floor; crossing the per-run budget caps at floor and notifies once.

**User override.** `/thinking <level>` (or any level change the policy did not make) pins that level until `/effort auto` or a model change. `/effort plan` / `/effort exec` force the investigate / mechanical phase for the run; `/effort <level>` pins; `/effort` prints level, ladder position and guard state; `/effort log` prints this run's decisions with the matched signals.

Every decision is appended to the session as a `lune.effort` entry and each run ends with a `lune.effort.summary` entry (turns, level histogram, cost, output and reasoning tokens, wall time).

Config, all optional:

```json
{
  "lune": {
    "effort": {
      "models": { "^openai/gpt-5\\.6-sol$": { "baseline": "low", "ceiling": "high", "rescue": "xhigh" } },
      "keywords": { "investigate": ["untangle"], "mechanical": ["regenerate"] },
      "budget": { "costUsd": 2, "outputTokens": 200000, "wallClockMinutes": 20 },
      "context": { "baselineAbove": 70, "floorAbove": 85 },
      "testFailurePatterns": ["\\bFAIL(ED)?\\b"],
      "allowOff": false
    }
  }
}
```

### A/B evaluation

`scripts/effort-ab.ts` runs every task in `tasks/*.json` (`{prompt, cwd?, check}`; see `tasks/README.md`) once at a fixed level and once with the policy, per model, through `pi --mode json`, and prints pass rate, mean cost, mean output and reasoning tokens and wall time per condition plus the per-task rows.

```bash
npm run effort-ab -- --models openai-codex/gpt-5.6-sol,zai/glm-5.3 --level high --runs 3
```

## Tests

```bash
cd packages/lune-model-adapt && npm test
```

`test/fixtures/codex-apply-patch` vendors OpenAI's `codex-rs/apply-patch` scenario corpus; see `SOURCE.md` there.
