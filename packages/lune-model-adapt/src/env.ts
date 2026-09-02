import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Nearest ancestor (including `cwd`) that contains a `.git` entry. */
export function findGitRoot(cwd: string): string | undefined {
	let dir = cwd;
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}
