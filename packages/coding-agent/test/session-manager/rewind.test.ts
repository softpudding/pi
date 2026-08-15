/**
 * Tests for SessionManager.rewind.
 *
 * Rewind truncates the session back to just before a checkpoint entry,
 * physically discarding the checkpoint and everything after it from the
 * session file.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";

function userMessage(text: string, timestamp: number): { role: "user"; content: string; timestamp: number } {
	return { role: "user", content: text, timestamp };
}

function assistantMessage(
	text: string,
	timestamp: number,
): {
	role: "assistant";
	content: Array<{ type: "text"; text: string }>;
	api: string;
	provider: string;
	model: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	};
	stopReason: "stop";
	timestamp: number;
} {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function appendTurn(session: SessionManager, userText: string, assistantText: string, at: number): void {
	session.appendMessage(userMessage(userText, at));
	session.appendMessage(assistantMessage(assistantText, at + 1));
}

function messageText(message: { role: string; content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (part && typeof part === "object" && "text" in part ? (part.text ?? "") : ""))
			.join("");
	}
	return "";
}

describe("SessionManager.rewind", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-rewind-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("rewinding to the first user message resets the session to empty", () => {
		const session = SessionManager.create(tempDir);
		appendTurn(session, "first", "reply one", 1);
		session.appendMessage(userMessage("second", 10));
		session.appendMessage(assistantMessage("reply two", 11));

		const firstUser = session.getEntries()[0].id;
		const newLeaf = session.rewind(firstUser);
		expect(newLeaf).toBeNull();
		expect(session.getLeafId()).toBeNull();
		expect(session.getEntries()).toHaveLength(0);
		expect(session.buildSessionContext().messages).toHaveLength(0);
	});

	it("truncates persisted session file back to before the checkpoint", () => {
		const session = SessionManager.create(tempDir);
		appendTurn(session, "first", "reply one", 1);
		const secondUser = session.appendMessage(userMessage("second", 10));
		session.appendMessage(assistantMessage("reply two", 11));

		expect(session.getEntries()).toHaveLength(4);
		expect(existsSync(session.getSessionFile()!)).toBe(true);

		const newLeaf = session.rewind(secondUser);
		expect(newLeaf).toBe(session.getLeafId());

		const entries = session.getEntries();
		expect(entries).toHaveLength(2);

		// The file on disk must not contain the discarded entries.
		const fileEntries = loadEntriesFromFile(session.getSessionFile()!);
		const messages = fileEntries.filter((e) => e.type === "message");
		expect(messages).toHaveLength(2);
		expect(messages.map((e) => e.id)).toEqual(entries.map((e) => e.id));
	});

	it("keeps entries up to the checkpoint's parent and continues from the new leaf", () => {
		const session = SessionManager.create(tempDir);
		appendTurn(session, "first", "reply one", 1);
		const secondUser = session.appendMessage(userMessage("second", 10));
		appendTurn(session, "third", "reply three", 20);

		session.rewind(secondUser);
		expect(session.getBranch().map((e) => e.id)).toEqual(session.getEntries().map((e) => e.id));

		const messages = session.buildSessionContext().messages;
		expect(messages).toHaveLength(2);
		expect(messages[0].role).toBe("user");
		expect(messageText(messages[0])).toBe("first");
		expect(messages[1].role).toBe("assistant");
		expect(messageText(messages[1])).toBe("reply one");

		// Appending after a rewind continues from the new leaf.
		const next = session.appendMessage(userMessage("fourth", 30));
		expect(
			session
				.getBranch()
				.map((e) => e.id)
				.pop(),
		).toBe(next);
	});

	it("drops entries on abandoned branches", () => {
		const session = SessionManager.create(tempDir);
		appendTurn(session, "first", "reply one", 1);
		const secondUser = session.appendMessage(userMessage("second", 10));
		session.appendMessage(assistantMessage("reply two", 11));

		// Branch back to the second user message and continue on a new branch.
		session.branch(secondUser);
		const branchedUser = session.appendMessage(userMessage("second (edited)", 20));
		session.appendMessage(assistantMessage("reply two-b", 21));

		// Rewinding to the original second message discards the new branch too.
		session.rewind(secondUser);
		expect(session.getEntries()).toHaveLength(2);
		expect(session.getEntries().some((e) => e.id === branchedUser)).toBe(false);
		expect(session.buildSessionContext().messages.map(messageText)).toEqual(["first", "reply one"]);
	});

	it("works in-memory (no session file)", () => {
		const session = SessionManager.inMemory();
		appendTurn(session, "first", "reply one", 1);
		const secondUser = session.appendMessage(userMessage("second", 10));
		session.appendMessage(assistantMessage("reply two", 11));

		const newLeaf = session.rewind(secondUser);
		expect(newLeaf).toBe(session.getLeafId());
		expect(session.getEntries()).toHaveLength(2);
		expect(session.getSessionFile()).toBeUndefined();
	});

	it("throws for unknown checkpoint ids", () => {
		const session = SessionManager.inMemory();
		appendTurn(session, "first", "reply one", 1);
		expect(() => session.rewind("does-not-exist")).toThrow(/not found/);
	});

	it("keeps labels for retained entries and drops labels for discarded ones", () => {
		const session = SessionManager.create(tempDir);
		appendTurn(session, "first", "reply one", 1);
		const secondUser = session.appendMessage(userMessage("second", 10));
		session.appendMessage(assistantMessage("reply two", 11));
		session.appendLabelChange(secondUser, "label-on-second");
		session.appendLabelChange(session.getLeafId()!, "label-on-reply-two");

		session.rewind(secondUser);

		const onDisk = readFileSync(session.getSessionFile()!, "utf8");
		expect(onDisk).not.toContain("label-on-reply-two");
		expect(onDisk).not.toContain("label-on-second");
	});
});
