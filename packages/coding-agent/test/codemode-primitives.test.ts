import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrimitiveScope } from "../src/extensions/codemode/primitives.ts";

const resources: { scope: PrimitiveScope; cwd: string }[] = [];
function setup() {
	const cwd = mkdtempSync(join(tmpdir(), "pi-atomic-primitives-"));
	const scope = new PrimitiveScope(cwd);
	resources.push({ scope, cwd });
	const globals = new Map(scope.globals().map((global) => [global.name, global]));
	const call = async (name: string, args: unknown, signal = new AbortController().signal) => {
		const global = globals.get(name);
		if (!global) throw new Error(`Missing primitive ${name}`);
		return global.execute(args, { signal });
	};
	return { cwd, scope, call };
}
afterEach(() => {
	for (const { scope, cwd } of resources.splice(0)) {
		scope.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});

describe("codemode resource primitives", () => {
	it("reports complete primitive argument contracts before effects", async () => {
		const { cwd, call } = setup();
		writeFileSync(join(cwd, "original"), "unchanged");
		await expect(call("host.fs.stat", "original")).rejects.toThrow("Contract: host.fs.stat(args: { path: string; }");
		const failure = await call("host.fs.write", { path: "original", data: 42, append: "yes" }).catch(
			(error: Error) => error.message,
		);
		expect(failure).toContain("/data");
		expect(failure).toContain("/append");
		expect(failure).toContain("Contract: host.fs.write");
		expect(readFileSync(join(cwd, "original"), "utf8")).toBe("unchanged");
	});
	it("preserves exact bytes across paged reads and binary writes", async () => {
		const { cwd, call } = setup();
		const bytes = Buffer.from("文件内容\0hello");
		writeFileSync(join(cwd, "input"), bytes);
		let offset = 0;
		const chunks: Buffer[] = [];
		while (true) {
			const result = (await call("host.fs.read", { path: "input", offset, length: 2, encoding: "base64" })) as {
				data: string;
				bytes: number;
				eof: boolean;
			};
			chunks.push(Buffer.from(result.data, "base64"));
			offset += result.bytes;
			if (result.eof) break;
		}
		expect(Buffer.concat(chunks)).toEqual(bytes);
		await call("host.fs.write", { path: "output", data: bytes.toString("base64"), encoding: "base64" });
		expect(readFileSync(join(cwd, "output"))).toEqual(bytes);
	});
	it("drains bounded stdout and stderr concurrently before a nonzero exit", async () => {
		const { call } = setup();
		const process = (await call("host.process.spawn", {
			program: globalThis.process.execPath,
			args: [
				"-e",
				"process.stdout.write('o'.repeat(131072));process.stderr.write('e'.repeat(131072));process.exitCode=3",
			],
		})) as { id: string; stdout: string; stderr: string; stdin: string };
		await call("host.streams.close", { id: process.stdin });
		const drain = async (id: string) => {
			let length = 0;
			while (true) {
				const chunk = (await call("host.streams.read", { id, maxBytes: 4096 })) as { bytes: number; eof: boolean };
				expect(chunk.bytes).toBeLessThanOrEqual(4096);
				length += chunk.bytes;
				if (chunk.eof) return length;
			}
		};
		expect(await Promise.all([drain(process.stdout), drain(process.stderr)])).toEqual([131072, 131072]);
		expect(await call("host.process.wait", { id: process.id })).toEqual({ exitCode: 3, signal: null });
	});
	it("retains unread stdout and stderr after a short process exits", async () => {
		const { call } = setup();
		const child = (await call("host.process.spawn", {
			program: process.execPath,
			args: ["-e", "process.stdout.write('stdout');process.stderr.write('stderr')"],
		})) as { id: string; stdout: string; stderr: string };
		expect(await call("host.process.wait", { id: child.id })).toEqual({ exitCode: 0, signal: null });
		// Let the child-process implementation flush/close its pipes before the next controller RPC.
		await call("host.clock.sleep", { ms: 50 });
		for (const [id, expected] of [
			[child.stdout, "stdout"],
			[child.stderr, "stderr"],
		]) {
			let text = "";
			while (true) {
				const part = (await call("host.streams.read", { id, maxBytes: 2 })) as {
					data: string;
					bytes: number;
					eof: boolean;
				};
				expect(part.bytes).toBeLessThanOrEqual(2);
				text += part.data;
				if (part.eof) break;
			}
			expect(text).toBe(expected);
		}
	});
	it("aborts a blocked stream read and terminates its child when the scope closes", async () => {
		const { call, scope } = setup();
		const child = (await call("host.process.spawn", {
			program: process.execPath,
			args: ["-e", "process.stdout.write(String(process.pid));setInterval(()=>{},1000)"],
		})) as { stdout: string; stderr: string };
		const first = (await call("host.streams.read", { id: child.stdout })) as { data: string };
		const pid = Number(first.data);
		expect(Number.isInteger(pid)).toBe(true);
		const controller = new AbortController();
		const pending = call("host.streams.read", { id: child.stderr }, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow("aborted");
		scope.close();
		await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
		await expect(call("host.fs.read", { path: "anything" })).rejects.toThrow("closed");
	});
});
