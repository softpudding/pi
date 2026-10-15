import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { codemodeRenderers } from "../src/extensions/codemode/renderer.ts";
import type { CodemodeToolDetails } from "../src/extensions/codemode/tool.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function render(
	result: AgentToolResult<CodemodeToolDetails | undefined>,
	isError = false,
	expanded = true,
	width = 200,
): string {
	const context = {
		args: { code: "" },
		toolCallId: "call",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: false,
		isError,
		durationMs: undefined,
		outputPad: 1,
	} satisfies ToolRenderContext;
	const component = codemodeRenderers.renderResult?.(
		result,
		{ expanded, isPartial: false },
		theme,
		context,
	) as Component;
	return stripVTControlCharacters(component.render(width).join("\n"))
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function createToolComponent(outputPad = 1): ToolExecutionComponent {
	return new ToolExecutionComponent(
		"codemode",
		"call",
		{ code: "return loop.finish(answer);" },
		{ showImages: false, outputPad },
		codemodeRenderers,
		{ requestRender: () => {} } as TUI,
		"/",
	);
}

describe("codemode renderer", () => {
	beforeAll(() => initTheme("dark"));

	it("shows input data separately from code and renders a data-only final answer once", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Interpolation syntax must stay literal data.
		const source = "source `with` ${syntax}";
		const component = new ToolExecutionComponent(
			"codemode",
			"data-call",
			{ code: "return loop.next(data);", data: { file: source } },
			{ showImages: false, outputPad: 1 },
			codemodeRenderers,
			{ requestRender: () => {} } as TUI,
			"/",
		);
		component.setExpanded(true);
		const text = stripVTControlCharacters(component.render(200).join("\n"));
		expect(text).toContain("return loop.next(data)");
		expect(text).toContain(source);
		const final = new ToolExecutionComponent(
			"codemode",
			"finish-call",
			{ finish: "Final text" },
			{ showImages: false, outputPad: 1 },
			codemodeRenderers,
			{ requestRender: () => {} } as TUI,
			"/",
		);
		final.updateResult({
			content: [{ type: "text", text: "Final text" }],
			details: { calls: [], loopControl: "finish" },
			isError: false,
		});
		const rendered = stripVTControlCharacters(final.render(80).join("\n"));
		expect(rendered).toContain("codemode finish");
		expect(rendered.match(/Final text/g)).toHaveLength(1);
	});

	it.each([0, 1, 3])("renders finish like an assistant reply outside the tool box (padding %s)", (outputPad) => {
		const answer = `# Final answer\n\n**Verified**: \`42\`.\n\n${"完整的中文回复。 ".repeat(30)}`;
		const result = {
			content: [
				{ type: "text" as const, text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
				{ type: "text" as const, text: answer },
			],
			details: {
				calls: [{ id: "call/1", name: "read", args: '{"path":"a"}', status: "ok" as const, durationMs: 5 }],
				loopControl: "finish" as const,
			},
			isError: false,
		};
		const original = structuredClone(result);
		const live = createToolComponent(outputPad);
		live.markExecutionStarted();
		live.updateResult({ content: [], details: { calls: [] }, isError: false }, true);
		live.updateResult(result);
		const replay = createToolComponent(outputPad);
		replay.updateResult(structuredClone(result));

		for (const expanded of [false, true]) {
			live.setExpanded(expanded);
			replay.setExpanded(expanded);
			for (const width of [30, 100]) {
				const expected = new AssistantMessageComponent(
					fauxAssistantMessage(answer),
					false,
					undefined,
					undefined,
					outputPad,
				).render(width);
				const lines = live.render(width);
				expect(lines.slice(-expected.length)).toEqual(expected);
				expect(replay.render(width)).toEqual(lines);
				const text = stripVTControlCharacters(lines.join("\n"));
				expect(text).toContain("read");
				expect(text.match(/Final answer/g)).toHaveLength(1);
				expect(text).not.toContain("Script completed");
			}
		}
		expect(result).toEqual(original);
	});

	it("keeps next, failed, and partial results in the tool view", () => {
		for (const state of [
			{ loopControl: "next" as const, isError: false, partial: false },
			{ loopControl: "finish" as const, isError: true, partial: false },
			{ loopControl: "finish" as const, isError: false, partial: true },
			{ loopControl: undefined, isError: false, partial: false },
		]) {
			const component = createToolComponent();
			component.updateResult(
				{
					content: [{ type: "text", text: "**not a final reply**" }],
					details: { calls: [], loopControl: state.loopControl },
					isError: state.isError,
				},
				state.partial,
			);
			const rendered = component.render(80).join("\n");
			expect(rendered).not.toContain("\x1b]133;A\x07");
			if (!state.partial) expect(stripVTControlCharacters(rendered)).toContain("**not a final reply**");
		}
	});

	it("updates final replies when padding, theme, or result content changes", () => {
		const component = createToolComponent();
		const result = {
			content: [{ type: "text" as const, text: "**Original answer**" }],
			details: { calls: [], loopControl: "finish" as const },
			isError: false,
		};
		component.updateResult(result);
		component.render(80);
		try {
			initTheme("light");
			component.setOutputPad(2);
			component.updateResult({ ...result, content: [{ type: "text", text: "**Redacted answer**" }] });
			component.invalidate();
			const expected = new AssistantMessageComponent(
				fauxAssistantMessage("**Redacted answer**"),
				false,
				undefined,
				undefined,
				2,
			).render(80);
			const lines = component.render(80);
			expect(lines.slice(-expected.length)).toEqual(expected);
			expect(stripVTControlCharacters(lines.join("\n"))).not.toContain("Original answer");
		} finally {
			initTheme("dark");
		}
	});

	it("hides the script header and shows the output", () => {
		const text = render({
			content: [
				{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
				{ type: "text", text: "hello" },
			],
			details: { calls: [{ id: "call/1", name: "read", args: '{"path":"a"}', status: "ok", durationMs: 5 }] },
		});
		expect(text).toBe('✓ read {"path":"a"} 5ms\n\nhello');
	});

	it("shows the cost of model calls and their total", () => {
		const call = { name: "models.classify", args: "scorer/judge", status: "ok" as const, durationMs: 5 };
		const text = render({
			content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }],
			details: {
				calls: [
					{ ...call, id: "call/models.classify/1", cost: 0.000012936 },
					{ ...call, id: "call/models.classify/2", cost: 0.02 },
					{ ...call, id: "call/models.classify/3" },
				],
			},
		});
		expect(text).toBe(
			[
				"✓ models.classify scorer/judge 5ms $0.000013",
				"✓ models.classify scorer/judge 5ms $0.02",
				"✓ models.classify scorer/judge 5ms",
				"Model calls: $0.02",
			].join("\n"),
		);
	});

	it("shows results without a header, such as rejected options", () => {
		const text = render(
			{
				content: [{ type: "text", text: "The @options line must be followed by JavaScript source" }],
				details: undefined,
			},
			true,
		);
		expect(text).toBe("The @options line must be followed by JavaScript source");
	});

	it("limits collapsed output to wrapped lines, not logical lines", () => {
		const text = render(
			{
				content: [
					{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
					{ type: "text", text: "x".repeat(1000) },
				],
				details: { calls: [], fullOutputPath: "/tmp/out.txt" },
			},
			false,
			false,
			50,
		);
		const lines = text.split("\n");
		expect(lines).toHaveLength(7);
		expect(lines.slice(0, 5)).toEqual(Array(5).fill("x".repeat(50)));
		expect(lines[5]).toMatch(/^\.\.\. \(15 more lines,/);
		expect(lines[6]).toBe("Full output: /tmp/out.txt");
	});
});
