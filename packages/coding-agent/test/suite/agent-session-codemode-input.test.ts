import { getCurrentTools } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";
import { harnessToolFiles } from "./harness-programs.ts";

const harnesses: Harness[] = [];
async function setup() {
	const h = await createHarness({
		initialActiveToolNames: ["codemode"],
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		extensionFactories: [createCodemodeExtension({ models: false })],
	});
	harnesses.push(h);
	return h;
}
const call = (args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage([fauxToolCall("codemode", args)], { stopReason: "toolUse" });
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

describe("codemode code and data input", () => {
	it.each([undefined, null, "fixture.run", []])(
		"locates a malformed definition handler and preserves its draft for repair: %j",
		async (handler) => {
			const h = await setup();
			const definition = {
				name: "fixture.run",
				description: "Return a value",
				parameters: { type: "object" },
				handler,
			};
			h.setResponses([
				call({
					data: { definition: JSON.stringify(definition) },
					code: `const d=await host.harness.begin();await host.state.set({key:"draft",value:d});
          await host.harness.write({target:d,path:"modules/fixture.mjs",content:'export function run(){return "repaired";}'});
          await host.harness.write({target:d,path:"tools/fixture.yaml",content:data.definition});
          await host.harness.prepare(d);return loop.next();`,
				}),
				(context) => {
					const result = getToolResult(h, "codemode");
					expect(result.isError).toBe(true);
					const diagnostic = getMessageText(result);
					expect(diagnostic).toContain(
						"tools/fixture.yaml.handler: expected an object with fields module, file, export",
					);
					expect(context.messages.some((message) => getMessageText(message).includes(diagnostic))).toBe(true);
					return call({
						code: `const d=await host.state.get({key:"draft"});
            const definition=JSON.parse((await host.harness.read({target:d,path:"tools/fixture.yaml"})).text);
            definition.handler={module:"fixture",file:"modules/fixture.mjs",export:"run"};
            await host.harness.write({target:d,path:"tools/fixture.yaml",content:JSON.stringify(definition)});
            const p=await host.harness.prepare(d);
            await host.harness.activate({revision:p.revision,expectedActiveRevision:p.baseRevision,when:"now"});
            return loop.finish(await host.tools.call({name:"fixture.run",args:{}}));`,
					});
				},
			]);
			await h.session.prompt("Repair the definition reported by prepare.");
			const result = getToolResult(h, "codemode");
			expect(result.isError, getMessageText(result)).toBe(false);
			expect(getMessageText(result)).toContain("repaired");
		},
	);

	it("rejects encoded data before effects and sends a concise diagnostic to the next inference", async () => {
		const h = await setup();
		const source = 'const value = "literal\\n";\n'.repeat(1000);
		h.setResponses([
			call({
				data: JSON.stringify({ source }),
				code: 'await host.state.set({key:"unwanted",value:true});return loop.next();',
			}),
			(context) => {
				const result = getToolResult(h, "codemode");
				expect(result.isError).toBe(true);
				const diagnostic = getMessageText(result);
				expect(diagnostic).toContain("data: must be object");
				expect(diagnostic).toContain("data: string");
				expect(diagnostic.length).toBeLessThan(600);
				expect(diagnostic).not.toContain("literal");
				expect(context.messages.some((message) => getMessageText(message).includes(diagnostic))).toBe(true);
				return call({ code: 'return loop.finish((await host.state.get({key:"unwanted"}))??"no effects");' });
			},
		]);
		await h.session.prompt("Validate input data.");
		expect(getMessageText(getToolResult(h, "codemode"))).toContain("no effects");
	});

	it.each(
		["function", "custom"].flatMap((protocol) =>
			["array", "object", "json-array", "json-object"].map((edits) => ({ protocol, edits })),
		),
	)("preserves literal text through $protocol input and $edits edit normalization", async ({ protocol, edits }) => {
		const h = await setup();
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Prompt content is literal data.
		const oldText = '"quoted" `code` ${literal} \\n\r\nold';
		const newText = oldText.replace("old", "new");
		const replacement = { oldText, newText };
		const editInput =
			edits === "array"
				? [replacement]
				: edits === "object"
					? replacement
					: JSON.stringify(edits === "json-array" ? [replacement] : replacement);
		const input = {
			data: { oldText, newText, edits: editInput },
			code: `const d=await host.harness.begin();
          await host.harness.write({target:d,path:"prompts/literal.prompt",content:data.oldText});
          const before=JSON.stringify(data.edits);
          const edited=await host.harness.edit({target:d,path:"prompts/literal.prompt",edits:data.edits});
          if(JSON.stringify(data.edits)!==before) throw new Error("Input was mutated");
          observe(edited,{view:"harness.edit"});
          const result=await host.harness.read({target:d,path:"prompts/literal.prompt"});
          store("read",result.text);observe(result,{view:"pi.read"});
          const p=await host.harness.prepare(d);observe(p,{view:"harness.prepare"});
          observe(await host.harness.activate({revision:p.revision,expectedActiveRevision:p.baseRevision}),{view:"harness.status"});
          return loop.next();`,
		};
		h.setResponses([
			call(protocol === "custom" ? { code: JSON.stringify(input) } : input),
			(context) => {
				const result = getToolResult(h, "codemode");
				expect(result.isError, getMessageText(result)).toBe(false);
				const text = getMessageText(result);
				expect(text).toContain(newText.split("\r\n")[0]);
				expect(text).not.toContain(JSON.stringify(newText));
				expect(text).toContain("Prepared revision:");
				expect(text).toContain("status: scheduled");
				expect(getMessageText(context.messages.at(-1))).toContain(text);
				return call({ code: "return loop.finish(load('read'));" });
			},
		]);
		await h.session.prompt("Edit and observe literal text.");
		// Native Pi edit preserves the document's CRLF convention.
		expect(getToolResult(h, "codemode").content[1]).toEqual({ type: "text", text: newText });
	});

	it.each(["function", "custom"])("writes source and finishes with literal data using %s input", async (protocol) => {
		const h = await setup();
		const answer =
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Final text must not be evaluated as JavaScript.
			'# 中文\n"quotes", \'single quotes\', `backticks`, ${notAnExpression} and \\slashes\n```js\nthrow new Error("text only");\n```';
		const files = harnessToolFiles(`export function run(){return ${JSON.stringify(answer)};}`, "fixture.run", {
			type: "object",
		});
		h.setResponses([
			(context) => {
				const tools = getCurrentTools(context.messages);
				expect(tools.map((tool) => tool.name)).toEqual(["codemode"]);
				expect(tools[0].constrainedSampling).toMatchObject({
					type: "grammar",
					inputProperty: "code",
					allowJsonInput: true,
				});
				return call({
					data: { files },
					code: `const d=await host.harness.begin();
            for(const [path,content] of Object.entries(data.files)) await host.harness.write({target:{draft:d.draft},path,content});
            const p=await host.harness.prepare({draft:d.draft});
            await host.harness.activate({revision:p.revision,expectedActiveRevision:d.baseRevision});
            return loop.next(p.preview.catalog);`,
				});
			},
			call({ code: 'return loop.next(await host.tools.call({name:"fixture.run",args:{}}));' }),
			(context) => {
				expect(getMessageText(context.messages.at(-1))).toContain(answer);
				return call(protocol === "custom" ? { code: JSON.stringify({ finish: answer }) } : { finish: answer });
			},
			fauxAssistantMessage("must not run"),
		]);
		await h.session.prompt("Define, observe, then explain.");
		expect(h.faux.state.callCount).toBe(3);
		expect(getToolResult(h, "codemode")).toMatchObject({
			isError: false,
			details: { loopControl: "finish", calls: [] },
		});
		expect(getToolResult(h, "codemode").content.slice(1)).toEqual([{ type: "text", text: answer }]);
		expect(h.eventsOfType("tool_execution_end").at(-1)?.result.terminate).toBe(true);
	});

	it("keeps strict edit checks after container normalization and never guesses text escapes", async () => {
		const h = await setup();
		h.setResponses([
			call({
				code: `const d=await host.harness.begin();
          const path="prompts/check.prompt";
          await host.harness.write({target:d,path,content:"alpha\\nbeta\\nalpha"});
          const cases=[
            {target:{revision:d.baseRevision},edits:{oldText:"beta",newText:"ok"}},
            {target:{...d,baseRevision:"stale"},edits:JSON.stringify({oldText:"beta",newText:"ok"})},
            {target:d,edits:"not JSON"},
            {target:d,edits:JSON.stringify({oldText:42,newText:"ok"})},
            {target:d,edits:{oldText:"alpha",newText:"ok"}},
            {target:d,edits:[{oldText:"beta",newText:"ok"},{oldText:"beta\\nalpha",newText:"ok"}]},
            {target:d,edits:{oldText:"alpha\\\\nbeta",newText:"ok"}}
          ];
          for(const args of cases) {
            let rejected=false;
            try {await host.harness.edit({path,...args});} catch(error){rejected=true;observe(error.message);}
            if(!rejected)throw new Error("Invalid edit accepted");
            const r=await host.harness.read({target:d,path});
            if(r.text!=="alpha\\nbeta\\nalpha"||r.harness.draftSequence!==1)throw new Error("Invalid edit changed draft");
          }
          return loop.finish("checks preserved");`,
			}),
		]);
		await h.session.prompt("Validate edit normalization boundaries.");
		const result = getToolResult(h, "codemode");
		expect(result.isError, getMessageText(result)).toBe(false);
		expect(getMessageText(result)).toContain("checks preserved");
	});

	it("keeps input data local to one invocation and permits ordinary local shadowing", async () => {
		const h = await setup();
		h.setResponses([
			call({ data: { value: "provided" }, code: "const data=globalThis.data; return loop.next(data.value);" }),
			(context) => {
				expect(getMessageText(context.messages.at(-1))).toContain("provided");
				return call({ code: "return loop.finish(typeof data);" });
			},
		]);
		await h.session.prompt("Use input data once.");
		expect(getToolResult(h, "codemode").content.slice(1)).toEqual([{ type: "text", text: "undefined" }]);
	});

	it.each<Parameters<typeof fauxToolCall>[1]>([
		{},
		{ code: 'await host.state.set({key:"effect",value:true});return loop.next();', finish: "ambiguous" },
		{ finish: "ambiguous", data: { value: "unused" } },
	])("rejects an ambiguous input before effects: %j", async (input) => {
		const h = await setup();
		h.setResponses([
			call(input),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("Codemode");
				return call({ code: 'return loop.finish((await host.state.get({key:"effect"}))??"no effects");' });
			},
		]);
		await h.session.prompt("Validate the request.");
		const results = h.eventsOfType("tool_execution_end");
		expect(results[0].isError).toBe(true);
		expect(getMessageText(results[0].result)).toMatch(/exactly one|data is input to code/);
		expect(getToolResult(h, "codemode").content.slice(1)).toEqual([{ type: "text", text: "no effects" }]);
	});
});
