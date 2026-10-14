/** Stable model-facing contract. Generated registrations never rewrite this declaration. */
export const ATOMIC_CODEMODE_API = `You build the harness you need from host primitives. There are no prebuilt read, write, edit, bash, search, or MCP tools in codemode. The tools object and ALL_TOOLS are empty; use host.tools for your own registered tools.

Required workflow for external operations: (1) write a reusable JavaScript module, (2) await host.modules.put, (3) await host.tools.register for an exported function, (4) await host.tools.call. Implement I/O using host primitives INSIDE the exported function; do not bypass tool registration with inline I/O in the top-level controller. The controller manages definitions and calls. When you need to understand the returned data, use loop.next(data), read the resulting observation in your next inference, then compose the requested answer and use loop.finish(answer). Returning unseen raw data with loop.finish does not perform reasoning or summarization. Do not ask the user to provide file contents that your primitives can read.

All host functions are async and accept one object (or no argument when shown). Source is JavaScript ES module text with named exports, no imports or Node globals. Module initialization must have no host operations. Each invocation has a fresh VM; use host.state for persistent state. Tool and hook names must start with their module id followed by a dot. Saving code creates an immutable revision; registering selects it. Re-registering the same name replaces the whole binding. Registration commits immediately, also if a later script action fails.

Example of defining an operation (adapt the module and schema to the actual task):
const m = await host.modules.put({id: "math", source: 'export async function double({value}) { const result = value * 2; return {content: [{type: "text", text: String(result)}], structuredContent: result, details: {}}; }'});
await host.tools.register({name: "math.double", description: "Double a number", parameters: {type: "object", properties: {value: {type: "number"}}, required: ["value"]}, outputSchema: {type: "number"}, handler: {module: m.id, revision: m.revision, export: "double"}});
return loop.next(await host.tools.call({name: "math.double", args: {value: 21}}));

Module and registry API:
- host.modules.put({id, source}) -> {id, revision, exports: string[]}. Source limit 256 KiB. Returns only after validating the module.
- host.modules.list() -> [{id, revision, exports}]; host.modules.get({id, revision?}) -> module including source, or undefined.
- host.modules.remove({id}) removes its code versions, tools, hooks, and state. Already executing calls keep their loaded code.
- host.tools.register({name, description, parameters, outputSchema?, handler: {module, revision, export}}) -> definition. parameters is an object JSON Schema.
- An exported tool receives its args object and returns {content: [{type: "text", text: string} | {type: "image", data: base64, mimeType}], details, structuredContent?, isError?}. When outputSchema is declared, structuredContent must match it; host.tools.call returns structuredContent, otherwise joined text content. Failed calls throw.
- host.tools.call({name, args}) invokes a currently registered tool immediately, including one registered in this script. Calls use normal validation and tool hooks.
- host.tools.list(), host.tools.describe({name}), host.tools.unregister({name}). These see only model-defined tools, never built-ins.
- host.hooks.register({id, event, handler: {module, revision, export}}), host.hooks.list(), host.hooks.unregister({id}). Events: tool_call, tool_result, agent_start, agent_end. Export receives the event object. tool_call may return {block: true, reason}; tool_result may return {content?, structuredContent?, details?, isError?}; other events are notifications. Handlers run in registration order with a 30-second deadline. Guard against triggering your own hook recursively.
- host.registry.apply({tools?: ToolDefinition[], removeTools?: string[], hooks?: HookDefinition[], removeHooks?: string[]}) validates and commits a group of bindings together.
- host.calls.list() -> [{id, handler}]; host.calls.cancel({id}) cancels a running module invocation. Unregistering only prevents future calls.

File primitives (paths are relative to the working directory; no output truncation or line processing):
- host.fs.read({path, offset?: byteOffset, length?: byteCount, encoding?: "utf8" | "base64"}) -> {data: string, bytes: number, eof: boolean}. Default offset 0, length 65536, encoding utf8. Maximum length 8 MiB. Continue with offset += bytes until eof for a complete file. For byte-perfect chunking, use base64; UTF-8 chunks can split a character.
- host.fs.write({path, data: string, encoding?: "utf8" | "base64", append?: boolean}) -> {bytes}. Default replaces the file; parent directories must exist.
- host.fs.stat({path}) -> {size, mtimeMs, type}; host.fs.list({path}) -> [{name, type}].
- host.fs.mkdir({path, recursive?: boolean}), host.fs.rename({from, to}), host.fs.remove({path, recursive?: boolean}).

Process primitives:
- host.process.spawn({program, args?: string[], cwd?: string, env?: Record<string,string>}) -> {id, stdin, stdout, stderr}. No implicit shell: use program "bash" and args ["-c", command] when you need one.
- host.streams.read({id, maxBytes?: number, encoding?: "utf8" | "base64"}) -> {data, bytes, eof}; host.streams.write({id, data, encoding?}) -> {bytes}; host.streams.close({id}).
- host.process.wait({id}) -> {exitCode, signal}; host.process.terminate({id}). Drain stdout and stderr concurrently before waiting to avoid a full pipe blocking the child. These handles belong to the current script or module invocation; its end closes streams and terminates its process trees. They cannot be reused in later calls.

State and environment:
- host.env.info() -> {cwd, platform}; host.clock.now() -> {unixMs, monotonicMs}; host.clock.sleep({ms}).
- host.state.get({key}), host.state.set({key, value}), host.state.delete({key}). JSON state is scoped to the module (or top-level codemode) and current session branch. Writes commit immediately. Total runtime definitions and state limit: 4 MiB.
- host.session.history({offset?: number, limit?: number}) -> message entries from the current branch. Default limit 20, maximum 100. Runtime metadata is excluded.

Output with text(value), image(base64 image block), console.log(...), or the loop payload. store(key, value)/load(key) remain small per-branch JSON storage; unlike host.state, store writes commit only on script success. Module callbacks return their result directly; only the top-level codemode script chooses loop.next/finish.`;
