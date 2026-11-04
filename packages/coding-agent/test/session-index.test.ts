import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionIndex } from "../src/core/session-index.ts";
import {
	buildSessionProjection,
	type FileEntry,
	parseSessionEntries,
	SessionManager,
} from "../src/core/session-manager.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-session-index-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const file = join(root, "session.jsonl");
	const session = SessionManager.inMemory(root);
	const entries = () => [session.getHeader()!, ...session.getEntries()];
	const write = () =>
		writeFileSync(
			file,
			`${entries()
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
	const user = (content: string) => session.appendMessage({ role: "user", content, timestamp: Date.now() });
	const open = () => {
		const index = new SessionIndex(file);
		cleanups.push(() => index.close());
		return index;
	};
	write();
	return { root, file, session, entries, write, user, open };
}

describe("session byte index", () => {
	it("reads original UTF-8 records and pages backwards/forwards with stable byte cursors", () => {
		const f = fixture();
		const first = f.user("三环负责人：研究进行中 🧭");
		const second = f.user("确认来源");
		const checkpoint = f.session.appendCompaction("已确认来源", first, 100);
		f.user("继续");
		f.write();
		const original = readFileSync(f.file);
		const index = f.open();
		expect(index.indexFile).toBe(join(f.root, "session.index.sqlite"));
		expect(index.sync()).toEqual({ bytesRead: original.length, indexedBytes: original.length });
		expect(index.readEntry(second)).toEqual(f.session.getEntry(second));
		expect(index.readEntry("missing")).toBeUndefined();
		expect(index.latestCompaction()).toEqual(f.session.getEntry(checkpoint));
		const latest = index.readPage({ limit: 2 });
		expect(index.readCheckpointPage(2)).toEqual(latest);
		expect(latest.entries.map((row) => row.entry)).toEqual(f.entries().slice(-2));
		expect(latest.hasEarlier).toBe(true);
		expect(latest.hasLater).toBe(false);
		const older = index.readPage({ before: latest.before, limit: 2 });
		expect(older.entries.map((row) => row.entry)).toEqual(f.entries().slice(1, 3));
		expect(index.readPage({ after: older.after, limit: 2 })).toEqual(latest);
		const beginning = index.readPage({ before: older.before, limit: 2 });
		expect(beginning.entries.map((row) => row.entry)).toEqual([f.session.getHeader()]);
		expect(beginning.hasEarlier).toBe(false);
		for (const row of [...beginning.entries, ...older.entries, ...latest.entries]) {
			expect(JSON.parse(original.subarray(row.offset, row.end).toString())).toEqual(row.entry);
		}
		expect(readFileSync(f.file)).toEqual(original);
	});

	it("reopens without scanning old bodies and catches up only the appended tail", () => {
		const f = fixture();
		f.user("旧记录".repeat(400_000)); // One record exceeds the scanner's 1 MiB chunk.
		f.write();
		const first = f.open();
		first.sync();
		const size = statSync(f.file).size;
		const reopened = f.open();
		expect(reopened.sync()).toEqual({ bytesRead: 0, indexedBytes: size });
		const id = f.user("新来信");
		const line = `${JSON.stringify(f.session.getEntry(id))}\n`;
		appendFileSync(f.file, line);
		expect(reopened.sync()).toEqual({ bytesRead: Buffer.byteLength(line), indexedBytes: statSync(f.file).size });
		expect(reopened.readPage({ after: size }).entries.map((row) => row.entry)).toEqual([f.session.getEntry(id)]);
		// Another open connection observes the committed offset and does no work.
		expect(first.sync().bytesRead).toBe(0);
	});

	it("leaves partial lines untouched, including a partially written Chinese character", () => {
		const f = fixture();
		const index = f.open();
		const { indexedBytes } = index.sync();
		const id = f.user("新易盛负责人来信");
		const line = Buffer.from(`${JSON.stringify(f.session.getEntry(id))}\n`);
		const split = line.indexOf(Buffer.from("新")) + 1;
		appendFileSync(f.file, line.subarray(0, split));
		const partial = readFileSync(f.file);
		expect(index.sync().indexedBytes).toBe(indexedBytes);
		expect(index.readEntry(id)).toBeUndefined();
		expect(readFileSync(f.file)).toEqual(partial);
		appendFileSync(f.file, line.subarray(split, -1));
		expect(index.sync().indexedBytes).toBe(indexedBytes); // Valid JSON still needs its newline.
		appendFileSync(f.file, "\n");
		expect(index.sync().indexedBytes).toBe(indexedBytes + line.length);
		expect(index.readEntry(id)).toEqual(f.session.getEntry(id));
	});

	it("skips malformed complete lines without changing the source or losing later records", () => {
		const f = fixture();
		f.user("仍可读取");
		f.write();
		const original = readFileSync(f.file, "utf8").replace("\n", "\n\n{broken\n");
		writeFileSync(f.file, original);
		const index = f.open();
		index.sync();
		expect(index.readPage().entries.map((row) => row.entry)).toEqual(parseSessionEntries(original));
		expect(readFileSync(f.file, "utf8")).toBe(original);
	});

	it("finds checkpoints on the selected branch, including repeated compaction", () => {
		const f = fixture();
		const common = f.user("公共起点");
		const first = f.session.appendCompaction("分支一摘要", common, 100);
		const abandoned = f.session.appendCompaction("分支一新摘要", first, 50);
		f.session.branch(common);
		const other = f.user("分支二，尚未压缩");
		f.write();
		const index = f.open();
		index.sync();
		expect(index.latestCompaction()).toBeUndefined();
		expect(index.readCheckpointPage().entries.map((row) => row.entry)).toEqual(f.entries());
		expect(index.latestCompaction(other)).toBeUndefined();
		expect(index.latestCompaction(first)).toEqual(f.session.getEntry(first));
		expect(index.latestCompaction(abandoned)).toEqual(f.session.getEntry(abandoned));
	});

	it("rebuilds a missing index and invalidates offsets after source replacement or truncation", () => {
		const f = fixture();
		f.user("旧内容".repeat(100));
		f.write();
		const original = readFileSync(f.file);
		const index = f.open();
		index.sync();
		const rebuilt = new SessionIndex(join(f.root, "copy.jsonl"));
		cleanups.push(() => rebuilt.close());
		writeFileSync(join(f.root, "copy.jsonl"), original);
		rebuilt.sync();
		expect(rebuilt.readPage()).toEqual(index.readPage());
		// An atomic replacement can be longer than the old source.
		const replacement: FileEntry = { ...f.session.getHeader()!, id: "replacement", cwd: "x".repeat(original.length) };
		writeFileSync(`${f.file}.new`, `${JSON.stringify(replacement)}\n`);
		renameSync(`${f.file}.new`, f.file);
		index.sync();
		expect(index.readPage().entries.map((row) => row.entry)).toEqual([replacement]);
		writeFileSync(f.file, `${JSON.stringify(f.session.getHeader())}\n`);
		index.sync();
		expect(index.readPage().entries.map((row) => row.entry)).toEqual([f.session.getHeader()]);
		writeFileSync(f.file, original);
		index.sync(true); // Explicit rebuild also supports intentional in-place edits.
		expect(index.readPage()).toEqual(rebuilt.readPage());
	});
});

describe("indexed checkpoint recovery", () => {
	it("matches native projection with retained tool results, source attribution, edits, and system state", () => {
		const f = fixture();
		f.session.appendModelChange("test-provider", "model-a");
		f.session.appendThinkingLevelChange("high");
		f.session.appendMessage({
			role: "system",
			content: "负责协调研究",
			sections: { sources: "转述时保留发送者身份" },
			timestamp: 1,
		});
		f.user("已归档材料".repeat(100_000));
		const kept = f.session.appendCustomMessageEntry(
			"inbox",
			JSON.stringify({
				origin: "agent",
				sender: { id: "agt_8", name: "三环负责人", profile: "stock-analysis" },
				text: "证据已复审",
			}),
			true,
			{ message_id: "msg_3", sender_id: "agt_8" },
		);
		f.session.appendMessage({
			role: "assistant",
			api: "openai-responses",
			provider: "test-provider",
			model: "model-b",
			content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "/workspace/report.md" } }],
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		});
		const result = f.session.appendMessage({
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "旧报告" }],
			isError: false,
			timestamp: 3,
		});
		f.session.appendCompaction("三环负责人汇报：证据已复审", kept, 10_000);
		f.session.appendContextEdit(result, { content: "已核实的报告" });
		f.user("继续");
		f.write();
		const index = f.open();
		index.sync();
		const recovered = index.readRecovery();
		expect({ ...buildSessionProjection(recovered.entries), ...recovered.settings }).toEqual(
			f.session.buildSessionProjection(),
		);
		expect(recovered.header).toEqual(f.session.getHeader());
		expect(recovered.leafId).toBe(f.session.getLeafId());
		expect(recovered.entries[0].id).toBe(kept);
		expect(recovered.settings).toEqual({
			model: { provider: "test-provider", modelId: "model-b" },
			thinkingLevel: "high",
		});
		expect(
			recovered.settingsEntries.some((entry) => entry.type === "model_change" && entry.modelId === "model-a"),
		).toBe(true);
		expect(recovered.bytesRead).toBeLessThan(10_000);
		expect(index.readBranch()).toEqual(f.session.getBranch());
	});

	it("handles repeated compaction, branch-specific settings, and a checkpoint retaining no earlier records", () => {
		const f = fixture();
		f.session.appendModelChange("test-provider", "common");
		f.session.appendThinkingLevelChange("medium");
		const common = f.user("共同起点");
		f.session.appendModelChange("test-provider", "abandoned");
		f.session.appendThinkingLevelChange("low");
		f.session.appendCompaction("废弃分支", null, 100);
		const abandoned = f.user("另一个分支");
		const abandonedProjection = f.session.buildSessionProjection();
		f.session.branch(common);
		const kept = f.user("本分支留用材料");
		f.session.appendCompaction("第一次压缩", kept, 100);
		f.user("新材料");
		f.session.appendCompaction("第二次压缩", kept, 100);
		f.write();
		const index = f.open();
		index.sync();
		const second = index.readRecovery();
		expect({ ...buildSessionProjection(second.entries), ...second.settings }).toEqual(
			f.session.buildSessionProjection(),
		);
		const oldBranch = index.readRecovery(abandoned);
		expect({ ...buildSessionProjection(oldBranch.entries), ...oldBranch.settings }).toEqual(abandonedProjection);
		expect(second.settings).toEqual({
			model: { provider: "test-provider", modelId: "common" },
			thinkingLevel: "medium",
		});
		const emptyKept = f.session.appendCompaction("完全归档", null, 100);
		f.write();
		index.sync(true);
		const third = index.readRecovery();
		expect(third.entries.map((entry) => entry.id)).toEqual([emptyKept]);
		expect({ ...buildSessionProjection(third.entries), ...third.settings }).toEqual(
			f.session.buildSessionProjection(),
		);
	});

	it("restores extension deltas on demand without including abandoned-branch state", () => {
		const f = fixture();
		const first = f.session.appendCustomEntry("codemode:store", { set: { a: 1, b: 2 } });
		const common = f.user("起点");
		f.session.appendCustomEntry("codemode:store", { set: { a: "abandoned" } });
		f.session.branch(common);
		const second = f.session.appendCustomEntry("codemode:store", { set: { c: 3 }, delete: ["b"] });
		f.session.appendCustomEntry("other-extension", { unrelated: true });
		f.session.appendCompaction("旧上下文摘要", null, 100);
		f.write();
		const index = f.open();
		index.sync();
		expect(index.readRecovery().entries.every((entry) => entry.type !== "custom")).toBe(true);
		expect(index.readCustomEntries("codemode:store")).toEqual([
			f.session.getEntry(first),
			f.session.getEntry(second),
		]);
		expect(index.readCustomEntries("missing")).toEqual([]);
	});

	it("supports new/uncompacted sessions and ignores firstKeptEntryId from a different branch", () => {
		const f = fixture();
		const index = f.open();
		index.sync();
		expect(index.readRecovery()).toMatchObject({
			entries: [],
			leafId: null,
			settings: { model: null, thinkingLevel: "off" },
		});
		expect(index.readCheckpointPage().entries.map((row) => row.entry)).toEqual([f.session.getHeader()]);
		const common = f.user("初始问题");
		f.write();
		index.sync(true);
		expect(index.readRecovery().entries).toEqual(f.session.getBranch());
		expect(index.readRecovery(null).entries).toEqual([]);
		expect(() => index.readRecovery("missing")).toThrow("not found");
		const other = f.user("其他分支");
		f.session.branch(common);
		f.user("当前分支");
		const checkpoint = f.session.appendCompaction("不留用其他分支", other, 100);
		f.write();
		index.sync(true);
		const recovered = index.readRecovery();
		expect(recovered.entries.map((entry) => entry.id)).toEqual([checkpoint]);
		expect({ ...buildSessionProjection(recovered.entries), ...recovered.settings }).toEqual(
			f.session.buildSessionProjection(),
		);
	});

	it("reads the same bounded recovery payload as archived history grows", () => {
		const f = fixture();
		f.session.appendModelChange("test-provider", "model");
		f.session.appendThinkingLevelChange("high");
		const index = f.open();
		const sizes: number[] = [];
		for (let round = 0; round < 3; round++) {
			for (let i = 0; i < 100; i++) f.user("已压缩的历史材料".repeat(1_000));
			f.session.appendCompaction("稳定摘要", null, 100);
			f.write();
			index.sync(true);
			expect(index.sync().bytesRead).toBe(0);
			const recovered = index.readRecovery();
			expect(recovered.entries).toHaveLength(1);
			sizes.push(recovered.bytesRead);
		}
		expect(new Set(sizes).size).toBe(1);
		expect(sizes[0]).toBeLessThan(2_000);
		expect(statSync(f.file).size).toBeGreaterThan(7_000_000);
	});
});
