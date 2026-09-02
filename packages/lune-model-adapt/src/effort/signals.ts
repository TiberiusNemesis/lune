/**
 * Turn-level failure detection from pi's turn_end payload. Pure functions; the extension
 * feeds them event data and the policy consumes the resulting `FailureSignal`.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

export type FailureReason = "tests failed" | "edit failed" | "tool error" | "doom loop" | "truncated";

export interface FailureSignal {
	reason: FailureReason;
	/** The matched pattern, tool name or call fingerprint. */
	detail: string;
}

export const DEFAULT_TEST_FAILURE_PATTERNS = [
	"\\bFAIL(ED)?\\b",
	"AssertionError",
	"error TS\\d+",
	"✗",
	"Tests:\\s+\\d+ failed",
	"ERR!",
];

export const EDIT_FAILURE_PATTERNS = ["verification failed", "Could not find", "Found \\d+ occurrences"];
const EDIT_TOOLS = new Set(["apply_patch", "edit"]);

/** How many recent tool calls the doom-loop detector looks at. */
export const DOOM_LOOP_WINDOW = 3;

export interface TurnInput {
	message: AgentMessage;
	toolResults: Pick<ToolResultMessage, "toolName" | "content" | "isError">[];
}

export interface CollectedSignals {
	failure?: FailureSignal;
	hadToolCalls: boolean;
	/** Fingerprints of the last DOOM_LOOP_WINDOW tool calls, including this turn's. */
	recentCalls: string[];
	stopReason?: string;
}

export function toolCallFingerprints(message: AgentMessage): string[] {
	if (message.role !== "assistant") return [];
	return message.content
		.filter((part): part is Extract<typeof part, { type: "toolCall" }> => part.type === "toolCall")
		.map((call) => `${call.name}:${stableJson(call.arguments)}`);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

const textOf = (result: TurnInput["toolResults"][number]): string =>
	result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

function firstMatch(text: string, patterns: string[]): string | undefined {
	for (const pattern of patterns) {
		try {
			if (new RegExp(pattern, "m").test(text)) return pattern;
		} catch {
			// Invalid user regex: skip it.
		}
	}
	return undefined;
}

/** A fingerprint that appears at least twice in the window. */
export function detectDoomLoop(recentCalls: string[]): string | undefined {
	const seen = new Set<string>();
	for (const call of recentCalls) {
		if (seen.has(call)) return call;
		seen.add(call);
	}
	return undefined;
}

export function collectTurnSignals(
	turn: TurnInput,
	previousCalls: string[],
	options: { testFailurePatterns?: string[] } = {},
): CollectedSignals {
	const calls = toolCallFingerprints(turn.message);
	const recentCalls = [...previousCalls, ...calls].slice(-DOOM_LOOP_WINDOW);
	const stopReason = turn.message.role === "assistant" ? turn.message.stopReason : undefined;
	const testPatterns = options.testFailurePatterns ?? DEFAULT_TEST_FAILURE_PATTERNS;

	let failure: FailureSignal | undefined;
	for (const result of turn.toolResults) {
		const text = textOf(result);
		if (result.toolName === "bash") {
			const hit = firstMatch(text, testPatterns);
			if (hit) {
				failure = { reason: "tests failed", detail: hit };
				break;
			}
		}
		if (EDIT_TOOLS.has(result.toolName)) {
			const hit = firstMatch(text, EDIT_FAILURE_PATTERNS);
			if (hit) {
				failure = { reason: "edit failed", detail: hit };
				break;
			}
		}
		if (result.isError) failure ??= { reason: "tool error", detail: result.toolName };
	}
	if (!failure) {
		const loop = detectDoomLoop(recentCalls);
		if (loop) failure = { reason: "doom loop", detail: loop.slice(0, 120) };
	}
	if (!failure && stopReason === "length") failure = { reason: "truncated", detail: "stopReason=length" };

	return { failure, hadToolCalls: calls.length > 0, recentCalls, stopReason };
}
