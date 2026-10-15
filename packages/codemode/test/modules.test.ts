import { describe, expect, it } from "vitest";
import { CodemodeSandbox } from "../src/index.ts";

describe("module programs and nested host namespaces", () => {
	it("inspects and invokes ES module exports with private helpers and fresh state", async () => {
		const sandbox = new CodemodeSandbox({ globals: [{ name: "host.fs.read", execute: () => "hello" }] });
		const source =
			"let count = 0; const double = n => n * 2; export async function read(n) { return [await host.fs.read({}), double(n), ++count]; }";
		try {
			expect(await sandbox.execute(source, { module: {} })).toMatchObject({ ok: true, value: ["read"] });
			for (let index = 0; index < 2; index++) {
				expect(await sandbox.execute(source, { module: { export: "read", args: [3] } })).toMatchObject({
					ok: true,
					value: ["hello", 6, 1],
				});
			}
		} finally {
			await sandbox.close();
		}
	});
	it("rejects host effects during initialization and missing exports", async () => {
		let effects = 0;
		const sandbox = new CodemodeSandbox({
			globals: [
				{
					name: "host.fs.write",
					execute: () => {
						effects++;
					},
				},
			],
		});
		try {
			const result = await sandbox.execute("await host.fs.write({}); export function run() {}", { module: {} });
			expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("initialization") } });
			expect(effects).toBe(0);
			expect(await sandbox.execute("export const value = 1", { module: { export: "value" } })).toMatchObject({
				ok: false,
			});
		} finally {
			await sandbox.close();
		}
	});
	it("keeps the caller's source location when an awaited host operation fails", async () => {
		const sandbox = new CodemodeSandbox({
			globals: [
				{
					name: "host.fs.read",
					execute: () => {
						throw new Error("read failed");
					},
				},
			],
		});
		try {
			const result = await sandbox.execute(
				'export async function run() {\n  await Promise.resolve();\n  return await host.fs.read({path:"missing"});\n}',
				{ module: { export: "run", filename: "modules/example.mjs@r-test" } },
			);
			expect(result).toMatchObject({
				ok: false,
				error: { message: "read failed", stack: expect.stringContaining("modules/example.mjs@r-test:3:") },
			});
			const script = await sandbox.execute('await Promise.resolve();\nawait host.fs.read({path:"missing"});');
			expect(script).toMatchObject({
				ok: false,
				error: { message: "read failed", stack: expect.stringContaining("codemode.js:2:") },
			});
		} finally {
			await sandbox.close();
		}
	});
	it("freezes nested namespaces and rejects colliding paths", async () => {
		expect(
			() =>
				new CodemodeSandbox({
					globals: [
						{ name: "host.fs", execute: () => 1 },
						{ name: "host.fs.read", execute: () => 2 },
					],
				}),
		).toThrow("conflicts");
		const sandbox = new CodemodeSandbox({ globals: [{ name: "host.fs.read", execute: () => 42 }] });
		try {
			expect(
				await sandbox.execute("return [Object.isFrozen(host), Object.isFrozen(host.fs), await host.fs.read({})]"),
			).toMatchObject({ ok: true, value: [true, true, 42] });
		} finally {
			await sandbox.close();
		}
	});
	it("can interrupt module initialization and exported callbacks", async () => {
		const sandbox = new CodemodeSandbox({ timeoutMs: 300 });
		try {
			for (const source of ["while (true) {}", "export function run() { while (true) {} }"]) {
				expect(await sandbox.execute(source, { module: { export: "run" } })).toMatchObject({
					ok: false,
					error: { kind: "timeout" },
				});
			}
		} finally {
			await sandbox.close();
		}
	});
});
