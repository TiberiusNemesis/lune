/**
 * Filesystem side of `apply_patch`: verify every hunk against the current files first,
 * then write. Ported from OpenCode `packages/opencode/src/tool/apply_patch.ts`, minus
 * permissions, formatting and LSP diagnostics.
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createTwoFilesPatch, diffLines, FILE_HEADERS_ONLY } from "diff";
import { deriveNewContentsFromChunks, type Hunk, parsePatch, splitBom } from "./patch.ts";

export type FileAction = "add" | "update" | "delete" | "move";

export interface FileChange {
	action: FileAction;
	/** Absolute path of the file named in the patch. */
	path: string;
	/** Absolute path after the change (move destination, otherwise `path`). */
	targetPath: string;
	/** `targetPath` relative to the workspace root, with forward slashes. */
	relativePath: string;
	movePath?: string;
	/** LF-normalized contents without BOM. */
	oldContent: string;
	newContent: string;
	/** Unified diff (file headers only). */
	diff: string;
	additions: number;
	deletions: number;
}

export interface ApplyPatchResult {
	files: FileChange[];
	/** `Success. Updated the following files:` plus one `A/M/D path` line per file. */
	summary: string;
	/** All unified diffs joined. */
	diff: string;
}

export interface ApplyPatchOptions {
	cwd: string;
	/** Root used for relative paths in output and the outside-workspace check. Default: cwd. */
	workspaceRoot?: string;
	/** Allow hunks that resolve outside the workspace root. Default: false. */
	allowOutsideWorkspace?: boolean;
	/** Per-file mutation lock, e.g. pi's `withFileMutationQueue`. Default: run directly. */
	mutate?: <T>(absolutePath: string, fn: () => Promise<T>) => Promise<T>;
}

const BOM = "﻿";

const verificationError = (message: string) => new Error(`apply_patch verification failed: ${message}`);

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1 || crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export const normalizeToLF = (text: string): string => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

export const restoreLineEndings = (text: string, ending: "\r\n" | "\n"): string =>
	ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;

function resolvePatchPath(raw: string, cwd: string): string {
	let path = raw.startsWith("@") ? raw.slice(1) : raw;
	if (path === "~" || path.startsWith("~/")) path = homedir() + path.slice(1);
	return resolve(cwd, path);
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function toRelative(root: string, path: string): string {
	return relative(root, path).replaceAll("\\", "/");
}

function unifiedDiff(name: string, oldContent: string, newContent: string): string {
	return createTwoFilesPatch(name, name, oldContent, newContent, undefined, undefined, {
		context: 3,
		headerOptions: FILE_HEADERS_ONLY,
	});
}

function countChanges(oldContent: string, newContent: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const change of diffLines(oldContent, newContent)) {
		if (change.added) additions += change.count ?? 0;
		if (change.removed) deletions += change.count ?? 0;
	}
	return { additions, deletions };
}

interface PendingChange extends FileChange {
	bom: boolean;
	lineEnding: "\r\n" | "\n";
}

async function readTextFile(path: string): Promise<string | undefined> {
	const stats = await stat(path).catch(() => undefined);
	if (!stats || stats.isDirectory()) return undefined;
	return readFile(path, "utf-8");
}

async function verifyHunk(hunk: Hunk, options: Required<Omit<ApplyPatchOptions, "mutate">>): Promise<PendingChange> {
	const { cwd, workspaceRoot, allowOutsideWorkspace } = options;
	const path = resolvePatchPath(hunk.path, cwd);
	const assertInside = (candidate: string) => {
		if (!allowOutsideWorkspace && !isInside(workspaceRoot, candidate)) {
			throw verificationError(
				`${candidate} is outside the workspace ${workspaceRoot}. Set lune.applyPatch.allowOutsideWorkspace to permit this.`,
			);
		}
	};
	assertInside(path);

	switch (hunk.type) {
		case "add": {
			const raw = hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`;
			const next = splitBom(raw);
			const name = toRelative(workspaceRoot, path);
			return {
				action: "add",
				path,
				targetPath: path,
				relativePath: name,
				oldContent: "",
				newContent: next.text,
				diff: unifiedDiff(name, "", next.text),
				...countChanges("", next.text),
				bom: next.bom,
				lineEnding: "\n",
			};
		}
		case "delete": {
			const raw = await readTextFile(path);
			if (raw === undefined) throw verificationError(`Failed to read file for deletion: ${path}`);
			const { bom, text } = splitBom(raw);
			const oldContent = normalizeToLF(text);
			const name = toRelative(workspaceRoot, path);
			return {
				action: "delete",
				path,
				targetPath: path,
				relativePath: name,
				oldContent,
				newContent: "",
				diff: unifiedDiff(name, oldContent, ""),
				additions: 0,
				deletions: oldContent.split("\n").length,
				bom,
				lineEnding: detectLineEnding(text),
			};
		}
		case "update": {
			const raw = await readTextFile(path);
			if (raw === undefined) throw verificationError(`Failed to read file to update: ${path}`);
			const { bom, text } = splitBom(raw);
			const oldContent = normalizeToLF(text);
			let derived: { content: string; bom: boolean };
			try {
				derived = deriveNewContentsFromChunks(path, hunk.chunks, oldContent);
			} catch (error) {
				throw verificationError(error instanceof Error ? error.message : String(error));
			}
			const movePath = hunk.movePath ? resolvePatchPath(hunk.movePath, cwd) : undefined;
			if (movePath) assertInside(movePath);
			const targetPath = movePath ?? path;
			const name = toRelative(workspaceRoot, targetPath);
			return {
				action: movePath ? "move" : "update",
				path,
				targetPath,
				relativePath: name,
				movePath,
				oldContent,
				newContent: derived.content,
				diff: unifiedDiff(name, oldContent, derived.content),
				...countChanges(oldContent, derived.content),
				bom: bom || derived.bom,
				lineEnding: detectLineEnding(text),
			};
		}
	}
}

async function writeChange(change: PendingChange): Promise<void> {
	const encoded = (change.bom ? BOM : "") + restoreLineEndings(change.newContent, change.lineEnding);
	switch (change.action) {
		case "add":
		case "update":
			await mkdir(dirname(change.targetPath), { recursive: true });
			await writeFile(change.targetPath, encoded, "utf-8");
			return;
		case "move":
			await mkdir(dirname(change.targetPath), { recursive: true });
			await writeFile(change.targetPath, encoded, "utf-8");
			await rm(change.path, { force: true });
			return;
		case "delete":
			await rm(change.path, { force: true });
			return;
	}
}

export function summarize(files: FileChange[]): string {
	const lines = files.map((f) => `${f.action === "add" ? "A" : f.action === "delete" ? "D" : "M"} ${f.relativePath}`);
	return `Success. Updated the following files:\n${lines.join("\n")}`;
}

/** Parse, verify against the filesystem, then apply a patch. Throws before touching any file on failure. */
export async function applyPatch(patchText: string, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
	if (!patchText) throw new Error("patchText is required");

	let hunks: Hunk[];
	try {
		hunks = parsePatch(patchText).hunks;
	} catch (error) {
		throw verificationError(error instanceof Error ? error.message : String(error));
	}
	if (hunks.length === 0) {
		const normalized = patchText.replace(/\r\n?/g, "\n").trim();
		if (normalized === "*** Begin Patch\n*** End Patch") throw new Error("patch rejected: empty patch");
		throw verificationError("no hunks found");
	}

	const resolved = {
		cwd: options.cwd,
		workspaceRoot: options.workspaceRoot ?? options.cwd,
		allowOutsideWorkspace: options.allowOutsideWorkspace ?? false,
	};
	const mutate = options.mutate ?? ((_path, fn) => fn());

	const changes: PendingChange[] = [];
	for (const hunk of hunks) changes.push(await verifyHunk(hunk, resolved));

	for (const change of changes) {
		const write = () => writeChange(change);
		await (change.action === "move"
			? mutate(change.path, () => mutate(change.targetPath, write))
			: mutate(change.targetPath, write));
	}

	const files: FileChange[] = changes.map(({ bom: _bom, lineEnding: _ending, ...file }) => file);
	return { files, summary: summarize(files), diff: files.map((f) => f.diff).join("\n") };
}
