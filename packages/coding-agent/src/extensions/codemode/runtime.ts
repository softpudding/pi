/** Branch-persistent model programs and their tool/event bindings. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { CodemodeSandbox, type CodemodeTool, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { type TSchema, Type } from "typebox";
import { Check } from "typebox/value";
import { getCodemodeWorkerSpecifier, getQuickJSWasmPath } from "../../config.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ToolCallEventResult,
	ToolResultEventResult,
} from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { integer, object, PrimitiveScope, string } from "./primitives.ts";

export const CODEMODE_RUNTIME_ENTRY = "codemode-runtime";
const MAX_SOURCE_CHARS = 256 * 1024;
const MAX_RUNTIME_CHARS = 4 * 1024 * 1024;

interface ModuleRef {
	module: string;
	revision: string;
	export: string;
}
interface ModuleDefinition {
	id: string;
	revision: string;
	source: string;
	exports: string[];
}
interface RuntimeTool {
	name: string;
	description: string;
	parameters: TSchema;
	outputSchema?: TSchema;
	handler: ModuleRef;
}
type HookEvent = "tool_call" | "tool_result" | "agent_start" | "agent_end";
interface RuntimeHook {
	id: string;
	event: HookEvent;
	handler: ModuleRef;
}
interface RegistryChanges {
	tools: RuntimeTool[];
	removeTools: string[];
	hooks: RuntimeHook[];
	removeHooks: string[];
}
type RuntimeChange =
	| { type: "module"; value: ModuleDefinition }
	| { type: "registry"; value: RegistryChanges }
	| { type: "remove-module"; id: string }
	| { type: "state"; scope: string; key: string; value?: unknown };

interface RuntimeState {
	modules: Map<string, ModuleDefinition>;
	tools: Map<string, RuntimeTool>;
	hooks: Map<string, RuntimeHook>;
	values: Map<string, unknown>;
}

function emptyState(): RuntimeState {
	return { modules: new Map(), tools: new Map(), hooks: new Map(), values: new Map() };
}

function apply(state: RuntimeState, change: RuntimeChange): void {
	switch (change.type) {
		case "module":
			state.modules.set(`${change.value.id}@${change.value.revision}`, change.value);
			break;
		case "registry":
			for (const name of change.value.removeTools) state.tools.delete(name);
			for (const id of change.value.removeHooks) state.hooks.delete(id);
			for (const tool of change.value.tools) state.tools.set(tool.name, tool);
			for (const hook of change.value.hooks) state.hooks.set(hook.id, hook);
			break;
		case "remove-module":
			for (const [key, module] of state.modules) if (module.id === change.id) state.modules.delete(key);
			for (const [key, tool] of state.tools) if (tool.handler.module === change.id) state.tools.delete(key);
			for (const [key, hook] of state.hooks) if (hook.handler.module === change.id) state.hooks.delete(key);
			for (const key of state.values.keys()) if (key.startsWith(`${change.id}\0`)) state.values.delete(key);
			break;
		case "state":
			if (change.value === undefined) state.values.delete(`${change.scope}\0${change.key}`);
			else state.values.set(`${change.scope}\0${change.key}`, change.value);
			break;
	}
}

function identifier(value: unknown, field: string): string {
	const name = string(value, field);
	if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(name)) throw new Error(`${field} must be a short identifier`);
	return name;
}

const contentSchema = Type.Array(
	Type.Union([
		Type.Object({ type: Type.Literal("text"), text: Type.String() }),
		Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
	]),
);

function toolResult(value: unknown): AgentToolResult<unknown> {
	const result = object(value);
	if (!Check(contentSchema, result.content))
		throw new Error('Tool must return { content: [{ type: "text", text: "..." }], details, structuredContent? }');
	if (result.isError !== undefined && typeof result.isError !== "boolean") throw new Error("isError must be boolean");
	return {
		content: result.content,
		details: result.details,
		...(result.structuredContent !== undefined
			? { structuredContent: result.structuredContent as AgentToolResult<unknown>["structuredContent"] }
			: {}),
		...(result.isError === true ? { isError: true } : {}),
	};
}

export type RuntimeRecord = (name: string, args: unknown, execute: () => Promise<unknown>) => Promise<unknown>;
interface Invocation {
	ctx: ExtensionContext;
	depth: number;
	module: string;
	record?: RuntimeRecord;
	modelGlobals: CodemodeTool[];
}

export class CodemodeRuntime {
	private readonly pi: ExtensionAPI;
	private state = emptyState();
	private lastEntry: string | undefined;
	private readonly ownedTools = new Map<string, RuntimeTool>();
	private readonly subscriptions = new Map<string, () => void>();
	private readonly active = new Map<string, { controller: AbortController; handler: ModuleRef }>();
	private readonly invocation = new AsyncLocalStorage<Invocation>();
	private nextHookCall = 0;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	/** Rebuild definitions only; replay never invokes a module or repeats external effects. */
	sync(ctx: ExtensionContext): void {
		const entries = ctx.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === CODEMODE_RUNTIME_ENTRY);
		const last = entries.at(-1)?.id;
		if (last === this.lastEntry) return;
		const state = emptyState();
		for (const entry of entries) if (entry.type === "custom") apply(state, entry.data as RuntimeChange);
		this.state = state;
		this.lastEntry = last;
		this.refresh();
	}

	private commit(change: RuntimeChange, ctx: ExtensionContext): void {
		this.sync(ctx);
		const next: RuntimeState = {
			modules: new Map(this.state.modules),
			tools: new Map(this.state.tools),
			hooks: new Map(this.state.hooks),
			values: new Map(this.state.values),
		};
		apply(next, change);
		if (JSON.stringify([...next.modules, ...next.tools, ...next.hooks, ...next.values]).length > MAX_RUNTIME_CHARS)
			throw new Error("Codemode runtime exceeds 4 MiB; remove unused modules or state");
		this.pi.appendEntry(CODEMODE_RUNTIME_ENTRY, change);
		this.state = next;
		this.lastEntry = ctx.sessionManager.getBranch().at(-1)?.id;
		if (change.type === "registry" || change.type === "remove-module") this.refresh();
	}

	private reference(value: unknown): ModuleRef {
		const ref = object(value);
		const handler = {
			module: identifier(ref.module, "handler.module"),
			revision: string(ref.revision, "handler.revision"),
			export: string(ref.export, "handler.export"),
		};
		const module = this.state.modules.get(`${handler.module}@${handler.revision}`);
		if (!module || !module.exports.includes(handler.export))
			throw new Error("Handler must reference a saved module revision and a callable export");
		return handler;
	}

	private parseTool(input: unknown): RuntimeTool {
		const args = object(input);
		const handler = this.reference(args.handler);
		const name = identifier(args.name, "name");
		if (!name.startsWith(`${handler.module}.`)) throw new Error(`Tool name must start with ${handler.module}.`);
		if (!this.ownedTools.has(name) && this.pi.getAllTools().some((tool) => tool.name === name))
			throw new Error(`Tool ${name} is owned by another extension`);
		const parameters = object(args.parameters);
		if (parameters.type !== "object") throw new Error("parameters must be an object JSON Schema");
		return {
			name,
			description: string(args.description, "description"),
			parameters: parameters as TSchema,
			...(args.outputSchema === undefined ? {} : { outputSchema: object(args.outputSchema) as TSchema }),
			handler,
		};
	}

	private parseHook(input: unknown): RuntimeHook {
		const args = object(input);
		const handler = this.reference(args.handler);
		const id = identifier(args.id, "id");
		if (!id.startsWith(`${handler.module}.`)) throw new Error(`Hook id must start with ${handler.module}.`);
		if (
			args.event !== "tool_call" &&
			args.event !== "tool_result" &&
			args.event !== "agent_start" &&
			args.event !== "agent_end"
		)
			throw new Error("Supported events: tool_call, tool_result, agent_start, agent_end");
		return { id, event: args.event, handler };
	}

	private refresh(): void {
		for (const [name, tool] of this.ownedTools) {
			if (!this.state.tools.has(name))
				this.pi.registerTool({
					name,
					label: name,
					description: tool.description,
					parameters: tool.parameters,
					exposure: "hidden",
					execute: async () => {
						throw new Error(`Tool ${name} was unregistered`);
					},
				});
		}
		for (const tool of this.state.tools.values()) {
			this.ownedTools.set(tool.name, tool);
			this.pi.registerTool({
				name: tool.name,
				label: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				outputSchema: tool.outputSchema,
				exposure: "deferred",
				defaultActive: false,
				execute: async (id, args, signal, _onUpdate, ctx) => {
					if (!ctx) throw new Error("Generated tools need a session");
					const value = toolResult(await this.run(tool.handler, [args], ctx, signal, id));
					if (tool.outputSchema && !value.isError && !Check(tool.outputSchema, value.structuredContent))
						throw new Error("structuredContent does not match outputSchema");
					return value;
				},
			});
		}
		for (const unsubscribe of this.subscriptions.values()) unsubscribe();
		this.subscriptions.clear();
		for (const hook of this.state.hooks.values()) {
			const run = (event: unknown, ctx: ExtensionContext) =>
				this.run(hook.handler, [event], ctx, ctx.signal, `hook:${hook.id}:${++this.nextHookCall}`);
			let unsubscribe: () => void;
			switch (hook.event) {
				case "tool_call":
					unsubscribe = this.pi.on("tool_call", async (event, ctx) => {
						const value = await run(event, ctx);
						if (value === undefined || value === null) return;
						const result = object(value);
						if (result.block !== undefined && typeof result.block !== "boolean")
							throw new Error("tool_call hook block must be boolean");
						if (result.reason !== undefined && typeof result.reason !== "string")
							throw new Error("tool_call hook reason must be string");
						return { block: result.block, reason: result.reason } as ToolCallEventResult;
					});
					break;
				case "tool_result":
					unsubscribe = this.pi.on("tool_result", async (event, ctx) => {
						const value = await run(event, ctx);
						if (value === undefined || value === null) return;
						const result = object(value);
						if (result.content !== undefined && !Check(contentSchema, result.content))
							throw new Error("Invalid tool_result hook content");
						if (result.isError !== undefined && typeof result.isError !== "boolean")
							throw new Error("Invalid tool_result isError");
						return {
							content: result.content,
							details: result.details,
							structuredContent: result.structuredContent,
							isError: result.isError,
						} as ToolResultEventResult;
					});
					break;
				case "agent_start":
					unsubscribe = this.pi.on("agent_start", async (event, ctx) => {
						await run(event, ctx);
					});
					break;
				case "agent_end":
					unsubscribe = this.pi.on("agent_end", async (event, ctx) => {
						await run(event, ctx);
					});
					break;
			}
			this.subscriptions.set(hook.id, unsubscribe);
		}
	}

	createScope(
		ctx: ExtensionContext,
		record?: RuntimeRecord,
		module = "codemode",
		modelGlobals?: CodemodeTool[],
	): { globals: CodemodeTool[]; close: () => void } {
		this.sync(ctx);
		const resources = new PrimitiveScope(ctx.cwd);
		const inherited = this.invocation.getStore();
		const invocation: Invocation = {
			ctx: "executeTool" in ctx ? ctx : (inherited?.ctx ?? ctx),
			depth: (inherited?.depth ?? 0) + 1,
			module,
			record: record ?? inherited?.record,
			modelGlobals: modelGlobals ?? inherited?.modelGlobals ?? [],
		};
		if (invocation.depth > 32) throw new Error("Generated program call depth exceeds 32");
		const emptyChanges = (): RegistryChanges => ({ tools: [], removeTools: [], hooks: [], removeHooks: [] });
		const methods: Record<string, CodemodeTool["execute"]> = {
			"host.modules.put": async (input, { signal }) => {
				const args = object(input);
				const id = identifier(args.id, "id");
				const source = string(args.source, "source");
				if (source.length > MAX_SOURCE_CHARS) throw new Error("Module source exceeds 256 KiB");
				const revision = createHash("sha256").update(source).digest("hex");
				const sandbox = this.sandbox([]);
				try {
					const result = await sandbox.execute(source, {
						signal,
						timeoutMs: 5000,
						module: { filename: `${id}.mjs` },
					});
					if (!result.ok) throw new Error(result.error.stack ?? result.error.message);
					if (!Array.isArray(result.value) || !result.value.every((name) => typeof name === "string"))
						throw new Error("Invalid module exports");
					signal.throwIfAborted();
					const value: ModuleDefinition = { id, revision, source, exports: result.value };
					this.commit({ type: "module", value }, ctx);
					return { id, revision, exports: value.exports };
				} finally {
					await sandbox.close();
				}
			},
			"host.modules.list": () =>
				[...this.state.modules.values()].map(({ source: _source, ...metadata }) => metadata),
			"host.modules.get": (input) => {
				const args = object(input);
				const id = string(args.id, "id");
				return [...this.state.modules.values()].findLast(
					(module) => module.id === id && (args.revision === undefined || module.revision === args.revision),
				);
			},
			"host.modules.remove": (input) => {
				this.commit({ type: "remove-module", id: string(object(input).id, "id") }, ctx);
			},
			"host.tools.register": (input) => {
				const tool = this.parseTool(input);
				this.commit({ type: "registry", value: { ...emptyChanges(), tools: [tool] } }, ctx);
				return tool;
			},
			"host.tools.unregister": (input) => {
				const name = string(object(input).name, "name");
				this.commit({ type: "registry", value: { ...emptyChanges(), removeTools: [name] } }, ctx);
			},
			"host.tools.list": () => [...this.state.tools.values()],
			"host.tools.describe": (input) => this.state.tools.get(string(object(input).name, "name")),
			"host.tools.call": async (input, { signal }) => {
				const args = object(input);
				const name = string(args.name, "name");
				const tool = this.state.tools.get(name);
				if (!tool)
					throw new Error(
						`Unknown generated tool ${name}. Define a module and register its tool first. Built-in and MCP tools are not exposed.`,
					);
				const caller = invocation.ctx;
				if (!("executeTool" in caller))
					throw new Error("Tool calls require an active codemode or generated tool invocation");
				const result = await (caller as ExtensionToolContext).executeTool(name, args.args ?? {}, { signal });
				if (result.isError)
					throw new Error(
						result.result.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n"),
					);
				return tool.outputSchema && result.result.structuredContent !== undefined
					? result.result.structuredContent
					: result.result.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n");
			},
			"host.hooks.register": (input) => {
				const hook = this.parseHook(input);
				this.commit({ type: "registry", value: { ...emptyChanges(), hooks: [hook] } }, ctx);
				return hook;
			},
			"host.hooks.unregister": (input) => {
				this.commit(
					{ type: "registry", value: { ...emptyChanges(), removeHooks: [string(object(input).id, "id")] } },
					ctx,
				);
			},
			"host.hooks.list": () => [...this.state.hooks.values()],
			"host.registry.apply": (input) => {
				const args = object(input);
				const list = (value: unknown): unknown[] => {
					if (value === undefined) return [];
					if (!Array.isArray(value)) throw new Error("Registry changes must be arrays");
					return value;
				};
				const changes: RegistryChanges = {
					tools: list(args.tools).map((tool) => this.parseTool(tool)),
					hooks: list(args.hooks).map((hook) => this.parseHook(hook)),
					removeTools: list(args.removeTools).map((name) => string(name, "name")),
					removeHooks: list(args.removeHooks).map((id) => string(id, "id")),
				};
				this.commit({ type: "registry", value: changes }, ctx);
			},
			"host.state.get": (input) => this.state.values.get(`${module}\0${string(object(input).key, "key")}`),
			"host.state.set": (input) => {
				const args = object(input);
				this.commit({ type: "state", scope: module, key: string(args.key, "key"), value: args.value }, ctx);
			},
			"host.state.delete": (input) => {
				this.commit({ type: "state", scope: module, key: string(object(input).key, "key") }, ctx);
			},
			"host.session.history": (input) => {
				const args = object(input ?? {});
				return ctx.sessionManager
					.getBranch()
					.filter((entry: SessionEntry) => entry.type === "message")
					.slice(
						integer(args.offset, "offset", 0),
						integer(args.offset, "offset", 0) + integer(args.limit, "limit", 20, 100),
					);
			},
			"host.calls.list": () => [...this.active].map(([id, call]) => ({ id, handler: call.handler })),
			"host.calls.cancel": (input) => {
				this.active.get(string(object(input).id, "id"))?.controller.abort();
			},
		};
		const globals = [
			...resources.globals(),
			...Object.entries(methods).map(([name, execute]) => ({ name, execute })),
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

	private sandbox(globals: CodemodeTool[]): CodemodeSandbox {
		return new CodemodeSandbox({
			globals,
			timeoutMs: Number.POSITIVE_INFINITY,
			memoryLimitBytes: 256 * 1024 * 1024,
			wasm: loadQuickJSWasm(getQuickJSWasmPath()),
			workerUrl: getCodemodeWorkerSpecifier(),
		});
	}

	private async run(
		handler: ModuleRef,
		args: unknown[],
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		id: string,
	): Promise<unknown> {
		const module = this.state.modules.get(`${handler.module}@${handler.revision}`);
		if (!module) throw new Error("Module revision is unavailable");
		const controller = new AbortController();
		const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const scope = this.createScope(ctx, undefined, module.id);
		const sandbox = this.sandbox(scope.globals);
		this.active.set(id, { controller, handler });
		try {
			const result = await sandbox.execute(module.source, {
				signal: combined,
				timeoutMs: id.startsWith("hook:") ? 30_000 : undefined,
				module: { export: handler.export, args, filename: `${module.id}@${module.revision.slice(0, 12)}.mjs` },
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
		for (const call of this.active.values()) call.controller.abort();
		for (const unsubscribe of this.subscriptions.values()) unsubscribe();
		this.subscriptions.clear();
	}
}
