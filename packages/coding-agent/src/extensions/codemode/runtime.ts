/** Execute model-owned tools against immutable Harness definitions. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { toToolDeclaration } from "@earendil-works/pi-ai";
import {
	type CodemodeOutputItem,
	CodemodeSandbox,
	type CodemodeTool,
	loadQuickJSEncoding,
	loadQuickJSWasm,
} from "@earendil-works/pi-codemode";
import { Check, Errors } from "typebox/value";
import { stringify } from "yaml";
import { getCodemodeWorkerSpecifier, getQuickJSEncodingPath, getQuickJSWasmPath } from "../../config.ts";
import type { CompactionPreparation } from "../../core/compaction/compaction.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEventResult,
	ToolResultEventResult,
} from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { ATOMIC_CODEMODE_API, HARNESS_DEFINITION_REFERENCE } from "./api.ts";
import { bindHostContract } from "./contracts.ts";
import type { HarnessExecutor } from "./harness/bridge.ts";
import {
	compactWithHarness,
	type HarnessCompactionPlan,
	planCompaction,
	type SummaryExecutor,
	summarizeBranchWithHarness,
} from "./harness/compaction.ts";
import {
	digest,
	evaluate,
	fileText,
	type Handler,
	type HarnessSnapshot,
	type HookEvent,
	loadDefaultFiles,
	type Provenance,
	runRule,
	yamlValue,
} from "./harness/definition.ts";
import type { HarnessRequestRecord } from "./harness/inspection.ts";
import { contentSchema, renderHarnessOutput } from "./harness/output.ts";
import { HARNESS_REQUEST_ENTRY, type HarnessPreview, HarnessStore } from "./harness/store.ts";
import { parameterDescriptions } from "./input.ts";
import { integer, object, PrimitiveScope, string } from "./primitives.ts";
import type { CodemodeNestedCall } from "./tool.ts";

export interface HarnessLoopOutcome {
	status:
		| "next"
		| "finish"
		| "assistant_finish"
		| "execution_failed"
		| "missing_decision"
		| "invalid_batch"
		| "invalid_tool";
	/** Native final text, provided only for a normally completed assistant response without tools. */
	text?: string;
	toolCalls: { id: string; name: string }[];
	results: {
		toolCallId: string;
		toolName: string;
		isError: boolean;
		loopControl?: "next" | "finish";
		error?: { kind: string; name?: string; message: string; stack?: string };
		calls: CodemodeNestedCall[];
	}[];
}

export type RuntimeRecord = (name: string, args: unknown, execute: () => Promise<unknown>) => Promise<unknown>;
interface Invocation {
	ctx: ExtensionContext;
	depth: number;
	module: string;
	parentId: string;
	request: string;
	requestId?: string;
	snapshot?: HarnessSnapshot;
	record?: RuntimeRecord;
	modelGlobals: CodemodeTool[];
}
interface Rendered extends HarnessPreview {
	system: { id: string; text: string }[];
	history: AgentMessage[];
	provenance: Provenance[];
}

/** Validate relations after projection; never send a dangling or reordered tool result. */
function validateHistory(value: unknown): AgentMessage[] {
	if (!Array.isArray(value)) throw new Error("context.history must return an array of messages");
	const pending = new Set<string>();
	for (const item of value) {
		const message = object(item);
		if (!["system", "user", "assistant", "toolResult"].includes(String(message.role)))
			throw new Error(`Invalid projected role: ${message.role}`);
		if (message.toolsAdded !== undefined || message.toolsRemoved !== undefined || message.sections !== undefined)
			throw new Error("History rules cannot declare provider tools or system sections");
		if (typeof message.content !== "string" && !Array.isArray(message.content))
			throw new Error("Projected message needs content");
		if (message.role === "toolResult") {
			const id = string(message.toolCallId, "toolCallId");
			if (!pending.delete(id)) throw new Error(`Orphan projected tool result ${id}`);
		} else if (message.role !== "system") {
			if (pending.size) throw new Error("History projection separated a tool call from its results");
			if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const part of message.content)
					if (part.type === "toolCall") pending.add(string(part.id, "tool call id"));
			}
		}
	}
	if (pending.size) throw new Error("History projection omitted tool results");
	return value as AgentMessage[];
}

export class CodemodeRuntime {
	readonly harness: HarnessStore;
	private readonly pi: ExtensionAPI;
	private readonly invocation = new AsyncLocalStorage<Invocation>();
	private readonly active = new Map<string, { controller: AbortController; handler: Handler; revision: string }>();
	private readonly subscriptions: (() => void)[] = [];
	private readonly toolCache = new Map<string, AgentTool[]>();
	private sources: Record<string, unknown> = {};
	private readonly modelAPI: string;
	private executor?: HarnessExecutor;
	private nextHookCall = 0;
	private currentCtx?: ExtensionContext;
	private closed = false;

	constructor(pi: ExtensionAPI, models = true) {
		this.pi = pi;
		this.modelAPI = models
			? "\nModel primitives: models.getAvailableOfType(type,provider?), models.getModelsOfType(type,provider?), models.getModelOfType(type,provider,id), models.classify(model,context), models.generateImages(model,context). Types: chat, classifier, image. Model credentials stay on the host. These globals also work in tool handlers. See docs/codemode.md for context schemas."
			: "";
		this.harness = new HarnessStore(
			(type, data) => pi.appendEntry(type, data),
			() => {
				const files = loadDefaultFiles();
				const manager = SettingsManager.inMemory(pi.getSettings());
				const settings = manager.getCompactionSettings(this.currentCtx?.model);
				files["policies/compaction.yaml"] = stringify({
					...object(yamlValue(files["policies/compaction.yaml"], "policies/compaction.yaml")),
					...settings,
					branchReserveTokens: manager.getBranchSummarySettings().reserveTokens,
				});
				return files;
			},
			async (snapshot, signal) => {
				const { history: _history, ...preview } = await this.render(snapshot, signal);
				return preview;
			},
		);
		this.subscriptions.push(
			pi.on(
				"tool_call",
				async (event, ctx) => this.hooks("tool_call", event, ctx) as Promise<ToolCallEventResult | undefined>,
			),
		);
		this.subscriptions.push(
			pi.on(
				"tool_result",
				async (event, ctx) => this.hooks("tool_result", event, ctx) as Promise<ToolResultEventResult | undefined>,
			),
		);
		this.subscriptions.push(
			pi.on("agent_start", async (event, ctx) => {
				await this.hooks("agent_start", event, ctx);
			}),
		);
		this.subscriptions.push(
			pi.on("agent_end", async (event, ctx) => {
				await this.hooks("agent_end", event, ctx);
			}),
		);
	}

	async sync(ctx: ExtensionContext): Promise<void> {
		if (this.closed) throw new Error("Harness runtime is closed");
		this.currentCtx = ctx;
		await this.harness.sync(ctx);
	}

	bindExecutor(executor: HarnessExecutor): void {
		this.executor = executor;
	}

	setSources(sources: Record<string, unknown>): void {
		this.sources = structuredClone(sources);
	}

	async compactionPolicy(
		entries: SessionEntry[],
		contextTokens: number,
		contextWindow: number,
		candidate = false,
		signal?: AbortSignal,
		purpose = "compaction",
	): Promise<{ snapshot: HarnessSnapshot; plan: HarnessCompactionPlan }> {
		const snapshot = await this.harness.snapshot(
			candidate ? (this.harness.pending?.revision ?? this.harness.activeRevision) : this.harness.activeRevision,
		);
		return { snapshot, plan: await planCompaction(snapshot, entries, contextTokens, contextWindow, signal, purpose) };
	}

	compact(
		policy: { snapshot: HarnessSnapshot; plan: HarnessCompactionPlan },
		preparation: CompactionPreparation,
		execute: SummaryExecutor,
		customInstructions?: string,
		signal?: AbortSignal,
	) {
		return compactWithHarness(
			policy.snapshot,
			policy.plan,
			preparation,
			execute,
			this.ruleSources(policy.snapshot),
			customInstructions,
			signal,
		);
	}

	summarizeBranch(
		policy: { snapshot: HarnessSnapshot; plan: HarnessCompactionPlan },
		entries: SessionEntry[],
		execute: SummaryExecutor,
		customInstructions?: string,
		replaceInstructions?: boolean,
		signal?: AbortSignal,
	) {
		return summarizeBranchWithHarness(
			policy.snapshot,
			policy.plan,
			entries,
			execute,
			this.ruleSources(policy.snapshot),
			customInstructions,
			replaceInstructions,
			signal,
		);
	}

	async previewRequest(signal?: AbortSignal): Promise<HarnessPreview> {
		return this.render(
			await this.harness.snapshot(this.harness.pending?.revision ?? this.harness.activeRevision),
			signal,
		);
	}

	private ruleSources(snapshot: HarnessSnapshot): Record<string, unknown> {
		return {
			...this.sources,
			"codemode.tools": snapshot.tools.map((tool) => ({ ...tool, revision: snapshot.revision })),
			"codemode.views": { definitions: snapshot.definition.codemode.output.views.file, handlers: snapshot.views },
			"host.api-reference": ATOMIC_CODEMODE_API + this.modelAPI,
			"host.definition-reference": HARNESS_DEFINITION_REFERENCE,
		};
	}

	private async render(snapshot: HarnessSnapshot, signal?: AbortSignal): Promise<Rendered> {
		const sources = this.ruleSources(snapshot);
		const provenance: Provenance[] = [];
		const system = await evaluate(
			snapshot,
			snapshot.definition.context.system,
			sources,
			"system",
			provenance,
			signal,
		);
		if (
			!Array.isArray(system) ||
			!system.every((block) => block && typeof block.id === "string" && typeof block.text === "string")
		)
			throw new Error("context.system must return [{id,text}]");
		if (new Set(system.map((b) => b.id)).size !== system.length) throw new Error("Duplicate system block id");
		const rawDescription = await evaluate(
			snapshot,
			snapshot.definition.codemode.description,
			sources,
			"codemode.description",
			provenance,
			signal,
		);
		const description =
			typeof rawDescription === "string" ? rawDescription : string(object(rawDescription).text, "description.text");
		if (!description.trim()) throw new Error("codemode description must not be empty");
		const descriptions = parameterDescriptions(
			typeof rawDescription === "string" ? undefined : object(rawDescription).parameterDescriptions,
		);
		const history = validateHistory(
			await evaluate(snapshot, snapshot.definition.context.history, sources, "history", provenance, signal),
		);
		const estimatedTokens = Math.ceil(
			(JSON.stringify(system).length +
				description.length +
				JSON.stringify(descriptions ?? {}).length +
				JSON.stringify(history).length) /
				4,
		);
		return {
			system,
			history,
			description,
			parameterDescriptions: descriptions,
			catalog: typeof rawDescription === "string" ? undefined : object(rawDescription).catalog,
			provenance,
			inputSnapshot: `i-${digest(sources)}`,
			estimatedTokens,
		};
	}

	async project(
		ctx: ExtensionContext,
		codemode: AgentTool,
		signal?: AbortSignal,
		commitCheckpoint?: () => void,
	): Promise<AgentMessage[]> {
		return this.harness.serialized(async () => {
			const pending = this.harness.pending;
			if (pending && pending.expectedActiveRevision !== this.harness.activeRevision)
				throw new Error("Scheduled Harness activation base changed");
			const snapshot = await this.harness.snapshot(pending?.revision ?? this.harness.activeRevision);
			const rendered = await this.render(snapshot, signal);
			signal?.throwIfAborted();
			const requestId = `q-${randomUUID()}`;
			const bootstrap = `Harness request revision: ${snapshot.revision}. Root: agent.yaml. Read its definition inside codemode: observe((await host.harness.read({path:"agent.yaml"})).text). Definitions and state survive history compaction.`;
			if (rendered.system.some((block) => block.id === "host.bootstrap"))
				throw new Error("System block ID host.bootstrap is reserved for the request pointer");
			const content = [...rendered.system.map((block) => block.text), bootstrap].join("\n\n");
			const parameters = structuredClone(codemode.parameters);
			for (const name of ["code", "data", "finish"] as const) {
				const schema = object(object(object(parameters).properties)[name]);
				delete schema.description;
				const description = rendered.parameterDescriptions?.[name];
				if (description !== undefined) schema.description = description;
			}
			const messages: AgentMessage[] = [
				{
					role: "system",
					content,
					toolsAdded: [toToolDeclaration({ ...codemode, description: rendered.description, parameters })],
					timestamp: 0,
				},
				...rendered.history,
			];
			commitCheckpoint?.();
			if (pending) this.harness.publishPending(snapshot.revision, ctx);
			const external = object(this.sources["external.contributions"] ?? {});
			const trace: HarnessRequestRecord = {
				requestId,
				revision: snapshot.revision,
				inputSnapshot: rendered.inputSnapshot,
				system: [...rendered.system, { id: "host.bootstrap", text: bootstrap }],
				description: rendered.description,
				catalog: rendered.catalog,
				provenance: [
					...rendered.provenance,
					{ output: "system/host.bootstrap", dependencies: ["host:request-pointer"] },
				],
				estimatedTokens: rendered.estimatedTokens,
				tokenEstimate: "characters/4",
				history: rendered.history.map((m) => ({ role: m.role, hash: digest(m) })),
				historyChars: JSON.stringify(rendered.history).length,
				externalContributions: { extensions: external.extensions, ownership: external.ownership },
				hostOwned: [
					"provider transport, credentials, routing, retries",
					"VM resource limits and cancellation",
					"bootstrap revision pointer and top-level codemode schema",
					"output truncation/spill, image normalization, execution error diagnostics",
					"native extension code and resource discovery",
				],
			};
			this.pi.appendEntry(HARNESS_REQUEST_ENTRY, { ...trace, sources: this.sources, messages });
			this.harness.recordRequest(trace);
			return messages;
		});
	}

	async decideLoop(
		outcome: HarnessLoopOutcome,
		state: Record<string, unknown>,
		ctx: ExtensionContext,
	): Promise<{
		action: "accept" | "continue" | "stop";
		state: Record<string, unknown>;
		text?: string;
		revision: string;
		reminder?: string;
	}> {
		const snapshot = await this.harness.snapshot(this.harness.requestRevision);
		const rule = snapshot.definition.loop;
		const reminders = Object.fromEntries(
			Object.entries(rule.reminders).map(([name, ref]) => [name, fileText(snapshot.files, ref.file)]),
		);
		const value = object(
			await runRule(
				snapshot.files,
				rule.decide,
				{ outcome, state, reminders },
				yamlValue(fileText(snapshot.files, rule.options.file), rule.options.file),
				ctx.signal,
			),
		);
		if (!["accept", "continue", "stop"].includes(String(value.action))) throw new Error("Invalid loop decision");
		const nextState = object(value.state);
		if (
			value.reminder !== undefined &&
			(typeof value.reminder !== "string" || !Object.hasOwn(reminders, value.reminder))
		)
			throw new Error("Unknown loop reminder");
		if (value.text !== undefined && typeof value.text !== "string") throw new Error("Invalid loop reminder text");
		return {
			action: value.action as "accept" | "continue" | "stop",
			state: nextState,
			revision: snapshot.revision,
			reminder: value.reminder as string | undefined,
			text: (value.text as string | undefined) ?? (value.reminder ? reminders[String(value.reminder)] : undefined),
		};
	}

	async renderOutput(
		output: CodemodeOutputItem[],
		revision: string,
		signal?: AbortSignal,
	): ReturnType<typeof renderHarnessOutput> {
		const snapshot = await this.harness.snapshot(revision);
		return renderHarnessOutput(snapshot, output, signal);
	}

	private tools(snapshot: HarnessSnapshot, ctx: ExtensionContext): AgentTool[] {
		const cached = this.toolCache.get(snapshot.revision);
		if (cached) return cached;
		const tools: AgentTool[] = snapshot.tools.map((tool) => ({
			name: tool.name,
			label: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			execute: async (id, args, signal) => {
				const value = await this.run(
					snapshot,
					tool.handler,
					[args],
					this.invocation.getStore()?.ctx ?? ctx,
					signal,
					id,
				);
				if (tool.outputSchema && !Check(tool.outputSchema, value))
					throw new Error(
						`${tool.name}: return value does not match outputSchema:\n${Errors(tool.outputSchema, value)
							.map((error) => `${error.instancePath || "/"}: ${error.message}`)
							.join("\n")}`,
					);
				// Only the native runner/UI needs an envelope. Internal callers receive the value
				// unchanged, whether or not the definition declares an output schema.
				return {
					content: [
						{ type: "text", text: typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined") },
					],
					details: {},
					structuredContent: value as AgentToolResult<unknown>["structuredContent"],
				};
			},
		}));
		this.toolCache.set(snapshot.revision, tools);
		return tools;
	}

	private async hooks(
		event: HookEvent,
		input: unknown,
		ctx: ExtensionContext,
	): Promise<Record<string, unknown> | undefined> {
		if (!this.harness.activeRevision || this.closed) return;
		const current = this.invocation.getStore();
		const snapshot =
			current?.snapshot ??
			(await this.harness.snapshot(
				event.startsWith("tool_") ? this.harness.requestRevision : this.harness.activeRevision,
			));
		let combined: Record<string, unknown> | undefined;
		for (const hook of snapshot.hooks.filter((h) => h.event === event)) {
			const hookInput = { ...object(input), ...combined };
			const value = await this.run(
				snapshot,
				hook.handler,
				[hookInput],
				ctx,
				ctx.signal,
				`hook:${hook.id}:${++this.nextHookCall}`,
			);
			if (value === null || value === undefined) continue;
			const result = object(value);
			if (event === "tool_call") {
				if (result.block !== undefined && typeof result.block !== "boolean")
					throw new Error("hook.block must be boolean");
				if (result.reason !== undefined && typeof result.reason !== "string")
					throw new Error("hook.reason must be string");
				if (result.block) return { block: true, reason: result.reason };
			} else if (event === "tool_result") {
				if (result.content !== undefined && !Check(contentSchema, result.content))
					throw new Error("Invalid hook content");
				if (result.isError !== undefined && typeof result.isError !== "boolean")
					throw new Error("Invalid hook isError");
				// A presentation-only hook must not erase an internal tool's return value.
				if (current?.snapshot && result.content !== undefined && result.structuredContent === undefined)
					result.structuredContent = hookInput.structuredContent;
				combined = { ...combined, ...result };
			}
		}
		return combined;
	}

	createScope(
		ctx: ExtensionContext,
		record?: RuntimeRecord,
		module = "codemode",
		modelGlobals?: CodemodeTool[],
		parentId = "codemode",
		pinned?: HarnessSnapshot,
	): { globals: CodemodeTool[]; close: () => void } {
		const resources = new PrimitiveScope(ctx.cwd);
		const primitives = resources.globals();
		const inherited = this.invocation.getStore();
		const invocation: Invocation = {
			ctx,
			depth: (inherited?.depth ?? 0) + 1,
			module,
			parentId,
			request: inherited?.request ?? this.harness.requestRevision,
			requestId: inherited?.requestId ?? this.harness.requestId,
			snapshot: pinned,
			record: record ?? inherited?.record,
			modelGlobals: modelGlobals ?? inherited?.modelGlobals ?? [],
		};
		if (invocation.depth > 32) throw new Error("Generated program call depth exceeds 32");
		const current = () => (pinned ? Promise.resolve(pinned) : this.harness.snapshot());
		const methods: Record<string, CodemodeTool["execute"]> = {
			"host.tools.list": async () => (await current()).tools,
			"host.tools.describe": async (input) =>
				(await current()).tools.find((t) => t.name === string(object(input).name, "name")),
			"host.tools.call": async (input, { signal }) => {
				const args = object(input);
				const name = string(args.name, "name");
				const snapshot = await current();
				const tool = snapshot.tools.find((t) => t.name === name);
				if (!tool) {
					const primitive = primitives.find((p) => p.name === (name.startsWith("host.") ? name : `host.${name}`));
					throw new Error(
						`Unknown generated tool ${name}. Available tools: ${snapshot.tools.map((t) => t.name).join(", ") || "(none)"}. ` +
							(primitive
								? `${primitive.name} is a primitive, not a defined tool. Call ${primitive.name}(args) directly inside a tool handler.`
								: "Use host.tools.list() for definitions, then host.tools.call({name,args}). Create and activate a Harness tool definition to add a tool."),
					);
				}
				if (!this.executor) throw new Error("Internal tool execution requires an active Harness request");
				const result = await this.invocation.run({ ...invocation, snapshot }, () =>
					this.executor!(invocation.parentId, name, args.args ?? {}, this.tools(snapshot, ctx), signal),
				);
				if (result.isError)
					throw new Error(
						result.result.content
							.filter((p) => p.type === "text")
							.map((p) => p.text)
							.join("\n"),
					);
				const value = result.result.structuredContent;
				if (tool.outputSchema && !Check(tool.outputSchema, value))
					throw new Error(
						`${tool.name}: return value after hooks does not match outputSchema:\n${Errors(
							tool.outputSchema,
							value,
						)
							.map((error) => `${error.instancePath || "/"}: ${error.message}`)
							.join("\n")}`,
					);
				return value;
			},
			"host.hooks.list": async () => (await current()).hooks,
			"host.state.get": (input) => this.harness.getState(module, string(object(input).key, "key")),
			"host.state.set": (input) => {
				const args = object(input);
				return this.harness.setState(module, string(args.key, "key"), args.value, ctx);
			},
			"host.state.delete": (input) =>
				this.harness.setState(module, string(object(input).key, "key"), undefined, ctx),
			"host.session.history": (input) => {
				const args = object(input ?? {});
				const offset = integer(args.offset, "offset", 0);
				return ctx.sessionManager
					.getBranch()
					.filter((e) => e.type === "message")
					.slice(offset, offset + integer(args.limit, "limit", 20, 100));
			},
			"host.calls.list": () =>
				[...this.active].map(([id, call]) => ({ id, handler: call.handler, revision: call.revision })),
			"host.calls.cancel": (input) => {
				this.active.get(string(object(input).id, "id"))?.controller.abort();
			},
		};
		const globals = [
			...primitives,
			...this.harness.globals(ctx, invocation.request, invocation.requestId),
			...Object.entries(methods).map(([name, execute]) => bindHostContract(name, execute)),
			...invocation.modelGlobals,
		].map(
			(global): CodemodeTool => ({
				...global,
				execute: (args, context) =>
					this.invocation.run(invocation, async () => {
						context.signal.throwIfAborted();
						const execute = async () => global.execute(args, context);
						return invocation.record && global.name.startsWith("host.")
							? invocation.record(global.name, args, execute)
							: execute();
					}),
			}),
		);
		return { globals, close: () => resources.close() };
	}

	private async run(
		snapshot: HarnessSnapshot,
		handler: Handler,
		args: unknown[],
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		id: string,
	): Promise<unknown> {
		const controller = new AbortController();
		const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const scope = this.createScope(ctx, undefined, handler.module, undefined, id, snapshot);
		const sandbox = new CodemodeSandbox({
			globals: scope.globals,
			timeoutMs: Infinity,
			memoryLimitBytes: 256 * 1024 * 1024,
			wasm: loadQuickJSWasm(getQuickJSWasmPath()),
			encodingWasm: loadQuickJSEncoding(getQuickJSEncodingPath()),
			workerUrl: getCodemodeWorkerSpecifier(),
		});
		this.active.set(id, { controller, handler, revision: snapshot.revision });
		try {
			const result = await sandbox.execute(fileText(snapshot.files, handler.file), {
				signal: combined,
				timeoutMs: id.startsWith("hook:") ? 30_000 : undefined,
				module: { export: handler.export, args, filename: `${handler.file}@${snapshot.revision.slice(0, 14)}` },
			});
			if (!result.ok) throw new Error(result.error.stack ?? result.error.message);
			return result.value;
		} finally {
			scope.close();
			await sandbox.close();
			this.active.delete(id);
		}
	}

	close(): void {
		this.closed = true;
		for (const call of this.active.values()) call.controller.abort();
		for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
	}
}
