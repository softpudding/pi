import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { CODEMODE_STORE_ENTRY_TYPE } from "../../src/extensions/codemode/tool.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

it("continues an indexed session through codemode, compaction, and retry without loading archived history", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-indexed-runtime-"));
	const file = join(root, "session.jsonl");
	const initial = SessionManager.open(file, root, root);
	initial.appendMessage({ role: "user", content: "ARCHIVED_ONLY".repeat(100_000), timestamp: 1 });
	initial.appendCustomEntry(CODEMODE_STORE_ENTRY_TYPE, { set: { count: 7, keep: true }, delete: [] });
	initial.appendCustomEntry(CODEMODE_STORE_ENTRY_TYPE, { set: {}, delete: ["keep"] });
	const incoming = initial.appendCustomMessageEntry(
		"inbox",
		JSON.stringify({
			origin: "agent",
			sender: { id: "agt_8", name: "三环负责人", profile: "stock-analysis" },
			text: "已复审",
		}),
		true,
		{ message_id: "old" },
	);
	initial.appendCompaction("三环负责人已汇报", incoming, 1000);
	const manager = SessionManager.open(file, root, root, { indexed: true });
	const fullBranch = vi.spyOn(manager, "getBranch").mockImplementation(() => {
		throw new Error("full branch on runtime path");
	});
	const fullEntries = vi.spyOn(manager, "getEntries").mockImplementation(() => {
		throw new Error("full history on runtime path");
	});
	let h: Harness | undefined;
	try {
		h = await createHarness({
			sessionManager: manager,
			initialActiveToolNames: ["codemode"],
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				createCodemodeExtension(),
				(pi) => {
					pi.on("session_before_compact", () => ({
						compaction: {
							summary: "三环负责人已汇报",
							firstKeptEntryId: manager.getLeafId()!,
							tokensBefore: 1000,
						},
					}));
				},
			],
		});
		await h.session.bindExtensions({ mode: "json" });
		h.setResponses([
			(context) => {
				const input = JSON.stringify(context.messages);
				expect(input).not.toContain("ARCHIVED_ONLY");
				expect(input).toContain("agt_8");
				expect(input).toContain("stock-analysis");
				return fauxAssistantMessage(
					[
						fauxToolCall("codemode", {
							code: 'const n = load("count") + 1; store("count", n); text({ n, keep: load("keep") ?? null });',
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("继续");
		expect(getToolResult(h, "codemode").isError).toBe(false);
		expect(JSON.stringify(getToolResult(h, "codemode").content)).toContain('\\"n\\":8');
		expect(JSON.stringify(getToolResult(h, "codemode").content)).toContain('\\"keep\\":null');
		await h.session.compact();
		const event = h.eventsOfType("compaction_end").at(-1);
		expect(event?.aborted).toBe(false);
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 overloaded" }),
			fauxAssistantMessage("recovered"),
		]);
		await h.session.prompt("再继续");
		expect(h.eventsOfType("auto_retry_end").at(-1)?.success).toBe(true);
		expect(manager.buildSessionProjection()).toEqual(SessionManager.open(file).buildSessionProjection());
		expect(manager.findCustomMessage("inbox", { key: "message_id", value: "old" })?.id).toBe(incoming);
	} finally {
		h?.cleanup();
		fullBranch.mockRestore();
		fullEntries.mockRestore();
		manager.close();
		rmSync(root, { recursive: true, force: true });
	}
});
