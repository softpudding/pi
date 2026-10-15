import { describe, expect, it } from "vitest";
import { loadDefaultFiles, runRule } from "../src/extensions/codemode/harness/definition.ts";

const files = loadDefaultFiles();
const reference = "rules/compaction.mjs#serialize";

describe("Harness summary input presentation", () => {
	it.each(["function", "custom"])(
		"preserves source separately from %s argument structure, including nested documents",
		async (protocol) => {
			const source =
				// biome-ignore lint/suspicious/noTemplateCurlyInString: This is source data, never evaluated by the serializer.
				'export function read(r) {\r\n  return `${r.text}\\n`;\r\n}\n// ``` and "quotes" without a final newline';
			const code = "const d=await host.harness.begin();\nreturn loop.next();";
			const values = {
				code,
				data: { files: { "rules/view.mjs": source }, tool: { name: "file.read", parameters: { type: "object" } } },
			};
			const args = protocol === "custom" ? { code: JSON.stringify(values) } : values;
			const original = structuredClone(args);
			const prompt = await runRule(
				files,
				reference,
				{
					messages: [{ role: "assistant", content: [{ type: "toolCall", name: "codemode", arguments: args }] }],
					instruction: "Summarize",
				},
				{ toolCallMaxChars: 8000, toolResultMaxChars: 2000 },
			);
			expect(prompt).toContain(code);
			expect(prompt).toContain(source);
			expect(prompt).toContain('"name": "file.read"');
			expect(prompt).toContain('"rules/view.mjs": "[argument text 2,');
			expect(prompt).toContain(`\n\`\`\`\`text\n${source}\n\`\`\`\``);
			expect(prompt).not.toContain(JSON.stringify(source));
			expect(prompt).not.toContain(JSON.stringify(code));
			expect(args).toEqual(original);
		},
	);

	it("caps tool call text explicitly without consuming the remainder of the conversation", async () => {
		const prompt = await runRule(
			files,
			reference,
			{
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								name: "codemode",
								arguments: {
									code: `start\n${"x".repeat(10000)}`,
									data: { prompt: "omitted document".repeat(1000) },
								},
							},
						],
					},
					{ role: "toolResult", content: [{ type: "text", text: 'readable\n"result"\n\\n' }] },
				],
				instruction: "Summary instruction",
			},
			{ toolCallMaxChars: 500, toolResultMaxChars: 2000 },
		);
		expect(prompt).toContain("[truncated for summary]");
		expect(prompt).toContain("argument texts omitted for summary");
		expect(prompt).toContain('readable\n"result"\n\\n');
		expect(prompt).toContain("Summary instruction");
		expect(String(prompt).length).toBeLessThan(1000);
	});

	it("keeps summary presentation editable and validates its text budget", async () => {
		const input = { messages: [], instruction: "Summary instruction" };
		await expect(runRule(files, reference, input, { toolCallMaxChars: -1 })).rejects.toThrow("non-negative integer");
		const custom = {
			...files,
			"rules/compaction.mjs": "export function serialize({instruction}){return 'CUSTOM '+instruction;}",
		};
		expect(await runRule(custom, reference, input, {})).toBe("CUSTOM Summary instruction");
	});
});
