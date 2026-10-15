import { getCurrentTools, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { loadDefaultFiles } from "../../src/extensions/codemode/harness/definition.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { codemodeInputContract } from "../../src/extensions/codemode/input.ts";
import { codemodeSchema, createCodemodeTool } from "../../src/extensions/codemode/tool.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";
import { installHarnessFiles } from "./harness-programs.ts";

const harnesses: Harness[] = [];
const script = (code: string) => fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" });
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

describe("Harness request guidance", () => {
	it("selects instructions from the routed model, with all inference handled by the faux provider", async () => {
		let target = "raw";
		const h = await createHarness({
			initialActiveToolNames: ["codemode"],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			modelsJson: {
				providers: {
					fixture: {
						api: "openai-responses",
						baseUrl: "https://fixture.invalid",
						apiKey: "fixture",
						models: [true, false].map((supportsOpenAIGrammarTools) => ({
							id: supportsOpenAIGrammarTools ? "raw" : "json",
							contextWindow: 100000,
							compat: { supportsOpenAIGrammarTools },
						})),
					},
				},
			},
			extensionFactories: [
				createCodemodeExtension({ models: false }),
				(pi) => {
					pi.registerVirtualModel({
						provider: "router",
						id: "auto",
						name: "Auto",
						route: (_request, ctx) => ({
							model: ctx.modelRegistry.find("fixture", target)!,
							thinkingLevel: "off",
						}),
					});
				},
			],
		});
		harnesses.push(h);
		const fauxStream = h.session.agent.streamFunction;
		const dispatched: string[] = [];
		h.session.agent.streamFunction = (model, context, options) => {
			dispatched.push(model.id);
			return fauxStream(h.getModel(), context, options);
		};
		await h.session.setModel(h.session.modelRuntime.getModel("router", "auto")!);
		for (const syntax of ["raw", "json", "raw"]) {
			target = syntax;
			h.setResponses([
				(context) => {
					const declaration = getCurrentTools(context.messages)[0];
					expect(declaration.description).not.toMatch(/free.form|function\/JSON|For JSON calls/i);
					if (syntax === "raw") {
						expect(declaration.description).toContain("Submit JavaScript source directly");
						expect(declaration.description).toContain("Optionally submit a JSON object");
						expect(declaration.description).not.toContain("Prefer operations in code");
					} else {
						expect(declaration.description).toContain("Submit an object containing {code,data?} or {finish}");
						expect(declaration.description).not.toContain("Submit JavaScript source directly");
						expect(declaration.parameters).toHaveProperty(
							"properties.data.description",
							expect.not.stringMatching(/free.form|raw JavaScript/i),
						);
					}
					expect(getMessageText(context.messages[0])).not.toContain("Submit ");
					return fauxAssistantMessage("done");
				},
			]);
			await h.session.prompt("Check this request");
			expect(h.session.model?.id).toBe("auto");
		}
		expect(dispatched).toEqual(["raw", "json", "raw"]);
		const raw = h.session.modelRuntime.getModel("fixture", "raw")!;
		const tool = createCodemodeTool();
		expect(codemodeInputContract(raw, { ...tool, constrainedSampling: undefined }).syntax).toBe("json");
		expect(codemodeInputContract({ ...raw, api: "custom-fixture" } as Model<string>, tool).syntax).toBe("json");
		expect(codemodeInputContract({ ...raw, compat: undefined }, tool).syntax).toBe("json");
	});

	it("replaces editable guide and parameter descriptions without a second fixed copy, and tracks renamed views", async () => {
		const h = await createHarness({
			initialActiveToolNames: ["codemode"],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [createCodemodeExtension({ models: false })],
		});
		harnesses.push(h);
		const defaults = loadDefaultFiles();
		const guide = "Use the project-specific controller workflow.";
		const dataDescription = "Project input documents, bound to data for this invocation.";
		const files = {
			"prompts/codemode.prompt": guide,
			"prompts/input-json.prompt": "Submit project operations in code and project documents in data.",
			"policies/input.yaml": JSON.stringify({ parameters: { data: dataDescription } }),
			"policies/views.yaml": '"project.read": rules/views.mjs#read\n',
		};
		h.setResponses([
			(context) => {
				const tool = getCurrentTools(context.messages)[0];
				expect(tool.description.split(defaults["prompts/codemode.prompt"]).length).toBe(2);
				expect(getMessageText(context.messages[0])).not.toContain(defaults["prompts/codemode.prompt"]);
				return script(
					`${installHarnessFiles(files)}observe((await host.harness.read({path:"agent.yaml"})).text);return loop.next();`,
				);
			},
			(context) => {
				const tool = getCurrentTools(context.messages)[0];
				const system = getMessageText(context.messages[0]);
				expect(tool.description.split(guide).length).toBe(2);
				expect(system).not.toContain(guide);
				expect(system + tool.description).not.toContain("Batch independent operations");
				expect(system + tool.description).not.toMatch(/harness.overview|pi.read/);
				expect(tool.description).toContain('"project.read": rules/views.mjs#read');
				expect(tool.description).not.toContain("Prefer operations in code");
				expect(tool.parameters).toHaveProperty("properties.data.description", dataDescription);
				expect(tool.parameters).not.toHaveProperty("properties.code.description");
				expect(tool.parameters).toHaveProperty("properties.code.type", "string");
				expect(codemodeSchema).not.toHaveProperty("properties.data.description");
				// The already-executed activation did not require a now-deleted view for bootstrap.
				expect(getToolResult(h, "codemode").isError).toBe(false);
				return script(
					'observe(await host.harness.read({path:"agent.yaml"}),{view:"project.read"});return loop.next();',
				);
			},
			() => {
				expect(getToolResult(h, "codemode").isError).toBe(false);
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("Change the guide and rename all views.");
		expect(h.getPendingResponseCount()).toBe(0);
	});

	it("rejects attempts to change parameter validation through presentation metadata", async () => {
		const h = await createHarness({
			initialActiveToolNames: ["codemode"],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [createCodemodeExtension({ models: false })],
		});
		harnesses.push(h);
		h.setResponses([
			script(
				`${installHarnessFiles({ "policies/input.yaml": '{"parameters":{"data":{"type":"string"}}}' })}return loop.finish("unreachable");`,
			),
			(context) => {
				expect(getMessageText(getToolResult(h, "codemode"))).toContain(
					"accepts only code, data and finish strings",
				);
				expect(getCurrentTools(context.messages)[0].parameters).toHaveProperty("properties.data.type", "object");
				return fauxAssistantMessage("Recovered; candidate was not activated.");
			},
		]);
		await h.session.prompt("Validate presentation metadata");
		expect(h.getPendingResponseCount()).toBe(0);
	});
});
