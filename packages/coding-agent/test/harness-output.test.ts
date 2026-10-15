import { beforeAll, describe, expect, it } from "vitest";
import {
	compileDefinition,
	type HarnessSnapshot,
	loadDefaultFiles,
} from "../src/extensions/codemode/harness/definition.ts";
import { renderHarnessOutput } from "../src/extensions/codemode/harness/output.ts";

let snapshot: HarnessSnapshot;
beforeAll(async () => {
	snapshot = await compileDefinition(loadDefaultFiles());
});
describe("explicit observation views", () => {
	it.each([
		["pi.read", "already a string", "complete read result object"],
		["harness.overview", { draft: "d-1" }, "overview returned by host.harness.inspect()"],
		["harness.detail", { text: "body" }, "detail page"],
		["harness.prepare", { revision: "r" }, "complete host.harness.prepare result"],
		["harness.edit", { text: "edited" }, "complete host.harness.edit result"],
		["harness.status", { preview: "hidden" }, "draft or activation status"],
		["harness.diagnostics", [{ code: "missing message" }], "Each diagnostic"],
	] as const)("reports the input contract for %s", async (view, value, message) => {
		const result = await renderHarnessOutput(snapshot, [{ type: "observation", value, view }]);
		expect(result.error).toContain(message);
		expect(result.items).toEqual([]);
	});
	it("keeps strings literal and requires explicit selection for arrays", async () => {
		const text = '"quotes"\n\\n literal\n';
		const result = await renderHarnessOutput(snapshot, [
			{ type: "observation", value: text },
			{ type: "observation", value: ["hidden"] },
		]);
		expect(result.items).toEqual([{ type: "text", text }]);
		expect(result.error).toContain("object/array requires an explicit view");
	});
	it("validates view exports before publication and isolates handler mutations from raw data", async () => {
		const files = {
			...snapshot.files,
			"policies/views.yaml": "custom: rules/custom.mjs#render\n",
			"rules/custom.mjs":
				"export function render(value){const source=value.source;value.source='changed';return source;}",
		};
		await expect(
			compileDefinition({ ...files, "policies/views.yaml": "custom: rules/custom.mjs#absent\n" }),
		).rejects.toThrow("callable export not found");
		const custom = await compileDefinition(files);
		const value = { source: "literal\nsource", metadata: { count: 1 } };
		const result = await renderHarnessOutput(custom, [{ type: "observation", value, view: "custom" }]);
		expect(result.error).toBeUndefined();
		expect(result.items).toEqual([{ type: "text", text: "literal\nsource" }]);
		expect(value).toEqual({ source: "literal\nsource", metadata: { count: 1 } });
	});
	it("renders prepare diffs literally and summarizes generated context without dumping it", async () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: The diff contains literal module source.
		const diff = "--- rules/view.mjs\n+++ rules/view.mjs\n+return `value ${input}\\n`;\n";
		const value = {
			revision: "r-prepared",
			baseRevision: "r-base",
			diagnostics: [{ severity: "info", path: "rules/view.mjs", line: 3, message: 'literal "quote"\n\\n' }],
			diff: [diff],
			preview: {
				system: [{ id: "system", text: "SYSTEM BODY NOT REQUESTED" }],
				description: "PROMPT BODY NOT REQUESTED".repeat(4000),
				estimatedTokens: 24000,
				catalog: { shown: ["file.read"], omitted: ["file.write"] },
			},
		};
		const original = structuredClone(value);
		const result = await renderHarnessOutput(snapshot, [{ type: "observation", value, view: "harness.prepare" }]);
		const output = result.items
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		expect(result.error).toBeUndefined();
		expect(output).toContain(diff);
		expect(output).toContain('info: rules/view.mjs:3: literal "quote"\n\\n');
		expect(output).toContain("Catalog shown: file.read");
		expect(output).not.toContain("BODY NOT REQUESTED");
		expect(output).not.toContain(JSON.stringify(diff));
		expect(output.length).toBeLessThan(800);
		expect(value).toEqual(original);
	});
	it("shows the native edit patch, small status fields and diagnostic text explicitly", async () => {
		const patch = '--- a\n+++ a\n-"old"\n+"new\\n"\n';
		const result = await renderHarnessOutput(snapshot, [
			{
				type: "observation",
				view: "harness.edit",
				value: { text: "Edited a", harness: { domain: "harness", path: "a" }, details: { patch, diff: "other" } },
			},
			{
				type: "observation",
				view: "harness.status",
				value: { status: "scheduled", revision: "r-new", requestRevision: "r-old", extra: "hidden" },
			},
			{
				type: "observation",
				view: "harness.diagnostics",
				value: ["first\nsecond", { message: "raw \\n", path: "a", line: 1 }],
			},
		]);
		const output = result.items
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		expect(result.error).toBeUndefined();
		expect(output).toContain(`Edited a\n\n${patch}`);
		expect(output).toContain("status: scheduled\nrevision: r-new\nrequestRevision: r-old");
		expect(output).toContain("first\nsecond\na:1: raw \\n");
		expect(output).not.toContain("hidden");
	});
});
