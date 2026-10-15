import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { getHarnessRuntime } from "../../src/extensions/codemode/harness/bridge.ts";
import { loadDefaultFiles } from "../../src/extensions/codemode/harness/definition.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";
import { harnessToolFiles, installHarnessFiles } from "./harness-programs.ts";

const harnesses: Harness[] = [];
async function setup() {
	const h = await createHarness({
		initialActiveToolNames: ["codemode"],
		settings: { compaction: { enabled: false, keepRecentTokens: 0 }, retry: { enabled: false } },
		extensionFactories: [createCodemodeExtension({ models: false })],
	});
	harnesses.push(h);
	return h;
}
const script = (code: string) => fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" });
async function run(h: Harness, code: string) {
	h.setResponses([script(code)]);
	await h.session.prompt("Run this task");
	const result = getToolResult(h, "codemode");
	expect(result.isError, getMessageText(result)).toBe(false);
	return result;
}
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

describe("Harness context policies", () => {
	it("sends literal tool input documents to the summary model through the editable serializer", async () => {
		const h = await setup();
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Module source is input data for the summary model.
		const source = 'export function render(r) {\n  return `${r.text}\\n`;\n}\n// "quotes" and ```';
		h.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: 'store("source",data.source);return loop.finish("stored");',
						data: { source },
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);
		await h.session.prompt("Keep source as data.");
		await run(h, 'return loop.finish("later task");');
		const summaries: TranscriptContext[] = [];
		h.setResponses(
			Array.from({ length: 2 }, () => (context: TranscriptContext) => {
				summaries.push(structuredClone(context));
				return fauxAssistantMessage("CHECKPOINT");
			}),
		);
		await h.session.compact();
		const text = summaries.flatMap((context) => context.messages.map(getMessageText)).join("\n");
		expect(text).toContain(source);
		expect(text).toContain("[Argument text");
		expect(text).not.toContain(JSON.stringify(source));
	});

	it("uses editable summary prompts, preserves tools through compaction, and separates task and Harness file effects", async () => {
		const h = await setup();
		writeFileSync(join(h.tempDir, "README.md"), "README TASK EVIDENCE");
		const defaults = loadDefaultFiles();
		const files = {
			...harnessToolFiles("export async function read({path}){const r=await host.fs.read({path});return r.data;}"),
			"prompts/compact-system.prompt": "CUSTOM SUMMARY SYSTEM",
			"prompts/compact-initial.prompt": "CUSTOM INITIAL",
			"prompts/compact-turn.prompt": "CUSTOM TURN",
			"agent.yaml": defaults["agent.yaml"].replace(
				"history: { source: session.history }",
				"history: { source: session.history }\n      environment: { source: environment }",
			),
			"rules/history.mjs": defaults["rules/history.mjs"].replace(
				"{ history }, options) {",
				'{ history, environment }, options) {\n  if (!environment.cwd) throw new Error("missing history environment");',
			),
		};
		await run(
			h,
			`${installHarnessFiles(files)}return loop.finish(await host.tools.call({name:"files.read",args:{path:"README.md"}}));`,
		);
		await run(h, 'return loop.finish("a later task");');
		const summaries: TranscriptContext[] = [];
		h.setResponses([
			(context) => {
				summaries.push(structuredClone(context));
				return fauxAssistantMessage("HISTORY CHECKPOINT");
			},
			(context) => {
				summaries.push(structuredClone(context));
				return fauxAssistantMessage("TURN CHECKPOINT");
			},
		]);
		const compacted = await h.session.compact();
		expect(compacted.summary).toContain("CHECKPOINT");
		expect(summaries.length).toBeGreaterThan(0);
		expect(JSON.stringify(summaries)).toContain("CUSTOM SUMMARY SYSTEM");
		expect(JSON.stringify(summaries)).toContain("CUSTOM TURN");
		expect(compacted.details).toMatchObject({
			readFiles: ["README.md"],
			modifiedFiles: [],
			usageRecordedSeparately: true,
		});
		let request: TranscriptContext | undefined;
		h.setResponses([
			(context) => {
				request = structuredClone(context);
				return script('return loop.finish(await host.tools.call({name:"files.read",args:{path:"README.md"}}));');
			},
		]);
		await h.session.prompt("Use the existing reader after compaction");
		expect(getCurrentTools(request!.messages).map((t) => t.name)).toEqual(["codemode"]);
		expect(getCurrentTools(request!.messages)[0].description).toContain("files.read");
		expect(getMessageText(getToolResult(h, "codemode"))).toContain("README TASK EVIDENCE");
	});
	it("keeps native context contributions visible beside editable system blocks", async () => {
		const h = await createHarness({
			initialActiveToolNames: ["codemode"],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [
				createCodemodeExtension({ models: false }),
				(pi) => {
					pi.on("context", (event) => ({
						messages: [
							...event.messages,
							{ role: "system", content: "NATIVE CONTEXT CONTRIBUTION", timestamp: 0 },
						],
					}));
				},
			],
		});
		harnesses.push(h);
		await run(
			h,
			`${installHarnessFiles({ "prompts/system.prompt": "EDITED HARNESS PREAMBLE" })}return loop.finish("configured");`,
		);
		let request: TranscriptContext | undefined;
		h.setResponses([
			(context) => {
				request = structuredClone(context);
				return script('return loop.finish("done");');
			},
		]);
		await h.session.prompt("Check the final context");
		expect(getMessageText(request!.messages[0])).toContain("EDITED HARNESS PREAMBLE");
		expect(getMessageText(request!.messages[0])).toContain("NATIVE CONTEXT CONTRIBUTION");
		expect(getCurrentTools(request!.messages).map((tool) => tool.name)).toEqual(["codemode"]);
	});
	it("stages a candidate checkpoint and retains the old active version when rendering it fails", async () => {
		const h = await setup();
		h.setResponses([
			script(
				`const d=await host.harness.begin();store("base",d.baseRevision);const target={draft:d.draft};const history=await host.harness.read({target,path:"rules/history.mjs"});await host.harness.write({target,path:"rules/history.mjs",content:history.text.replace('export function project({ history }, options) {','export function project({ history }, options) { if(history.messages.some(m=>m.role==="compactionSummary"))throw new Error("candidate-checkpoint-rejected");')});await host.harness.edit({target,path:"policies/compaction.yaml",edits:[{oldText:"enabled: false",newText:"enabled: true"},{oldText:"reserveTokens: 16384",newText:"reserveTokens: 999999"}]});const p=await host.harness.prepare({draft:d.draft});await host.harness.activate({revision:p.revision,expectedActiveRevision:d.baseRevision});return loop.next("candidate scheduled");`,
			),
			fauxAssistantMessage("TEMPORARY CHECKPOINT"),
			script('return loop.finish("must not run");'),
		]);
		await h.session.prompt("Prepare a candidate");
		const runtime = await getHarnessRuntime(
			h.session.getToolDefinition("codemode"),
			h.session.extensionRunner.createContext(),
		);
		expect(runtime!.harness.pending).toBeDefined();
		expect(runtime!.harness.activeRevision).not.toBe(runtime!.harness.pending!.revision);
		expect(h.sessionManager.getBranch().filter((e) => e.type === "compaction")).toEqual([]);
		expect(h.sessionManager.getBranch().some((e) => e.type === "usage" && e.kind === "harness-summary")).toBe(true);
		expect(JSON.stringify(h.session.messages)).toContain("candidate-checkpoint-rejected");
		await h.session.prompt("/harness restore initial");
		expect(runtime!.harness.pending).toBeUndefined();
		await run(h, 'return loop.finish("recovered");');
	});
	it("changes reminder text and correction limits from definition files", async () => {
		const h = await setup();
		await run(
			h,
			`${installHarnessFiles({ "policies/loop.yaml": "maxCorrections: 1\nmaxExecutionRecoveries: 3\n", "prompts/loop-retry.prompt": "CUSTOM RETRY", "prompts/loop-exhausted.prompt": "CUSTOM STOP" })}return loop.finish("configured");`,
		);
		h.setResponses([
			fauxAssistantMessage(""),
			fauxAssistantMessage(""),
			script('return loop.finish("must not run");'),
		]);
		await h.session.prompt("Test corrections");
		const reminders = h.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom_message" && e.customType === "codemode-loop-reminder");
		expect(reminders).toHaveLength(2);
		expect(reminders[0]).toMatchObject({ content: "CUSTOM RETRY" });
		expect(reminders[1]).toMatchObject({ content: expect.stringContaining("CUSTOM STOP") });
	});
	it("lets a loop rule generate reminders and carry its own state from concrete outcomes", async () => {
		const h = await setup();
		await run(
			h,
			`${installHarnessFiles({
				"rules/loop.mjs": `export function decide({outcome,state}) {
        if(outcome.status === "next" || outcome.status === "finish") return {action:"accept",state:{last:outcome.status}};
        return {action:"continue",state:{seen:(state.seen??0)+1},text:JSON.stringify({status:outcome.status,text:outcome.text,previous:state,errors:outcome.results.map(r=>r.error),calls:outcome.results.flatMap(r=>r.calls)})};
      }`,
			})}return loop.finish("configured");`,
		);
		h.setResponses([
			script('await host.state.set({key:"effect",value:true});throw new Error("custom failure");'),
			fauxAssistantMessage("Native completion rejected by the custom policy."),
			(context) => {
				const message = JSON.parse(getMessageText(context.messages.at(-1)));
				expect(message).toMatchObject({
					status: "assistant_finish",
					text: "Native completion rejected by the custom policy.",
					previous: { seen: 1 },
				});
				return script('return loop.next("observed");');
			},
			fauxAssistantMessage("Another native completion."),
			(context) => {
				expect(JSON.parse(getMessageText(context.messages.at(-1))).previous).toEqual({ last: "next" });
				return script('return loop.finish("complete");');
			},
		]);
		await h.session.prompt("Exercise a custom recovery rule.");
		const entries = h.sessionManager
			.getBranch()
			.flatMap((e) => (e.type === "custom_message" && e.customType === "codemode-loop-reminder" ? [e] : []));
		expect(JSON.parse(String(entries[0].content))).toMatchObject({
			status: "execution_failed",
			errors: [{ message: "custom failure" }],
			calls: [{ name: "host.state.set", status: "ok" }],
		});
		expect(getToolResult(h, "codemode").details).toMatchObject({ loopControl: "finish" });
	});
	it("edits output presentation and persists custom history roles in the request trace", async () => {
		const h = await setup();
		await run(
			h,
			`${installHarnessFiles({ "policies/output.yaml": "maxOutputTokens: 10000\nlabelItems: false\nconsoleTag: diagnostics\n", "policies/history.yaml": "customRole: system\ncompactionPrefix: summary\ncompactionSuffix: end\nbranchPrefix: branch\nbranchSuffix: end\n" })}return loop.finish("configured");`,
		);
		await h.session.sendCustomMessage({
			customType: "test-reminder",
			content: "VISIBLE SYSTEM REMINDER",
			display: false,
		});
		let request: TranscriptContext | undefined;
		h.setResponses([
			(context) => {
				request = structuredClone(context);
				return script('text("a");console.log("b");return loop.finish("c");');
			},
		]);
		await h.session.prompt("Render the output");
		expect(getMessageText(getToolResult(h, "codemode"))).toContain("a\nc\n<diagnostics>\nb\n</diagnostics>");
		expect(
			request!.messages.some((m) => m.role === "system" && getMessageText(m) === "VISIBLE SYSTEM REMINDER"),
		).toBe(true);
	});
});
