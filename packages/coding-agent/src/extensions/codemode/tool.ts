/** Codemode exposes primitives and model-owned programs, never the prebuilt tool catalog. */
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CodemodeLoopControl } from "@earendil-works/pi-codemode";
import { CODEMODE_SOURCE_GRAMMAR } from "@earendil-works/pi-codemode/source";
import { type Static, Type } from "typebox";
import { getDocsPath } from "../../config.ts";
import type { ExtensionContext, ToolDefinition, ToolInfo } from "../../core/extensions/types.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { wrapToolDefinition } from "../../core/tools/tool-definition-wrapper.ts";
import { ATOMIC_CODEMODE_API } from "./api.ts";
import { loadCodemodeExecutor } from "./execute.lazy.ts";
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

export const codemodeSchema = Type.Object({ code: Type.String({ description: "Raw JavaScript source." }) });
export type CodemodeToolInput = Static<typeof codemodeSchema>;
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
}
export interface CodemodeToolDetails {
	calls: CodemodeNestedCall[];
	loopControl?: CodemodeLoopControl;
	fullOutputPath?: string;
}

export const codemodeToolSystemPromptContribution = {
	snippet: "Build and run your own tools from host primitives",
	guidelines: [
		"Use exactly one codemode call per response, with no sibling top-level tool calls. Batch independent operations inside that script with Promise.allSettled.",
		"Every external operation must use a model-authored registered tool: write its JavaScript export, await host.modules.put, await host.tools.register, then await host.tools.call. Put host.fs/process/streams operations inside that export. Do not skip registration by calling these primitives directly in the controller script. No prebuilt tools are available.",
		"When a task requires understanding new external data, return the tool's data with loop.next so you can read it on the next inference. Then compose the requested explanation or decision and return it with loop.finish. Code cannot use your reasoning on data you have not yet observed. Raw source data alone does not satisfy a request to analyze or explain it.",
		"End every script with return loop.next(results) to continue, or return loop.finish(answer) to finish. Even a text-only answer must use loop.finish, not a standalone assistant response.",
	],
} as const;

export function createCodemodeDescription(): string {
	return `Run JavaScript as the body of an async function in a QuickJS sandbox. Input is raw source, not JSON or a markdown fence. Top-level await and return work. No Node, filesystem, network, or timers except through the documented host interfaces.
Optional first line: // @options: {"max_output_tokens": 10000, "timeout_ms": 60000}

Loop control is required: make exactly one codemode call, with no other top-level tools, then return loop.next(results) to append results and request another inference, or return loop.finish(answer) to deliver the final answer without another inference. Previous context is preserved. Plain return, text(), exit(), or a standalone assistant answer does not select a loop decision. Multiple top-level calls are rejected before any side effect.

${ATOMIC_CODEMODE_API}`;
}

export function createCodemodeToolDefinition(
	options: CodemodeToolOptions = {},
): ToolDefinition<typeof codemodeSchema, CodemodeToolDetails | undefined> {
	return {
		name: CODEMODE_TOOL_NAME,
		label: CODEMODE_TOOL_NAME,
		description:
			createCodemodeDescription() +
			(options.models
				? `\n\nModel primitives (also available in module callbacks): \`models\`: classifiers and image generation. Async APIs: models.getAvailableOfType(type, provider?), models.getModelsOfType(type, provider?), models.getModelOfType(type, provider, id), models.classify(model, context), models.generateImages(model, context). Types: "chat", "classifier", "image". Model calls resolve catalog credentials on the host; scripts select a model by provider and id. API reference: ${CODEMODE_DOCS_PATH}.`
				: ""),
		promptSnippet: codemodeToolSystemPromptContribution.snippet,
		promptGuidelines: [...codemodeToolSystemPromptContribution.guidelines],
		parameters: codemodeSchema,
		exposure: "model-only",
		prepareLoadout: (loadout) => ({
			hiddenDeclarations: loadout.declared
				.filter((tool) => tool.name !== CODEMODE_TOOL_NAME)
				.map((tool) => tool.name),
		}),
		constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
		execute: async (toolCallId, params, signal, onUpdate, ctx) =>
			(await loadCodemodeExecutor()).executeCodemode(toolCallId, params, signal, onUpdate, ctx, options),
		...codemodeRenderers,
	};
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
