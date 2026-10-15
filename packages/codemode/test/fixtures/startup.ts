import { CodemodeSandbox, loadQuickJSEncoding, loadQuickJSWasm } from "../../src/index.ts";

async function main(): Promise<void> {
	const sandbox = new CodemodeSandbox({
		globals: [],
		timeoutMs: 5000,
		wasm: loadQuickJSWasm(process.argv[2]),
		encodingWasm: loadQuickJSEncoding(process.argv[3]),
		workerUrl: "./src/runtime/worker.ts",
	});
	try {
		const result = await sandbox.execute(
			'export function compose() { return new TextDecoder().decode(new TextEncoder().encode("42 中文")); }',
			{
				module: { export: "compose", args: [] },
			},
		);
		if (!result.ok) throw new Error(result.error.message);
		process.stdout.write(`completed:${result.value}\n`);
	} finally {
		await sandbox.close();
	}
}

// Like CLI startup, there is no stdin reader, test-runner timer or top-level await keeping it alive.
void main();
