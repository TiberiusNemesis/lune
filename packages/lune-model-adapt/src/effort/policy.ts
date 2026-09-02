/**
 * The effort policy as a pure function: `decide(state, signals, options)` returns the next
 * state and the level to run the next turn at. The extension only wires pi hooks to it;
 * other harnesses can call it directly.
 *
 * Ladder: open a run at floor / baseline / ceiling by prompt phase; step up one available
 * level per failed turn (up to ceiling, then rescue after two consecutive failures at
 * ceiling); step down toward baseline after three clean turns with tool calls; at most one
 * change per `hysteresisTurns` turns. Guards (context pressure, budget) cap the result and
 * bypass hysteresis. A user pin blocks everything.
 */

import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import {
	type Classification,
	type ClassifierOptions,
	classifyPrompt,
	type Phase,
	type PromptClassifier,
} from "./classify.ts";
import { type Budget, type Ladder, minLevel, rank, stepDown, stepUp } from "./ladder.ts";
import type { FailureSignal } from "./signals.ts";

export interface Spent {
	costUsd: number;
	outputTokens: number;
	reasoningTokens: number;
}

export interface PolicyState {
	/** Level the next turn runs at (what the policy last set, or what the user pinned). */
	level: ModelThinkingLevel;
	phase: Phase;
	/** `/effort plan|exec`: phase forced for the current run. */
	forcedPhase?: Phase;
	/** User-selected level; blocks all policy changes until cleared. */
	pinned?: ModelThinkingLevel;
	turn: number;
	lastChangeTurn?: number;
	consecutiveFailures: number;
	failuresAtCeiling: number;
	cleanToolTurns: number;
	recentCalls: string[];
	budgetNotified: boolean;
	spent: Spent;
	startedAt?: number;
	/** Turns run at each level during this run. */
	histogram: Partial<Record<ModelThinkingLevel, number>>;
}

export type TurnSignals =
	| { kind: "open"; prompt: string; now: number }
	/** `/effort plan|exec` mid-run: jump to the phase's opening level. */
	| { kind: "force"; phase: Phase }
	| {
			kind: "turn";
			turnIndex: number;
			failure?: FailureSignal;
			hadToolCalls: boolean;
			contextPercent: number | null | undefined;
			now: number;
			/** Rolling tool-call fingerprints from `collectTurnSignals`; stored on the state. */
			recentCalls?: string[];
	  };

export interface PolicyOptions {
	ladder: Ladder;
	budget?: Budget;
	contextCaps?: { baselineAbove?: number; floorAbove?: number };
	/** Minimum turns between two policy changes. Default: 2. */
	hysteresisTurns?: number;
	/** Clean turns with tool calls before stepping down. Default: 3. */
	cleanTurnsToStepDown?: number;
	classifier?: ClassifierOptions;
	/** Replaces the keyword classifier (hook for a small-model classifier). */
	classify?: PromptClassifier;
}

export interface Decision {
	state: PolicyState;
	from: ModelThinkingLevel;
	to: ModelThinkingLevel;
	changed: boolean;
	/** One or two words for the status bar. */
	reason: string;
	arrow: "↑" | "↓" | "·";
	/** Evidence behind the decision, e.g. `tests failed: \bFAIL(ED)?\b`. */
	signals: string[];
	/** Shown to the user once, when a budget cap fires. */
	notify?: string;
}

const ZERO_SPENT: Spent = { costUsd: 0, outputTokens: 0, reasoningTokens: 0 };

export function initialState(level: ModelThinkingLevel): PolicyState {
	return {
		level,
		phase: "baseline",
		turn: -1,
		consecutiveFailures: 0,
		failuresAtCeiling: 0,
		cleanToolTurns: 0,
		recentCalls: [],
		budgetNotified: false,
		spent: { ...ZERO_SPENT },
		histogram: {},
	};
}

/** Accumulate an assistant message's usage into the run budget. */
export function recordUsage(state: PolicyState, usage: Usage): PolicyState {
	return {
		...state,
		spent: {
			costUsd: state.spent.costUsd + (usage.cost?.total ?? 0),
			outputTokens: state.spent.outputTokens + (usage.output ?? 0),
			reasoningTokens: state.spent.reasoningTokens + (usage.reasoning ?? 0),
		},
	};
}

export function budgetExceeded(spent: Spent, elapsedMs: number, budget?: Budget): string | undefined {
	if (!budget) return undefined;
	if (budget.costUsd !== undefined && spent.costUsd >= budget.costUsd) {
		return `cost $${spent.costUsd.toFixed(2)} ≥ $${budget.costUsd}`;
	}
	if (budget.outputTokens !== undefined && spent.outputTokens >= budget.outputTokens) {
		return `output ${spent.outputTokens} ≥ ${budget.outputTokens} tokens`;
	}
	if (budget.wallClockMinutes !== undefined && elapsedMs >= budget.wallClockMinutes * 60_000) {
		return `wall time ${(elapsedMs / 60_000).toFixed(1)} ≥ ${budget.wallClockMinutes} min`;
	}
	return undefined;
}

export function openingLevel(ladder: Ladder, phase: Phase): ModelThinkingLevel {
	if (phase === "investigate") return ladder.ceiling;
	if (phase === "mechanical") return ladder.floor;
	return ladder.baseline;
}

function finish(
	state: PolicyState,
	from: ModelThinkingLevel,
	to: ModelThinkingLevel,
	reason: string,
	signals: string[],
	notify?: string,
): Decision {
	const arrow = rank(to) > rank(from) ? "↑" : rank(to) < rank(from) ? "↓" : "·";
	return { state: { ...state, level: to }, from, to, changed: from !== to, reason, arrow, signals, notify };
}

function classify(prompt: string, options: PolicyOptions): Classification {
	if (options.classify) return { phase: options.classify(prompt), because: "custom classifier" };
	return classifyPrompt(prompt, options.classifier);
}

export function decide(state: PolicyState, signals: TurnSignals, options: PolicyOptions): Decision {
	const { ladder } = options;

	if (signals.kind === "open") {
		const classification = state.forcedPhase
			? { phase: state.forcedPhase, because: "forced" }
			: classify(signals.prompt, options);
		const next: PolicyState = {
			...initialState(state.level),
			phase: classification.phase,
			forcedPhase: state.forcedPhase,
			pinned: state.pinned,
			startedAt: signals.now,
		};
		const evidence = [`phase: ${classification.phase} (${classification.because})`];
		if (state.pinned) return finish(next, state.level, state.pinned, "pinned", evidence);
		return finish(next, state.level, openingLevel(ladder, classification.phase), classification.phase, evidence);
	}

	if (signals.kind === "force") {
		const next: PolicyState = { ...state, phase: signals.phase, forcedPhase: signals.phase, pinned: undefined };
		const target = openingLevel(ladder, signals.phase);
		if (target !== state.level) next.lastChangeTurn = state.turn;
		return finish(next, state.level, target, signals.phase, [`forced: ${signals.phase}`]);
	}

	const { turnIndex, failure } = signals;
	const next: PolicyState = {
		...state,
		turn: turnIndex,
		recentCalls: signals.recentCalls ?? state.recentCalls,
		histogram: { ...state.histogram, [state.level]: (state.histogram[state.level] ?? 0) + 1 },
	};
	const evidence: string[] = [];
	if (state.pinned) return finish(next, state.level, state.pinned, "pinned", evidence);

	const level = state.level;
	let target = level;
	let reason = "steady";

	if (failure) {
		evidence.push(`${failure.reason}: ${failure.detail}`);
		next.consecutiveFailures = state.consecutiveFailures + 1;
		next.cleanToolTurns = 0;
		next.failuresAtCeiling = rank(level) >= rank(ladder.ceiling) ? state.failuresAtCeiling + 1 : 0;
		if (rank(level) < rank(ladder.ceiling)) {
			target = minLevel(stepUp(ladder.levels, level), ladder.ceiling);
			reason = failure.reason;
		} else if (level === ladder.ceiling && ladder.rescue && next.failuresAtCeiling >= 2) {
			target = ladder.rescue;
			reason = "rescue";
		}
	} else {
		next.consecutiveFailures = 0;
		next.failuresAtCeiling = 0;
		next.cleanToolTurns = signals.hadToolCalls ? state.cleanToolTurns + 1 : state.cleanToolTurns;
		const cleanTurns = options.cleanTurnsToStepDown ?? 3;
		if (next.cleanToolTurns >= cleanTurns && rank(level) > rank(ladder.baseline)) {
			target = stepDown(ladder.levels, level);
			reason = "clean";
			evidence.push(`clean turns: ${next.cleanToolTurns}`);
		}
	}

	const hysteresis = options.hysteresisTurns ?? 2;
	if (target !== level && state.lastChangeTurn !== undefined && turnIndex - state.lastChangeTurn < hysteresis) {
		evidence.push(`hysteresis: changed on turn ${state.lastChangeTurn}`);
		target = level;
		reason = "steady";
	} else if (target !== level && reason === "clean") {
		next.cleanToolTurns = 0;
	}

	// Guards: caps applied after the ladder, immune to hysteresis.
	const percent = signals.contextPercent;
	const caps = options.contextCaps ?? {};
	let cap: ModelThinkingLevel | undefined;
	let capReason = "";
	if (percent != null && percent > (caps.floorAbove ?? 85)) {
		cap = ladder.floor;
		capReason = "context";
		evidence.push(`context: ${percent.toFixed(0)}%`);
	} else if (percent != null && percent > (caps.baselineAbove ?? 70)) {
		cap = ladder.baseline;
		capReason = "context";
		evidence.push(`context: ${percent.toFixed(0)}%`);
	}
	let notify: string | undefined;
	const over = budgetExceeded(state.spent, signals.now - (state.startedAt ?? signals.now), options.budget);
	if (over) {
		evidence.push(`budget: ${over}`);
		if (!cap || rank(ladder.floor) < rank(cap)) {
			cap = ladder.floor;
			capReason = "budget";
		}
		if (!state.budgetNotified) {
			next.budgetNotified = true;
			notify = `Effort capped at ${ladder.floor} for this run: ${over}`;
		}
	}
	if (cap && rank(target) > rank(cap)) {
		target = cap;
		reason = capReason;
	}

	if (target !== level) next.lastChangeTurn = turnIndex;
	return finish(next, level, target, reason, evidence, notify);
}
