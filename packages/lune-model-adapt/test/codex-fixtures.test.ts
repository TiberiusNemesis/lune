/**
 * Runs OpenAI's codex-rs apply-patch scenario fixtures (test/fixtures/codex-apply-patch) through
 * applyPatch: copy `input/` to a temp dir, apply `patch.txt`, compare with `expected/`.
 */
import { cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatch } from "../src/apply.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "codex-apply-patch");

/** Scenarios where this port intentionally differs from the codex CLI. */
const DIVERGENCES: Record<string, { reason: string; expected: Record<string, string> }> = {
	"015_failure_after_partial_success_leaves_changes": {
		reason:
			"every hunk is verified before any file is written, so a failing patch leaves no changes (OpenCode behavior)",
		expected: {},
	},
	"024_preserves_mixed_line_endings": {
		reason: "line endings are normalized to the file's dominant ending, like pi's edit tool, instead of per line",
		expected: { "lines.txt": "one\r\ntwo\r\nTHREE\r\nfour\r\n" },
	},
};

async function snapshot(root: string): Promise<Record<string, string>> {
	const entries: Record<string, string> = {};
	if (!(await stat(root).catch(() => undefined))) return entries;
	for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const full = join(entry.parentPath, entry.name);
		entries[relative(root, full)] = await readFile(full, "utf-8");
	}
	return entries;
}

const scenarios = (await readdir(FIXTURES, { withFileTypes: true }))
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();

describe("codex-rs apply-patch scenarios", () => {
	it("found the vendored scenarios", () => {
		expect(scenarios.length).toBeGreaterThanOrEqual(25);
	});

	it.each(scenarios)("%s", async (name) => {
		const dir = join(FIXTURES, name);
		const work = await mkdtemp(join(tmpdir(), "lune-codex-"));
		try {
			if (await stat(join(dir, "input")).catch(() => undefined)) {
				await cp(join(dir, "input"), work, { recursive: true });
			}
			const patchText = await readFile(join(dir, "patch.txt"), "utf-8");
			// Like the codex harness, only the final filesystem state is asserted.
			await applyPatch(patchText, { cwd: work }).catch(() => undefined);

			const divergence = DIVERGENCES[name];
			const expected = divergence ? divergence.expected : await snapshot(join(dir, "expected"));
			expect(await snapshot(work), divergence?.reason).toEqual(expected);
		} finally {
			await rm(work, { recursive: true, force: true });
		}
	});
});
