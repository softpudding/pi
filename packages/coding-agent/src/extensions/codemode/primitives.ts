/** Resource operations for generated programs. No built-in agent tool is invoked here. */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { CodemodeTool } from "@earendil-works/pi-codemode";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
import { killProcessTree } from "../../utils/shell.ts";
import { bindHostContract } from "./contracts.ts";

export function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object");
	return value as Record<string, unknown>;
}

export function string(value: unknown, name: string): string {
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	return value;
}

export function integer(value: unknown, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
		throw new Error(`${name} must be an integer between 0 and ${max}`);
	}
	return value;
}

function encoding(value: unknown): "utf8" | "base64" {
	if (value === undefined || value === "utf8") return "utf8";
	if (value === "base64") return "base64";
	throw new Error('encoding must be "utf8" or "base64"');
}

interface ProcessResource {
	child: ChildProcess;
	exited: Promise<{ exitCode: number | null; signal: string | null }>;
}

/** Resources belong to one invocation; closing it releases streams and terminates its process trees. */
export class PrimitiveScope {
	private readonly cwd: string;
	private readonly processes = new Map<string, ProcessResource>();
	private readonly readers = new Map<string, Readable>();
	private readonly writers = new Map<string, Writable>();
	private nextId = 0;
	private closed = false;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	private path(value: unknown): string {
		return resolve(this.cwd, string(value, "path"));
	}

	globals(): CodemodeTool[] {
		const operations: Record<string, CodemodeTool["execute"]> = {
			"host.env.info": () => ({ cwd: this.cwd, platform: process.platform }),
			"host.fs.read": async (input, { signal }) => {
				const args = object(input);
				const offset = integer(args.offset, "offset", 0);
				const length = integer(args.length, "length", 65536, 8 * 1024 * 1024);
				if (length === 0) throw new Error("length must be positive");
				const file = await open(this.path(args.path), "r");
				try {
					signal.throwIfAborted();
					const size = (await file.stat()).size;
					const buffer = Buffer.alloc(length);
					const { bytesRead } = await file.read(buffer, 0, length, offset);
					return {
						data: buffer.subarray(0, bytesRead).toString(encoding(args.encoding)),
						bytes: bytesRead,
						eof: offset + bytesRead >= size,
					};
				} finally {
					await file.close();
				}
			},
			"host.fs.write": async (input, { signal }) => {
				const args = object(input);
				const path = this.path(args.path);
				const data = Buffer.from(string(args.data, "data"), encoding(args.encoding));
				return withFileMutationQueue(path, async () => {
					signal.throwIfAborted();
					await writeFile(path, data, { flag: args.append === true ? "a" : "w", signal });
					return { bytes: data.length };
				});
			},
			"host.fs.stat": async (input) => {
				const info = await stat(this.path(object(input).path));
				return { size: info.size, mtimeMs: info.mtimeMs, type: info.isDirectory() ? "directory" : "file" };
			},
			"host.fs.list": async (input) => {
				const entries = await readdir(this.path(object(input).path), { withFileTypes: true });
				return entries.map((entry) => ({
					name: entry.name,
					type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
				}));
			},
			"host.fs.mkdir": (input) => {
				const args = object(input);
				return mkdir(this.path(args.path), { recursive: args.recursive === true });
			},
			"host.fs.rename": (input) => {
				const args = object(input);
				return rename(this.path(args.from), this.path(args.to));
			},
			"host.fs.remove": (input) => {
				const args = object(input);
				return rm(this.path(args.path), { recursive: args.recursive === true, force: false });
			},
			"host.clock.now": () => ({ unixMs: Date.now(), monotonicMs: performance.now() }),
			"host.clock.sleep": async (input, { signal }) => {
				await delay(integer(object(input).ms, "ms", 0, 2147483647), undefined, { signal });
			},
			"host.process.spawn": async (input, { signal }) => {
				const args = object(input);
				const program = string(args.program, "program");
				const argv = args.args ?? [];
				if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === "string"))
					throw new Error("args must be strings");
				const env = args.env === undefined ? {} : object(args.env);
				if (!Object.values(env).every((value) => typeof value === "string"))
					throw new Error("env values must be strings");
				signal.throwIfAborted();
				const child = spawn(program, argv, {
					cwd: args.cwd === undefined ? this.cwd : this.path(args.cwd),
					env: { ...process.env, ...(env as Record<string, string>) },
					stdio: "pipe",
					detached: process.platform !== "win32",
					windowsHide: true,
				});
				const id = `process-${++this.nextId}`;
				const exited = new Promise<{ exitCode: number | null; signal: string | null }>((resolveExit) => {
					child.once("exit", (exitCode, exitSignal) => resolveExit({ exitCode, signal: exitSignal }));
					child.once("error", () => resolveExit({ exitCode: -1, signal: null }));
				});
				this.processes.set(id, { child, exited });
				for (const [name, stream] of [
					["stdout", child.stdout],
					["stderr", child.stderr],
				] as const) {
					if (!stream) continue;
					// Keep pull mode across process exit. ChildProcess otherwise resumes unread pipes
					// during cleanup, discarding bytes before a later streams.read can consume them.
					stream.on("readable", () => {});
					this.readers.set(`${id}/${name}`, stream);
				}
				if (child.stdin) {
					child.stdin.on("error", () => {});
					this.writers.set(`${id}/stdin`, child.stdin);
				}
				await new Promise<void>((resolveSpawn, reject) => {
					child.once("spawn", resolveSpawn);
					child.once("error", reject);
				});
				return { id, stdin: `${id}/stdin`, stdout: `${id}/stdout`, stderr: `${id}/stderr` };
			},
			"host.process.wait": async (input) => {
				const id = string(object(input).id, "id");
				const process = this.processes.get(id);
				if (!process) throw new Error(`Unknown process ${id}`);
				return process.exited;
			},
			"host.process.terminate": (input) => {
				const id = string(object(input).id, "id");
				const process = this.processes.get(id);
				if (!process) throw new Error(`Unknown process ${id}`);
				if (process.child.pid) killProcessTree(process.child.pid);
			},
			"host.streams.read": async (input, { signal }) => {
				const args = object(input);
				const id = string(args.id, "id");
				const stream = this.readers.get(id);
				if (!stream) throw new Error(`Unknown readable stream ${id}`);
				const maxBytes = integer(args.maxBytes, "maxBytes", 65536, 8 * 1024 * 1024);
				if (maxBytes === 0) throw new Error("maxBytes must be positive");
				while (true) {
					signal.throwIfAborted();
					const data: unknown = stream.read(Math.min(maxBytes, stream.readableLength) || undefined);
					if (Buffer.isBuffer(data))
						return { data: data.toString(encoding(args.encoding)), bytes: data.length, eof: false };
					if (stream.readableEnded || stream.destroyed) return { data: "", bytes: 0, eof: true };
					await new Promise<void>((ready, reject) => {
						const cleanup = () => {
							stream.off("readable", onReady);
							stream.off("end", onReady);
							stream.off("close", onReady);
							stream.off("error", onError);
							signal.removeEventListener("abort", onAbort);
						};
						const onReady = () => {
							cleanup();
							ready();
						};
						const onError = (error: Error) => {
							cleanup();
							reject(error);
						};
						const onAbort = () => {
							cleanup();
							reject(new Error("Stream read aborted"));
						};
						stream.once("readable", onReady);
						stream.once("end", onReady);
						stream.once("close", onReady);
						stream.once("error", onError);
						signal.addEventListener("abort", onAbort, { once: true });
					});
				}
			},
			"host.streams.write": async (input) => {
				const args = object(input);
				const id = string(args.id, "id");
				const stream = this.writers.get(id);
				if (!stream) throw new Error(`Unknown writable stream ${id}`);
				const data = Buffer.from(string(args.data, "data"), encoding(args.encoding));
				await new Promise<void>((done, reject) => stream.write(data, (error) => (error ? reject(error) : done())));
				return { bytes: data.length };
			},
			"host.streams.close": (input) => {
				const id = string(object(input).id, "id");
				this.writers.get(id)?.end();
				this.readers.get(id)?.destroy();
				this.writers.delete(id);
				this.readers.delete(id);
			},
		};
		return Object.entries(operations).map(([name, execute]) =>
			bindHostContract(name, (args, context) => {
				if (this.closed) throw new Error("Invocation resources are closed");
				context.signal.throwIfAborted();
				return execute(args, context);
			}),
		);
	}

	close(): void {
		this.closed = true;
		for (const { child } of this.processes.values()) if (child.pid) killProcessTree(child.pid);
		for (const reader of this.readers.values()) reader.destroy();
		for (const writer of this.writers.values()) writer.destroy();
		this.processes.clear();
		this.readers.clear();
		this.writers.clear();
	}
}
