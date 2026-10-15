/** Observation data becomes model-visible content only through the selected Harness output rule. */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { CodemodeOutputItem } from "@earendil-works/pi-codemode";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { object } from "../primitives.ts";
import { fileText, type HarnessSnapshot, runRule, yamlValue } from "./definition.ts";

export const contentSchema = Type.Array(
	Type.Union([
		Type.Object({ type: Type.Literal("text"), text: Type.String() }),
		Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
	]),
);

export async function renderHarnessOutput(
	snapshot: HarnessSnapshot,
	output: readonly CodemodeOutputItem[],
	signal?: AbortSignal,
): Promise<{ items: AgentToolResult<unknown>["content"]; maxOutputTokens: number; error?: string }> {
	const rule = snapshot.definition.codemode.output;
	const items: Exclude<CodemodeOutputItem, { type: "observation" }>[] = [];
	const errors: string[] = [];
	for (const [index, item] of output.entries()) {
		if (item.type !== "observation") {
			items.push(item);
			continue;
		}
		try {
			let text: unknown;
			if (item.view === undefined && (item.value === null || typeof item.value !== "object")) {
				text = String(item.value);
			} else {
				const reference =
					item.view && Object.hasOwn(snapshot.views, item.view) ? snapshot.views[item.view] : undefined;
				if (!reference)
					throw new Error(
						`observe(): ${item.view === undefined ? "object/array requires an explicit view" : `unknown view ${JSON.stringify(item.view)}`}. Available views: ${Object.keys(snapshot.views).join(", ") || "(none)"}. Definitions: agent.yaml codemode.output.views -> ${rule.views.file}. Edit the mapping and handler in a draft, prepare and activate; views take effect on the next request.`,
					);
				text = await runRule(snapshot.files, reference, item.value, undefined, signal);
				if (typeof text !== "string") throw new Error(`View ${item.view} (${reference}) must return a string`);
			}
			items.push({ type: "text", text: String(text) });
		} catch (error) {
			errors.push(
				`Observation at output item ${index + 1}, view ${item.view ?? "(missing)"}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	let rendered: AgentToolResult<unknown>["content"] = items;
	let maxOutputTokens = 10_000;
	try {
		const value = object(
			await runRule(
				snapshot.files,
				rule.render,
				{ output: items },
				yamlValue(fileText(snapshot.files, rule.options.file), rule.options.file),
				signal,
			),
		);
		if (
			!Check(contentSchema, value.items) ||
			!Number.isSafeInteger(value.maxOutputTokens) ||
			Number(value.maxOutputTokens) < 0 ||
			Number(value.maxOutputTokens) > 1_000_000
		)
			throw new Error("Invalid output rule result");
		rendered = value.items;
		maxOutputTokens = Number(value.maxOutputTokens);
	} catch (error) {
		errors.push(`Output layout ${rule.render}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { items: rendered, maxOutputTokens, ...(errors.length ? { error: errors.join("\n") } : {}) };
}
