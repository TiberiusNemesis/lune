/**
 * Parser and content deriver for the Codex / OpenCode `*** Begin Patch` format.
 *
 * Ported from OpenCode `packages/opencode/src/patch/index.ts` (commit 8e0f1c2),
 * with the grammar tightened to match OpenAI's reference implementation in
 * `codex-rs/apply-patch` (unknown headers, empty update hunks and stray lines
 * inside an update hunk are rejected instead of silently skipped).
 *
 * Everything in this module is pure: no filesystem access.
 */

export interface UpdateFileChunk {
	oldLines: string[];
	newLines: string[];
	changeContext?: string;
	isEndOfFile?: boolean;
}

export type Hunk =
	| { type: "add"; path: string; contents: string }
	| { type: "delete"; path: string }
	| { type: "update"; path: string; movePath?: string; chunks: UpdateFileChunk[] };

const BEGIN_MARKER = "*** Begin Patch";
const END_MARKER = "*** End Patch";
const ADD_MARKER = "*** Add File:";
const DELETE_MARKER = "*** Delete File:";
const UPDATE_MARKER = "*** Update File:";
const MOVE_MARKER = "*** Move to:";
const EOF_MARKER = "*** End of File";

const INVALID_HEADER = (line: string) =>
	`'${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`;
const UNEXPECTED_LINE = (line: string) =>
	`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`;

/** Strip a `cat <<'EOF' ... EOF` / `<<EOF ... EOF` wrapper some models emit around the patch. */
export function stripHeredoc(input: string): string {
	const match = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
	return match ? match[2] : input;
}

function headerPath(trimmed: string, marker: string): string | undefined {
	if (!trimmed.startsWith(marker)) return undefined;
	const path = trimmed.slice(marker.length).trim();
	if (!path) throw new Error(INVALID_HEADER(trimmed));
	return path;
}

function chunkIsEmpty(chunk: UpdateFileChunk): boolean {
	return chunk.oldLines.length === 0 && chunk.newLines.length === 0;
}

export function parsePatch(patchText: string): { hunks: Hunk[] } {
	const cleaned = stripHeredoc(patchText.replace(/\r\n?/g, "\n").trim());
	const lines = cleaned.split("\n");

	const beginIdx = lines.findIndex((line) => line.trim() === BEGIN_MARKER);
	const endIdx = lines.findIndex((line, idx) => idx > beginIdx && line.trim() === END_MARKER);
	if (beginIdx === -1 || endIdx === -1) {
		throw new Error("Invalid patch format: missing Begin/End markers");
	}

	const hunks: Hunk[] = [];
	let current: Hunk | undefined;

	const finishUpdate = () => {
		if (current?.type !== "update") return;
		if (current.chunks.length === 0 || current.chunks.every(chunkIsEmpty)) {
			throw new Error(`Update file hunk for path '${current.path}' is empty`);
		}
	};

	for (let i = beginIdx + 1; i < endIdx; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		// Section headers are recognised in every state. Codex tolerates whitespace around them.
		const addPath = headerPath(trimmed, ADD_MARKER);
		const deletePath = addPath === undefined ? headerPath(trimmed, DELETE_MARKER) : undefined;
		const updatePath =
			addPath === undefined && deletePath === undefined ? headerPath(trimmed, UPDATE_MARKER) : undefined;
		if (addPath !== undefined || deletePath !== undefined || updatePath !== undefined) {
			finishUpdate();
			if (addPath !== undefined) current = { type: "add", path: addPath, contents: "" };
			else if (deletePath !== undefined) current = { type: "delete", path: deletePath };
			else current = { type: "update", path: updatePath as string, chunks: [] };
			hunks.push(current);
			continue;
		}

		if (current?.type === "add") {
			if (line.startsWith("+")) {
				current.contents += `${line.slice(1)}\n`;
				continue;
			}
			throw new Error(INVALID_HEADER(trimmed));
		}

		if (current?.type === "update") {
			const { chunks } = current;
			const last = chunks[chunks.length - 1];
			// Inside a hunk only trailing whitespace is ignored, so a context line " @@ x" stays a context line.
			const marker = line.trimEnd();

			if (chunks.length === 0 && current.movePath === undefined && marker.startsWith(MOVE_MARKER)) {
				current.movePath = marker.slice(MOVE_MARKER.length).trim();
				if (!current.movePath) throw new Error(INVALID_HEADER(trimmed));
				continue;
			}
			if (marker === "@@" || marker.startsWith("@@ ")) {
				const context = marker.slice(2).trim();
				chunks.push({ oldLines: [], newLines: [], changeContext: context || undefined });
				continue;
			}
			if (marker === EOF_MARKER) {
				if (!last || chunkIsEmpty(last)) throw new Error("Update hunk does not contain any lines");
				last.isEndOfFile = true;
				continue;
			}
			if (last?.isEndOfFile) {
				if (trimmed === "") continue;
				throw new Error(`Expected update hunk to start with a @@ context marker, got: '${line}'`);
			}
			if (!last) chunks.push({ oldLines: [], newLines: [] });
			const target = chunks[chunks.length - 1];
			if (line === "") {
				target.oldLines.push("");
				target.newLines.push("");
			} else if (line.startsWith(" ")) {
				target.oldLines.push(line.slice(1));
				target.newLines.push(line.slice(1));
			} else if (line.startsWith("-")) {
				target.oldLines.push(line.slice(1));
			} else if (line.startsWith("+")) {
				target.newLines.push(line.slice(1));
			} else {
				throw new Error(UNEXPECTED_LINE(line));
			}
			continue;
		}

		// Between sections (before the first header or after a delete): only blank lines are tolerated.
		if (trimmed === "") continue;
		throw new Error(INVALID_HEADER(trimmed));
	}
	finishUpdate();

	for (const hunk of hunks) {
		if (hunk.type === "add" && hunk.contents.endsWith("\n")) hunk.contents = hunk.contents.slice(0, -1);
	}
	return { hunks };
}

// ---------------------------------------------------------------------------
// Applying update chunks to file contents
// ---------------------------------------------------------------------------

const BOM = "﻿";

export function splitBom(text: string): { bom: boolean; text: string } {
	return text.startsWith(BOM) ? { bom: true, text: text.slice(1) } : { bom: false, text };
}

/**
 * Compute the new file contents for an update hunk. `originalText` may carry a BOM,
 * which is stripped before matching and reported back so the caller can restore it.
 * Line endings must already be normalized to LF by the caller.
 */
export function deriveNewContentsFromChunks(
	filePath: string,
	chunks: UpdateFileChunk[],
	originalText: string,
): { content: string; bom: boolean } {
	const original = splitBom(originalText);
	const originalLines = original.text.split("\n");
	if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") originalLines.pop();

	const replacements = computeReplacements(originalLines, filePath, chunks);
	const newLines = applyReplacements(originalLines, replacements);
	if (newLines.length === 0 || newLines[newLines.length - 1] !== "") newLines.push("");

	const next = splitBom(newLines.join("\n"));
	return { content: next.text, bom: original.bom || next.bom };
}

type Replacement = [start: number, oldLength: number, newLines: string[]];

function computeReplacements(originalLines: string[], filePath: string, chunks: UpdateFileChunk[]): Replacement[] {
	const replacements: Replacement[] = [];
	let lineIndex = 0;

	for (const chunk of chunks) {
		if (chunk.changeContext) {
			const contextIdx = seekSequence(originalLines, [chunk.changeContext], lineIndex);
			if (contextIdx === -1) throw new Error(`Failed to find context '${chunk.changeContext}' in ${filePath}`);
			lineIndex = contextIdx + 1;
		}

		// A chunk with a context marker but no lines only moves the cursor.
		if (chunkIsEmpty(chunk)) continue;

		// Pure addition: appended at the end of the file (matches codex-rs and OpenCode).
		if (chunk.oldLines.length === 0) {
			const insertionIdx =
				originalLines.length > 0 && originalLines[originalLines.length - 1] === ""
					? originalLines.length - 1
					: originalLines.length;
			replacements.push([insertionIdx, 0, chunk.newLines]);
			continue;
		}

		let pattern = chunk.oldLines;
		let newSlice = chunk.newLines;
		let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);

		// Retry without a trailing empty line, which models often add before the next marker.
		if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") newSlice = newSlice.slice(0, -1);
			found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		}

		if (found === -1) {
			throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
		}
		replacements.push([found, pattern.length, newSlice]);
		lineIndex = found + pattern.length;
	}

	replacements.sort((a, b) => a[0] - b[0]);
	return replacements;
}

function applyReplacements(lines: string[], replacements: Replacement[]): string[] {
	const result = [...lines];
	for (let i = replacements.length - 1; i >= 0; i--) {
		const [start, oldLength, newSegment] = replacements[i];
		result.splice(start, oldLength, ...newSegment);
	}
	return result;
}

/** Normalize typographic punctuation to ASCII, mirroring codex-rs `seek_sequence::normalise`. */
function normalizeUnicode(str: string): string {
	return str
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[‐‑‒–—―]/g, "-")
		.replace(/…/g, "...")
		.replace(/ /g, " ");
}

type Comparator = (a: string, b: string) => boolean;

function tryMatch(lines: string[], pattern: string[], startIndex: number, compare: Comparator, eof: boolean): number {
	const matchesAt = (at: number) => pattern.every((p, j) => compare(lines[at + j], p));
	if (eof) {
		const fromEnd = lines.length - pattern.length;
		if (fromEnd >= startIndex && matchesAt(fromEnd)) return fromEnd;
	}
	for (let i = startIndex; i <= lines.length - pattern.length; i++) {
		if (matchesAt(i)) return i;
	}
	return -1;
}

/**
 * Find `pattern` in `lines` at or after `startIndex` with decreasing strictness:
 * exact, trailing-whitespace-insensitive, whitespace-insensitive, then Unicode-punctuation-normalized.
 * With `eof`, the end of the file is tried first.
 */
export function seekSequence(lines: string[], pattern: string[], startIndex: number, eof = false): number {
	if (pattern.length === 0 || pattern.length > lines.length) return -1;
	const passes: Comparator[] = [
		(a, b) => a === b,
		(a, b) => a.trimEnd() === b.trimEnd(),
		(a, b) => a.trim() === b.trim(),
		(a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()),
	];
	for (const compare of passes) {
		const idx = tryMatch(lines, pattern, startIndex, compare, eof);
		if (idx !== -1) return idx;
	}
	return -1;
}
