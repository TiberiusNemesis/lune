import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatch } from "../src/apply.ts";

const BOM = "﻿";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "lune-apply-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const read = (name: string) => readFile(join(dir, name), "utf-8");
const write = async (name: string, content: string) => {
	await mkdir(join(dir, name, ".."), { recursive: true });
	await writeFile(join(dir, name), content, "utf-8");
};
const exists = (name: string) =>
	access(join(dir, name))
		.then(() => true)
		.catch(() => false);
const run = (patchText: string, extra: Partial<Parameters<typeof applyPatch>[1]> = {}) =>
	applyPatch(patchText, { cwd: dir, ...extra });
const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

describe("applyPatch (ported from OpenCode apply_patch.test.ts)", () => {
	it("requires patchText", async () => {
		await expect(run("")).rejects.toThrow("patchText is required");
	});

	it("rejects invalid patch format", async () => {
		await expect(run("invalid patch")).rejects.toThrow("apply_patch verification failed");
	});

	it("rejects empty patch", async () => {
		await expect(run("*** Begin Patch\n*** End Patch")).rejects.toThrow("patch rejected: empty patch");
		await expect(run("*** Begin Patch\r\n*** End Patch\r\n")).rejects.toThrow("patch rejected: empty patch");
	});

	it("applies add/update/delete in one patch", async () => {
		await write("modify.txt", "line1\nline2\n");
		await write("delete.txt", "obsolete\n");
		const result = await run(
			patch(
				"*** Add File: nested/new.txt\n+created\n*** Delete File: delete.txt\n*** Update File: modify.txt\n@@\n-line2\n+changed",
			),
		);
		expect(result.summary).toBe(
			"Success. Updated the following files:\nA nested/new.txt\nD delete.txt\nM modify.txt",
		);
		expect(result.files.map((f) => f.action)).toEqual(["add", "delete", "update"]);
		expect(result.files[0].diff).toContain("+created");
		expect(result.files[2].diff).toContain("-line2");
		expect(result.files[2].diff).toContain("+changed");
		expect(result.diff).toContain("--- modify.txt\n+++ modify.txt");
		expect(await read("nested/new.txt")).toBe("created\n");
		expect(await read("modify.txt")).toBe("line1\nchanged\n");
		expect(await exists("delete.txt")).toBe(false);
	});

	it("reports move file info", async () => {
		await write("old/name.txt", "old content\n");
		const result = await run(
			patch("*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-old content\n+new content"),
		);
		expect(result.files).toHaveLength(1);
		const move = result.files[0];
		expect(move.action).toBe("move");
		expect(move.relativePath).toBe("renamed/dir/name.txt");
		expect(move.movePath).toBe(join(dir, "renamed/dir/name.txt"));
		expect(move.diff).toContain("-old content");
		expect(move.diff).toContain("+new content");
		expect(await exists("old/name.txt")).toBe(false);
		expect(await read("renamed/dir/name.txt")).toBe("new content\n");
	});

	it("applies multiple hunks to one file", async () => {
		await write("multi.txt", "line1\nline2\nline3\nline4\n");
		await run(patch("*** Update File: multi.txt\n@@\n-line2\n+changed2\n@@\n-line4\n+changed4"));
		expect(await read("multi.txt")).toBe("line1\nchanged2\nline3\nchanged4\n");
	});

	it("does not invent a first-line diff for BOM files", async () => {
		await write("example.cs", `${BOM}using System;\n\nclass Test {}\n`);
		const result = await run(patch("*** Update File: example.cs\n@@\n class Test {}\n+class Next {}"));
		const shown = result.files[0].diff;
		expect(shown).not.toContain(BOM);
		expect(shown).not.toContain("-using System;");
		expect(shown).not.toContain("+using System;");
		const content = await read("example.cs");
		expect(content.charCodeAt(0)).toBe(0xfeff);
		expect(content.slice(1)).toBe("using System;\n\nclass Test {}\nclass Next {}\n");
	});

	it("inserts lines with insert-only hunk", async () => {
		await write("insert_only.txt", "alpha\nomega\n");
		await run(patch("*** Update File: insert_only.txt\n@@\n alpha\n+beta\n omega"));
		expect(await read("insert_only.txt")).toBe("alpha\nbeta\nomega\n");
	});

	it("appends trailing newline on update", async () => {
		await write("no_newline.txt", "no newline at end");
		await run(patch("*** Update File: no_newline.txt\n@@\n-no newline at end\n+first line\n+second line"));
		expect(await read("no_newline.txt")).toBe("first line\nsecond line\n");
	});

	it("moves file overwriting existing destination", async () => {
		await write("old/name.txt", "from\n");
		await write("renamed/dir/name.txt", "existing\n");
		await run(patch("*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-from\n+new"));
		expect(await exists("old/name.txt")).toBe(false);
		expect(await read("renamed/dir/name.txt")).toBe("new\n");
	});

	it("adds file overwriting existing file", async () => {
		await write("duplicate.txt", "old content\n");
		await run(patch("*** Add File: duplicate.txt\n+new content"));
		expect(await read("duplicate.txt")).toBe("new content\n");
	});

	it("rejects update when target file is missing", async () => {
		await expect(run(patch("*** Update File: missing.txt\n@@\n-nope\n+better"))).rejects.toThrow(
			"apply_patch verification failed: Failed to read file to update",
		);
	});

	it("rejects delete when file is missing or a directory", async () => {
		await expect(run(patch("*** Delete File: missing.txt"))).rejects.toThrow("apply_patch verification failed");
		await mkdir(join(dir, "dir"));
		await expect(run(patch("*** Delete File: dir"))).rejects.toThrow("apply_patch verification failed");
		expect(await exists("dir")).toBe(true);
	});

	it("rejects invalid hunk header", async () => {
		await expect(run(patch("*** Frobnicate File: foo"))).rejects.toThrow("apply_patch verification failed");
	});

	it("rejects update with missing context and leaves the file untouched", async () => {
		await write("modify.txt", "line1\nline2\n");
		await expect(run(patch("*** Update File: modify.txt\n@@\n-missing\n+changed"))).rejects.toThrow(
			"apply_patch verification failed: Failed to find expected lines",
		);
		expect(await read("modify.txt")).toBe("line1\nline2\n");
	});

	it("verification failure leaves no side effects", async () => {
		await expect(
			run(patch("*** Add File: created.txt\n+hello\n*** Update File: missing.txt\n@@\n-old\n+new")),
		).rejects.toThrow();
		expect(await exists("created.txt")).toBe(false);
	});

	it("supports end of file anchor", async () => {
		await write("tail.txt", "alpha\nlast\n");
		await run(patch("*** Update File: tail.txt\n@@\n-last\n+end\n*** End of File"));
		expect(await read("tail.txt")).toBe("alpha\nend\n");
	});

	it("rejects missing second chunk context", async () => {
		await write("two_chunks.txt", "a\nb\nc\nd\n");
		await expect(run(patch("*** Update File: two_chunks.txt\n@@\n-b\n+B\n\n-d\n+D"))).rejects.toThrow();
		expect(await read("two_chunks.txt")).toBe("a\nb\nc\nd\n");
	});

	it("disambiguates change context with @@ header", async () => {
		await write("multi_ctx.txt", "fn a\nx=10\ny=2\nfn b\nx=10\ny=20\n");
		await run(patch("*** Update File: multi_ctx.txt\n@@ fn b\n-x=10\n+x=11"));
		expect(await read("multi_ctx.txt")).toBe("fn a\nx=10\ny=2\nfn b\nx=11\ny=20\n");
	});

	it("EOF anchor matches from end of file first", async () => {
		await write("eof_anchor.txt", "start\nmarker\nmiddle\nmarker\nend\n");
		await run(patch("*** Update File: eof_anchor.txt\n@@\n-marker\n-end\n+marker-changed\n+end\n*** End of File"));
		expect(await read("eof_anchor.txt")).toBe("start\nmarker\nmiddle\nmarker-changed\nend\n");
	});

	it("parses heredoc-wrapped patches", async () => {
		await run("cat <<'EOF'\n*** Begin Patch\n*** Add File: heredoc_test.txt\n+heredoc content\n*** End Patch\nEOF");
		expect(await read("heredoc_test.txt")).toBe("heredoc content\n");
		await run("<<EOF\n*** Begin Patch\n*** Add File: heredoc_no_cat.txt\n+no cat prefix\n*** End Patch\nEOF");
		expect(await read("heredoc_no_cat.txt")).toBe("no cat prefix\n");
	});

	it("matches with trailing and leading whitespace differences", async () => {
		await write("trailing_ws.txt", "line1  \nline2\nline3   \n");
		await run(patch("*** Update File: trailing_ws.txt\n@@\n-line2\n+changed"));
		expect(await read("trailing_ws.txt")).toBe("line1  \nchanged\nline3   \n");

		await write("leading_ws.txt", "  line1\nline2\n  line3\n");
		await run(patch("*** Update File: leading_ws.txt\n@@\n-line2\n+changed"));
		expect(await read("leading_ws.txt")).toBe("  line1\nchanged\n  line3\n");
	});

	it("matches with Unicode punctuation differences", async () => {
		await write("unicode.txt", "He said “hello”\nsome—dash\nend\n");
		await run(patch('*** Update File: unicode.txt\n@@\n-He said "hello"\n+He said "hi"'));
		expect(await read("unicode.txt")).toBe('He said "hi"\nsome—dash\nend\n');
	});
});

describe("applyPatch (lune additions)", () => {
	it("preserves CRLF line endings", async () => {
		await write("crlf.txt", "one\r\ntwo\r\nthree\r\n");
		const result = await run(patch("*** Update File: crlf.txt\n@@\n-one\n+ONE\n two\n+between\n three"));
		expect(await read("crlf.txt")).toBe("ONE\r\ntwo\r\nbetween\r\nthree\r\n");
		expect(result.files[0].diff).not.toContain("\r");
		expect(result.files[0].additions).toBe(2);
		expect(result.files[0].deletions).toBe(1);
	});

	it("preserves a BOM through a rename with content change", async () => {
		await write("a.txt", `${BOM}x\ny\n`);
		await run(patch("*** Update File: a.txt\n*** Move to: b.txt\n@@\n-y\n+z"));
		expect(await exists("a.txt")).toBe(false);
		expect(await read("b.txt")).toBe(`${BOM}x\nz\n`);
	});

	it("rejects files outside the workspace unless allowed", async () => {
		const outside = await mkdtemp(join(tmpdir(), "lune-outside-"));
		try {
			const target = join(outside, "x.txt");
			await writeFile(target, "a\n");
			const body = `*** Update File: ${target}\n@@\n-a\n+b`;
			await expect(run(patch(body))).rejects.toThrow("apply_patch verification failed");
			await expect(run(patch(body))).rejects.toThrow("outside the workspace");
			await expect(run(patch("*** Update File: ../../../etc/hosts\n@@\n-a\n+b"))).rejects.toThrow(
				"outside the workspace",
			);
			expect(await readFile(target, "utf-8")).toBe("a\n");

			await run(patch(body), { allowOutsideWorkspace: true });
			expect(await readFile(target, "utf-8")).toBe("b\n");
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("rejects a move destination outside the workspace", async () => {
		await write("in.txt", "a\n");
		await expect(run(patch("*** Update File: in.txt\n*** Move to: ../escaped.txt\n@@\n-a\n+b"))).rejects.toThrow(
			"outside the workspace",
		);
		expect(await read("in.txt")).toBe("a\n");
	});

	it("rejects a context mismatch with the @@ header", async () => {
		await write("ctx.txt", "a\nb\n");
		await expect(run(patch("*** Update File: ctx.txt\n@@ fn nowhere\n-b\n+c"))).rejects.toThrow(
			"apply_patch verification failed: Failed to find context 'fn nowhere'",
		);
	});

	it("rejects an empty update hunk with codex wording", async () => {
		await write("f.txt", "a\n");
		await expect(run(patch("*** Update File: f.txt"))).rejects.toThrow("Update file hunk for path 'f.txt' is empty");
	});

	it("routes writes through the mutation hook, including both ends of a move", async () => {
		await write("m.txt", "a\n");
		const seen: string[] = [];
		await run(patch("*** Add File: n.txt\n+x\n*** Update File: m.txt\n*** Move to: moved.txt\n@@\n-a\n+b"), {
			mutate: async (path, fn) => {
				seen.push(path);
				return fn();
			},
		});
		expect(seen).toEqual([join(dir, "n.txt"), join(dir, "m.txt"), join(dir, "moved.txt")]);
	});

	it("strips a leading @ from paths and produces a header-only unified diff", async () => {
		await write("at.txt", "a\n");
		const result = await run(patch("*** Update File: @at.txt\n@@\n-a\n+b"));
		expect(await read("at.txt")).toBe("b\n");
		expect(result.files[0].diff).toBe("--- at.txt\n+++ at.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n");
	});
});
