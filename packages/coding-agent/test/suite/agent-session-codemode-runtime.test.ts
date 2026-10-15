import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionManager } from "../../src/core/session-manager.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";
import { harnessToolFiles, installHarnessFiles } from "./harness-programs.ts";

const harnesses: Harness[] = [];
const requests = new WeakMap<Harness, TranscriptContext[]>();
async function setup(sessionManager?: SessionManager) {
	const h = await createHarness({
		sessionManager,
		initialActiveToolNames: ["codemode", "legacy"],
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		tools: [
			{
				name: "legacy",
				label: "legacy",
				description: "Never exposed",
				parameters: Type.Object({}),
				execute: async () => {
					throw new Error("Legacy executed");
				},
			},
		],
		extensionFactories: [createCodemodeExtension({ models: false })],
	});
	harnesses.push(h);
	requests.set(h, []);
	await h.session.bindExtensions({});
	return h;
}
function script(code: string) {
	return fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" });
}
async function run(h: Harness, code: string) {
	h.setResponses([
		(context) => {
			requests.get(h)?.push(structuredClone(context));
			return script(code);
		},
	]);
	await h.session.prompt("Run the program");
	const result = getToolResult(h, "codemode");
	expect(result.isError, getMessageText(result)).toBe(false);
	return getMessageText(result);
}
const readSource = `export async function read({path}) { let text="",offset=0; while(true) { const r=await host.fs.read({path,offset,length:1024});text+=r.data;offset+=r.bytes;if(r.eof)break; } return text; }`;
const files = (source = readSource) => harnessToolFiles(source, "files.read", undefined, { type: "string" });
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

describe("editable Harness", () => {
	it("reports the complete schema contract before invalid Harness calls can have effects", async () => {
		const h = await setup();
		const output = await run(
			h,
			`
      const before=await host.harness.inspect();
      const d=await host.harness.begin();
      const failures=await Promise.allSettled([
        host.harness.activate({when:"now"}),
        host.harness.prepare({draft:d}),
        host.harness.write({target:{draft:d.draft},path:"notes/bad",content:42})
      ]);
      const after=await host.harness.inspect();
      return loop.finish({errors:failures.map(r=>r.reason.message),unchanged:before.activeRevision===after.activeRevision,sequence:after.drafts[0].sequence,pending:after.pendingActivation??null});`,
		);
		const result = JSON.parse(output.slice(output.indexOf("Output:\n") + "Output:\n".length));
		expect(result.errors[0].split("Contract:")[0]).toContain("expectedActiveRevision");
		expect(result.errors[0].split("Contract:")[0]).toContain("revision");
		expect(output).toContain("Contract: host.harness.activate");
		expect(output).toContain("Contract: host.harness.prepare");
		expect(output).toContain("Contract: host.harness.write");
		expect(output).toContain('"unchanged":true,"sequence":0,"pending":null');
		const description = getCurrentTools(requests.get(h)![0].messages)[0].description;
		expect(description).toContain("declare const host:");
		expect(description).toContain("drafts: Array<{ baseRevision: string; id: string; sequence: number; }>");
		expect(description).toContain("expectedActiveRevision: string;");
	});
	it.each([true, false])("returns handler data unchanged with outputSchema=%s", async (withSchema) => {
		const h = await setup();
		const values = [
			{ text: "README", size: 6, eof: true },
			[1, false, null],
			"plain",
			42,
			false,
			null,
			{
				content: [{ type: "text", text: "data, not an envelope" }],
				structuredContent: { nested: true },
				details: { ok: true },
				isError: true,
			},
		];
		const definitions = harnessToolFiles(
			"export function read({value}) { return value; }",
			"files.read",
			{ type: "object", properties: { value: {} }, required: ["value"] },
			withSchema ? {} : undefined,
		);
		const output = await run(
			h,
			`${installHarnessFiles(definitions)}
      const tools = await host.tools.list();
      const result = [];
      for (const value of ${JSON.stringify(values)}) result.push(await host.tools.call({name:tools[0].name,args:{value}}));
      return loop.finish(result);`,
		);
		expect(JSON.parse(output.slice(output.indexOf("Output:\n") + "Output:\n".length).trim())).toEqual(values);
		const native = h.eventsOfType("tool_execution_end").filter((e) => e.toolName === "files.read");
		expect(native.map((e) => e.result.structuredContent)).toEqual(values);
		expect(native.every((e) => !e.isError)).toBe(true);
	});
	it("uses draft handles directly and rejects inconsistent base revisions before any mutation", async () => {
		const h = await setup();
		const output = await run(
			h,
			`const draft=await host.harness.begin();
      await host.harness.write({target:draft,path:"notes/draft",content:"original"});
      const wrong={...draft,baseRevision:"r-wrong"};
      const failures=await Promise.allSettled([
        host.harness.read({target:wrong,path:"notes/draft"}),
        host.harness.write({target:wrong,path:"notes/draft",content:"bad"}),
        host.harness.edit({target:wrong,path:"notes/draft",edits:[{oldText:"original",newText:"bad"}]}),
        host.harness.remove({target:wrong,path:"notes/draft"}),
        host.harness.prepare(wrong),host.harness.discard(wrong)
      ]);
      await host.harness.edit({target:draft,path:"notes/draft",edits:[{oldText:"original",newText:"edited"}]});
      const read=await host.harness.read({target:draft,path:"notes/draft"});
      const prepared=await host.harness.prepare(draft);
      await host.harness.remove({target:draft,path:"notes/draft"});
      await host.harness.discard(draft);
      return loop.finish({errors:failures.map(r=>r.reason.message),read:read.text,sequence:prepared.draftSequence,drafts:(await host.harness.inspect()).drafts});`,
		);
		const result = JSON.parse(output.slice(output.indexOf("Output:\n") + 8));
		expect(result.errors).toHaveLength(6);
		expect(result.errors.every((error: string) => error.includes("baseRevision mismatch"))).toBe(true);
		expect(result).toMatchObject({ read: "edited", sequence: 2, drafts: [] });
	});
	it("validates return data and explains unknown names using the active tool directory", async () => {
		const h = await setup();
		const definitions = harnessToolFiles(
			"export function read({value}) { return value; }",
			"files.read",
			{ type: "object", properties: { value: {} } },
			{ type: "string" },
		);
		const output = await run(
			h,
			`${installHarnessFiles(definitions)}
      const attempts = await Promise.allSettled([
        host.tools.call({name:"files.read",args:{value:42}}),
        host.tools.call({name:"fs.stat",args:{path:"README.md"}})
      ]);
      return loop.finish(attempts.map(r => r.reason.message));`,
		);
		expect(output).toContain("files.read: return value does not match outputSchema");
		expect(output).toContain("must be string");
		expect(output).toContain("Available tools: files.read");
		expect(output).toContain("host.fs.stat is a primitive, not a defined tool");
		await run(h, 'return loop.finish("inspect declarations");');
		const description = getCurrentTools(requests.get(h)!.at(-1)!.messages)[0].description;
		expect(description).toContain('await host.tools.call({"name":"files.read","args":{}})');
	});
	it("preserves data through a presentation-only hook and validates explicit hook replacements", async () => {
		const h = await setup();
		const source = `export function read(){return {text:"evidence"};}
      export function observe(e){if(e.toolName==="files.read")return {content:[{type:"text",text:"UI label"}]};}`;
		const definitions = {
			...harnessToolFiles(
				source,
				"files.read",
				{ type: "object" },
				{ type: "object", required: ["text"], properties: { text: { type: "string" } } },
			),
			"hooks/display.yaml": JSON.stringify({
				id: "files.observe",
				event: "tool_result",
				handler: { module: "files", file: "modules/files.mjs", export: "observe" },
			}),
		};
		const output = await run(
			h,
			`${installHarnessFiles(definitions)}
      const d=await host.harness.begin();
      await host.harness.edit({target:{draft:d.draft},path:"agent.yaml",edits:[{oldText:"definitions: []",newText:"definitions: [hooks/display.yaml]"}]});
      const p=await host.harness.prepare({draft:d.draft});
      await host.harness.activate({revision:p.revision,expectedActiveRevision:d.baseRevision,when:"now"});
      return loop.finish(await host.tools.call({name:"files.read",args:{}}));`,
		);
		expect(output).toContain('{"text":"evidence"}');
		expect(h.eventsOfType("tool_execution_end").find((e) => e.toolName === "files.read")?.result.content).toEqual([
			{ type: "text", text: "UI label" },
		]);
		const invalidSource = source.replace(
			'return {content:[{type:"text",text:"UI label"}]}',
			"return {structuredContent:42}",
		);
		const failure = await run(
			h,
			`${installHarnessFiles({ "modules/files.mjs": invalidSource })}
      try {await host.tools.call({name:"files.read",args:{}});} catch(e) {return loop.finish(e.message);}`,
		);
		expect(failure).toContain("return value after hooks does not match outputSchema");
	});
	it("defines and immediately calls a task reader without adding a provider tool", async () => {
		const h = await setup();
		const readme = "# Example\nREADME evidence.\n".repeat(60);
		writeFileSync(join(h.tempDir, "README.md"), readme);
		const output = await run(
			h,
			`${installHarnessFiles(files())} return loop.finish(await host.tools.call({name:"files.read",args:{path:"README.md"}}));`,
		);
		expect(output).toContain(readme.trim());
		expect(getToolResult(h, "codemode").nestedCalls?.calls.some((call) => call.name === "files.read")).toBe(true);
		expect(getCurrentTools(requests.get(h)![0].messages).map((t) => t.name)).toEqual(["codemode"]);
		expect(h.session.getAllTools().some((t) => t.name === "files.read")).toBe(false);
	});
	it("has no legacy task tools or mutable registry APIs", async () => {
		const h = await setup();
		const output = await run(
			h,
			`const errors=await Promise.allSettled([host.tools.call({name:"legacy",args:{}}),host.tools.call({name:"read",args:{}})]); const absent=[]; for(const get of [()=>host.modules,()=>host.tools.register,()=>host.registry]) {try{get();}catch(e){absent.push(e.message);}} return loop.finish({tools:Object.keys(tools),all:ALL_TOOLS,own:await host.tools.list(),absent,errors:errors.map(r=>r.reason.message)});`,
		);
		expect(output).toContain('"tools":[],"all":[],"own":[]');
		expect(output).toContain("host.modules does not exist");
		expect(output).toContain("host.tools.register does not exist");
		expect(output).toContain("Unknown generated tool legacy");
	});
	it("uses native Harness read line semantics and edit diffs without touching the task FS", async () => {
		const h = await setup();
		writeFileSync(join(h.tempDir, "README.md"), "task file");
		const output = await run(
			h,
			`const d=await host.harness.begin(); const target={draft:d.draft}; await host.harness.write({target,path:"notes/example.txt",content:"one\\ntwo\\nthree"}); const read=await host.harness.read({target,path:"notes/example.txt",offset:2,limit:1}); const edit=await host.harness.edit({target,path:"notes/example.txt",edits:[{oldText:"two",newText:"changed"}]}); const errors=await Promise.allSettled([host.harness.read({path:"README.md"}),host.harness.read({path:"../README.md"}),host.harness.write({target:{revision:"active"},path:"x",content:"bad"})]); return loop.finish({read,edit,errors:errors.map(r=>r.reason.message)});`,
		);
		expect(output).toContain("two");
		expect(output).toContain("changed");
		expect(output).toContain('"patch"');
		expect(output).toContain("Harness file not found: README.md");
		expect(output).toContain("Invalid Harness logical path");
		const result = JSON.parse(output.slice(output.indexOf("Output:\n") + "Output:\n".length));
		expect(result.read.text).toBe("two\n\n[1 more lines in file. Use offset=3 to continue.]");
		expect(result.read).not.toHaveProperty("content");
		expect(result.read).not.toHaveProperty("structuredContent");
		expect(result.edit).toMatchObject({
			text: expect.any(String),
			details: { patch: expect.stringContaining("changed") },
			harness: { domain: "harness", path: "notes/example.txt" },
		});
		expect(existsSync(join(h.tempDir, "notes"))).toBe(false);
	});
	it("changes the actual system prompt and Nested tools on the next inference, using candidate tools in preview", async () => {
		const h = await setup();
		const observations: TranscriptContext[] = [];
		h.setResponses([
			(context) => {
				observations.push(structuredClone(context));
				return script(
					`const d=await host.harness.begin(); const target={draft:d.draft}; for(const [path,content] of Object.entries(${JSON.stringify(files())})) await host.harness.write({target,path,content}); await host.harness.write({target,path:"prompts/system.prompt",content:"SYSTEM-EDIT-MARKER"}); await host.harness.write({target,path:"prompts/codemode.prompt",content:"DESCRIPTION-EDIT-MARKER. Call files.read through host.tools.call."}); const p=await host.harness.prepare({draft:d.draft}); if(!p.preview.description.includes("files.read"))throw new Error("stale preview"); const a=await host.harness.activate({revision:p.revision,expectedActiveRevision:d.baseRevision}); const own=await host.tools.list(); return loop.next({status:a.status,own,preview:p.preview.description});`,
				);
			},
			(context) => {
				observations.push(structuredClone(context));
				return script("return loop.finish(await host.tools.list());");
			},
		]);
		await h.session.prompt("Install and inspect");
		expect(observations).toHaveLength(2);
		expect(getMessageText(observations[1].messages[0])).toContain("SYSTEM-EDIT-MARKER");
		const declaration = getCurrentTools(observations[1].messages);
		expect(declaration.map((t) => t.name)).toEqual(["codemode"]);
		expect(declaration[0].description).toContain("DESCRIPTION-EDIT-MARKER");
		expect(declaration[0].description.split("Nested tools")[1]).toContain("files.read");
		expect(getMessageText(h.session.messages.find((m) => m.role === "toolResult"))).toContain(
			'"status":"scheduled","own":[]',
		);
		const trace = h.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && e.customType === "codemode-harness-request-v1")
			.at(-1);
		expect(JSON.stringify(trace)).toContain("rules/codemode.mjs#describe");
		expect(JSON.stringify(trace)).toContain("SYSTEM-EDIT-MARKER");
	});
	it("freezes prepared candidates, rejects invalid references, and checks activation conflicts", async () => {
		const h = await setup();
		const output = await run(
			h,
			`const d=await host.harness.begin(); const target={draft:d.draft}; await host.harness.write({target,path:"prompts/system.prompt",content:"prepared-value"}); const p=await host.harness.prepare({draft:d.draft}); await host.harness.write({target,path:"prompts/system.prompt",content:"later-draft-value"}); await host.harness.activate({revision:p.revision,expectedActiveRevision:d.baseRevision,when:"now"}); let conflict; try{await host.harness.activate({revision:p.revision,expectedActiveRevision:d.baseRevision});}catch(e){conflict=e.message;} await host.harness.write({target,path:"agent.yaml",content:"format: invalid"}); let invalid; try{await host.harness.prepare({draft:d.draft});}catch(e){invalid=e.message;} return loop.finish({text:(await host.harness.read({target:{revision:"active"},path:"prompts/system.prompt"})).text,conflict,invalid,request:(await host.harness.inspect()).requestRevision,base:d.baseRevision});`,
		);
		expect(output).toContain('"text":"prepared-value"');
		expect(output).toContain("activation conflict");
		expect(output).toContain("Unsupported Harness format");
		expect(output).not.toContain('"text":"later-draft-value"');
	});
	it("cancels pending activation and keeps draft edits until explicitly activated", async () => {
		const h = await setup();
		expect(
			await run(
				h,
				`const d=await host.harness.begin(); await host.harness.write({target:{draft:d.draft},path:"prompts/system.prompt",content:"cancelled-marker"}); const p=await host.harness.prepare({draft:d.draft}); await host.harness.activate({revision:p.revision,expectedActiveRevision:d.baseRevision}); let conflict;try{await host.harness.activate({revision:p.revision,expectedActiveRevision:d.baseRevision});}catch(e){conflict=e.message;} await host.harness.cancelActivation({revision:p.revision}); return loop.finish(conflict);`,
			),
		).toContain("pending");
		await run(h, 'return loop.finish("next user prompt");');
		expect(getMessageText(requests.get(h)![1].messages[0])).not.toContain("cancelled-marker");
	});
	it("replaces and revokes file-defined tools while retaining earlier revisions for rollback", async () => {
		const h = await setup();
		const source = (value: string) => `export function read(){return ${JSON.stringify(value)};}`;
		expect(
			await run(
				h,
				`${installHarnessFiles(files(source("first")))} store("old",(await host.harness.inspect()).activeRevision); return loop.finish(await host.tools.call({name:"files.read",args:{path:"x"}}));`,
			),
		).toContain("first");
		expect(
			await run(
				h,
				`${installHarnessFiles(files(source("second")))} return loop.finish(await host.tools.call({name:"files.read",args:{path:"x"}}));`,
			),
		).toContain("second");
		expect(
			await run(
				h,
				`const d=await host.harness.begin(); await host.harness.remove({target:{draft:d.draft},path:"tools/files.read.yaml"}); const p=await host.harness.prepare({draft:d.draft}); await host.harness.activate({revision:p.revision,expectedActiveRevision:d.baseRevision,when:"now"}); const revoked=await host.tools.list(); await host.harness.activate({revision:load("old"),expectedActiveRevision:p.revision,when:"now"}); return loop.finish({revoked,restored:await host.tools.call({name:"files.read",args:{path:"x"}})});`,
			),
		).toContain('"revoked":[],"restored":"first"');
	});
	it("restores tools, drafts and state after resume without replaying task effects", async () => {
		const h = await setup();
		await run(
			h,
			`${installHarnessFiles(files())} await host.state.set({key:"saved",value:42}); const d=await host.harness.begin(); await host.harness.write({target:{draft:d.draft},path:"notes/saved",content:"unfinished"}); store("draft",d.draft); return loop.finish("installed");`,
		);
		const resumed = await setup(h.sessionManager);
		writeFileSync(join(resumed.tempDir, "README.md"), "resumed README");
		expect(
			await run(
				resumed,
				`return loop.finish({text:await host.tools.call({name:"files.read",args:{path:"README.md"}}),saved:await host.state.get({key:"saved"}),draft:(await host.harness.read({target:{draft:load("draft")},path:"notes/saved"})).text});`,
			),
		).toContain('"text":"resumed README","saved":42,"draft":"unfinished"');
	});
	it("restores definitions and state independently on each session branch", async () => {
		const h = await setup();
		await run(h, 'return loop.finish("before");');
		const before = h.sessionManager.getLeafId()!;
		await run(
			h,
			`${installHarnessFiles(files())} await host.state.set({key:"branch",value:1}); return loop.finish("installed");`,
		);
		const installed = h.sessionManager.getLeafId()!;
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
	it("keeps old code, nested resolution and result hooks pinned while new calls see a replacement", async () => {
		const h = await setup();
		const source = `export async function read(){await host.state.set({key:"started",value:true}); while(!await host.state.get({key:"release"}))await host.clock.sleep({ms:5}); const value=await host.tools.call({name:"files.inner",args:{}});return value;} export function inner(){return "old";} export function observe(e){if(e.toolName==="files.read")return {structuredContent:e.structuredContent+"-oldhook"};}`;
		const initial = {
			...files(source),
			...harnessToolFiles(source, "files.inner", { type: "object" }, { type: "string" }),
			"hooks/observe.yaml": JSON.stringify({
				id: "files.observe",
				event: "tool_result",
				handler: { module: "files", file: "modules/files.mjs", export: "observe" },
			}),
		};
		const output = await run(
			h,
			`const d=await host.harness.begin();const target={draft:d.draft};for(const [path,content]of Object.entries(${JSON.stringify(initial)}))await host.harness.write({target,path,content});await host.harness.edit({target,path:"agent.yaml",edits:[{oldText:"definitions: []",newText:"definitions: [hooks/observe.yaml]"}]});const p=await host.harness.prepare({draft:d.draft});await host.harness.activate({revision:p.revision,expectedActiveRevision:d.baseRevision,when:"now"});const pending=host.tools.call({name:"files.read",args:{path:"x"}});while(!(await host.calls.list()).length)await host.clock.sleep({ms:5});const next=await host.harness.begin();await host.harness.write({target:{draft:next.draft},path:"modules/files.mjs",content:'export function read(){return "new";} export function inner(){return "new";} export function observe(){} export async function release(){await host.state.set({key:"release",value:true});return null;}'});await host.harness.write({target:{draft:next.draft},path:"tools/release.yaml",content:JSON.stringify({name:"files.release",description:"release",parameters:{type:"object"},handler:{module:"files",file:"modules/files.mjs",export:"release"}})});const v=await host.harness.prepare({draft:next.draft});await host.harness.activate({revision:v.revision,expectedActiveRevision:next.baseRevision,when:"now"});const current=await host.tools.call({name:"files.read",args:{path:"x"}});await host.tools.call({name:"files.release",args:{}});return loop.finish({old:await pending,current});`,
		);
		expect(output).toContain('"old":"old-oldhook","current":"new"');
	});
	it("validates arguments and rejects module initialization effects before publishing", async () => {
		const h = await setup();
		const output = await run(
			h,
			`${installHarnessFiles(files())} const d=await host.harness.begin();await host.harness.write({target:{draft:d.draft},path:"modules/files.mjs",content:'await host.fs.write({path:"bad.txt",data:"bad"}); export function read(){}'});const failures=await Promise.allSettled([host.tools.call({name:"files.read",args:{}}),host.harness.prepare({draft:d.draft})]); return loop.finish(failures.map(r=>r.reason.message));`,
		);
		expect(output).toContain("path");
		expect(output).toContain("host");
		expect(existsSync(join(h.tempDir, "bad.txt"))).toBe(false);
	});
	it("retains activated definitions after a later controller failure", async () => {
		const h = await setup();
		h.setResponses([
			script(`${installHarnessFiles(files())} throw new Error("after activation");`),
			script("return loop.finish(await host.tools.list());"),
		]);
		await h.session.prompt("Install and recover");
		expect(getMessageText(getToolResult(h, "codemode"))).toContain("files.read");
	});
	it("cancels a running module and releases its invocation", async () => {
		const h = await setup();
		const source = "export async function read(){await host.clock.sleep({ms:60000});return null;}";
		const output = await run(
			h,
			`${installHarnessFiles(files(source))} const pending=host.tools.call({name:"files.read",args:{path:"x"}}).catch(e=>e.message);let calls=[];while(!calls.length){calls=await host.calls.list();await host.clock.sleep({ms:5});}await host.calls.cancel({id:calls[0].id});return loop.finish({error:await pending,active:await host.calls.list()});`,
		);
		expect(output).toContain("abort");
		expect(output).toContain('"active":[]');
	});
});
