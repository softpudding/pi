/** Logical Harness storage. The session branch is the journal; task FS is never consulted. */
import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { CodemodeTool } from "@earendil-works/pi-codemode";
import { Check } from "typebox/value";
import type { ExtensionContext } from "../../../core/extensions/types.ts";
import { createEditTool } from "../../../core/tools/edit.ts";
import { generateUnifiedPatch } from "../../../core/tools/edit-diff.ts";
import { createReadTool } from "../../../core/tools/read.ts";
import { createWriteTool } from "../../../core/tools/write.ts";
import { bindHostContract } from "../contracts.ts";
import type { CodemodeParameterDescriptions } from "../input.ts";
import { object, string } from "../primitives.ts";
import { compileDefinition, type DefinitionFiles, fileText, type HarnessSnapshot, logicalPath } from "./definition.ts";
import {
	type HarnessRequestRecord,
	type InspectionQuery,
	inspectRequest,
	resolveInspectionQuery,
} from "./inspection.ts";

export const HARNESS_ENTRY = "codemode-harness-v1";
export const HARNESS_REQUEST_ENTRY = "codemode-harness-request-v1";
interface Draft {
	id: string;
	baseRevision: string;
	sequence: number;
	files: Record<string, string>;
}
interface PendingActivation {
	revision: string;
	expectedActiveRevision: string;
}
type Change =
	| { type: "snapshot"; revision: string; files: DefinitionFiles; initial?: boolean }
	| { type: "draft"; draft: Draft }
	| { type: "discard"; draft: string }
	| { type: "file"; draft: string; path: string; content?: string }
	| { type: "activate"; revision: string }
	| { type: "pending"; activation?: PendingActivation }
	| { type: "state"; key: string; value?: unknown };

export interface HarnessPreview {
	system: unknown;
	description: string;
	parameterDescriptions?: CodemodeParameterDescriptions;
	catalog?: unknown;
	provenance: unknown;
	inputSnapshot: string;
	estimatedTokens: number;
}

export class HarnessStore {
	private readonly append: (type: string, data: unknown) => void;
	private readonly defaults: () => DefinitionFiles;
	private readonly preview: (snapshot: HarnessSnapshot, signal?: AbortSignal) => Promise<HarnessPreview>;
	private files = new Map<string, DefinitionFiles>();
	private compiled = new Map<string, HarnessSnapshot>();
	private drafts = new Map<string, Draft>();
	private values = new Map<string, unknown>();
	private requests = new Map<string, HarnessRequestRecord>();
	private lastEntry?: string;
	private queue = Promise.resolve();
	activeRevision = "";
	requestRevision = "";
	pending?: PendingActivation;
	requestId?: string;

	constructor(
		append: (type: string, data: unknown) => void,
		defaults: () => DefinitionFiles,
		preview: (snapshot: HarnessSnapshot, signal?: AbortSignal) => Promise<HarnessPreview>,
	) {
		this.append = append;
		this.defaults = defaults;
		this.preview = preview;
	}

	async serialized<T>(run: () => Promise<T>): Promise<T> {
		const before = this.queue;
		let release!: () => void;
		this.queue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await before;
		try {
			return await run();
		} finally {
			release();
		}
	}

	async sync(ctx: ExtensionContext): Promise<void> {
		await this.serialized(async () => {
			const branch = ctx.sessionManager.getBranch();
			if (branch.some((e) => e.type === "custom" && e.customType === "codemode-runtime"))
				throw new Error(
					"Incompatible codemode-runtime session. Start a new Harness session; legacy registrations are not silently imported.",
				);
			const entries = branch.filter((e) => e.type === "custom" && e.customType === HARNESS_ENTRY);
			const last = entries.at(-1)?.id;
			if (last !== this.lastEntry || !this.activeRevision) {
				this.files.clear();
				this.drafts.clear();
				this.values.clear();
				this.activeRevision = "";
				this.pending = undefined;
				for (const entry of entries) if (entry.type === "custom") this.apply(entry.data as Change);
				this.lastEntry = last;
				this.requestRevision = this.activeRevision;
			}
			this.requests.clear();
			this.requestId = undefined;
			for (const entry of branch) {
				if (entry.type !== "custom" || entry.customType !== HARNESS_REQUEST_ENTRY) continue;
				const record = entry.data as HarnessRequestRecord;
				if (typeof record.requestId !== "string") continue;
				this.requests.set(record.requestId, record);
				this.requestId = record.requestId;
				this.requestRevision = record.revision;
			}
			if (!this.activeRevision) {
				const snapshot = await compileDefinition(this.defaults(), ctx.signal);
				this.compiled.set(snapshot.revision, snapshot);
				this.commit({ type: "snapshot", revision: snapshot.revision, files: snapshot.files, initial: true }, ctx);
				this.requestRevision = snapshot.revision;
			}
		});
	}

	recordRequest(record: HarnessRequestRecord): void {
		this.requests.set(record.requestId, structuredClone(record));
		this.requestId = record.requestId;
		this.requestRevision = record.revision;
	}

	private apply(change: Change): void {
		switch (change.type) {
			case "snapshot":
				this.files.set(change.revision, change.files);
				if (change.initial) this.activeRevision = change.revision;
				break;
			case "draft":
				this.drafts.set(change.draft.id, structuredClone(change.draft));
				break;
			case "discard":
				this.drafts.delete(change.draft);
				break;
			case "file": {
				const draft = this.drafts.get(change.draft);
				if (!draft) throw new Error(`Missing draft ${change.draft} in journal`);
				if (change.content === undefined) delete draft.files[change.path];
				else draft.files[change.path] = change.content;
				draft.sequence++;
				break;
			}
			case "activate":
				this.activeRevision = change.revision;
				this.pending = undefined;
				break;
			case "pending":
				this.pending = change.activation;
				break;
			case "state":
				if (change.value === undefined) this.values.delete(change.key);
				else this.values.set(change.key, change.value);
				break;
		}
	}

	private commit(change: Change, ctx: ExtensionContext): void {
		ctx.signal?.throwIfAborted();
		this.append(HARNESS_ENTRY, change);
		this.apply(change);
		this.lastEntry = ctx.sessionManager.getBranch().at(-1)?.id;
	}

	async snapshot(revision = this.activeRevision): Promise<HarnessSnapshot> {
		const cached = this.compiled.get(revision);
		if (cached && this.files.has(revision)) return cached;
		const files = this.files.get(revision);
		if (!files) throw new Error(`Unknown Harness revision ${revision}`);
		const snapshot = await compileDefinition(files);
		if (snapshot.revision !== revision) throw new Error("Harness snapshot hash mismatch");
		this.compiled.set(revision, snapshot);
		return snapshot;
	}

	/** User recovery path: usable even when an active context rule cannot render. */
	async recover(revision: string, ctx: ExtensionContext): Promise<void> {
		await this.serialized(async () => {
			const selected = revision === "initial" ? this.files.keys().next().value : revision;
			if (!selected) throw new Error("No Harness revision available");
			await this.snapshot(selected);
			this.commit({ type: "activate", revision: selected }, ctx);
		});
	}

	/** Commit only after the complete candidate request has been constructed and validated. */
	publishPending(revision: string, ctx: ExtensionContext): void {
		if (
			!this.pending ||
			this.pending.revision !== revision ||
			this.pending.expectedActiveRevision !== this.activeRevision
		)
			throw new Error("Pending Harness activation conflict");
		this.commit({ type: "activate", revision }, ctx);
	}

	private revision(value: unknown, request: string): string {
		const name = string(value, "revision");
		return name === "request" ? request : name === "active" ? this.activeRevision : name;
	}

	private draft(input: unknown): Draft {
		const handle = object(input);
		const id = string(handle.draft, "draft");
		const draft = this.drafts.get(id);
		if (!draft) throw new Error(`Unknown Harness draft ${id}`);
		if (handle.baseRevision !== undefined && handle.baseRevision !== draft.baseRevision)
			throw new Error(`Harness draft ${id} baseRevision mismatch: expected ${draft.baseRevision}`);
		return draft;
	}

	private async fileOperation(
		kind: "read" | "write" | "edit",
		input: unknown,
		ctx: ExtensionContext,
		request: string,
		signal: AbortSignal,
	): Promise<unknown> {
		const args = object(input);
		const target = object(args.target ?? { revision: "request" });
		if ("draft" in target === "revision" in target) throw new Error("target needs exactly one of draft or revision");
		const draft = "draft" in target ? this.draft(target) : undefined;
		const revision = draft ? undefined : this.revision(target.revision, request);
		const files = draft?.files ?? this.files.get(revision!);
		if (!files) throw new Error(`Unknown Harness revision ${revision}`);
		if (kind !== "read" && !draft) throw new Error("Harness writes and edits require target: {draft}");
		const path = logicalPath(args.path);
		const operations = {
			readFile: async (path: string) => Buffer.from(fileText(files, path)),
			access: async (path: string) => {
				fileText(files, path);
			},
			mkdir: async () => {},
			writeFile: async (path: string, content: string) => {
				signal.throwIfAborted();
				if (content.length > 256 * 1024 || JSON.stringify({ ...files, [path]: content }).length > 4 * 1024 * 1024)
					throw new Error("Harness file (256 KiB) or draft (4 MiB) limit exceeded");
				if (content.split("\n").some((line) => Buffer.byteLength(line) > 48 * 1024))
					throw new Error("Harness lines must fit native read (48 KiB per line); format the source with newlines");
				this.commit({ type: "file", draft: draft!.id, path, content }, ctx);
			},
		};
		const options = {
			operations,
			resolvePath: logicalPath,
			mutationQueue: async <T>(_path: string, fn: () => Promise<T>) => fn(),
		};
		let result: AgentToolResult<unknown>;
		if (kind === "read") {
			for (const field of ["offset", "limit"])
				if (args[field] !== undefined && (!Number.isSafeInteger(args[field]) || Number(args[field]) < 1))
					throw new Error(`${field} must be a positive line count`);
			const tool = createReadTool("", {
				...options,
				longLineHint:
					"This Harness line exceeds the read window; replace it with formatted multiline source in a draft.",
			});
			if (!Check(tool.parameters, args)) throw new Error("Invalid Harness read arguments");
			result = await tool.execute("harness-read", args, signal);
		} else if (kind === "write") {
			const tool = createWriteTool("", options);
			if (!Check(tool.parameters, args)) throw new Error("Invalid Harness write arguments");
			result = await tool.execute("harness-write", args, signal);
		} else {
			const tool = createEditTool("", options);
			if (!Check(tool.parameters, args))
				throw new Error("Invalid Harness edit arguments; expected edits: [{oldText,newText}]");
			result = await tool.execute("harness-edit", args, signal);
		}
		return {
			text: result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
			details: result.details,
			harness: { domain: "harness", path, revision, draft: draft?.id, draftSequence: draft?.sequence },
		};
	}

	globals(ctx: ExtensionContext, request: string, requestId = this.requestId): CodemodeTool[] {
		const methods: Record<string, CodemodeTool["execute"]> = {
			discard: (input) => {
				const draft = this.draft(input);
				this.commit({ type: "discard", draft: draft.id }, ctx);
				return { status: "discarded", draft: draft.id };
			},
			inspect: async (input) => {
				const query = resolveInspectionQuery(input as InspectionQuery);
				const selectedId = query.requestId ?? requestId;
				const record = selectedId === undefined ? undefined : this.requests.get(selectedId);
				if (selectedId !== undefined && !record)
					throw new Error(`Unknown saved Harness request ${selectedId} on this session branch`);
				const revision = record?.revision ?? request;
				const meta = { requestId: selectedId, requestRevision: revision, activeRevision: this.activeRevision };
				if (query.section && query.section !== "overview") {
					if (!record) throw new Error("No saved Harness request is available yet");
					return { ...meta, ...inspectRequest(record, query) };
				}
				if (query.id !== undefined || query.limit !== undefined)
					throw new Error("id and limit require a detail section: system, codemode or provenance");
				const snapshot = await this.snapshot(revision);
				return {
					section: "overview",
					...meta,
					pendingActivation: this.pending,
					drafts: [...this.drafts.values()].map(({ files: _files, ...draft }) => draft),
					files: Object.keys(snapshot.files),
					context: record
						? {
								system: record.system.map(({ id, text }) => ({ id, chars: text.length })),
								codemode: { id: "codemode", chars: record.description.length },
								history: { id: "history", messages: record.history.length, chars: record.historyChars },
							}
						: undefined,
					sources: record?.provenance ?? [],
					views: snapshot.views,
					viewDefinitions: snapshot.definition.codemode.output.views.file,
				};
			},
			begin: (input) => {
				const base = this.revision(object(input ?? {}).base ?? "active", request);
				const files = this.files.get(base);
				if (!files) throw new Error(`Unknown base ${base}`);
				const draft = { id: `d-${randomUUID()}`, baseRevision: base, sequence: 0, files: { ...files } };
				if (this.drafts.size >= 32) throw new Error("Harness has 32 drafts; discard unused drafts first");
				this.commit({ type: "draft", draft }, ctx);
				return { draft: draft.id, baseRevision: base };
			},
			read: (input, { signal }) => this.fileOperation("read", input, ctx, request, signal),
			write: (input, { signal }) => this.fileOperation("write", input, ctx, request, signal),
			edit: (input, { signal }) => this.fileOperation("edit", input, ctx, request, signal),
			remove: (input, { signal }) => {
				signal.throwIfAborted();
				const args = object(input);
				const draft = this.draft(args.target);
				const path = logicalPath(args.path);
				fileText(draft.files, path);
				this.commit({ type: "file", draft: draft.id, path }, ctx);
				return { draft: draft.id, path, draftSequence: draft.sequence };
			},
			prepare: async (input, { signal }) => {
				const draft = this.draft(input);
				const snapshot = await compileDefinition({ ...draft.files }, signal);
				const preview = await this.preview(snapshot, signal);
				signal.throwIfAborted();
				if (!this.files.has(snapshot.revision))
					this.commit({ type: "snapshot", revision: snapshot.revision, files: snapshot.files }, ctx);
				this.compiled.set(snapshot.revision, snapshot);
				const baseline = this.files.get(draft.baseRevision)!;
				const changed = [...new Set([...Object.keys(baseline), ...Object.keys(snapshot.files)])].filter(
					(path) => baseline[path] !== snapshot.files[path],
				);
				return {
					revision: snapshot.revision,
					baseRevision: draft.baseRevision,
					draftSequence: draft.sequence,
					diagnostics: [],
					preview,
					diff: changed.map((path) =>
						generateUnifiedPatch(path, baseline[path] ?? "", snapshot.files[path] ?? ""),
					),
				};
			},
			activate: async (input, { signal }) => {
				const args = object(input);
				const revision = string(args.revision, "revision");
				const expected = string(args.expectedActiveRevision, "expectedActiveRevision");
				if (expected !== this.activeRevision)
					throw new Error(`Harness activation conflict: active is ${this.activeRevision}`);
				if (this.pending) throw new Error("A Harness activation is pending; cancel it before scheduling another");
				const when = args.when ?? "next_request";
				if (when !== "now" && when !== "next_request") throw new Error("when must be now or next_request");
				const snapshot = await this.snapshot(revision);
				await this.preview(snapshot, signal);
				signal.throwIfAborted();
				if (when === "now") this.commit({ type: "activate", revision }, ctx);
				else this.commit({ type: "pending", activation: { revision, expectedActiveRevision: expected } }, ctx);
				return { status: when === "now" ? "active" : "scheduled", revision, requestRevision: request };
			},
			cancelActivation: (input) => {
				if (this.pending?.revision !== string(object(input).revision, "revision"))
					throw new Error("No matching scheduled activation");
				this.commit({ type: "pending" }, ctx);
				return { status: "cancelled" };
			},
		};
		return Object.entries(methods).map(([name, execute]) =>
			bindHostContract(`host.harness.${name}`, (args, call) =>
				this.serialized(async () => {
					call.signal.throwIfAborted();
					return execute(args, call);
				}),
			),
		);
	}

	getState(module: string, key: string): unknown {
		return this.values.get(`${module}\0${key}`);
	}
	async setState(module: string, key: string, value: unknown, ctx: ExtensionContext): Promise<void> {
		await this.serialized(async () => {
			const values = new Map(this.values);
			values.set(`${module}\0${key}`, value);
			if (JSON.stringify([...values]).length > 4 * 1024 * 1024) throw new Error("Harness state exceeds 4 MiB");
			this.commit({ type: "state", key: `${module}\0${key}`, value }, ctx);
		});
	}
}
