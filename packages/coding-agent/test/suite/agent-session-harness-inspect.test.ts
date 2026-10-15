import { getCurrentTools } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionManager } from "../../src/core/session-manager.ts";
import type { HarnessRequestRecord } from "../../src/extensions/codemode/harness/inspection.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";
import { installHarnessFiles } from "./harness-programs.ts";

const harnesses: Harness[] = [];
async function setup(sessionManager?: SessionManager) {
	const h = await createHarness({
		sessionManager,
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

describe("saved Harness request inspection", () => {
	it("returns only composition metadata and renders a default overview without truncation", async () => {
		const h = await setup();
		h.setResponses([
			call({
				code: 'const info=await host.harness.inspect();store("info",info);observe(info,{view:"harness.overview"});return loop.next();',
			}),
			(context) => {
				const result = getToolResult(h, "codemode");
				const text = getMessageText(result);
				expect(text.length).toBeLessThan(6000);
				expect(text).toContain("agent.yaml");
				expect(text).toContain("harness.overview");
				expect(text).not.toContain("truncated output");
				expect(text).not.toContain("declare const host");
				expect(result.details).not.toHaveProperty("fullOutputPath");
				expect(getCurrentTools(context.messages).map((t) => t.name)).toEqual(["codemode"]);
				return call({ code: 'return loop.finish(load("info"));' });
			},
		]);
		await h.session.prompt("Explore the composition.");
		const text = getMessageText(getToolResult(h, "codemode"));
		const info = JSON.parse(text.slice(text.indexOf("Output:\n") + 8));
		expect(info.section).toBe("overview");
		expect(info).not.toHaveProperty("request");
		expect(info).not.toHaveProperty("description");
		expect(
			info.context.system.every(
				(block: Record<string, unknown>) => Object.keys(block).sort().join(",") === "chars,id",
			),
		).toBe(true);
		expect(info.context.codemode.chars).toBeGreaterThan(12000);
		expect(info.views["pi.read"]).toBe("rules/views.mjs#read");
		expect(JSON.stringify(info)).not.toContain("definitionReference");
	});

	it("observes native read body and continuation hints without file metadata", async () => {
		const h = await setup();
		h.setResponses([
			call({
				code: 'const d=await host.harness.begin();store("draft",d.draft);await host.harness.write({target:{draft:d.draft},path:"notes/source",content:"first\\nsecond\\nthird"});const r=await host.harness.read({target:{draft:d.draft},path:"notes/source",limit:1});store("raw",r);observe(r,{view:"pi.read"});return loop.next();',
			}),
			() => {
				const result = getToolResult(h, "codemode");
				expect(result.content[1]).toEqual({
					type: "text",
					text: "first\n\n[2 more lines in file. Use offset=2 to continue.]",
				});
				return call({
					code: 'const r=await host.harness.read({target:{draft:load("draft")},path:"notes/source",offset:2});observe(r,{view:"pi.read"});return loop.next();',
				});
			},
			() => {
				expect(getToolResult(h, "codemode").content[1]).toEqual({ type: "text", text: "second\nthird" });
				return call({ code: 'return loop.finish(load("raw"));' });
			},
		]);
		await h.session.prompt("Read a definition in pages.");
		expect(getMessageText(getToolResult(h, "codemode"))).toContain(
			'"harness":{"domain":"harness","path":"notes/source"',
		);
	});

	it("pins all detail pages across immediate activation, next request and session resume", async () => {
		const h = await setup();
		const original = "AB\u{1f600}内容\n".repeat(1400);
		h.setResponses([
			call({
				code: `${installHarnessFiles({ "prompts/system.prompt": original })}return loop.finish("configured");`,
			}),
		]);
		await h.session.prompt("Set up a long system block.");
		let description = "";
		h.setResponses([
			(context) => {
				description = getCurrentTools(context.messages)[0].description;
				return call({
					code: `const pages=[];
          for(const query of [{section:"system",id:"preamble",limit:1301},{section:"codemode"},{section:"provenance",limit:400}]) pages.push(await host.harness.inspect(query));
          store("pages",pages);
          ${installHarnessFiles({ "prompts/system.prompt": "NEW SYSTEM", "prompts/codemode.prompt": "NEW GUIDE" })}
          const after=await host.harness.inspect();
          if(after.requestRevision===after.activeRevision)throw new Error("request overwritten");
          const still=await host.harness.inspect({section:"system",id:"preamble",limit:1301});
          if(still.text!==pages[0].text)throw new Error("regenerated past output");
          observe(pages[0],{view:"harness.detail"});return loop.next();`,
				});
			},
			(context) => {
				expect(getCurrentTools(context.messages)[0].description).toContain("NEW GUIDE");
				expect(getMessageText(context.messages.at(-1))).toContain(
					"Continue this saved request with host.harness.inspect(",
				);
				return call({ finish: "Saved continuation positions." });
			},
		]);
		await h.session.prompt("Read part of the old request, then activate new context.");
		const resumed = await setup(h.sessionManager);
		resumed.setResponses([
			call({
				code: `// @options: {"max_output_tokens":50000}
      const results=[];
      for(const first of load("pages")) {
        let page=first,body=first.text;
        while(page.next) {
          page=await host.harness.inspect(page.next);
          if(page.requestId!==first.requestId || page.requestRevision!==first.requestRevision) throw new Error("mixed requests");
          body+=page.text;
        }
        results.push({section:first.section,body,requestId:first.requestId,revision:first.requestRevision});
      }
      return loop.finish(results);`,
			}),
		]);
		await resumed.session.prompt("Continue the saved request after resume.");
		const text = getMessageText(getToolResult(resumed, "codemode"));
		expect(getToolResult(resumed, "codemode").isError).toBe(false);
		const results = JSON.parse(text.slice(text.indexOf("Output:\n") + 8));
		expect(results[0].body).toBe(original);
		expect(results[1].body).toBe(description);
		const record = h.sessionManager
			.getBranch()
			.flatMap((e) =>
				e.type === "custom" && e.customType === "codemode-harness-request-v1"
					? [e.data as HarnessRequestRecord]
					: [],
			)
			.find((r) => r.requestId === results[0].requestId)!;
		expect(JSON.parse(results[2].body)).toMatchObject({
			inputSnapshot: record.inputSnapshot,
			outputs: record.provenance,
		});
	});

	it("rejects unbound continuations and unknown snapshots rather than silently using the current request", async () => {
		const h = await setup();
		h.setResponses([
			call({
				code: `const first=await host.harness.inspect({section:"codemode"});
      const errors=await Promise.allSettled([
      host.harness.inspect({section:"codemode",offset:1}),
      host.harness.inspect({...first.next,requestId:"q-absent"}),
      host.harness.inspect({cursor:"broken"}),
      host.harness.inspect({section:"system",id:"absent"}),
      host.harness.inspect({section:"codemode",requestId:"q-absent"}),
      host.harness.inspect({limit:100}),
      host.harness.inspect({section:"codemode",limit:12001})
      ]); return loop.finish(errors.map(r=>r.reason.message));`,
			}),
		]);
		await h.session.prompt("Validate continuation contracts.");
		const text = getMessageText(getToolResult(h, "codemode"));
		expect(text).toContain("Invalid inspect cursor");
		expect(text).toContain("Available IDs:");
		expect(text).toContain("Unknown saved Harness request q-absent");
		expect(text).toContain("require a detail section");
		expect(text).toContain("Invalid arguments for host.harness.inspect");
	});
	it("does not reuse another branch's saved request through a cursor", async () => {
		const h = await setup();
		h.setResponses([call({ finish: "Before the branch." })]);
		await h.session.prompt("Create the branch point.");
		const before = h.sessionManager.getLeafId()!;
		h.setResponses([call({ code: 'return loop.finish((await host.harness.inspect({section:"codemode"})).next);' })]);
		await h.session.prompt("Create a request on one branch.");
		const text = getMessageText(getToolResult(h, "codemode"));
		const cursor = JSON.parse(text.slice(text.indexOf("Output:\n") + 8));
		await h.session.navigateTree(before);
		h.setResponses([
			call({
				code: `try { await host.harness.inspect(${JSON.stringify(cursor)}); return loop.finish("wrong request"); }
        catch(e) { return loop.finish(e.message); }`,
			}),
		]);
		await h.session.prompt("Try the cursor on another branch.");
		expect(getMessageText(getToolResult(h, "codemode"))).toContain("Unknown saved Harness request");
	});
});
