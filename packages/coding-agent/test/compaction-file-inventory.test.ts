import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	compact,
	generateBranchSummary,
	prepareBranchEntries,
	prepareCompaction,
	stripLegacyFileInventory,
} from "../src/core/compaction/index.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { buildSessionProjection, type SessionEntry } from "../src/core/session-manager.ts";

const current = "Continue from src/current.ts; preserve the user's review requirement.";
const inventory = "\n\n<read-files>\nold-read.ts\n</read-files>\n\n<modified-files>\nold-write.ts\n</modified-files>";
const legacy = current + inventory;
const timestamp = new Date(1).toISOString();
const model: Model<"openai-completions"> = {
	id: "fixture",
	name: "Fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "http://unused",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const entries: SessionEntry[] = [
	{
		type: "compaction",
		id: "old",
		parentId: null,
		timestamp,
		summary: legacy,
		firstKeptEntryId: "old",
		tokensBefore: 100,
		details: { readFiles: ["old-read.ts"], modifiedFiles: ["old-write.ts"] },
	},
	{
		type: "message",
		id: "user",
		parentId: "old",
		timestamp,
		message: { role: "user", content: "Continue the work", timestamp: 1 },
	},
	{
		type: "message",
		id: "assistant",
		parentId: "user",
		timestamp,
		message: {
			...fauxAssistantMessage(""),
			content: [
				{ type: "toolCall", id: "read", name: "read", arguments: { path: "recent-read.ts" } },
				{ type: "toolCall", id: "code", name: "codemode", arguments: { code: "await tools.write(...)" } },
			],
		},
	},
	{
		type: "message",
		id: "result",
		parentId: "assistant",
		timestamp,
		message: {
			role: "toolResult",
			toolCallId: "code",
			toolName: "codemode",
			content: [],
			isError: false,
			timestamp: 1,
			nestedCalls: {
				calls: [{ id: "code/1", name: "write", arguments: { path: "recent-write.ts" }, status: "ok" }],
				complete: true,
			},
		},
	},
	{
		type: "message",
		id: "latest",
		parentId: "result",
		timestamp,
		message: { role: "user", content: "What is next?", timestamp: 2 },
	},
];

function summaryStream(requests: string[]): StreamFn {
	return (_model, context) => {
		requests.push(JSON.stringify(context));
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage(current) });
			stream.end();
		});
		return stream;
	};
}

describe("summary file inventories", () => {
	it.each(["\n", "\r\n"])("removes complete standalone blocks with %j line endings", (newline) => {
		expect(stripLegacyFileInventory(legacy.replaceAll("\n", newline))).toBe(current);
		expect(stripLegacyFileInventory(`${legacy}\n\n---\n\nTurn context`)).toBe(`${current}\n\n---\n\nTurn context`);
	});

	it("preserves ordinary paths, inline tags and incomplete blocks", () => {
		const text = `${current}\nUse <read-files> as a label.\n<modified-files>\nunclosed.ts`;
		expect(stripLegacyFileInventory(text)).toBe(text);
	});

	it("restores and recompacts old summaries without inheriting their inventories or changing history", async () => {
		const original = JSON.stringify(entries);
		const projection = buildSessionProjection(entries);
		expect(JSON.stringify(convertToLlm(projection.messages))).not.toContain("old-read.ts");
		const preparation = prepareCompaction(entries, { enabled: true, keepRecentTokens: 1, reserveTokens: 1000 });
		expect(preparation?.previousSummary).toBe(current);
		expect(preparation).not.toHaveProperty("fileOps");
		const requests: string[] = [];
		const result = await compact(
			preparation!,
			model,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			summaryStream(requests),
		);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("recent-read.ts");
		expect(requests[0]).toContain("src/current.ts");
		expect(requests[0]).not.toContain("old-read.ts");
		expect(requests[0]).not.toContain("old-write.ts");
		expect(result.summary).toBe(current);
		expect(result).not.toHaveProperty("details");
		expect(JSON.stringify(entries)).toBe(original);
	});

	it("cleans old compaction and branch summaries before branch summarization", async () => {
		const branch: SessionEntry[] = [
			...entries,
			{
				type: "branch_summary",
				id: "branch",
				parentId: "latest",
				timestamp,
				fromId: "assistant",
				summary: legacy,
				details: { readFiles: ["old-read.ts"], modifiedFiles: ["old-write.ts"] },
			},
		];
		const original = JSON.stringify(branch);
		expect(prepareBranchEntries(branch)).not.toHaveProperty("fileOps");
		const requests: string[] = [];
		const result = await generateBranchSummary(branch, {
			model,
			signal: new AbortController().signal,
			streamFn: summaryStream(requests),
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("src/current.ts");
		expect(requests[0]).not.toContain("old-read.ts");
		expect(requests[0]).not.toContain("old-write.ts");
		expect(result.summary).toContain(current);
		expect(result.summary).not.toContain("<read-files>");
		expect(result).not.toHaveProperty("readFiles");
		expect(result).not.toHaveProperty("modifiedFiles");
		expect(JSON.stringify(branch)).toBe(original);
	});
});
