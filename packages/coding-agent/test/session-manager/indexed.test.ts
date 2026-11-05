import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionIndex } from "../../src/core/session-index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-indexed-manager-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const file = join(root, "session.jsonl");
	const open = () => {
		const manager = SessionManager.open(file, root, root, { indexed: true });
		cleanups.push(() => manager.close());
		return manager;
	};
	return { root, file, open };
}

it("recovers context and archived receipts without full-history reads, and retains the original log", () => {
	const f = fixture();
	const initial = SessionManager.open(f.file, f.root, f.root);
	initial.appendModelChange("test", "model");
	initial.appendThinkingLevelChange("high");
	initial.appendMessage({ role: "user", content: "旧历史".repeat(500_000), timestamp: 1 });
	const old = initial.appendCustomMessageEntry("inbox", "负责人汇报", true, { message_id: "old", task_id: "tsk_9" });
	initial.appendCustomEntry("store", { set: { a: 1 }, delete: [] });
	initial.appendCompaction("负责人已汇报", null, 1000);
	initial.appendMessage({ role: "user", content: "继续", timestamp: 2 });
	const original = readFileSync(f.file, "utf8");
	const readAll = vi.spyOn(SessionIndex.prototype, "readEntries").mockImplementation(() => {
		throw new Error("eager history read");
	});
	const readBranch = vi.spyOn(SessionIndex.prototype, "readBranch").mockImplementation(() => {
		throw new Error("eager branch read");
	});
	const manager = f.open();
	expect(manager.buildSessionProjection()).toEqual(initial.buildSessionProjection());
	expect(manager.getRuntimeBranch()).toHaveLength(2);
	expect(manager.getSettingsEntries()).toHaveLength(2);
	expect(manager.findCustomMessage("inbox", { key: "message_id", value: "old" })?.id).toBe(old);
	expect(manager.findCustomMessage("inbox", { key: "message_id", value: "missing" })).toBeUndefined();
	expect(manager.getCustomEntries("store")).toEqual(initial.getCustomEntries("store"));
	const kept = manager.appendMessage({ role: "user", content: "近期资料", timestamp: 3 });
	const identity = manager.getEntry(kept);
	manager.appendCompaction("新的摘要", kept, 50);
	expect(manager.getEntry(kept)).toBe(identity);
	manager.appendContextEdit(kept, { content: "修正后的近期资料" });
	manager.appendThinkingLevelChange("low");
	manager.appendModelChange("test", "switched");
	expect(manager.buildSessionContext().thinkingLevel).toBe("low");
	expect(manager.buildSessionContext().model?.modelId).toBe("switched");
	expect(readFileSync(f.file, "utf8").startsWith(original)).toBe(true);
	readAll.mockRestore();
	readBranch.mockRestore();
	const full = SessionManager.open(f.file, f.root, f.root);
	expect(manager.buildSessionProjection()).toEqual(full.buildSessionProjection());
	expect(manager.getEntries()).toEqual(full.getEntries());
	expect(manager.getEntryCount()).toBe(full.getEntryCount());
	expect(manager.getBranch()).toEqual(full.getBranch());
	expect(f.open().buildSessionProjection()).toEqual(full.buildSessionProjection());
});

it("keeps branch navigation, archived labels, children, and forks available on demand", () => {
	const f = fixture();
	const manager = f.open();
	const common = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
	manager.appendSessionInfo("research");
	manager.appendLabelChange(common, "bookmark");
	const first = manager.appendMessage({ role: "user", content: "branch one", timestamp: 2 });
	manager.appendCompaction("summary", null, 100);
	manager.branch(common);
	manager.appendModelChange("test", "branch two");
	manager.appendMessage({ role: "user", content: "branch two", timestamp: 3 });
	manager.appendCompaction("summary two", null, 100);
	const full = SessionManager.open(f.file, f.root, f.root);
	expect(manager.getLabel(common)).toBe("bookmark");
	expect(manager.getSessionName()).toBe("research");
	expect(manager.getChildren(common)).toEqual(full.getChildren(common));
	expect(manager.getTree()).toEqual(full.getTree());
	manager.branch(first);
	full.branch(first);
	expect(manager.buildSessionProjection()).toEqual(full.buildSessionProjection());
	manager.branchWithSummary(common, "branch summary");
	expect(manager.getRuntimeBranch().at(-1)?.type).toBe("branch_summary");
	const fork = manager.createBranchedSession(first)!;
	expect(manager.getLabel(common)).toBe("bookmark");
	expect(manager.getEntries()).toEqual(SessionManager.open(fork).getEntries());
	manager.setSessionFile(f.file);
	expect(manager.getEntries()).toEqual(SessionManager.open(f.file).getEntries());
	manager.resetLeaf();
	expect(manager.buildSessionContext()).toEqual({ messages: [], model: null, thinkingLevel: "off" });
	manager.newSession();
	manager.appendMessage({ role: "user", content: "new session", timestamp: 4 });
	expect(manager.getEntries()).toHaveLength(1);
	expect(manager.findCustomMessage("inbox")).toBeUndefined();
});

it("indexes buffered custom messages only after persistence and catches a complete unterminated tail", () => {
	const f = fixture();
	const manager = f.open();
	const id = manager.appendCustomMessageEntry("inbox", "request", false, { message_id: "one", task_id: 4 });
	expect(existsSync(f.file)).toBe(false);
	expect(manager.findCustomMessage("inbox", { key: "message_id", value: "one" })?.id).toBe(id);
	manager.appendMessage({ role: "user", content: "flush", timestamp: 1 });
	manager.close();
	appendFileSync(
		f.file,
		JSON.stringify({
			type: "custom_message",
			id: "tail",
			parentId: id,
			timestamp: new Date().toISOString(),
			customType: "inbox",
			content: "tail",
			display: true,
			details: { message_id: "two", task_id: "4" },
		}),
	);
	const reopened = f.open();
	expect(reopened.findCustomMessage("inbox", { key: "task_id", value: 4 })?.id).toBe(id);
	expect(reopened.findCustomMessage("inbox", { key: "task_id", value: "4" })?.id).toBe("tail");
	expect(reopened.findCustomMessage("inbox", { key: "task_id" })?.id).toBe("tail");
	expect(readFileSync(f.file, "utf8").endsWith("\n")).toBe(true);
	const native = SessionManager.open(f.file);
	expect(reopened.buildSessionProjection()).toEqual(native.buildSessionProjection());
	// A missing derived index is rebuilt from the same authoritative file.
	reopened.close();
	rmSync(f.file.replace(".jsonl", ".index.sqlite"));
	expect(f.open().getEntries()).toEqual(native.getEntries());
});

it("migrates old sessions once and supports an explicitly empty file", () => {
	const f = fixture();
	writeFileSync(f.file, "");
	const empty = f.open();
	empty.appendMessage({ role: "user", content: "empty file", timestamp: 1 });
	empty.close();
	const entries = readFileSync(f.file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	entries[0].version = 2;
	writeFileSync(f.file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	const migrated = f.open();
	expect(migrated.getHeader()?.version).toBe(3);
	expect(migrated.getEntries()).toEqual(entries.slice(1));
});
