import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const hasBun = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

it.skipIf(!hasBun)(
	"settles a compiled worker before startup loses its last event-loop handle",
	() => {
		const directory = mkdtempSync(join(tmpdir(), "pi-worker-startup-"));
		try {
			const binary = join(directory, process.platform === "win32" ? "startup.exe" : "startup");
			const build = spawnSync(
				"bun",
				[
					"build",
					"--compile",
					"--no-compile-autoload-bunfig",
					"--no-compile-autoload-dotenv",
					"./test/fixtures/startup.ts",
					"./src/runtime/worker.ts",
					"--outfile",
					binary,
				],
				{ cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 30000 },
			);
			expect(build.status, build.stderr).toBe(0);
			const require = createRequire(import.meta.url);
			const result = spawnSync(
				binary,
				[require.resolve("quickjs-wasi/quickjs.wasm"), require.resolve("quickjs-wasi/encoding.so")],
				{
					encoding: "utf8",
					timeout: 10000,
				},
			);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toBe("completed:42 中文\n");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	40000,
);
