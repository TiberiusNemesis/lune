/**
 * effort-policy: adapts pi's thinking level per run and per turn.
 *
 * Runs open at floor / baseline / ceiling depending on the prompt (mechanical / default /
 * investigative), step up one available level after a failed turn (tool error, test failure,
 * failed edit, doom loop, truncation) and step back down after three clean turns. Context
 * pressure and a per-run budget cap the level. A level the user selects pins it until
 * `/effort auto` or a model change. The decision itself is `decide()` in src/effort/policy.ts.
 *
 * Config: `lune.effort` in settings.json (see src/effort/ladder.ts `EffortConfig`).
 * Command: `/effort [plan|exec|auto|log|<level>]`.
 */

import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { loadLuneConfig, type LuneConfig } from "../src/config.ts";
import {
	clampToLevels,
	collectTurnSignals,
	type Decision,
	decide,
	initialState,
	type LadderResolution,
	LEVEL_ORDER,
	type Phase,
	type PolicyOptions,
	type PolicyState,
	recordUsage,
	resolveLadder,
} from "../src/effort/index.ts";

export const DECISION_ENTRY = "lune.effort";
export const SUMMARY_ENTRY = "lune.effort.summary";

export interface DecisionEntry {
	run: number;
	turn: number;
	from: ModelThinkingLevel;
	to: ModelThinkingLevel;
	reason: string;
	signals: string[];
	contextPercent: number | null;
	costSoFar: number;
	/** cacheRead of the assistant message that ended this turn; lets a level change be checked against cache hits. */
	cacheRead?: number;
}

export interface SummaryEntry {
	run: number;
	phase: Phase;
	turns: number;
	levels: Partial<Record<ModelThinkingLevel, number>>;
	costUsd: number;
	outputTokens: number;
	reasoningTokens: number;
	wallMs: number;
}

const FORCED_PHASES: Record<string, Phase> = { plan: "investigate", exec: "mechanical" };

export default function effortPolicyExtension(pi: ExtensionAPI) {
	let config: LuneConfig = {};
	let resolution: LadderResolution = { active: false, reason: "no model" };
	let state: PolicyState = initialState("medium");
	let knownModel: string | undefined;
	/** Current run id (its opening timestamp); 0 when idle. */
	let run = 0;
	/** Levels this extension asked pi to set and has not yet seen echoed back by thinking_level_select. */
	const ownWrites: ModelThinkingLevel[] = [];
	let lastCacheRead: number | undefined;

	const ladder = () => (resolution.active ? resolution.ladder : undefined);
	const modelKey = (model: Model<any> | undefined) => (model ? `${model.provider}/${model.id}` : undefined);

	function loadConfig(ctx: ExtensionContext): void {
		config = loadLuneConfig({
			global: join(getAgentDir(), "settings.json"),
			project: ctx.isProjectTrusted() ? join(ctx.cwd, CONFIG_DIR_NAME, "settings.json") : undefined,
		});
	}

	function options(): PolicyOptions {
		const effort = config.effort ?? {};
		const active = ladder();
		if (!active) throw new Error("effort policy inactive");
		return {
			ladder: active,
			budget: effort.budget,
			contextCaps: effort.context,
			classifier: {
				investigateKeywords: effort.keywords?.investigate,
				mechanicalKeywords: effort.keywords?.mechanical,
				longPromptWords: effort.longPromptWords,
				shortPromptWords: effort.shortPromptWords,
			},
		};
	}

	function setLevel(level: ModelThinkingLevel): void {
		if (pi.getThinkingLevel() === level) return;
		ownWrites.push(level);
		pi.setThinkingLevel(level);
	}

	function status(ctx: ExtensionContext, text: string | undefined): void {
		if (ctx.hasUI) ctx.ui.setStatus("effort", text);
	}

	function apply(ctx: ExtensionContext, decision: Decision, contextPercent: number | null | undefined): void {
		state = decision.state;
		if (decision.changed) setLevel(decision.to);
		status(ctx, `${decision.to} ${decision.arrow} ${decision.reason}`);
		if (decision.notify) ctx.ui.notify(decision.notify, "warning");
		const entry: DecisionEntry = {
			run,
			turn: state.turn,
			from: decision.from,
			to: decision.to,
			reason: decision.reason,
			signals: decision.signals,
			contextPercent: contextPercent ?? null,
			costSoFar: state.spent.costUsd,
			cacheRead: lastCacheRead,
		};
		pi.appendEntry(DECISION_ENTRY, entry);
	}

	/** Recompute the ladder for `model`; while idle the policy parks the level at baseline (or the pin). */
	function reconfigure(ctx: ExtensionContext, model: Model<any> | undefined): void {
		resolution = model ? resolveLadder(model, config.effort) : { active: false, reason: "no model selected" };
		knownModel = modelKey(model);
		const active = ladder();
		if (!active) {
			status(ctx, undefined);
			return;
		}
		const level = state.pinned ?? active.baseline;
		state = { ...state, level };
		setLevel(level);
		status(ctx, `${level} · ${state.pinned ? "pinned" : "ready"}`);
	}

	pi.on("session_start", (_event, ctx) => {
		loadConfig(ctx);
		state = initialState(pi.getThinkingLevel());
		reconfigure(ctx, ctx.model);
	});

	pi.on("model_select", (event, ctx) => {
		state = { ...state, pinned: undefined };
		reconfigure(ctx, event.model);
	});

	pi.on("thinking_level_select", (event, ctx) => {
		const own = ownWrites.indexOf(event.level);
		if (own >= 0) {
			ownWrites.splice(own, 1);
			return;
		}
		// pi re-clamps the level while switching models; model_select follows and re-evaluates.
		if (!ladder() || modelKey(ctx.model) !== knownModel) return;
		state = { ...state, level: event.level, pinned: event.level };
		status(ctx, `${event.level} · pinned`);
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!ladder()) return;
		run = Date.now();
		lastCacheRead = undefined;
		apply(ctx, decide(state, { kind: "open", prompt: event.prompt, now: run }, options()), ctx.getContextUsage()?.percent);
	});

	pi.on("message_end", (event) => {
		if (!ladder() || event.message.role !== "assistant") return;
		state = recordUsage(state, event.message.usage);
		lastCacheRead = event.message.usage.cacheRead;
	});

	pi.on("turn_end", (event, ctx) => {
		if (!ladder()) return;
		const collected = collectTurnSignals(event, state.recentCalls, {
			testFailurePatterns: config.effort?.testFailurePatterns,
		});
		const percent = ctx.getContextUsage()?.percent;
		const decision = decide(
			state,
			{
				kind: "turn",
				turnIndex: event.turnIndex,
				failure: collected.failure,
				hadToolCalls: collected.hadToolCalls,
				contextPercent: percent,
				now: Date.now(),
				recentCalls: collected.recentCalls,
			},
			options(),
		);
		apply(ctx, decision, percent);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!ladder() || run === 0) return;
		const summary: SummaryEntry = {
			run,
			phase: state.phase,
			turns: Object.values(state.histogram).reduce((sum, n) => sum + n, 0),
			levels: state.histogram,
			costUsd: state.spent.costUsd,
			outputTokens: state.spent.outputTokens,
			reasoningTokens: state.spent.reasoningTokens,
			wallMs: Date.now() - (state.startedAt ?? Date.now()),
		};
		pi.appendEntry(SUMMARY_ENTRY, summary);
		run = 0;
		state = { ...initialState(state.level), pinned: state.pinned };
		status(ctx, `${state.level} · ${state.pinned ? "pinned" : "ready"}`);
	});

	function describe(ctx: ExtensionContext): string {
		const key = modelKey(ctx.model) ?? "(no model)";
		if (!resolution.active) return `Effort policy inactive for ${key}: ${resolution.reason}. Nothing is set.`;
		const active = resolution.ladder;
		const position = state.pinned
			? "pinned"
			: state.level === active.baseline
				? "baseline"
				: state.level === active.ceiling
					? "ceiling"
					: state.level === active.rescue
						? "rescue"
						: state.level === active.floor
							? "floor"
							: "between";
		const percent = ctx.getContextUsage()?.percent;
		const caps = config.effort?.context ?? {};
		const budget = config.effort?.budget;
		const budgetText = budget
			? `cost $${state.spent.costUsd.toFixed(2)}${budget.costUsd !== undefined ? ` of $${budget.costUsd}` : ""}` +
				`, output ${state.spent.outputTokens}${budget.outputTokens !== undefined ? ` of ${budget.outputTokens}` : ""} tokens` +
				`${budget.wallClockMinutes !== undefined ? `, ${budget.wallClockMinutes} min limit` : ""}` +
				`${state.budgetNotified ? " (capped)" : ""}`
			: "none";
		return [
			`Effort: ${state.level} (${position}) · ladder ${active.floor}…${active.ceiling}${active.rescue ? ` · rescue ${active.rescue}` : ""}`,
			`Model: ${key} · levels ${active.levels.join(" · ")} · table /${active.source}/`,
			`Phase: ${run ? state.phase : "idle"}${state.forcedPhase ? ` · forced ${state.forcedPhase}` : ""}${state.pinned ? ` · pinned ${state.pinned}` : ""}`,
			`Guards: context ${percent == null ? "n/a" : `${percent.toFixed(0)}%`} (>${caps.baselineAbove ?? 70}% → ${active.baseline}, >${caps.floorAbove ?? 85}% → ${active.floor}) · budget ${budgetText}`,
		].join("\n");
	}

	function logTable(ctx: ExtensionContext): string {
		const decisions = ctx.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === DECISION_ENTRY)
			.map((entry) => (entry as { data?: DecisionEntry }).data)
			.filter((entry): entry is DecisionEntry => entry !== undefined);
		if (decisions.length === 0) return "No effort decisions recorded in this session.";
		const latest = Math.max(...decisions.map((d) => d.run));
		const rows = decisions
			.filter((d) => d.run === latest)
			.map((d) =>
				[
					d.turn < 0 ? "open" : String(d.turn),
					d.from === d.to ? d.to : `${d.from} → ${d.to}`,
					d.reason,
					d.contextPercent == null ? "-" : `${d.contextPercent.toFixed(0)}%`,
					`$${d.costSoFar.toFixed(3)}`,
					d.cacheRead === undefined ? "-" : String(d.cacheRead),
					d.signals.join("; "),
				].join(" | "),
			);
		return ["turn | level | reason | ctx | cost | cacheRead | signals", ...rows].join("\n");
	}

	pi.registerCommand("effort", {
		description: "Effort policy: /effort [plan|exec|auto|log|<level>]",
		getArgumentCompletions: (prefix) =>
			["plan", "exec", "auto", "log", ...LEVEL_ORDER]
				.filter((item) => item.startsWith(prefix))
				.map((item) => ({ value: item, label: item })),
		handler: async (args, ctx) => {
			const arg = args.trim();
			const active = ladder();
			if (!arg || arg === "log") {
				ctx.ui.notify(arg ? logTable(ctx) : describe(ctx), "info");
				return;
			}
			if (!active) {
				ctx.ui.notify(describe(ctx), "warning");
				return;
			}
			if (arg === "auto") {
				state = { ...state, pinned: undefined, forcedPhase: undefined };
				status(ctx, `${state.level} · auto`);
				ctx.ui.notify("Effort policy: automatic (pin and forced phase cleared)", "info");
				return;
			}
			const phase = FORCED_PHASES[arg];
			if (phase) {
				if (run) apply(ctx, decide(state, { kind: "force", phase }, options()), ctx.getContextUsage()?.percent);
				else state = { ...state, forcedPhase: phase, pinned: undefined };
				ctx.ui.notify(`Effort phase forced to ${phase} (${arg}) for this run`, "info");
				return;
			}
			if ((LEVEL_ORDER as readonly string[]).includes(arg)) {
				const level = clampToLevels(active.levels, arg as ModelThinkingLevel);
				state = { ...state, pinned: level, level };
				setLevel(level);
				status(ctx, `${level} · pinned`);
				ctx.ui.notify(`Effort pinned at ${level}${level !== arg ? ` (${arg} is not available on this model)` : ""}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /effort [plan|exec|auto|log|<level>]", "warning");
		},
	});
}
