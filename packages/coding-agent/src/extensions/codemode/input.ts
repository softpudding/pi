/** Facts about the declaration sent on this request, independent of editable usage guidance. */
import type { Api, Model, Tool } from "@earendil-works/pi-ai";
import { resolveGrammarConstrainedSampling } from "@earendil-works/pi-ai/api/constrained-sampling";

export function codemodeInputContract(model: Model<Api> | undefined, tool: Tool) {
	// These adapters implement OpenAI custom tools. Other APIs always receive the JSON schema.
	const supportsGrammar =
		model !== undefined &&
		["openai-completions", "openai-responses", "azure-openai-responses", "openai-codex-responses"].includes(
			model.api,
		) &&
		model.compat !== undefined &&
		"supportsOpenAIGrammarTools" in model.compat &&
		model.compat.supportsOpenAIGrammarTools === true;
	const grammar = resolveGrammarConstrainedSampling(tool, supportsGrammar);
	const config = tool.constrainedSampling;
	return {
		syntax: grammar ? "javascript" : "json",
		jsonEnvelope: !grammar || (config !== false && config?.type === "grammar" && config.allowJsonInput === true),
	};
}

export type CodemodeParameterDescriptions = Partial<Record<"code" | "data" | "finish", string>>;

export function parameterDescriptions(value: unknown): CodemodeParameterDescriptions | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("codemode.description.parameterDescriptions must be an object");
	for (const [key, description] of Object.entries(value)) {
		if (!["code", "data", "finish"].includes(key) || typeof description !== "string")
			throw new Error("codemode.description.parameterDescriptions accepts only code, data and finish strings");
	}
	return value as CodemodeParameterDescriptions;
}
