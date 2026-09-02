import { describe, expect, it } from "vitest";
import { deriveNewContentsFromChunks, parsePatch, seekSequence, stripHeredoc } from "../src/patch.ts";

const BOM = "\uFEFF";

describe("parsePatch (ported from OpenCode patch.test.ts)", () => {
	it("should parse simple add file patch", () => {
		const result = parsePatch("*** Begin Patch\n*** Add File: test.txt\n+Hello World\n*** End Patch");
		expect(result.hunks).toEqual([{ type: "add", path: "test.txt", contents: "Hello World" }]);
	});

	it("should parse delete file patch", () => {
		const result = parsePatch("*** Begin Patch\n*** Delete File: old.txt\n*** End Patch");
		expect(result.hunks).toEqual([{ type: "delete", path: "old.txt" }]);
	});

	it("should parse patch with multiple hunks", () => {
		const patchText = `*** Begin Patch
*** Add File: new.txt
+This is a new file
*** Update File: existing.txt
@@
 old line
-new line
+updated line
*** End Patch`;
		const result = parsePatch(patchText);
		expect(result.hunks).toHaveLength(2);
		expect(result.hunks[0].type).toBe("add");
		expect(result.hunks[1]).toEqual({
			type: "update",
			path: "existing.txt",
			movePath: undefined,
			chunks: [
				{ oldLines: ["old line", "new line"], newLines: ["old line", "updated line"], changeContext: undefined },
			],
		});
	});

	it("should parse file move operation", () => {
		const patchText = `*** Begin Patch
*** Update File: old-name.txt
*** Move to: new-name.txt
@@
-Old content
+New content
*** End Patch`;
		const hunk = parsePatch(patchText).hunks[0];
		expect(hunk.type).toBe("update");
		expect(hunk.path).toBe("old-name.txt");
		if (hunk.type === "update") expect(hunk.movePath).toBe("new-name.txt");
	});

	it("should throw error for invalid patch format", () => {
		expect(() => parsePatch("This is not a valid patch")).toThrow("Invalid patch format");
	});
});

describe("parsePatch grammar (codex-rs rules)", () => {
	it("parses @@ context, End of File and multiple chunks", () => {
		const patchText = `*** Begin Patch
*** Update File: a.ts
@@ class Foo
 x
-y
+z
@@
-last
+end
*** End of File
*** End Patch`;
		const hunk = parsePatch(patchText).hunks[0];
		if (hunk.type !== "update") throw new Error("expected update");
		expect(hunk.chunks).toEqual([
			{ oldLines: ["x", "y"], newLines: ["x", "z"], changeContext: "class Foo" },
			{ oldLines: ["last"], newLines: ["end"], changeContext: undefined, isEndOfFile: true },
		]);
	});

	it("tolerates whitespace around markers and headers", () => {
		const patchText = " *** Begin Patch \n  *** Update File: foo.txt\n@@\n-old\n+new\n *** End Patch ";
		const hunk = parsePatch(patchText).hunks[0];
		expect(hunk.path).toBe("foo.txt");
	});

	it("normalizes CRLF patch text", () => {
		const result = parsePatch("*** Begin Patch\r\n*** Add File: a.txt\r\n+one\r\n+two\r\n*** End Patch\r\n");
		expect(result.hunks[0]).toEqual({ type: "add", path: "a.txt", contents: "one\ntwo" });
	});

	it("strips heredoc wrappers", () => {
		expect(stripHeredoc("cat <<'EOF'\nbody\nEOF")).toBe("body");
		expect(stripHeredoc("<<EOF\nbody\nEOF\n")).toBe("body");
		const result = parsePatch("<<EOF\n*** Begin Patch\n*** Add File: h.txt\n+hi\n*** End Patch\nEOF");
		expect(result.hunks[0].path).toBe("h.txt");
	});

	it("treats blank lines inside an update hunk as empty context lines", () => {
		const hunk = parsePatch("*** Begin Patch\n*** Update File: f\n@@\n-a\n\n+b\n*** End Patch").hunks[0];
		if (hunk.type !== "update") throw new Error("expected update");
		expect(hunk.chunks[0]).toEqual({ oldLines: ["a", ""], newLines: ["", "b"], changeContext: undefined });
	});

	it("allows consecutive @@ context markers", () => {
		const hunk = parsePatch("*** Begin Patch\n*** Update File: f\n@@ class A\n@@ def m():\n-a\n+b\n*** End Patch")
			.hunks[0];
		if (hunk.type !== "update") throw new Error("expected update");
		expect(hunk.chunks.map((c) => c.changeContext)).toEqual(["class A", "def m():"]);
	});

	it("rejects an invalid hunk header", () => {
		expect(() => parsePatch("*** Begin Patch\n*** Frobnicate File: foo\n*** End Patch")).toThrow(
			"'*** Frobnicate File: foo' is not a valid hunk header",
		);
	});

	it("rejects an empty update hunk", () => {
		expect(() => parsePatch("*** Begin Patch\n*** Update File: foo.txt\n*** End Patch")).toThrow(
			"Update file hunk for path 'foo.txt' is empty",
		);
		expect(() => parsePatch("*** Begin Patch\n*** Update File: foo.txt\n@@\n*** End Patch")).toThrow(
			"Update file hunk for path 'foo.txt' is empty",
		);
	});

	it("rejects stray lines inside an update hunk", () => {
		expect(() => parsePatch("*** Begin Patch\n*** Update File: f\n@@\n-a\nbad\n*** End Patch")).toThrow(
			"Unexpected line found in update hunk: 'bad'",
		);
	});

	it("rejects lines without + inside an add hunk", () => {
		expect(() => parsePatch("*** Begin Patch\n*** Add File: f\nno plus\n*** End Patch")).toThrow(
			"'no plus' is not a valid hunk header",
		);
	});

	it("rejects End of File on an empty chunk", () => {
		expect(() => parsePatch("*** Begin Patch\n*** Update File: f\n@@\n*** End of File\n*** End Patch")).toThrow(
			"Update hunk does not contain any lines",
		);
	});

	it("returns no hunks for an empty envelope", () => {
		expect(parsePatch("*** Begin Patch\n*** End Patch").hunks).toEqual([]);
	});
});

describe("deriveNewContentsFromChunks", () => {
	const derive = (text: string, patch: string) => {
		const hunk = parsePatch(`*** Begin Patch\n*** Update File: f\n${patch}\n*** End Patch`).hunks[0];
		if (hunk.type !== "update") throw new Error("expected update");
		return deriveNewContentsFromChunks("f", hunk.chunks, text);
	};

	it("replaces matched lines and guarantees a trailing newline", () => {
		expect(derive("a\nb\nc", "@@\n-b\n+B").content).toBe("a\nB\nc\n");
	});

	it("appends pure additions at the end of the file", () => {
		expect(derive("a\nb\n", "@@\n+c\n+d").content).toBe("a\nb\nc\nd\n");
	});

	it("uses the @@ context to disambiguate", () => {
		expect(derive("fn a\nx=1\nfn b\nx=1\n", "@@ fn b\n-x=1\n+x=2").content).toBe("fn a\nx=1\nfn b\nx=2\n");
	});

	it("anchors End of File chunks at the end first", () => {
		expect(derive("m\nmid\nm\nend\n", "@@\n-m\n-end\n+M\n+end\n*** End of File").content).toBe("m\nmid\nM\nend\n");
	});

	it("preserves a BOM flag without matching against it", () => {
		const result = derive(`${BOM}using System;\n\nclass T {}\n`, "@@\n class T {}\n+class N {}");
		expect(result.bom).toBe(true);
		expect(result.content).toBe("using System;\n\nclass T {}\nclass N {}\n");
	});

	it("reports context and sequence failures with OpenCode wording", () => {
		expect(() => derive("a\n", "@@ nope\n-a\n+b")).toThrow("Failed to find context 'nope' in f");
		expect(() => derive("a\n", "@@\n-zzz\n+b")).toThrow("Failed to find expected lines in f:\nzzz");
	});

	it("retries without a trailing empty context line", () => {
		expect(derive("a\nb\n", "@@\n-b\n+B\n").content).toBe("a\nB\n");
	});
});

describe("seekSequence", () => {
	const lines = ["  one  ", "two", "“quoted”"];
	it("matches exact, rstrip, trim and unicode-normalized in that order", () => {
		expect(seekSequence(lines, ["two"], 0)).toBe(1);
		expect(seekSequence(lines, ["  one"], 0)).toBe(0);
		expect(seekSequence(lines, ["one"], 0)).toBe(0);
		expect(seekSequence(lines, ['"quoted"'], 0)).toBe(2);
	});
	it("returns -1 when the pattern is longer than the input", () => {
		expect(seekSequence(["a"], ["a", "b"], 0)).toBe(-1);
	});
});
