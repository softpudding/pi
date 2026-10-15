/** The executable, versioned definition language. No Pi objects enter rule VMs. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CodemodeSandbox, loadQuickJSEncoding, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { minimatch } from "minimatch";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { parseDocument } from "yaml";
import {
	getCodemodeWorkerSpecifier,
	getHarnessDefaultsDir,
	getQuickJSEncodingPath,
	getQuickJSWasmPath,
} from "../../../config.ts";
import { object, string } from "../primitives.ts";

export type DefinitionFiles = Readonly<Record<string, string>>;
export interface Handler {
	module: string;
	file: string;
	export: string;
}
export interface HarnessTool {
	name: string;
	description: string;
	parameters: TSchema;
	outputSchema?: TSchema;
	handler: Handler;
}
export type HookEvent = "tool_call" | "tool_result" | "agent_start" | "agent_end";
export interface HarnessHook {
	id: string;
	event: HookEvent;
	handler: Handler;
}
export type Expression =
	| { file: string }
	| { source: string }
	| { render: string; inputs?: Record<string, Expression>; options?: { file: string } };
export interface HarnessDefinition {
	format: "pi-harness/v1";
	context: { system: Expression; history: Expression };
	codemode: {
		description: Expression;
		tools: { definitions: string[] };
		hooks: { definitions: string[] };
		output: { render: string; options: { file: string }; views: { file: string } };
	};
	loop: { decide: string; options: { file: string }; reminders: Record<string, { file: string }> };
	compaction: {
		plan: string;
		serialize: string;
		merge: string;
		options: { file: string };
		prompts: Record<"system" | "initial" | "update" | "turn" | "branch", { file: string }>;
	};
}
export interface HarnessSnapshot {
	revision: string;
	files: DefinitionFiles;
	definition: HarnessDefinition;
	tools: HarnessTool[];
	hooks: HarnessHook[];
	views: Readonly<Record<string, string>>;
}
export interface Provenance {
	output: string;
	dependencies: string[];
}

export const SOURCE_NAMES = [
	"host.input-contract",
	"codemode.views",
	"project.instructions",
	"project.skills",
	"environment",
	"user.prompt-config",
	"session.history",
	"codemode.tools",
	"host.api-reference",
	"host.definition-reference",
	"external.contributions",
] as const;

export function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Logical paths only: no expansion, OS lookup, links, or working-directory fallback. */
export function logicalPath(value: unknown): string {
	const path = string(value, "path");
	if (
		!path ||
		path.length > 240 ||
		/[\\\x00-\x1f:*?[\]{}~@]/.test(path) ||
		path.split("/").some((p) => !p || p === "." || p === "..")
	) {
		throw new Error(`Invalid Harness logical path: ${path}`);
	}
	return path;
}

export function fileText(files: DefinitionFiles, path: string): string {
	const content = files[logicalPath(path)];
	if (typeof content !== "string") throw new Error(`Harness file not found: ${path}`);
	return content;
}

export function yamlValue(text: string, path: string): unknown {
	const document = parseDocument(text, { uniqueKeys: true });
	if (document.errors.length || document.warnings.length)
		throw new Error(`${path}: ${[...document.errors, ...document.warnings].map((e) => e.message).join("; ")}`);
	const value: unknown = document.toJS({ maxAliasCount: 0 });
	return value;
}

function fields(value: unknown, allowed: string[], location: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		const received = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
		throw new Error(`${location}: expected an object with fields ${allowed.join(", ")}; received ${received}`);
	}
	const record = object(value);
	for (const key of Object.keys(record))
		if (!allowed.includes(key)) throw new Error(`${location}: unknown field ${key}`);
	return record;
}

function identifier(value: unknown, field: string): string {
	const name = string(value, field);
	if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(name)) throw new Error(`${field}: invalid identifier`);
	return name;
}

export function ruleReference(value: string): { file: string; export: string } {
	const [file, name, extra] = value.split("#");
	if (!name || extra !== undefined || !/^[a-zA-Z_$][\w$]*$/.test(name))
		throw new Error(`Expected file.mjs#export: ${value}`);
	return { file: logicalPath(file), export: name };
}

export function createRuleSandbox(): CodemodeSandbox {
	return new CodemodeSandbox({
		globals: [],
		timeoutMs: 5000,
		memoryLimitBytes: 64 * 1024 * 1024,
		wasm: loadQuickJSWasm(getQuickJSWasmPath()),
		encodingWasm: loadQuickJSEncoding(getQuickJSEncodingPath()),
		workerUrl: getCodemodeWorkerSpecifier(),
	});
}

export async function runRule(
	files: DefinitionFiles,
	reference: string,
	input: unknown,
	options?: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	const ref = ruleReference(reference);
	const sandbox = createRuleSandbox();
	try {
		const result = await sandbox.execute(fileText(files, ref.file), {
			signal,
			module: { filename: ref.file, export: ref.export, args: [input, options] },
		});
		if (!result.ok) throw new Error(`${reference}: ${result.error.stack ?? result.error.message}`);
		return result.value;
	} finally {
		await sandbox.close();
	}
}

export function loadDefaultFiles(): Record<string, string> {
	const files: Record<string, string> = {};
	const root = getHarnessDefaultsDir();
	const visit = (path: string) => {
		for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
			const name = path ? `${path}/${entry.name}` : entry.name;
			if (entry.isDirectory()) visit(name);
			else if (entry.isFile()) files[name] = readFileSync(join(root, name), "utf8");
		}
	};
	visit("");
	return files;
}

/** Compile all bindings before publishing anything. Initialization runs without host capabilities. */
export async function compileDefinition(input: DefinitionFiles, signal?: AbortSignal): Promise<HarnessSnapshot> {
	const files = Object.freeze(Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))));
	if (JSON.stringify(files).length > 4 * 1024 * 1024) throw new Error("Harness files exceed 4 MiB");
	for (const [path, source] of Object.entries(files)) {
		logicalPath(path);
		if (typeof source !== "string" || source.length > 256 * 1024) throw new Error(`${path}: file exceeds 256 KiB`);
	}
	const root = fields(
		yamlValue(fileText(files, "agent.yaml"), "agent.yaml"),
		["format", "context", "codemode", "loop", "compaction"],
		"agent.yaml",
	);
	if (root.format !== "pi-harness/v1") throw new Error("Unsupported Harness format; expected pi-harness/v1");
	const exports = new Map<string, string[]>();
	const requireExport = async (reference: string) => {
		const ref = ruleReference(reference);
		let names = exports.get(ref.file);
		if (!names) {
			const sandbox = createRuleSandbox();
			try {
				const result = await sandbox.execute(fileText(files, ref.file), { signal, module: { filename: ref.file } });
				if (!result.ok) throw new Error(`${ref.file}: ${result.error.message}`);
				if (!Array.isArray(result.value) || !result.value.every((v) => typeof v === "string"))
					throw new Error(`${ref.file}: invalid exports`);
				names = result.value;
				exports.set(ref.file, names);
			} finally {
				await sandbox.close();
			}
		}
		if (!names.includes(ref.export)) throw new Error(`${reference}: callable export not found`);
	};
	const checkFile = (value: unknown) => {
		const ref = fields(value, ["file"], "file reference");
		fileText(files, string(ref.file, "file"));
	};
	const checkOptions = (value: unknown) => {
		checkFile(value);
		const path = string(object(value).file, "options.file");
		yamlValue(fileText(files, path), path);
	};
	const checkExpression = async (value: unknown, depth = 0): Promise<void> => {
		if (depth > 32) throw new Error("Expression exceeds 32 levels");
		const ref = object(value);
		if ("file" in ref) {
			checkFile(ref);
			return;
		}
		if ("source" in ref) {
			fields(ref, ["source"], "source reference");
			if (!(SOURCE_NAMES as readonly unknown[]).includes(ref.source))
				throw new Error(`Unknown input source: ${ref.source}`);
			return;
		}
		fields(ref, ["render", "inputs", "options"], "render");
		await requireExport(string(ref.render, "render"));
		if (ref.options !== undefined) checkOptions(ref.options);
		for (const expression of Object.values(object(ref.inputs ?? {}))) await checkExpression(expression, depth + 1);
	};
	const context = fields(root.context, ["system", "history"], "context");
	await checkExpression(context.system);
	await checkExpression(context.history);
	const codemode = fields(root.codemode, ["description", "tools", "hooks", "output"], "codemode");
	await checkExpression(codemode.description);
	const output = fields(codemode.output, ["render", "options", "views"], "codemode.output");
	await requireExport(string(output.render, "output.render"));
	checkOptions(output.options);
	checkOptions(output.views);
	const viewsPath = string(object(output.views).file, "output.views.file");
	const views: Record<string, string> = {};
	for (const [name, reference] of Object.entries(object(yamlValue(fileText(files, viewsPath), viewsPath)))) {
		identifier(name, "view name");
		const ref = string(reference, `view ${name}`);
		await requireExport(ref);
		Object.defineProperty(views, name, { value: ref, enumerable: true });
	}
	const loop = fields(root.loop, ["decide", "options", "reminders"], "loop");
	await requireExport(string(loop.decide, "loop.decide"));
	checkOptions(loop.options);
	for (const [name, ref] of Object.entries(object(loop.reminders))) {
		identifier(name, "loop.reminders key");
		checkFile(ref);
	}
	const compaction = fields(root.compaction, ["plan", "serialize", "merge", "options", "prompts"], "compaction");
	for (const key of ["plan", "serialize", "merge"]) await requireExport(string(compaction[key], `compaction.${key}`));
	checkOptions(compaction.options);
	const prompts = fields(compaction.prompts, ["system", "initial", "update", "turn", "branch"], "compaction.prompts");
	for (const name of ["system", "initial", "update", "turn", "branch"]) checkFile(prompts[name]);
	const definitions = (value: unknown, glob: boolean): string[] => {
		const config = fields(value, ["definitions"], "definitions");
		if (!Array.isArray(config.definitions) || !config.definitions.every((v) => typeof v === "string"))
			throw new Error("definitions must be a path array");
		return config.definitions.flatMap((pattern: string) => {
			if (!glob || !pattern.includes("*")) {
				fileText(files, pattern);
				return [pattern];
			}
			logicalPath(pattern.replaceAll("*", "glob"));
			return Object.keys(files)
				.filter((path) => minimatch(path, pattern))
				.sort();
		});
	};
	const moduleFiles = new Map<string, string>();
	const handler = async (value: unknown, location: string): Promise<Handler> => {
		const ref = fields(value, ["module", "file", "export"], location);
		const parsed = {
			module: identifier(ref.module, `${location}.module`),
			file: logicalPath(string(ref.file, `${location}.file`)),
			export: string(ref.export, `${location}.export`),
		};
		if (moduleFiles.has(parsed.module) && moduleFiles.get(parsed.module) !== parsed.file)
			throw new Error(`Module ${parsed.module} references conflicting files`);
		moduleFiles.set(parsed.module, parsed.file);
		await requireExport(`${parsed.file}#${parsed.export}`);
		return parsed;
	};
	const tools: HarnessTool[] = [];
	for (const path of definitions(codemode.tools, true)) {
		const def = fields(
			yamlValue(fileText(files, path), path),
			["name", "description", "parameters", "outputSchema", "handler"],
			path,
		);
		const ref = await handler(def.handler, `${path}.handler`);
		const name = identifier(def.name, "tool.name");
		if (!name.startsWith(`${ref.module}.`))
			throw new Error(
				`${path}: tool name ${JSON.stringify(name)} must start with handler.module prefix ${JSON.stringify(`${ref.module}.`)}. Set name and handler.module consistently.`,
			);
		if (tools.some((t) => t.name === name)) throw new Error(`${path}: duplicate tool name ${JSON.stringify(name)}`);
		const parameters = object(def.parameters) as TSchema;
		if (object(def.parameters).type !== "object")
			throw new Error(`${path}: parameters must be an object JSON Schema`);
		// Exercise the same interpreter used by the nested-call runner.
		Check(parameters, {});
		const outputSchema = def.outputSchema === undefined ? undefined : (object(def.outputSchema) as TSchema);
		if (outputSchema) Check(outputSchema, null);
		tools.push({ name, description: string(def.description, "description"), parameters, outputSchema, handler: ref });
	}
	const hooks: HarnessHook[] = [];
	for (const path of definitions(codemode.hooks, false)) {
		const def = fields(yamlValue(fileText(files, path), path), ["id", "event", "handler"], path);
		const ref = await handler(def.handler, `${path}.handler`);
		const id = identifier(def.id, "hook.id");
		if (!id.startsWith(`${ref.module}.`) || hooks.some((h) => h.id === id))
			throw new Error(`${path}: duplicate hook or wrong namespace`);
		if (!["tool_call", "tool_result", "agent_start", "agent_end"].includes(string(def.event, "event")))
			throw new Error(`${path}: unsupported event`);
		hooks.push({ id, event: def.event as HookEvent, handler: ref });
	}
	return {
		revision: `r-${digest(files)}`,
		files,
		definition: root as unknown as HarnessDefinition,
		tools,
		hooks,
		views: Object.freeze(views),
	};
}

export async function evaluate(
	snapshot: HarnessSnapshot,
	expression: Expression,
	sources: Record<string, unknown>,
	output: string,
	provenance: Provenance[],
	signal?: AbortSignal,
): Promise<unknown> {
	const dependencies = new Set<string>();
	const visit = async (node: Expression): Promise<unknown> => {
		if ("file" in node) {
			dependencies.add(node.file);
			return fileText(snapshot.files, node.file);
		}
		if ("source" in node) {
			dependencies.add(`source:${node.source}`);
			if (!(node.source in sources)) throw new Error(`Missing input source: ${node.source}`);
			return sources[node.source];
		}
		dependencies.add(node.render);
		const inputs: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(node.inputs ?? {})) inputs[key] = await visit(value);
		let options: unknown;
		if (node.options) {
			dependencies.add(node.options.file);
			options = yamlValue(fileText(snapshot.files, node.options.file), node.options.file);
		}
		return runRule(snapshot.files, node.render, inputs, options, signal);
	};
	const result = await visit(expression);
	provenance.push({ output, dependencies: [...dependencies] });
	return result;
}
