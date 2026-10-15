/** Codemode exposes primitives and model-owned programs, never the prebuilt tool catalog. */
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CodemodeError, CodemodeLoopControl } from "@earendil-works/pi-codemode";
import { CODEMODE_SOURCE_GRAMMAR } from "@earendil-works/pi-codemode/source";
import { type Static, Type } from "typebox";
import { getDocsPath } from "../../config.ts";
import type { ExtensionContext, ToolDefinition, ToolInfo } from "../../core/extensions/types.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { wrapToolDefinition } from "../../core/tools/tool-definition-wrapper.ts";
import { loadCodemodeExecutor } from "./execute.lazy.ts";
import { attachHarnessRuntime } from "./harness/bridge.ts";
import { codemodeRenderers } from "./renderer.ts";
import type { CodemodeRuntime } from "./runtime.ts";

export const CODEMODE_TOOL_NAME = "codemode";
export const CODEMODE_STORE_ENTRY_TYPE = "codemode-store";
export const CODEMODE_DOCS_PATH = join(getDocsPath(), "codemode.md");

export interface CodemodeStoreEntryData {
	set: Record<string, unknown>;
	delete: string[];
}
export type CodemodeModelRuntime = Pick<
	ModelRegistry,
	"getModelsOfType" | "getAvailableOfType" | "getModelOfType" | "classify" | "generateImages"
>;
export interface CodemodeToolOptions {
	models?: boolean;
	appendEntry?: (customType: string, data: CodemodeStoreEntryData) => void;
	getRuntime?: (ctx: ExtensionContext) => Promise<CodemodeRuntime>;
}

export const codemodeSchema = Type.Object({
	code: Type.Optional(Type.String()),
	data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	finish: Type.Optional(Type.String()),
});
export type CodemodeToolInput = Static<typeof codemodeSchema>;

/** Custom-tool input is carried in code by the provider adapter. Decode one explicit JSON object only. */
export function prepareCodemodeArguments(input: unknown): CodemodeToolInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input as CodemodeToolInput;
	const args = input as Record<string, unknown>;
	if (Object.keys(args).length !== 1 || typeof args.code !== "string") return args as CodemodeToolInput;
	// A quoted property at the start of a block cannot be a JavaScript statement.
	// Leave ordinary JS blocks, expressions, and all document strings untouched.
	if (!/^\s*\{\s*"(?:[^"\\]|\\.)*"\s*:/.test(args.code)) return args as CodemodeToolInput;
	try {
		return JSON.parse(args.code) as CodemodeToolInput;
	} catch {
		throw new Error(
			"Invalid codemode JSON envelope: expected a valid object containing {code,data?} or {finish}. No operations were executed.",
		);
	}
}
export function isCodemodeTool(tool: Pick<ToolInfo, "name" | "parameters">): boolean {
	return tool.name === CODEMODE_TOOL_NAME && tool.parameters === codemodeSchema;
}

export type CodemodeNestedCallStatus = "running" | "ok" | "error" | "cancelled";
export interface CodemodeNestedCall {
	id: string;
	name: string;
	args: string;
	status: CodemodeNestedCallStatus;
	durationMs?: number;
	error?: string;
	cost?: number;
	effect?: { domain: "task" | "harness"; operation: "read" | "write" | "edit"; path: string };
}
export interface CodemodeToolDetails {
	calls: CodemodeNestedCall[];
	loopControl?: CodemodeLoopControl;
	error?: CodemodeError | { kind: "presentation"; message: string };
	fullOutputPath?: string;
}

export function createCodemodeDescription(): string {
	return "Execute JavaScript with host primitives and Harness-defined tools. The active Harness generates request-specific instructions from agent.yaml.";
}

export function createCodemodeToolDefinition(
	options: CodemodeToolOptions = {},
): ToolDefinition<typeof codemodeSchema, CodemodeToolDetails | undefined> {
	const definition: ToolDefinition<typeof codemodeSchema, CodemodeToolDetails | undefined> = {
		name: CODEMODE_TOOL_NAME,
		label: CODEMODE_TOOL_NAME,
		description:
			createCodemodeDescription() +
			(options.models
				? `\n\nModel primitives (also available in module callbacks): \`models\`: classifiers and image generation. Async APIs: models.getAvailableOfType(type, provider?), models.getModelsOfType(type, provider?), models.getModelOfType(type, provider, id), models.classify(model, context), models.generateImages(model, context). Types: "chat", "classifier", "image". Model calls resolve catalog credentials on the host; scripts select a model by provider and id. API reference: ${CODEMODE_DOCS_PATH}.`
				: ""),
		promptSnippet: "Build and run your own tools from host primitives",
		parameters: codemodeSchema,
		exposure: "model-only",
		prepareLoadout: (loadout) => ({
			hiddenDeclarations: loadout.declared
				.filter((tool) => tool.name !== CODEMODE_TOOL_NAME)
				.map((tool) => tool.name),
		}),
		constrainedSampling: {
			type: "grammar",
			variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR },
			inputProperty: "code",
			allowJsonInput: true,
		},
		prepareArguments: prepareCodemodeArguments,
		execute: async (toolCallId, params, signal, onUpdate, ctx) =>
			(await loadCodemodeExecutor()).executeCodemode(toolCallId, params, signal, onUpdate, ctx, options),
		...codemodeRenderers,
	};
	if (options.getRuntime) attachHarnessRuntime(definition, options.getRuntime);
	return definition;
}

export function createCodemodeTool(options: CodemodeToolOptions = {}): AgentTool<typeof codemodeSchema> {
	const definition = createCodemodeToolDefinition(options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
