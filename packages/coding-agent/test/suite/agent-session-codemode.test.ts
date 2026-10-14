import { readFileSync, rmSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantImages,
	type ClassifierModel,
	type ClassifierResult,
	fauxAssistantMessage,
	fauxToolCall,
	type ImageModel,
	type ImagesContext,
} from "@earendil-works/pi-ai";
import type { ToolResultMessage, Usage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { CustomEntry } from "../../src/core/session-manager.ts";
import { readCodemodeStore } from "../../src/extensions/codemode/execute.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import {
	CODEMODE_DOCS_PATH,
	CODEMODE_STORE_ENTRY_TYPE,
	type CodemodeToolDetails,
	createCodemodeTool,
} from "../../src/extensions/codemode/tool.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function usage(input: number, cost: number): Usage {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

const codemodeResult = (harness: Harness) => getToolResult(harness, "codemode");

/** The output after the script header, which is checked on the way. */
function resultText(message: ToolResultMessage): string {
	const [header, ...items] = message.content;
	expect(header).toEqual({
		type: "text",
		text: expect.stringMatching(/^Script (completed|failed)\nWall time \d+\.\d seconds\nOutput:\n$/),
	});
	return items.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");
}

const TINY_PNG_LABEL = /^\[Image saved to (\S+\.png) \(image\/png, \d+B\)\]$/;

/**
 * Replace the `[Image saved to ...]` labels in `text` with `<saved>` after checking that each file
 * holds the tiny PNG, and remove the files.
 */
function checkSavedImages(text: string): string {
	return text
		.split("\n")
		.map((line) => {
			const path = TINY_PNG_LABEL.exec(line)?.[1];
			if (!path) return line;
			try {
				expect(readFileSync(path).toString("base64")).toBe(TINY_PNG_BASE64);
			} finally {
				rmSync(path, { force: true });
			}
			return "<saved>";
		})
		.join("\n");
}

describe("AgentSession codemode tool", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup() {
		const harness = await createHarness({
			initialActiveToolNames: ["codemode"],
			extensionFactories: [createCodemodeExtension()],
		});
		harnesses.push(harness);
		return harness;
	}

	// Saved images: https://github.com/earendil-works/pi/issues/10310
	it("attaches only the images the script passes to image(), in output order, each after its saved path", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `
							// Images only appear when the script explicitly emits them.
							const shot = "captured";
							text(shot);
							image("data:image/png;base64,${TINY_PNG_BASE64}");
							image("data:image/png;base64,${TINY_PNG_BASE64}");
							text("after");
						`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = codemodeResult(harness);
		// The same image shown twice is saved once, so both labels name one file.
		const lines = resultText(result).split("\n");
		expect(lines).toEqual([
			"==> text 1/2 <==",
			"captured",
			lines[2],
			"<image>",
			lines[2],
			"<image>",
			"==> text 2/2 <==",
			"after",
		]);
		expect(checkSavedImages(lines[2])).toBe("<saved>");
		expect(result.content[2]).toEqual({ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
	});

	it("marks where each text item starts and puts console lines last in one text block", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: 'text("one\\ntwo");\nconsole.log("a");\nconsole.log("b");\ntext("three\\n");\nreturn 4;',
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		// Providers join adjacent text blocks with nothing or a newline, so the output is one block.
		const result = codemodeResult(harness);
		expect(result.content).toHaveLength(2);
		expect(resultText(result)).toBe(
			"==> text 1/3 <==\none\ntwo\n==> text 2/3 <==\nthree\n==> text 3/3 <==\n4\n<console_output>\na\nb\n</console_output>",
		);
	});

	it("reports script failures as results that keep partial output and the calls that ran", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `text("partial");\nconsole.log("log");\nawait host.clock.now();\nthrow new Error("boom");`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = codemodeResult(harness);
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toMatch(/^Script failed\n/);
		const text = resultText(result);
		expect(text).toMatch(/^partial\n<console_output>\nlog\n<\/console_output>\nScript error:\nError: boom\n/);
		expect(text).toContain("codemode.js:4");
		expect(text).toContain("Tool calls made before the failure (they are not undone): host.clock.now (ok)");
		expect((result.details as unknown as CodemodeToolDetails).calls.map((call) => call.name)).toEqual([
			"host.clock.now",
		]);
	});
});

describe("codemode options and store", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	// No tools override: the session builds its own codemode tool, including the store writer.
	async function setup() {
		const harness = await createHarness({
			initialActiveToolNames: ["codemode"],
			extensionFactories: [createCodemodeExtension()],
		});
		harnesses.push(harness);
		return harness;
	}

	async function run(harness: Harness, code: string): Promise<ToolResultMessage> {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		return codemodeResult(harness);
	}

	function storeEntries(harness: Harness): unknown[] {
		return harness.sessionManager
			.getBranch()
			.filter(
				(entry): entry is CustomEntry => entry.type === "custom" && entry.customType === CODEMODE_STORE_ENTRY_TYPE,
			)
			.map((entry) => entry.data);
	}

	const increment = `const next = (load("count") ?? 0) + 1;\nstore("count", next);\nreturn next;`;

	it("applies the timeout_ms option and rejects invalid options", async () => {
		const harness = await setup();
		const timedOut = await run(harness, '// @options: {"timeout_ms": 200}\nwhile (true) {}');
		expect(timedOut.isError).toBe(true);
		expect(resultText(timedOut)).toContain("Script error:\nScript timed out");

		const invalid = await run(harness, '// @options: {"yield": 1}\ntext(1)');
		expect(invalid.isError).toBe(true);
		expect(invalid.content).toEqual([
			{
				type: "text",
				text: "@options only supports `max_output_tokens` and `timeout_ms`; got `yield`",
			},
		]);
	});

	it("limits script memory so runaway allocations fail inside the script", async () => {
		const harness = await setup();
		const result = await run(
			harness,
			'// @options: {"timeout_ms": 30000}\nlet a = [];\ntry { while (true) a.push("x".repeat(1 << 20) + a.length); } catch (error) { const n = a.length; a = null; return { n, error: String(error) }; }',
		);
		expect(result.isError).toBe(false);
		const { n, error } = JSON.parse(resultText(result)) as { n: number; error: string };
		expect(error).toContain("out of memory");
		// Each entry holds at least 1 MiB, so the limit stops the script well before wasm32's 4 GiB.
		expect(n).toBeLessThan(512);
	});

	it("truncates output to the token budget and spills the full text", async () => {
		const harness = await setup();
		const result = await run(
			harness,
			`// @options: {"max_output_tokens": 30}\nfor (let i = 0; i < 100; i++) text("row " + i);\nimage("data:image/png;base64,${TINY_PNG_BASE64}");`,
		);
		const details = result.details as unknown as CodemodeToolDetails;
		const path = details.fullOutputPath;
		if (!path) throw new Error("No spill file");
		try {
			const text = resultText(result);
			expect(text).toMatch(/^Warning: truncated output/);
			expect(text).toContain("row 0\n");
			expect(text).toContain("tokens truncated");
			expect(text).toContain("row 99\n");
			expect(text).not.toContain("row 50\n");
			expect(text).toContain(`[Full output: ${path} (read with offset/limit)]`);
			// Images follow the truncated text, each after the path it was saved to.
			expect(result.content.at(-1)).toEqual({ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
			expect(checkSavedImages(text.split("\n").at(-2) ?? "")).toBe("<saved>");
			expect(readFileSync(path, "utf8")).toBe(
				Array.from({ length: 100 }, (_, i) => `==> text ${i + 1}/100 <==\nrow ${i}`).join("\n"),
			);
		} finally {
			rmSync(path, { force: true });
		}

		const small = await run(harness, "return { ok: true };");
		expect((small.details as unknown as CodemodeToolDetails).fullOutputPath).toBeUndefined();
	});

	it("persists store() writes as custom entries for later calls", async () => {
		const harness = await setup();
		expect(resultText(await run(harness, increment))).toBe("1");
		expect(resultText(await run(harness, increment))).toBe("2");
		expect(storeEntries(harness)).toEqual([
			{ set: { count: 1 }, delete: [] },
			{ set: { count: 2 }, delete: [] },
		]);
		const appended = harness
			.eventsOfType("entry_appended")
			.filter((event) => event.entry.type === "custom" && event.entry.customType === CODEMODE_STORE_ENTRY_TYPE);
		expect(appended).toHaveLength(2);

		expect(resultText(await run(harness, 'store("count", undefined);\nreturn load("count") === undefined;'))).toBe(
			"true",
		);
		expect(storeEntries(harness).at(-1)).toEqual({ set: {}, delete: ["count"] });
	});

	it("appends nothing for failed scripts or scripts without writes", async () => {
		const harness = await setup();
		expect((await run(harness, 'store("count", 5);\nthrow new Error("boom");')).isError).toBe(true);
		expect((await run(harness, 'return load("count") ?? "missing";')).isError).toBe(false);
		expect(storeEntries(harness)).toEqual([]);
	});

	it("runs without a session, starting from an empty store", async () => {
		const tool = createCodemodeTool();
		const result = await tool.execute("direct", { code: increment });
		expect(result.content[1]).toEqual({ type: "text", text: "1" });
	});

	it("loads the values written on the current branch", async () => {
		const harness = await setup();
		await run(harness, increment);
		const firstPrompt = harness.sessionManager.getBranch().find((entry) => entry.type === "message");
		if (!firstPrompt) throw new Error("No first prompt entry");
		expect(resultText(await run(harness, increment))).toBe("2");

		// Branch from the first prompt: the store entries written after it are on another path.
		harness.sessionManager.branch(firstPrompt.id);
		expect(resultText(await run(harness, increment))).toBe("1");
	});

	it("folds store entries from the root, ignoring malformed data", () => {
		const entry = (data: unknown, customType = CODEMODE_STORE_ENTRY_TYPE): CustomEntry => ({
			type: "custom",
			customType,
			data,
			id: Math.random().toString(36).slice(2),
			parentId: null,
			timestamp: new Date(0).toISOString(),
		});
		expect(
			readCodemodeStore([
				entry({ set: { a: 1, b: { c: 2 } }, delete: [] }),
				entry({ set: { a: 3 }, delete: ["b"] }),
				entry({ set: { z: 1 } }),
				entry({ set: { other: 1 }, delete: [] }, "other-extension"),
			]),
		).toEqual({ a: 3 });
	});
});

describe("codemode models", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const scorerModel: ClassifierModel<"test-classifier"> = {
		type: "classifier",
		id: "judge",
		name: "Judge",
		api: "test-classifier",
		provider: "scorer",
		baseUrl: "https://classifier.test/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		headers: { "X-Secret": "hunter2" },
	};

	const painterModel: ImageModel<"test-images"> = {
		type: "image",
		id: "painter",
		name: "Painter",
		api: "test-images",
		provider: "scorer",
		baseUrl: "https://images.test/v1",
		input: ["text", "image"],
		output: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};

	interface ClassifyObservation {
		baseUrl: string;
		apiKey: string | undefined;
		text: unknown;
	}

	interface ImagesObservation {
		baseUrl: string;
		apiKey: string | undefined;
		input: ImagesContext["input"];
	}

	async function setup() {
		const harness = await createHarness({
			initialActiveToolNames: ["codemode"],
			extensionFactories: [createCodemodeExtension()],
		});
		harnesses.push(harness);
		const observed: ClassifyObservation[] = [];
		const imageRequests: ImagesObservation[] = [];
		let active = 0;
		let maxActive = 0;
		harness.session.modelRuntime.registerProvider("scorer", {
			apiKey: "secret-key",
			models: [scorerModel, painterModel],
			images: {
				"test-images": {
					generateImages: async (model, context, options): Promise<AssistantImages> => {
						imageRequests.push({ baseUrl: model.baseUrl, apiKey: options?.apiKey, input: context.input });
						const prompt = context.input.find((block) => block.type === "text")?.text;
						const base = { api: model.api, provider: model.provider, model: model.id, timestamp: 0 };
						if (prompt === "explode") {
							return { ...base, output: [], stopReason: "error", errorMessage: "painter exploded" };
						}
						return {
							...base,
							output: [
								{ type: "text", text: `painted ${prompt}` },
								{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
							],
							usage: usage(100, 0.04),
							stopReason: "stop",
						};
					},
				},
			},
			classifiers: {
				"test-classifier": {
					classify: async (model, context, options): Promise<ClassifierResult> => {
						active++;
						maxActive = Math.max(maxActive, active);
						await new Promise((resolve) => setTimeout(resolve, 10));
						active--;
						const text = context.state.text;
						observed.push({ baseUrl: model.baseUrl, apiKey: options?.apiKey, text });
						if (text === "explode") {
							return {
								api: model.api,
								provider: model.provider,
								model: model.id,
								answers: {},
								stopReason: "error",
								errorMessage: "classifier exploded",
								timestamp: 0,
							};
						}
						return {
							api: model.api,
							provider: model.provider,
							model: model.id,
							answers: { approved: { type: "bool", probability: text === "good" ? 0.9 : 0.1 } },
							usage: usage(300, 0.001),
							stopReason: "stop",
							timestamp: 0,
						};
					},
				},
			},
		});
		harness.session.setActiveToolsByName(["codemode"]);
		return { harness, observed, imageRequests, maxActive: () => maxActive };
	}

	async function run(harness: Harness, code: string): Promise<ToolResultMessage> {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		return codemodeResult(harness);
	}

	const questions = `{ approved: { type: "bool", instructions: "Approval?", criteria: { true: "yes", false: "no" } } }`;

	it("declares models only for the session's own codemode tool", async () => {
		const { harness } = await setup();
		const codemode = harness.session.agent.state.tools.find((tool) => tool.name === "codemode");
		// The description names the models globals and points to the docs for the API.
		expect(codemode?.description).toContain("`models`: classifiers and image generation");
		expect(codemode?.description).toContain(CODEMODE_DOCS_PATH);

		const overridden = await createHarness({ tools: [createCodemodeTool() as AgentTool] });
		harnesses.push(overridden);
		const plain = overridden.session.agent.state.tools.find((tool) => tool.name === "codemode");
		expect(plain?.description).not.toContain("`models`");
	});

	it("lists models and classifies with catalog auth, ignoring script-supplied fields", async () => {
		const { harness, observed, maxActive } = await setup();
		const result = await run(
			harness,
			`
			const [model] = await models.getAvailableOfType("classifier", "scorer");
			const listed = await models.getModelsOfType("classifier");
			const same = await models.getModelOfType("classifier", "scorer", "judge");
			const texts = ["good", "bad", "good", "bad", "good", "bad"];
			const results = await Promise.all(
				texts.map((text) => models.classify({ ...model, baseUrl: "https://evil.test" }, { state: { text }, questions: ${questions} })),
			);
			return {
				id: model.id,
				headers: "headers" in model,
				listed: listed.some((entry) => entry.provider === "scorer" && entry.id === "judge"),
				same: same.id,
				missing: (await models.getModelOfType("classifier", "scorer", "nope")) === undefined,
				probabilities: results.map((r) => r.answers.approved.probability),
				cost: results[0].usage.cost.total,
			};
		`,
		);
		expect(result.isError).toBe(false);
		expect(JSON.parse(resultText(result))).toEqual({
			id: "judge",
			headers: false,
			listed: true,
			same: "judge",
			missing: true,
			probabilities: [0.9, 0.1, 0.9, 0.1, 0.9, 0.1],
			cost: 0.001,
		});
		expect(observed).toHaveLength(6);
		expect(
			observed.every((entry) => entry.baseUrl === "https://classifier.test/v1" && entry.apiKey === "secret-key"),
		).toBe(true);
		// Six classifications with at most four in flight.
		expect(maxActive()).toBe(4);
		const details = result.details as unknown as CodemodeToolDetails;
		expect(details.calls.map((call) => [call.name, call.args, call.status, call.cost])).toEqual(
			Array.from({ length: 6 }, () => ["models.classify", "scorer/judge", "ok", 0.001]),
		);
		// The classifications' usage becomes the codemode result's usage.
		expect(result.usage?.input).toBe(1800);
		expect(result.usage?.cost.total).toBeCloseTo(0.006, 10);
		expect(harness.session.getSessionStats().cost).toBeCloseTo(0.006, 10);
	});

	it("generates images with catalog auth and attaches them through image()", async () => {
		const { harness, imageRequests } = await setup();
		const result = await run(
			harness,
			`
			const [model] = await models.getAvailableOfType("image", "scorer");
			const reference = { type: "image", data: "${TINY_PNG_BASE64}", mimeType: "image/png" };
			const generated = await models.generateImages(
				{ ...model, baseUrl: "https://evil.test" },
				{ input: [{ type: "text", text: "a fox" }, reference] },
			);
			for (const block of generated.output) {
				if (block.type === "image") image(block);
				else text(block.text);
			}
			const failed = await models.generateImages(model, { input: [{ type: "text", text: "explode" }] });
			const attempt = async (fn) => { try { await fn(); return "ok"; } catch (error) { return error.message; } };
			return {
				id: model.id,
				stopReason: generated.stopReason,
				failed: [failed.stopReason, failed.errorMessage],
				wrongType: await attempt(() => models.generateImages({ provider: "scorer", id: "judge" }, { input: [] })),
			};
		`,
		);
		expect(result.isError).toBe(false);
		const [header, text, ...rest] = checkSavedImages(resultText(result)).split("\n");
		expect(header).toBe("==> text 1/2 <==");
		expect(text).toBe("painted a fox");
		expect(rest[0]).toBe("<saved>");
		expect(rest[1]).toBe("<image>");
		expect(rest[2]).toBe("==> text 2/2 <==");
		expect(JSON.parse(rest.slice(3).join("\n"))).toEqual({
			id: "painter",
			stopReason: "stop",
			failed: ["error", "painter exploded"],
			wrongType:
				'"scorer/judge" is a classifier model, not an image model. List the image models you can use with models.getAvailableOfType("image").',
		});
		expect(result.content[2]).toEqual({ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
		expect(imageRequests.map((request) => [request.baseUrl, request.apiKey])).toEqual([
			["https://images.test/v1", "secret-key"],
			["https://images.test/v1", "secret-key"],
		]);
		expect(imageRequests[0].input).toEqual([
			{ type: "text", text: "a fox" },
			{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
		]);
		const details = result.details as unknown as CodemodeToolDetails;
		expect(details.calls.map((call) => [call.name, call.args, call.status, call.cost, call.error])).toEqual([
			["models.generateImages", "scorer/painter", "ok", 0.04, undefined],
			["models.generateImages", "scorer/painter", "error", undefined, "painter exploded"],
		]);
		expect(result.usage?.cost.total).toBeCloseTo(0.04, 10);
		expect(harness.session.getSessionStats().cost).toBeCloseTo(0.04, 10);
	});

	it("notes generated images that the script did not show", async () => {
		const { harness } = await setup();
		const result = await run(
			harness,
			`
			const [model] = await models.getAvailableOfType("image", "scorer");
			const generated = await models.generateImages(model, { input: [{ type: "text", text: "a fox" }] });
			return generated.stopReason;
		`,
		);
		expect(result.isError).toBe(false);
		expect(resultText(result)).toBe(
			"stop\nNote: models.generateImages() returned 1 image that the script did not show. Show each image block of result.output with image(block).",
		);
	});

	it("reports provider errors as results and invalid arguments as exceptions", async () => {
		const { harness } = await setup();
		const result = await run(
			harness,
			`
			const model = await models.getModelOfType("classifier", "scorer", "judge");
			const failed = await models.classify(model, { state: { text: "explode" }, questions: ${questions} });
			const attempt = async (fn) => { try { await fn(); return "ok"; } catch (error) { return error.message; } };
			return {
				failed: [failed.stopReason, failed.errorMessage],
				badType: await attempt(() => models.getModelsOfType("video")),
				unknown: await attempt(() => models.classify({ provider: "scorer", id: "nope" }, {})),
				noModel: await attempt(() => models.classify("judge", {})),
				undefinedModel: await attempt(() => models.classify(undefined, {})),
				noState: await attempt(() => models.classify(model, { questions: ${questions} })),
				badQuestion: await attempt(() =>
					models.classify(model, { state: {}, questions: { kind: { type: "choice", instructions: "Kind?", criteria: ["a", "b"] } } }),
				),
				badImage: await attempt(() => models.generateImages({ provider: "scorer", id: "painter" }, { prompt: "a fox" })),
				badSplit: await attempt(() => models.getModelOfType("classifier", "scorer/judge")),
			};
		`,
		);
		expect(result.isError).toBe(false);
		const value = JSON.parse(resultText(result));
		expect(value.failed).toEqual(["error", "classifier exploded"]);
		expect(value.badType).toContain('Unknown model type "video"');
		expect(value.unknown).toBe(
			'Unknown classifier model "scorer/nope". List the classifier models you can use with models.getAvailableOfType("classifier").',
		);
		expect(value.noModel).toContain(
			"models.classify() expects a classifier model as its first argument, got a string.",
		);
		expect(value.undefinedModel).toContain(
			"models.getModelOfType() returns undefined for an unknown provider or id.",
		);
		expect(value.noState).toContain("models.classify() context.state must be an object, got undefined.");
		expect(value.noState).toContain("codemode.md");
		expect(value.badQuestion).toContain(
			'context.questions.kind is a "choice" question, so criteria must map each label to its meaning.',
		);
		expect(value.badImage).toContain(
			"models.generateImages() context.input must be a non-empty array of blocks, got undefined.",
		);
		expect(value.badSplit).toContain("The provider and the id are separate arguments");
		const details = result.details as unknown as CodemodeToolDetails;
		expect(details.calls.map((call) => [call.name, call.status, call.error])).toEqual([
			["models.classify", "error", "classifier exploded"],
		]);
		expect(result.usage).toBeUndefined();
	});
});
