/**
 * System prompt assembly: family block -> environment block -> the rest of pi's default prompt.
 * The environment block ports OpenCode `SystemPrompt.environment()`.
 */

export interface EnvInfo {
	modelId: string;
	provider: string;
	cwd: string;
	workspaceRoot: string;
	isGitRepo: boolean;
	platform: string;
	/** Day-granularity date string, e.g. `new Date().toDateString()`. */
	date: string;
}

/** First line of pi's default identity paragraph (packages/coding-agent/src/core/system-prompt.ts). */
export const PI_IDENTITY_PREFIX = "You are an expert coding assistant operating inside pi";

export function buildEnvBlock(env: EnvInfo): string {
	return [
		`You are powered by the model named ${env.modelId}. The exact model ID is ${env.provider}/${env.modelId}`,
		"Here is some useful information about the environment you are running in:",
		"<env>",
		`  Working directory: ${env.cwd}`,
		`  Workspace root folder: ${env.workspaceRoot}`,
		`  Is directory a git repo: ${env.isGitRepo ? "yes" : "no"}`,
		`  Platform: ${env.platform}`,
		`  Today's date: ${env.date}`,
		"</env>",
	].join("\n");
}

/** Drop every line that mentions `tool`, then collapse blank runs left behind. */
export function stripToolMentions(text: string, tool: string): string {
	return text
		.split("\n")
		.filter((line) => !line.includes(tool))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n");
}

export interface AssembleOptions {
	/** `event.systemPrompt` as pi built it (possibly already modified by earlier extensions). */
	basePrompt: string;
	familyText: string;
	env: EnvInfo;
	/** Whether `apply_patch` is in the active tool set; otherwise lines mentioning it are dropped. */
	includeApplyPatch: boolean;
}

/**
 * Replace pi's identity paragraph with the family block and environment block, leaving every
 * other section (Available tools, Guidelines, docs pointer, project context, skills, cwd) intact.
 * When the identity paragraph is absent (custom system prompt), only the environment block is
 * prepended, mirroring OpenCode which skips the provider prompt for agents with their own prompt.
 */
export function assembleSystemPrompt(options: AssembleOptions): string {
	const { basePrompt, env } = options;
	const family = (
		options.includeApplyPatch ? options.familyText : stripToolMentions(options.familyText, "apply_patch")
	).trim();
	const envBlock = buildEnvBlock(env);

	const start = basePrompt.indexOf(PI_IDENTITY_PREFIX);
	if (start === -1) return `${envBlock}\n\n${basePrompt}`;
	const paragraphEnd = basePrompt.indexOf("\n\n", start);
	const end = paragraphEnd === -1 ? basePrompt.length : paragraphEnd;
	return `${basePrompt.slice(0, start)}${family}\n\n${envBlock}${basePrompt.slice(end)}`;
}

export function countWords(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}

/** The prompt up to the first project-context or skills section. */
export function beforeProjectContext(prompt: string): string {
	const cut = ["<project_context>", "<available_skills>"]
		.map((marker) => prompt.indexOf(marker))
		.filter((idx) => idx !== -1);
	return cut.length === 0 ? prompt : prompt.slice(0, Math.min(...cut));
}
