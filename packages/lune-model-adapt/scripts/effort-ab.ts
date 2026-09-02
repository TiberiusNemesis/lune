/**
 * A/B harness for the effort policy: runs every task in tasks/*.json once at a fixed thinking
 * level and once with extensions/effort-policy.ts, per model, through `pi --mode json`, then
 * prints pass rate, mean cost, mean output(+reasoning) tokens and wall time per condition.
 *
 *   node scripts/effort-ab.ts [--tasks tasks] [--models a/b,c/d] [--level high] [--runs 1]
 *                             [--only fixed|policy] [--pi path/to/cli.js] [--extra "-e x.ts"]
 *
 * The fixed condition uses `--thinking <level>`; the policy condition loads effort-policy.ts and
 * lets it pick levels. Both run with pi's default tools, no session file, and a fresh copy of the
 * task's cwd. Extra `-e` extensions (model-prompts, apply-patch) can be added to both with --extra.
 */

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Task {
	name: string;
	prompt: string;
	cwd?: string;
	check: string;
}

interface RunResult {
	task: string;
	model: string;
	condition: string;
	pass: boolean;
	costUsd: number;
	outputTokens: number;
	reasoningTokens: number;
	wallMs: number;
	turns: number;
	levels: string[];
	error?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "..");

function parseArgs(argv: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) continue;
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) out[arg.slice(2)] = "true";
		else out[arg.slice(2)] = argv[++i];
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const tasksDir = resolve(packageDir, args.tasks ?? "tasks");
const models = (args.models ?? "openai-codex/gpt-5.6-sol").split(",").map((m) => m.trim());
const fixedLevel = args.level ?? "high";
const runs = Number(args.runs ?? "1");
const only = args.only;
const piCli = resolve(packageDir, args.pi ?? "../coding-agent/dist/bundle/cli.js");
const extra = args.extra ? args.extra.split(/\s+/).filter(Boolean) : [];
const extensionPath = join(packageDir, "extensions", "effort-policy.ts");

if (!existsSync(piCli)) {
	console.error(`pi CLI not found at ${piCli}; build packages/coding-agent or pass --pi`);
	process.exit(2);
}

const tasks: Task[] = readdirSync(tasksDir)
	.filter((f) => f.endsWith(".json"))
	.sort()
	.map((file) => ({ name: file.replace(/\.json$/, ""), ...JSON.parse(readFileSync(join(tasksDir, file), "utf-8")) }));

function shell(command: string, cwd: string): Promise<number> {
	return new Promise((done) => {
		const child = spawn("sh", ["-c", command], { cwd, stdio: "ignore" });
		child.on("close", (code) => done(code ?? 1));
		child.on("error", () => done(1));
	});
}

function runPi(cliArgs: string[], cwd: string): Promise<{ lines: string[]; stderr: string; code: number }> {
	return new Promise((done) => {
		const child = spawn(process.execPath, [piCli, ...cliArgs], {
			cwd,
			env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("close", (code) => done({ lines: stdout.split("\n").filter(Boolean), stderr, code: code ?? 1 }));
	});
}

async function runOne(task: Task, model: string, condition: "fixed" | "policy"): Promise<RunResult> {
	const cwd = mkdtempSync(join(tmpdir(), `effort-ab-${task.name}-`));
	if (task.cwd) cpSync(join(tasksDir, task.cwd), cwd, { recursive: true });
	const cliArgs = ["--mode", "json", "--no-session", "--model", model, ...extra];
	if (condition === "fixed") cliArgs.push("--thinking", fixedLevel);
	else cliArgs.push("-e", extensionPath);
	cliArgs.push(task.prompt);

	const started = Date.now();
	const { lines, stderr, code } = await runPi(cliArgs, cwd);
	const wallMs = Date.now() - started;

	const result: RunResult = {
		task: task.name,
		model,
		condition,
		pass: false,
		costUsd: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		wallMs,
		turns: 0,
		levels: [],
	};
	for (const line of lines) {
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const usage = event.message.usage ?? {};
			result.costUsd += usage.cost?.total ?? 0;
			result.outputTokens += usage.output ?? 0;
			result.reasoningTokens += usage.reasoning ?? 0;
			result.turns++;
		}
		if (event.type === "thinking_level_changed") result.levels.push(event.level);
	}
	if (code !== 0) result.error = stderr.trim().split("\n").at(-1) ?? `exit ${code}`;
	result.pass = (await shell(task.check, cwd)) === 0;
	rmSync(cwd, { recursive: true, force: true });
	return result;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function summarize(results: RunResult[]) {
	const groups = new Map<string, RunResult[]>();
	for (const r of results) {
		const key = `${r.model} | ${r.condition}`;
		groups.set(key, [...(groups.get(key) ?? []), r]);
	}
	console.log("\ncondition | pass rate | mean cost | mean output tok | mean reasoning tok | mean wall s | n");
	for (const [key, rs] of groups) {
		const passRate = ((100 * rs.filter((r) => r.pass).length) / rs.length).toFixed(0);
		console.log(
			`${key} | ${passRate}% | $${mean(rs.map((r) => r.costUsd)).toFixed(4)} | ${mean(rs.map((r) => r.outputTokens)).toFixed(0)} | ${mean(rs.map((r) => r.reasoningTokens)).toFixed(0)} | ${(mean(rs.map((r) => r.wallMs)) / 1000).toFixed(1)} | ${rs.length}`,
		);
	}
}

const results: RunResult[] = [];
console.log(
	`tasks: ${tasks.map((t) => t.name).join(", ")}\nmodels: ${models.join(", ")}\nfixed level: ${fixedLevel} · runs per cell: ${runs}\n`,
);
console.log("task | model | condition | pass | cost | output tok | reasoning tok | wall s | turns | levels | error");
for (const model of models) {
	for (const task of tasks) {
		for (let i = 0; i < runs; i++) {
			for (const condition of ["fixed", "policy"] as const) {
				if (only && only !== condition) continue;
				const r = await runOne(task, model, condition);
				results.push(r);
				console.log(
					`${r.task} | ${r.model} | ${r.condition}${condition === "fixed" ? `(${fixedLevel})` : ""} | ${r.pass ? "PASS" : "FAIL"} | $${r.costUsd.toFixed(4)} | ${r.outputTokens} | ${r.reasoningTokens} | ${(r.wallMs / 1000).toFixed(1)} | ${r.turns} | ${r.levels.join("→") || "-"} | ${r.error ?? ""}`,
				);
			}
		}
	}
}
summarize(results);
