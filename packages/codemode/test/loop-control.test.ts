import { afterEach, describe, expect, it } from "vitest";
import { CodemodeSandbox } from "../src/index.ts";

const sandboxes: CodemodeSandbox[] = [];

function createSandbox(): CodemodeSandbox {
	const sandbox = new CodemodeSandbox({
		timeoutMs: 10_000,
		tools: [{ name: "echo", execute: (args) => args }],
	});
	sandboxes.push(sandbox);
	return sandbox;
}

afterEach(async () => {
	await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.close()));
});

describe("codemode loop control", () => {
	it("allows local names to shadow outer capabilities without hidden parameter collisions", async () => {
		const sandbox = createSandbox();
		expect(
			await sandbox.execute(`
      const echo = globalThis.tools.echo;
      const tools = await echo(["one", "two"]);
      const console = { message: "local console" };
      const text = "local text", image = "local image", store = "local store", load = "local load";
      const exit = "local exit", ALL_TOOLS = "local catalog", loop = globalThis.loop;
      globalThis.console.log("outer console");
      return loop.next({ tools, console, text, image, store, load, exit, ALL_TOOLS });
    `),
		).toMatchObject({
			ok: true,
			loopControl: "next",
			value: {
				tools: ["one", "two"],
				console: { message: "local console" },
				text: "local text",
				image: "local image",
				store: "local store",
				load: "local load",
				exit: "local exit",
				ALL_TOOLS: "local catalog",
			},
			output: [{ type: "text", text: "outer console", console: true }],
		});
		expect(await sandbox.execute('const tools = 1;\nthrow new Error("line marker");')).toMatchObject({
			ok: false,
			error: { stack: expect.stringContaining("codemode.js:2:") },
		});
	});

	it.each(["next", "finish"] as const)("separates %s from ordinary return data and output", async (action) => {
		const sandbox = createSandbox();
		const body =
			'text("before"); console.log("log"); store("count", 1); const value = await tools.echo({ answer: 42 });';
		const ordinary = await sandbox.execute(`${body} return value;`);
		const controlled = await sandbox.execute(`${body} return loop.${action}(value);`);
		expect(ordinary.ok && controlled.ok).toBe(true);
		if (!ordinary.ok || !controlled.ok) throw new Error("Expected successful scripts");
		expect(controlled.loopControl).toBe(action);
		expect(controlled.value).toEqual(ordinary.value);
		expect(controlled.output).toEqual(ordinary.output);
		expect(controlled.storeWrites).toEqual(ordinary.storeWrites);
		expect(controlled.calls).toMatchObject([{ name: "echo", status: "ok" }]);
		expect(ordinary).not.toHaveProperty("loopControl");
	});

	it.each(["next", "finish"] as const)("allows %s without tools or a payload", async (action) => {
		expect(await createSandbox().execute(`return loop.${action}();`)).toMatchObject({
			ok: true,
			loopControl: action,
			value: undefined,
			output: [],
			calls: [],
		});
	});

	it.each([
		'loop.finish("ignored"); return 42;',
		'text(loop.finish("ignored"));',
		'console.log("return loop.finish(msg)"); return { loopControl: "finish", value: 42 };',
		'const value = loop.finish("ignored"); return { ...value };',
		'loop.next("ignored"); exit();',
	])("does not select control from discarded, printed, or forged values: %s", async (code) => {
		const result = await createSandbox().execute(code);
		expect(result.ok).toBe(true);
		expect(result).not.toHaveProperty("loopControl");
	});

	it("uses only the returned decision", async () => {
		expect(
			await createSandbox().execute('const unused = loop.finish("unused"); return loop.next("continue");'),
		).toMatchObject({ ok: true, loopControl: "next", value: "continue" });
	});

	it.each([
		'store("count", 1); const value = loop.finish("done"); throw new Error("failed");',
		"const value = {}; value.self = value; return loop.finish(value);",
		'return loop.finish({ toJSON() { throw new Error("serialization failed"); } });',
	])("does not commit a decision or store writes on failure: %s", async (code) => {
		const result = await createSandbox().execute(code);
		expect(result.ok).toBe(false);
		expect(result).not.toHaveProperty("loopControl");
		expect(result).not.toHaveProperty("storeWrites");
	});

	it("does not commit control on cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await createSandbox().execute('return loop.finish("done");', { signal: controller.signal });
		expect(result).toMatchObject({ ok: false, error: { kind: "aborted" } });
		expect(result).not.toHaveProperty("loopControl");
	});

	it("protects loop helpers from mutation and host-global collisions", async () => {
		const result = await createSandbox().execute(`
			loop.finish = () => "replaced";
			globalThis.loop = {};
			return loop.finish("original");
		`);
		expect(result).toMatchObject({ ok: true, loopControl: "finish", value: "original" });
		for (const name of ["loop", "loop.finish"]) {
			expect(() => new CodemodeSandbox({ globals: [{ name, execute: () => undefined }] })).toThrow(/Invalid global/);
		}
	});
});
