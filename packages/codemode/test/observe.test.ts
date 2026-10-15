import { afterEach, describe, expect, it } from "vitest";
import { CodemodeSandbox } from "../src/index.ts";

const sandboxes: CodemodeSandbox[] = [];
function sandbox(): CodemodeSandbox {
	const instance = new CodemodeSandbox({ timeoutMs: 10_000 });
	sandboxes.push(instance);
	return instance;
}
afterEach(async () => {
	await Promise.all(sandboxes.splice(0).map((instance) => instance.close()));
});

describe("structured observations", () => {
	it("snapshots data without formatting, changing return values, or selecting loop control", async () => {
		const source = 'export function run() {\n\treturn "\\n 中文 `literal`";\n}\n';
		const result = await sandbox().execute(
			`text("before");
      const value = {source:data.source,meta:{eof:true},items:[null,42,"false"],content:"ordinary field"};
				const options = {view:"source"};
				const returned = observe(value, options);
				options.view = "changed";
      value.meta.eof = false;
      observe(undefined);
      text("after");
      return {value,returned:typeof returned};`,
			{ data: { source } },
		);
		expect(result).toMatchObject({
			ok: true,
			value: { value: { source, meta: { eof: false } }, returned: "undefined" },
			output: [
				{ type: "text", text: "before" },
				{
					type: "observation",
					view: "source",
					value: { source, meta: { eof: true }, items: [null, 42, "false"], content: "ordinary field" },
				},
				{ type: "observation", value: undefined },
				{ type: "text", text: "after" },
			],
		});
		expect(result).not.toHaveProperty("loopControl");
	});

	it.each(["null", "[]", '"source"', '{view:""}', "{view:42}", '{type:"source"}'])(
		"rejects invalid view options: %s",
		async (options) => {
			const result = await sandbox().execute(`observe({source:"text"},${options});`);
			expect(result).toMatchObject({
				ok: false,
				error: { kind: "script", message: expect.stringContaining("observe() options") },
				output: [],
			});
		},
	);

	it("lets a controller observe data and explicitly continue without duplicate return output", async () => {
		expect(
			await sandbox().execute('return loop.next(observe({source:"one\\ntwo",loopControl:"finish"}));'),
		).toMatchObject({
			ok: true,
			loopControl: "next",
			value: undefined,
			output: [{ type: "observation", value: { source: "one\ntwo", loopControl: "finish" } }],
		});
	});

	it.each([
		"() => 1",
		"{fn() {}}",
		"Symbol('x')",
		"1n",
		"NaN",
		"Infinity",
		"(() => {const x={};x.self=x;return x;})()",
	])("rejects unsupported data before emitting an observation: %s", async (value) => {
		const result = await sandbox().execute(`text("kept"); observe(${value}); return loop.finish("unreachable");`);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "script", message: expect.stringContaining("observe()") },
			output: [{ type: "text", text: "kept" }],
		});
		expect(result).not.toHaveProperty("loopControl");
	});

	it("keeps emitted observations on later failure and applies the shared output budget", async () => {
		expect(await sandbox().execute('observe({saved:true}); throw new Error("later");')).toMatchObject({
			ok: false,
			output: [{ type: "observation", value: { saved: true } }],
		});
		const result = await sandbox().execute('observe("x".repeat(16 * 1024 * 1024));');
		expect(result).toMatchObject({ ok: false, error: { name: "RangeError" }, output: [] });
	});

	it("reserves the host binding but permits ordinary local shadowing", async () => {
		expect(() => new CodemodeSandbox({ globals: [{ name: "observe", execute: () => undefined }] })).toThrow(
			/Invalid global/,
		);
		expect(await sandbox().execute('const observe = "local"; globalThis.observe(observe);')).toMatchObject({
			ok: true,
			output: [{ type: "observation", value: "local" }],
		});
	});
});
