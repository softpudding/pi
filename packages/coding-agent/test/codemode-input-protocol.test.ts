import type { JsonObject, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { stream as completions } from "../../ai/src/api/openai-completions.ts";
import { stream as responses } from "../../ai/src/api/openai-responses.ts";
import { normalizeContext } from "../../ai/src/utils/transcript.ts";
import { codemodeInputContract } from "../src/extensions/codemode/input.ts";
import { createCodemodeTool, prepareCodemodeArguments } from "../src/extensions/codemode/tool.ts";

// biome-ignore lint/suspicious/noTemplateCurlyInString: Literal tool data must survive the provider adapter.
const source = '"quotes" `backticks` ${literal} \\n\r\n中文';
const code = `// ${source.replaceAll("\n", "\n// ")}\nobserve(data.source);return loop.next();`;
const inputs: JsonObject[] = [{ code }, { code, data: { source } }, { finish: source }];

describe("codemode provider input protocol", () => {
	it.each(["openai-responses", "openai-completions"] as const)(
		"round trips raw and JSON input through %s adapters",
		async (api) => {
			for (const supportsOpenAIGrammarTools of [true, false]) {
				const tool = createCodemodeTool();
				const model: Model<typeof api> = {
					id: "fixture",
					name: "fixture",
					api,
					provider: "fixture",
					baseUrl: "https://fixture.invalid/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100000,
					maxTokens: 4096,
					compat: { supportsOpenAIGrammarTools },
				};
				for (const input of inputs) {
					const raw =
						Object.keys(input).length === 1 && typeof input.code === "string"
							? input.code
							: JSON.stringify(input);
					const item = supportsOpenAIGrammarTools
						? { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "codemode", input: raw }
						: {
								type: "function_call",
								id: "fc_1",
								call_id: "call_1",
								name: "codemode",
								arguments: JSON.stringify(input),
							};
					const events =
						api === "openai-responses"
							? [
									{ type: "response.output_item.added", output_index: 0, item },
									{ type: "response.output_item.done", output_index: 0, item },
									{ type: "response.completed", response: { status: "completed", output: [item] } },
								]
							: [
									{
										id: "reply",
										choices: [
											{
												index: 0,
												delta: {
													tool_calls: [
														supportsOpenAIGrammarTools
															? {
																	index: 0,
																	id: "call_1",
																	type: "custom",
																	custom: { name: "codemode", input: raw },
																}
															: {
																	index: 0,
																	id: "call_1",
																	type: "function",
																	function: { name: "codemode", arguments: JSON.stringify(input) },
																},
													],
												},
												finish_reason: null,
											},
										],
									},
									{ id: "reply", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
								];
					let body: { tools: Array<{ type: string }>; input?: unknown; messages?: unknown } | undefined;
					const options = {
						apiKey: "test",
						transport: "sse" as const,
						maxRetries: 0,
						fetch: async (_url: unknown, init?: RequestInit) => {
							body = JSON.parse(String(init?.body));
							return new Response(
								`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
								{ headers: { "content-type": "text/event-stream" } },
							);
						},
					};
					const context = normalizeContext({
						tools: [tool],
						messages: [{ role: "user", content: "fixture", timestamp: 1 }],
					});
					const result = await (api === "openai-responses"
						? responses(model as Model<"openai-responses">, context, options)
						: completions(model as Model<"openai-completions">, context, options)
					).result();
					expect(result.stopReason, result.errorMessage).toBe("toolUse");
					expect(body?.tools.map((entry) => entry.type)).toEqual([
						supportsOpenAIGrammarTools ? "custom" : "function",
					]);
					expect(codemodeInputContract(model, tool)).toEqual({
						syntax: body?.tools[0].type === "custom" ? "javascript" : "json",
						jsonEnvelope: true,
					});
					const call = result.content.find((part) => part.type === "toolCall");
					expect(call?.type).toBe("toolCall");
					if (call?.type !== "toolCall") throw new Error("Missing call");
					expect(prepareCodemodeArguments(call.arguments)).toEqual(input);
					if (supportsOpenAIGrammarTools) expect(call.arguments).toEqual({ code: raw });
					// Replay a function-tool history into either protocol, retaining data/finish.
					const replay = normalizeContext({
						tools: [tool],
						messages: [
							{ ...result, content: [{ ...call, arguments: input }] },
							{
								role: "toolResult",
								toolCallId: call.id,
								toolName: call.name,
								content: [{ type: "text", text: source }],
								isError: false,
								timestamp: 2,
							},
						],
					});
					const replayed = await (api === "openai-responses"
						? responses(model as Model<"openai-responses">, replay, options)
						: completions(model as Model<"openai-completions">, replay, options)
					).result();
					expect(replayed.stopReason, replayed.errorMessage).toBe("toolUse");
					const history = body?.input ?? body?.messages;
					expect(JSON.stringify(history)).toContain(
						JSON.stringify(supportsOpenAIGrammarTools ? raw : JSON.stringify(input)).slice(1, -1),
					);
				}
			}
		},
	);

	it("does not reinterpret JavaScript blocks or recursively decode documents", () => {
		const block = { code: '{ const value = "text"; observe(value); } return loop.next();' };
		expect(prepareCodemodeArguments(block)).toBe(block);
		const quotedBlock = { code: '{ "use strict"; observe("text"); } return loop.next();' };
		expect(prepareCodemodeArguments(quotedBlock)).toBe(quotedBlock);
		const colonInString = { code: '{ "text: still a string statement"; } return loop.next();' };
		expect(prepareCodemodeArguments(colonInString)).toBe(colonInString);
		const input = { code: JSON.stringify({ code: JSON.stringify({ finish: "data only" }) }) };
		expect(prepareCodemodeArguments(input)).toEqual({ code: JSON.stringify({ finish: "data only" }) });
		expect(() => prepareCodemodeArguments({ code: '{"data":' })).toThrow("No operations were executed");
		expect(() => prepareCodemodeArguments({ code: '{"data":' })).not.toThrow(/free.form|raw JavaScript/i);
	});
});
