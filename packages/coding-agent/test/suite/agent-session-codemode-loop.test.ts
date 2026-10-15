import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { CODEMODE_LOOP_REMINDER_TYPE, createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness, type HarnessOptions } from "./harness.ts";
import { harnessToolFiles, installHarnessFiles } from "./harness-programs.ts";

const harnesses: Harness[] = [];

function script(code: string) {
	return fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" });
}

async function setup(options: HarnessOptions = {}): Promise<Harness> {
	const harness = await createHarness({
		...options,
		initialActiveToolNames: options.initialActiveToolNames ?? ["codemode"],
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		extensionFactories: [
			createCodemodeExtension({ models: false, defaultActive: false }),
			...(options.extensionFactories ?? []),
		],
	});
	harnesses.push(harness);
	return harness;
}

function reminders(harness: Harness) {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === CODEMODE_LOOP_REMINDER_TYPE);
}

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

describe("AgentSession explicit codemode loop", () => {
	it("appends next results once, preserves history across a definition update, and finishes without an extra inference", async () => {
		const harness = await setup();
		const install = installHarnessFiles(
			harnessToolFiles('export function run() { return "selected evidence"; }', "fixture.run", { type: "object" }),
		);
		const requests: TranscriptContext["messages"][] = [];
		harness.setResponses([
			(context) => {
				requests.push(structuredClone(context.messages));
				return script(
					`${install}text("visible"); console.log("diagnostic"); return loop.next(await host.tools.call({name:"fixture.run",args:{}}));`,
				);
			},
			(context) => {
				requests.push(structuredClone(context.messages));
				return script('return loop.finish("Verified: 42");');
			},
			fauxAssistantMessage("must not run"),
		]);

		await harness.session.prompt("Remember PREFIX-MARKER and verify the fixture.");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(
			harness.eventsOfType("tool_execution_start").filter((event) => event.toolName === "fixture.run"),
		).toHaveLength(1);
		expect(requests[1].filter((m) => m.role !== "system").slice(0, 1)).toEqual(
			requests[0].filter((m) => m.role !== "system"),
		);
		expect(JSON.stringify(requests[1])).toContain("PREFIX-MARKER");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(results[0].details).toMatchObject({ loopControl: "next" });
		expect(results[0].content.slice(1)).toEqual([
			{
				type: "text",
				text: "==> text 1/2 <==\nvisible\n==> text 2/2 <==\nselected evidence\n<console_output>\ndiagnostic\n</console_output>",
			},
		]);
		expect(requests[1].filter((message) => message.role === "toolResult")).toHaveLength(1);
		expect(results[1].details).toMatchObject({ loopControl: "finish" });
		expect(results[1].content.slice(1)).toEqual([{ type: "text", text: "Verified: 42" }]);
		expect(harness.eventsOfType("tool_execution_end").at(-1)?.result.terminate).toBe(true);
		expect(reminders(harness)).toEqual([]);
	});

	it("can request another reasoning step without nested tool calls", async () => {
		const harness = await setup();
		harness.setResponses([
			script("return loop.next({ partial: 20 });"),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("partial");
				return script('return loop.finish("42");');
			},
		]);
		await harness.session.prompt("Continue, then finish.");
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("tool_execution_start").map((event) => event.toolName)).toEqual([
			"codemode",
			"codemode",
		]);
		expect(reminders(harness)).toEqual([]);
	});

	describe.each(["parallel", "sequential"] as const)("top-level batches (%s)", (executionMode) => {
		it.each([
			["next", "next"],
			["finish", "finish"],
			["next", "finish"],
			["finish", "next"],
			["finish-input", "next"],
			["finish-input", "finish-input"],
			["codemode", "fixture"],
			["fixture", "codemode"],
		] as const)("rejects %s + %s before any tool or script executes", async (first, second) => {
			let executions = 0;
			const harness = await setup({
				initialActiveToolNames: ["codemode", "fixture"],
				extensionFactories: [
					(pi) => {
						pi.registerTool({
							name: "fixture",
							label: "Fixture",
							description: "Record a side effect",
							parameters: Type.Object({}),
							execute: async () => {
								executions++;
								return { content: [{ type: "text", text: "executed" }], details: undefined };
							},
						});
					},
				],
			});
			harness.session.agent.toolExecution = executionMode;
			const calls = [first, second].map((kind) =>
				kind === "fixture"
					? fauxToolCall("fixture", {})
					: kind === "finish-input"
						? fauxToolCall("codemode", { finish: "must not finish" })
						: fauxToolCall("codemode", {
								code: `store("blocked", true); await tools.fixture({}); return loop.${kind === "next" ? "next" : "finish"}("must not run");`,
							}),
			);
			let prefix: TranscriptContext["messages"] = [];
			harness.setResponses([
				(context) => {
					prefix = structuredClone(context.messages);
					return fauxAssistantMessage(calls, { stopReason: "toolUse" });
				},
				(context) => {
					expect(context.messages.slice(0, prefix.length)).toEqual(prefix);
					const results = context.messages.filter((message) => message.role === "toolResult");
					expect(results).toHaveLength(2);
					expect(results.map((result) => result.toolCallId)).toEqual(calls.map((call) => call.id));
					for (const result of results) {
						expect(result.isError).toBe(true);
						expect(result.details).not.toHaveProperty("loopControl");
						expect(getMessageText(result)).toContain("only top-level tool call");
						expect(getMessageText(result)).toContain("Promise.allSettled");
					}
					return script(
						'if (load("blocked") !== undefined) throw new Error("Rejected script executed"); return loop.finish("Recovered.");',
					);
				},
				fauxAssistantMessage("must not run"),
			]);

			await harness.session.prompt("Run the operations.");
			expect(executions).toBe(0);
			expect(harness.eventsOfType("tool_execution_start").filter((event) => event.parentToolCallId)).toEqual([]);
			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(reminders(harness)).toHaveLength(1);
			expect(reminders(harness)[0]).toMatchObject({ details: { outcome: { status: "invalid_batch" } } });
			expect(getToolResult(harness, "codemode")).toMatchObject({
				isError: false,
				details: { loopControl: "finish" },
			});
		});
	});

	it("allows concurrent nested calls inside one controller script", async () => {
		const harness = await setup();
		const source = `export async function run({value}) {
      await host.state.set({key:value,value:true});
      while (!(await host.state.get({key:value === "left" ? "right" : "left"}))) await host.clock.sleep({ms:5});
      return value;
    }`;
		const install = installHarnessFiles(
			harnessToolFiles(source, "fixture.run", {
				type: "object",
				properties: { value: { type: "string" } },
				required: ["value"],
			}),
		);
		harness.setResponses([
			script(`// @options: {"timeout_ms": 5000}
${install}
const results = await Promise.allSettled([
  host.tools.call({name:"fixture.run",args:{value:"left"}}),
  host.tools.call({name:"fixture.run",args:{value:"right"}}),
]);
return loop.finish(results);`),
			fauxAssistantMessage("must not run"),
		]);

		await harness.session.prompt("Batch the independent operations inside one script.");
		expect(harness.eventsOfType("tool_execution_start").filter((event) => event.parentToolCallId)).toHaveLength(2);
		expect(harness.faux.state.callCount).toBe(1);
		const result = getToolResult(harness, "codemode");
		expect(result).toMatchObject({ isError: false, details: { loopControl: "finish" } });
		expect(JSON.parse(getMessageText({ content: result.content.slice(1) }))).toEqual([
			{ status: "fulfilled", value: "left" },
			{ status: "fulfilled", value: "right" },
		]);
		expect(reminders(harness)).toEqual([]);
	});

	it.each([true, false])("allows legacy calls only when codemode is inactive (active: %s)", async (active) => {
		let executions = 0;
		const harness = await setup({
			initialActiveToolNames: active ? ["codemode", "fixture"] : ["fixture"],
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "fixture",
						label: "Fixture",
						description: "Ordinary tool",
						parameters: Type.Object({}),
						execute: async () => {
							executions++;
							return { content: [{ type: "text", text: "executed" }], details: undefined };
						},
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("fixture", {}), fauxToolCall("fixture", {})], { stopReason: "toolUse" }),
			active ? script('return loop.finish("Done.");') : fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Run ordinary tools.");
		expect(executions).toBe(active ? 0 : 2);
		expect(harness.faux.state.callCount).toBe(2);
		expect(reminders(harness)).toHaveLength(active ? 1 : 0);
		expect(
			harness.session.messages
				.filter((message) => message.role === "toolResult")
				.filter((message) => message.toolName === "fixture")
				.every((result) => Boolean(result.isError) === active),
		).toBe(true);
	});

	it("bounds corrections for repeated invalid batches", async () => {
		const harness = await setup();
		harness.setResponses([
			...Array.from({ length: 4 }, () =>
				fauxAssistantMessage(
					[
						fauxToolCall("codemode", { code: 'return loop.next("must not run");' }),
						fauxToolCall("codemode", { code: 'return loop.finish("must not run");' }),
					],
					{ stopReason: "toolUse" },
				),
			),
			(_context, options) => {
				// Existing tool-turn scheduling may invoke the provider with an already-aborted
				// signal. No further response content or tool execution may follow exhaustion.
				expect(options?.signal?.aborted).toBe(true);
				return script('return loop.finish("must not run");');
			},
		]);
		await harness.session.prompt("Go.");
		expect(
			harness.session.messages.filter((message) => message.role === "assistant" && message.stopReason !== "aborted"),
		).toHaveLength(4);
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(8);
		expect(results.every((result) => result.isError)).toBe(true);
		expect(reminders(harness)).toHaveLength(4);
		expect(reminders(harness).at(-1)).toMatchObject({ details: { exhausted: true } });
	});

	it("accepts a native final answer without an extra inference or tool call", async () => {
		const harness = await setup();
		const answer = `The answer is 42. Markdown: \`code\`, "quotes", \${data}.`;
		harness.setResponses([fauxAssistantMessage(answer), fauxAssistantMessage("must not run")]);
		await harness.session.prompt("Compute 6 * 7.");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("tool_execution_start")).toEqual([]);
		expect(reminders(harness)).toEqual([]);
		expect(getMessageText(harness.session.messages.at(-1))).toBe(answer);
	});

	it("accepts a native final answer after observing next results", async () => {
		const harness = await setup();
		harness.setResponses([
			script('return loop.next("evidence");'),
			(context) => {
				expect(getMessageText(context.messages.at(-1))).toContain("evidence");
				return fauxAssistantMessage("Done.");
			},
		]);
		await harness.session.prompt("Go.");
		expect(harness.faux.state.callCount).toBe(2);
		expect(reminders(harness)).toEqual([]);
		expect(getMessageText(harness.session.messages.at(-1))).toBe("Done.");
	});

	it.each([
		["", "stop"],
		[" \n\t", "stop"],
		["unfinished answer", "length"],
	] as const)("recovers an empty or incomplete native answer (%j, %s)", async (text, stopReason) => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(text, { stopReason }),
			(context) => {
				expect(getMessageText(context.messages.at(-1))).toContain("No valid loop decision");
				return fauxAssistantMessage("Complete answer.");
			},
		]);
		await harness.session.prompt("Answer completely.");
		expect(harness.faux.state.callCount).toBe(2);
		expect(reminders(harness)).toHaveLength(1);
		expect(reminders(harness)[0]).toMatchObject({ details: { outcome: { status: "missing_decision" } } });
	});

	it.each([
		"return { answer: 42 };",
		'text("partial"); exit();',
		'loop.finish("discarded");',
		'text("return loop.finish(42)");',
	])("preserves ordinary output but reminds on a missing decision: %s", async (code) => {
		const harness = await setup();
		harness.setResponses([script(code), script('return loop.finish("done");')]);
		await harness.session.prompt("Go.");
		const first = harness.session.messages.find((message) => message.role === "toolResult");
		expect(first).toMatchObject({ isError: false });
		expect(first?.details).not.toHaveProperty("loopControl");
		expect(reminders(harness)).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("does not accept a finish value from a failed script or replay its effects", async () => {
		const harness = await setup();
		harness.setResponses([
			script('text("effect recorded"); const decision = loop.finish("wrong"); throw new Error("failed");'),
			script('return loop.finish("Recovered without replay.");'),
		]);
		await harness.session.prompt("Go.");
		const first = harness.session.messages.find((message) => message.role === "toolResult");
		expect(first).toMatchObject({ isError: true });
		expect(getMessageText(first)).toContain("effect recorded");
		expect(first?.details).not.toHaveProperty("loopControl");
		expect(reminders(harness)).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("separates execution recovery from protocol corrections and resets budgets after next", async () => {
		const harness = await setup();
		harness.setResponses([
			script(
				`${installHarnessFiles({ "policies/loop.yaml": "maxCorrections: 1\nmaxExecutionRecoveries: 2\n" })}return loop.next("configured");`,
			),
			script(
				'await host.state.set({key:"committed",value:1}); throw new TypeError("bad result shape"); return loop.next("unreachable");',
			),
			(context) => {
				const reminder = getMessageText(context.messages.at(-1));
				expect(reminder).toContain("bad result shape");
				expect(reminder).toContain("host.state.set");
				expect(reminder).not.toContain("You did not correctly control");
				return fauxAssistantMessage("");
			},
			script("const broken = ; return loop.next();"),
			script('return loop.next(await host.state.get({key:"committed"}));'),
			script('throw new Error("new recovery budget");'),
			script('return loop.finish(await host.state.get({key:"committed"}));'),
		]);
		await harness.session.prompt("Recover without replaying effects.");
		expect(harness.faux.state.callCount).toBe(7);
		expect(reminders(harness)).toMatchObject([
			{
				details: {
					outcome: {
						status: "execution_failed",
						results: [
							{
								error: { kind: "script", name: "TypeError" },
								calls: [{ name: "host.state.set", status: "ok" }],
							},
						],
					},
					state: { executionFailures: 1 },
					reminder: "execution",
				},
			},
			{
				details: {
					outcome: { status: "missing_decision" },
					state: { executionFailures: 1, protocolCorrections: 1 },
					reminder: "retry",
				},
			},
			{
				details: {
					outcome: { status: "execution_failed", results: [{ error: { name: "SyntaxError" }, calls: [] }] },
					state: { executionFailures: 2, protocolCorrections: 1 },
				},
			},
			{ details: { state: { executionFailures: 1 }, reminder: "execution" } },
		]);
		expect(getToolResult(harness, "codemode")).toMatchObject({ isError: false, details: { loopControl: "finish" } });
	});

	it("exhausts the editable execution budget independently of the protocol budget", async () => {
		const harness = await setup();
		harness.setResponses([
			script(
				`${installHarnessFiles({ "policies/loop.yaml": "maxCorrections: 9\nmaxExecutionRecoveries: 1\n" })}return loop.next();`,
			),
			script('throw new Error("first failure");'),
			script('throw new Error("second failure");'),
		]);
		await harness.session.prompt("Exercise execution recovery exhaustion.");
		expect(reminders(harness)).toHaveLength(2);
		expect(reminders(harness).at(-1)).toMatchObject({
			content: expect.stringContaining("executionFailures=1"),
			details: { exhausted: true, outcome: { status: "execution_failed" }, state: { executionFailures: 1 } },
		});
		expect(harness.eventsOfType("tool_execution_start")).toHaveLength(3);
	});

	it("does not execute truncated controller scripts", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code: 'return loop.finish("truncated");' })], {
				stopReason: "length",
			}),
			script('return loop.finish("Complete.");'),
		]);
		await harness.session.prompt("Go.");
		const first = harness.session.messages.find((message) => message.role === "toolResult");
		expect(first).toMatchObject({ isError: true });
		expect(getMessageText(first)).toContain("not executed");
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("bounds correction attempts and reports failure instead of successful completion", async () => {
		const harness = await setup();
		harness.setResponses([
			...Array.from({ length: 4 }, () => fauxAssistantMessage("")),
			script('return loop.finish("must not run");'),
		]);
		await harness.session.prompt("Go.");
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(reminders(harness)).toHaveLength(4);
		expect(reminders(harness).at(-1)).toMatchObject({
			content: expect.stringContaining("recovery budget is exhausted"),
			details: { exhausted: true },
		});
	});

	it.each(["error", "aborted"] as const)("does not correct a provider %s", async (stopReason) => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage("not a native final answer", { stopReason }),
			script('return loop.finish("must not run");'),
		]);
		await harness.session.prompt("Go.");
		expect(harness.faux.state.callCount).toBe(1);
		expect(reminders(harness)).toEqual([]);
	});

	it("does not impose loop control when codemode is inactive", async () => {
		const harness = await setup({ initialActiveToolNames: ["read"] });
		harness.setResponses([fauxAssistantMessage("ordinary response")]);
		await harness.session.prompt("Go.");
		expect(harness.faux.state.callCount).toBe(1);
		expect(reminders(harness)).toEqual([]);
	});

	it("retains queued user input after finish", async () => {
		let queued = false;
		const harness = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", (event) => {
						if (event.toolName !== "codemode" || queued) return;
						queued = true;
						pi.sendUserMessage("New user work", { deliverAs: "followUp" });
					});
				},
			],
		});
		harness.setResponses([
			script('return loop.finish("First task complete.");'),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("New user work");
				return script('return loop.finish("Second task complete.");');
			},
		]);
		await harness.session.prompt("First task.");
		expect(harness.faux.state.callCount).toBe(2);
		expect(reminders(harness)).toEqual([]);
	});
});
