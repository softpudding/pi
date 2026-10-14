import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionManager } from "../../src/core/session-manager.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const requests = new WeakMap<Harness, ReturnType<typeof getCurrentTools>[]>();
async function setup(sessionManager?: SessionManager) {
	const harness = await createHarness({
		sessionManager,
		initialActiveToolNames: ["codemode", "legacy"],
		tools: [
			{
				name: "legacy",
				label: "legacy",
				description: "Legacy tool that must not be accessible",
				parameters: Type.Object({}),
				execute: async () => {
					throw new Error("Legacy tool executed");
				},
			},
		],
		extensionFactories: [createCodemodeExtension({ models: false })],
	});
	harnesses.push(harness);
	requests.set(harness, []);
	await harness.session.bindExtensions({});
	return harness;
}
async function run(harness: Harness, code: string) {
	harness.setResponses([
		(context) => {
			requests.get(harness)?.push(structuredClone(getCurrentTools(context.messages)));
			return fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" });
		},
	]);
	await harness.session.prompt("Run the program");
	const result = getToolResult(harness, "codemode");
	expect(result.isError, getMessageText(result)).toBe(false);
	return getMessageText(result);
}
function definition(source: string, exported = "read", name = "files.read") {
	return `const m = await host.modules.put({id: "files", source: ${JSON.stringify(source)}});
await host.tools.register({name: ${JSON.stringify(name)}, description: "Read a file", parameters: {type: "object", properties: {path: {type: "string"}}, required: ["path"]}, outputSchema: {type: "string"}, handler: {module: m.id, revision: m.revision, export: ${JSON.stringify(exported)}}});`;
}
const readSource = `export async function read({path}) { let text = "", offset = 0; while (true) { const r = await host.fs.read({path, offset, length: 1024}); text += r.data; offset += r.bytes; if (r.eof) break; } return {content: [{type: "text", text}], structuredContent: text, details: {}}; }`;

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("model-authored codemode runtime", () => {
	it("registers and immediately invokes a file reader using only primitives", async () => {
		const h = await setup();
		const readme = "# Example\nA project whose purpose comes from its README.\n".repeat(60);
		writeFileSync(join(h.tempDir, "README.md"), readme);
		const output = await run(
			h,
			`${definition(readSource)} return loop.finish(await host.tools.call({name: "files.read", args: {path: "README.md"}}));`,
		);
		expect(output).toContain(readme.trim());
		expect(getToolResult(h, "codemode").nestedCalls?.calls.some((call) => call.name === "files.read")).toBe(true);
		expect(requests.get(h)).toHaveLength(1);
	});
	it("excludes legacy tools from declarations, discovery, and direct or nested calls", async () => {
		const h = await setup();
		const output = await run(
			h,
			`const result = await Promise.allSettled([host.tools.call({name: "legacy", args: {}}), host.tools.call({name: "read", args: {path: "README.md"}})]); return loop.finish({tools: Object.keys(tools), all: ALL_TOOLS, own: await host.tools.list(), errors: result.map(r => r.reason.message)});`,
		);
		expect(output).toContain('"tools":[],"all":[],"own":[]');
		expect(output).toContain("Unknown generated tool legacy");
		expect(requests.get(h)?.[0].map((tool) => tool.name)).toEqual(["codemode"]);
	});
	it("replaces, unregisters, and removes definitions without changing the declaration prefix", async () => {
		const h = await setup();
		const source = (value: string) =>
			`export async function read() { return {content: [{type: "text", text: ${JSON.stringify(value)}}], structuredContent: ${JSON.stringify(value)}, details: {}}; }`;
		await run(
			h,
			`${definition(source("first"))} return loop.finish(await host.tools.call({name:"files.read",args:{path:"x"}}));`,
		);
		const firstTools = requests.get(h)?.[0];
		expect(
			await run(
				h,
				`${definition(source("second"))} return loop.finish(await host.tools.call({name:"files.read",args:{path:"x"}}));`,
			),
		).toContain("second");
		const output = await run(
			h,
			`await host.tools.unregister({name:"files.read"}); let error; try { await host.tools.call({name:"files.read",args:{path:"x"}}); } catch(e) { error=e.message; } await host.modules.remove({id:"files"}); return loop.finish({error,tools:await host.tools.list(),modules:await host.modules.list()});`,
		);
		expect(output).toContain("Unknown generated tool");
		expect(output).toContain('"tools":[],"modules":[]');
		for (const request of requests.get(h) ?? []) expect(request).toEqual(firstTools);
	});
	it("keeps committed definitions after a later failure and rejects invalid batches atomically", async () => {
		const h = await setup();
		const output = await run(
			h,
			`${definition(readSource)} let error; try { await host.registry.apply({removeTools:["files.read"], tools:[{name:"files.bad",description:"bad",parameters:{type:"object"},handler:{module:m.id,revision:m.revision,export:"missing"}}]}); } catch(e) {error=e.message;} return loop.finish({error,tools:await host.tools.list()});`,
		);
		expect(output).toContain("callable export");
		expect(output).toContain("files.read");
		expect(output).not.toContain('"name":"files.bad"');
	});
	it("runs and unsubscribes model-authored result hooks with persistent module state", async () => {
		const h = await setup();
		writeFileSync(join(h.tempDir, "README.md"), "content");
		const source = `${readSource}\nexport async function observe(event) { if (event.toolName !== "files.read") return; const n = (await host.state.get({key:"count"})) ?? 0; await host.state.set({key:"count",value:n+1}); return {content:[{type:"text",text:"hooked"}],structuredContent:"hooked"}; }\nexport async function count() { const text = String(await host.state.get({key:"count"})); return {content:[{type:"text",text}],structuredContent:text,details:{}}; }`;
		const output = await run(
			h,
			`${definition(source)} await host.hooks.register({id:"files.observe",event:"tool_result",handler:{module:m.id,revision:m.revision,export:"observe"}}); const first=await host.tools.call({name:"files.read",args:{path:"README.md"}}); await host.hooks.unregister({id:"files.observe"}); const second=await host.tools.call({name:"files.read",args:{path:"README.md"}}); await host.tools.register({name:"files.count",description:"Count",parameters:{type:"object"},outputSchema:{type:"string"},handler:{module:m.id,revision:m.revision,export:"count"}}); return loop.finish({first,second,count:await host.tools.call({name:"files.count",args:{}})});`,
		);
		expect(output).toContain('"first":"hooked","second":"content","count":"1"');
	});
	it("restores source, bindings, and state on resume without replaying file writes", async () => {
		const h = await setup();
		await run(
			h,
			`${definition(readSource)} await host.state.set({key:"saved",value:42}); return loop.finish("installed");`,
		);
		const resumed = await setup(h.sessionManager);
		writeFileSync(join(resumed.tempDir, "README.md"), "resumed README");
		const output = await run(
			resumed,
			`return loop.finish({text:await host.tools.call({name:"files.read",args:{path:"README.md"}}),saved:await host.state.get({key:"saved"})});`,
		);
		expect(output).toContain('"text":"resumed README","saved":42');
	});
	it("validates arguments and prevents module-initialization side effects", async () => {
		const h = await setup();
		const output = await run(
			h,
			`${definition(readSource)} const results = await Promise.allSettled([host.tools.call({name:"files.read",args:{}}),host.modules.put({id:"bad",source:'await host.fs.write({path:"bad.txt",data:"bad"}); export function run() {}'})]); return loop.finish(results.map(r=>r.reason.message));`,
		);
		expect(output).toContain("path");
		expect(output).toContain("host");
	});
	it("creates a shell operation from process and streaming primitives", async () => {
		const h = await setup();
		const output = await run(
			h,
			`const p=await host.process.spawn({program:${JSON.stringify(process.execPath)},args:["-e","process.stdout.write('out');process.stderr.write('err')"]}); await host.streams.close({id:p.stdin}); async function drain(id) { let text=""; while(true) { const r=await host.streams.read({id});text+=r.data;if(r.eof)return text; } } const [stdout,stderr]=await Promise.all([drain(p.stdout),drain(p.stderr)]); return loop.finish({stdout,stderr,status:await host.process.wait({id:p.id})});`,
		);
		expect(output).toContain('"stdout":"out","stderr":"err","status":{"exitCode":0,"signal":null}');
	});
	it("retains a committed registration after a script throws", async () => {
		const h = await setup();
		h.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("codemode", { code: `${definition(readSource)} throw new Error("after registration");` })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("codemode", { code: "return loop.finish(await host.tools.list());" })], {
				stopReason: "toolUse",
			}),
		]);
		await h.session.prompt("Install and recover");
		const results = h.session.messages.filter((message) => message.role === "toolResult");
		expect(results[0].isError).toBe(true);
		expect(getMessageText(results[1])).toContain("files.read");
	});
	it("restores the registry and state when changing branches", async () => {
		const h = await setup();
		await run(h, 'return loop.finish("before install");');
		const before = h.sessionManager.getLeafId();
		if (!before) throw new Error("Missing branch leaf");
		await run(
			h,
			`${definition(readSource)} await host.state.set({key:"branch",value:1}); return loop.finish("installed");`,
		);
		const installed = h.sessionManager.getLeafId();
		if (!installed) throw new Error("Missing installed leaf");
		await h.session.navigateTree(before);
		expect(
			await run(
				h,
				'return loop.finish({tools:await host.tools.list(),state:await host.state.get({key:"branch"})});',
			),
		).toContain('"tools":[]');
		await h.session.navigateTree(installed);
		expect(
			await run(
				h,
				'return loop.finish({tools:await host.tools.list(),state:await host.state.get({key:"branch"})});',
			),
		).toContain('"state":1');
	});
	it("keeps a running revision alive after replacement and module removal", async () => {
		const h = await setup();
		const source =
			'export async function read() { await host.clock.sleep({ms:400}); return {content:[{type:"text",text:"old"}],structuredContent:"old",details:{}}; }';
		const replacement =
			'export function read() {return {content:[{type:"text",text:"new"}],structuredContent:"new",details:{}};}';
		const output = await run(
			h,
			`${definition(source)}
const pending=host.tools.call({name:"files.read",args:{path:"x"}});
while((await host.calls.list()).length===0) await host.clock.sleep({ms:5});
{${definition(replacement)}}
const next=await host.tools.call({name:"files.read",args:{path:"x"}});
await host.modules.remove({id:"files"});
return loop.finish({previous:await pending,next,tools:await host.tools.list()});`,
		);
		expect(output).toContain('"previous":"old","next":"new","tools":[]');
	});
	it("cancels a running module and releases its invocation", async () => {
		const h = await setup();
		const source =
			"export async function read() { await host.clock.sleep({ms:60000}); return {content:[],details:{}}; }";
		const output = await run(
			h,
			`${definition(source)}
const pending=host.tools.call({name:"files.read",args:{path:"x"}}).catch(e=>e.message);
let calls=[]; while(calls.length===0) {calls=await host.calls.list();await host.clock.sleep({ms:5});}
await host.calls.cancel({id:calls[0].id});
return loop.finish({error:await pending,active:await host.calls.list()});`,
		);
		expect(output).toContain("abort");
		expect(output).toContain('"active":[]');
	});
});
