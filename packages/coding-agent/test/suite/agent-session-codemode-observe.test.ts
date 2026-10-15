import { getCurrentTools } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";
import { harnessToolFiles, installHarnessFiles } from "./harness-programs.ts";

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

describe("editable observation presentation", () => {
	it("renders only the selected body without changing the complete tool value", async () => {
		const h = await setup();
		const source = 'export function run() {\n\tconst literal = "\\n";\n\treturn "中文 quotes \\" and ```";\n}\n';
		const value = { text: source, meta: { path: "module.mjs", eof: true }, empty: {}, list: [null, "false", false] };
		h.setResponses([
			call({
				code: `${installHarnessFiles(harnessToolFiles("export function run(args) { return args; }", "fixture.run", { type: "object" }))}
          const result=await host.tools.call({name:"fixture.run",args:data});
          store("result",result);
          observe(result,{view:"pi.read"});
          return loop.next();`,
				data: value,
			}),
			(context) => {
				const content = getMessageText(context.messages.at(-1));
				expect(content).toContain(source);
				expect(content).not.toContain(JSON.stringify(source));
				expect(getToolResult(h, "codemode").content[1]).toEqual({ type: "text", text: source });
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["codemode"]);
				return call({ code: "return loop.finish(load('result'));" });
			},
		]);
		await h.session.prompt("Observe structured tool data.");
		const last = getToolResult(h, "codemode").content[1];
		if (last.type !== "text") throw new Error("Expected text output");
		expect(JSON.parse(last.text)).toEqual(value);
	});

	it("lets the model edit the formatter, applying the request revision even after immediate activation", async () => {
		const h = await setup();
		const source = 'const message = "one";\nconst next = "two";\n';
		const custom = `export function render(value) { return "CUSTOM VIEW\\n" + value.source; }`;
		h.setResponses([
			call({
				data: { custom, source },
				code: `const before=await host.harness.read({path:"policies/views.yaml"});
          store("original",before.text);
          const draft=await host.harness.begin();
          await host.harness.write({target:{draft:draft.draft},path:"rules/custom.mjs",content:data.custom});
          await host.harness.write({target:{draft:draft.draft},path:"policies/views.yaml",content:before.text.replace("pi.read: rules/views.mjs#read", "pi.read: rules/custom.mjs#render") + "fixture.source: rules/custom.mjs#render\\n"});
          const prepared=await host.harness.prepare({draft:draft.draft});
          await host.harness.activate({expectedActiveRevision:draft.baseRevision,revision:prepared.revision,when:"now"});
          observe({text:data.source,source:data.source},{view:"pi.read"});return loop.next();`,
			}),
			(context) => {
				expect(getMessageText(context.messages.at(-1))).toContain(source);
				expect(getMessageText(context.messages.at(-1))).not.toContain("CUSTOM VIEW");
				return call({ data: { source }, code: 'observe(data,{view:"fixture.source"});return loop.next();' });
			},
			(context) => {
				expect(getMessageText(context.messages.at(-1))).toContain(`CUSTOM VIEW\n${source}`);
				expect(getMessageText(context.messages.at(-1))).not.toContain("$.source");
				return call({ finish: "Observed with the edited Harness formatter." });
			},
		]);
		await h.session.prompt("Edit your observation format.");
		expect(h.faux.state.callCount).toBe(3);
	});

	it("keeps observations before a failure and still requires an explicit loop decision", async () => {
		const h = await setup();
		h.setResponses([
			call({ code: 'observe("readable\\nsource"); throw new Error("after observation");' }),
			() => {
				const result = getToolResult(h, "codemode");
				expect(result.isError).toBe(true);
				expect(getMessageText(result)).toContain("readable\nsource");
				return call({ code: 'observe("no decision");' });
			},
			() => {
				expect(getToolResult(h, "codemode").details).not.toHaveProperty("loopControl");
				return call({ finish: "Recovered." });
			},
		]);
		await h.session.prompt("Check observation and loop independence.");
		expect(h.faux.state.callCount).toBe(3);
	});

	it("reports a broken editable formatter as failure and does not accept the script's finish", async () => {
		const h = await setup();
		h.setResponses([
			call({
				code: `store("original",(await host.harness.read({path:"rules/output.mjs"})).text);
          ${installHarnessFiles({ "rules/output.mjs": 'export function render(){throw new Error("broken observation policy");}' })}return loop.next();`,
			}),
			call({ code: 'observe("new");return loop.finish("must not finish");' }),
			call({
				code: `const d=await host.harness.begin();
          await host.harness.write({target:{draft:d.draft},path:"rules/output.mjs",content:load("original")});
          const p=await host.harness.prepare({draft:d.draft});
          await host.harness.activate({expectedActiveRevision:d.baseRevision,revision:p.revision,when:"now"});
          return loop.next();`,
			}),
			call({ finish: "Recovered the original observation policy." }),
		]);
		await h.session.prompt("Reject a broken view.");
		const results = h.eventsOfType("tool_execution_end").filter((event) => event.toolName === "codemode");
		expect(results[1].isError).toBe(true);
		expect(getMessageText(results[1].result)).toContain("broken observation policy");
		expect(results[1].result.terminate).not.toBe(true);
		expect(results[2].isError).toBe(true);
		expect(h.faux.state.callCount).toBe(4);
	});
	it("shows the handler and controller call sites alongside observations after a host failure", async () => {
		const h = await setup();
		h.setResponses([
			call({
				code: `${installHarnessFiles(harnessToolFiles("export async function fail(args) {\n  await Promise.resolve();\n  return await host.fs.stat(args);\n}", "fixture.fail"))}
          observe("retained\\nobservation");
          await host.tools.call({name:"fixture.fail",args:{path:"missing-observation-test-file"}});
          return loop.next();`,
			}),
			(context) => {
				const text = context.messages.map(getMessageText).join("\n");
				expect(text).toContain("retained\nobservation");
				expect(text).toMatch(/modules\/fixture\.mjs@r-[a-f0-9]+:3:/);
				expect(text).toContain("codemode.js:");
				return call({ finish: "The failing call is identified in its source." });
			},
		]);
		await h.session.prompt("Diagnose a handler's host failure.");
		expect(h.faux.state.callCount).toBe(2);
	});
	it.each([undefined, "missing.view"])(
		"reports view %s as presentation failure, keeping effects and successful output",
		async (view) => {
			const h = await setup();
			h.setResponses([
				call({
					code: `await host.state.set({key:"effect",value:1});
        store("kept",{text:"recoverable"});observe("prior observation");
        observe({text:"must not dump",path:"hidden"},${JSON.stringify(view ? { view } : {})});
        return loop.finish("must not terminate");`,
				}),
				(context) => {
					const result = getToolResult(h, "codemode");
					expect(result.isError).toBe(true);
					expect(result.details).toMatchObject({
						error: { kind: "presentation" },
						calls: [{ name: "host.state.set", status: "ok" }],
					});
					expect(result.details).not.toHaveProperty("loopControl");
					const content = getMessageText(result);
					expect(content).toContain(
						view ? 'unknown view "missing.view"' : "object/array requires an explicit view",
					);
					expect(content).toContain("Available views:");
					expect(content).toContain("policies/views.yaml");
					expect(content).toContain("prior observation");
					expect(content).not.toContain("must not dump");
					expect(getMessageText(context.messages.at(-1))).not.toContain("missing_decision");
					return call({
						code: 'if(await host.state.get({key:"effect"})!==1) throw new Error("lost effect"); observe(load("kept"),{view:"pi.read"});return loop.next();',
					});
				},
				(context) => {
					expect(getMessageText(context.messages.at(-1))).toContain("recoverable");
					return call({ finish: "Recovered without repeating the operation." });
				},
			]);
			await h.session.prompt("Exercise missing view recovery.");
			expect(h.faux.state.callCount).toBe(3);
		},
	);
});
