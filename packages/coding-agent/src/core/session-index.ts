import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	FileEntry,
	SessionContext,
	SessionEntry,
	SessionHeader,
} from "./session-manager.ts";

interface IndexState {
	source: string;
	size: number;
	mtime: number;
	indexed_bytes: number;
}

interface Location {
	offset: number;
	length: number;
	parent_offset: number | null;
	checkpoint: number | null;
	model_offset: number | null;
	selection_offset: number | null;
	thinking_offset: number | null;
}

export interface IndexedSessionEntry {
	offset: number;
	end: number;
	entry: FileEntry;
}

export interface SessionHistoryPage {
	entries: IndexedSessionEntry[];
	/** Exclusive backward cursor and inclusive forward cursor, both in JSONL bytes. */
	before: number;
	after: number;
	hasEarlier: boolean;
	hasLater: boolean;
}

export interface SessionRecovery {
	header: SessionHeader;
	leafId: string | null;
	/** Raw branch suffix: retained pre-checkpoint records, checkpoint, then its tail. */
	entries: SessionEntry[];
	/** Settings can precede the retained suffix and must survive compaction. */
	settings: Pick<SessionContext, "model" | "thinkingLevel">;
	/** Latest explicit model choice, physical assistant model, and thinking change. */
	settingsEntries: SessionEntry[];
	/** JSONL bytes read by this recovery, excluding sync(). */
	bytesRead: number;
}

export interface CustomMessageMatch {
	key: string;
	/** Omit to find the latest message with this scalar detail present. */
	value?: string | number | boolean;
}

function detailHash(value: string | number | boolean): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Rebuildable byte index for an append-only pi JSONL file. It never writes the log.
 * Call sync() before reading to include new complete lines; an incomplete tail is
 * left for the next sync. Transcript bodies remain in JSONL, not in SQLite.
 */
export class SessionIndex {
	readonly file: string;
	readonly indexFile: string;
	private readonly db: DatabaseSync;

	constructor(file: string) {
		this.file = resolve(file);
		this.indexFile = this.file.replace(/(?:\.jsonl)?$/, ".index.sqlite");
		this.db = new DatabaseSync(this.indexFile);
		try {
			this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
			const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
			// Only derived offsets live here. A changed index schema is rebuilt from
			// JSONL by the next sync, without migrating or rewriting session history.
			if (version.user_version !== 2)
				this.db.exec(
					"DROP TABLE IF EXISTS entries; DROP TABLE IF EXISTS state; DROP TABLE IF EXISTS message_details;",
				);
			this.db.exec(`
				CREATE TABLE IF NOT EXISTS state (
					id INTEGER PRIMARY KEY CHECK (id = 1), source TEXT NOT NULL,
					size INTEGER NOT NULL, mtime REAL NOT NULL, indexed_bytes INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS entries (
					offset INTEGER PRIMARY KEY, length INTEGER NOT NULL,
					id TEXT NOT NULL, kind TEXT NOT NULL, parent_offset INTEGER,
					checkpoint INTEGER, model_offset INTEGER, selection_offset INTEGER,
					thinking_offset INTEGER, custom_type TEXT
				);
				CREATE INDEX IF NOT EXISTS entries_id ON entries(id, offset);
				CREATE INDEX IF NOT EXISTS entries_custom ON entries(kind, custom_type, offset);
				CREATE TABLE IF NOT EXISTS message_details (
					offset INTEGER NOT NULL, custom_type TEXT NOT NULL, key TEXT NOT NULL, value_hash TEXT NOT NULL,
					PRIMARY KEY (offset, key)
				);
				CREATE INDEX IF NOT EXISTS detail_lookup ON message_details(custom_type, key, value_hash, offset);
				PRAGMA user_version = 2;
				COMMIT;
			`);
		} catch (error) {
			this.db.close();
			throw error;
		}
	}

	/** Rebuild explicitly after editing old JSONL lines; normal appends need only sync(). */
	sync(rebuild = false): { bytesRead: number; indexedBytes: number } {
		this.db.exec("BEGIN IMMEDIATE");
		let fd: number | undefined;
		try {
			fd = openSync(this.file, "r");
			const stat = fstatSync(fd);
			const source = `${stat.dev}:${stat.ino}`;
			const previous = this.db.prepare("SELECT * FROM state WHERE id = 1").get() as IndexState | undefined;
			// Replacement/truncation invalidates every offset. In-place edits of old
			// history are outside the append-only contract and use sync(true).
			const reset = rebuild || !previous || previous.source !== source || stat.size < previous.size;
			if (!reset && previous.size === stat.size && previous.mtime === stat.mtimeMs) {
				this.db.exec("COMMIT");
				return { bytesRead: 0, indexedBytes: previous.indexed_bytes };
			}
			if (reset) this.db.exec("DELETE FROM entries; DELETE FROM state; DELETE FROM message_details;");
			let offset = reset ? 0 : previous.indexed_bytes;
			let position = offset;
			let pending = Buffer.alloc(0);
			let bytesRead = 0;
			const buffer = Buffer.allocUnsafe(1024 * 1024);
			const insert = this.db.prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
			const parent = this.db.prepare("SELECT * FROM entries WHERE id = ? ORDER BY offset DESC LIMIT 1");
			const detail = this.db.prepare("INSERT INTO message_details VALUES (?, ?, ?, ?)");
			while (position < stat.size) {
				const count = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
				if (!count) throw new Error("Session file was truncated during indexing");
				position += count;
				bytesRead += count;
				pending = Buffer.concat([pending, buffer.subarray(0, count)]);
				let start = 0;
				let newline = pending.indexOf(10, start);
				while (newline !== -1) {
					const length = newline + 1 - start;
					let entry: FileEntry | undefined;
					try {
						entry = JSON.parse(pending.subarray(start, newline).toString("utf8"));
					} catch {
						// Match pi's treatment of blank/malformed complete lines.
					}
					if (entry && typeof entry.id === "string" && typeof entry.type === "string") {
						const ancestor =
							entry.type !== "session" && entry.parentId
								? (parent.get(entry.parentId) as Location | undefined)
								: undefined;
						// Cache the branch's checkpoint while scanning, so finding it
						// later does not walk years of parent pointers.
						const checkpoint = entry.type === "compaction" ? offset : (ancestor?.checkpoint ?? null);
						const isAssistant = entry.type === "message" && entry.message.role === "assistant";
						insert.run(
							offset,
							length,
							entry.id,
							entry.type,
							ancestor?.offset ?? null,
							checkpoint,
							entry.type === "model_change" || isAssistant ? offset : (ancestor?.model_offset ?? null),
							entry.type === "model_change" ? offset : (ancestor?.selection_offset ?? null),
							entry.type === "thinking_level_change" ? offset : (ancestor?.thinking_offset ?? null),
							entry.type === "custom" || entry.type === "custom_message" ? entry.customType : null,
						);
						if (entry.type === "custom_message" && entry.details && typeof entry.details === "object") {
							for (const [key, value] of Object.entries(entry.details)) {
								if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
									// Hash scalar metadata so long text fields aren't duplicated in the index.
									detail.run(offset, entry.customType, key, detailHash(value));
								}
							}
						}
					}
					offset += length;
					start = newline + 1;
					newline = pending.indexOf(10, start);
				}
				pending = pending.subarray(start);
			}
			this.db
				.prepare("INSERT OR REPLACE INTO state VALUES (1, ?, ?, ?, ?)")
				.run(source, stat.size, stat.mtimeMs, offset);
			this.db.exec("COMMIT");
			return { bytesRead, indexedBytes: offset };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}

	readEntry(id: string): FileEntry | undefined {
		const row = this.db.prepare("SELECT * FROM entries WHERE id = ? ORDER BY offset DESC LIMIT 1").get(id) as
			| Location
			| undefined;
		return row ? this.readRows([row])[0].entry : undefined;
	}

	hasEntry(id: string): boolean {
		return !!this.db.prepare("SELECT 1 FROM entries WHERE id = ? AND kind != 'session' LIMIT 1").get(id);
	}

	entryCount(): number {
		return (
			this.db.prepare("SELECT count(*) AS count FROM entries WHERE kind != 'session'").get() as { count: number }
		).count;
	}

	/** Physical history, including abandoned branches; read only when explicitly requested. */
	readEntries(kind?: SessionEntry["type"]): SessionEntry[] {
		const rows = (kind === undefined
			? this.db.prepare("SELECT * FROM entries WHERE kind != 'session' ORDER BY offset").all()
			: this.db.prepare("SELECT * FROM entries WHERE kind = ? ORDER BY offset").all(kind)) as unknown as Location[];
		return this.readRows(rows).map((row) => row.entry as SessionEntry);
	}

	latestEntry(kind: SessionEntry["type"]): SessionEntry | undefined {
		const row = this.db.prepare("SELECT * FROM entries WHERE kind = ? ORDER BY offset DESC LIMIT 1").get(kind) as
			| Location
			| undefined;
		return row ? (this.readRows([row])[0].entry as SessionEntry) : undefined;
	}

	/** Search physical history by extension identity, independent of compaction/branching. */
	findCustomMessage(customType: string, match?: CustomMessageMatch): CustomMessageEntry | undefined {
		const row = (
			match
				? this.db
						.prepare(`SELECT e.* FROM message_details d JOIN entries e ON e.offset = d.offset
				WHERE d.custom_type = ? AND d.key = ? ${match.value === undefined ? "" : "AND d.value_hash = ?"}
				ORDER BY d.offset DESC LIMIT 1`)
						.get(
							...(match.value === undefined
								? [customType, match.key]
								: [customType, match.key, detailHash(match.value)]),
						)
				: this.db
						.prepare(
							"SELECT * FROM entries WHERE kind = 'custom_message' AND custom_type = ? ORDER BY offset DESC LIMIT 1",
						)
						.get(customType)
		) as Location | undefined;
		return row ? (this.readRows([row])[0].entry as CustomMessageEntry) : undefined;
	}

	/** Latest checkpoint on the selected leaf's branch, not an abandoned branch. */
	latestCompaction(leafId?: string): CompactionEntry | undefined {
		const leaf = this.leafLocation(leafId);
		if (leaf?.checkpoint == null) return undefined;
		const row = this.db.prepare("SELECT * FROM entries WHERE offset = ?").get(leaf.checkpoint) as unknown as Location;
		return this.readRows([row])[0].entry as CompactionEntry;
	}

	/** Read just what native context projection needs; old transcript bodies stay on disk. */
	readRecovery(leafId?: string | null): SessionRecovery {
		const headerRow = this.db.prepare("SELECT * FROM entries ORDER BY offset LIMIT 1").get() as Location | undefined;
		if (!headerRow) throw new Error("Session has no complete header; sync the index before reading");
		const header = this.readRows([headerRow])[0].entry;
		if (header.type !== "session" || header.version !== 3) {
			throw new Error("Indexed recovery requires a version 3 session; migrate it with SessionManager first");
		}
		let bytesRead = headerRow.length;
		const loaded = new Map<number, FileEntry>([[headerRow.offset, header]]);
		const leaf = this.leafLocation(leafId);
		let boundary = 0;
		let checkpoint: CompactionEntry | undefined;
		if (leaf?.checkpoint != null) {
			const row = this.db
				.prepare("SELECT * FROM entries WHERE offset = ?")
				.get(leaf.checkpoint) as unknown as Location;
			checkpoint = this.readRows([row])[0].entry as CompactionEntry;
			loaded.set(row.offset, checkpoint);
			bytesRead += row.length;
			const kept = this.db
				.prepare("SELECT offset FROM entries WHERE id = ? AND offset < ? ORDER BY offset DESC LIMIT 1")
				.get(checkpoint.firstKeptEntryId, row.offset) as { offset: number } | undefined;
			boundary = kept?.offset ?? row.offset;
		}
		let rows = leaf ? this.branchRows(leaf, boundary) : [];
		// Native projection retains nothing if firstKeptEntryId is not an ancestor
		// (for example it points at an abandoned branch). Do not include that branch.
		if (checkpoint && !rows.some((row) => row.offset === boundary)) {
			rows = rows.filter((row) => row.offset >= leaf!.checkpoint!);
		}
		const settingsRows = [...new Set([leaf?.selection_offset, leaf?.model_offset, leaf?.thinking_offset])]
			.filter((offset): offset is number => offset != null)
			.sort((a, b) => a - b)
			.map((offset) => this.db.prepare("SELECT * FROM entries WHERE offset = ?").get(offset) as unknown as Location);
		const unread = new Map(
			[...rows, ...settingsRows].filter((row) => !loaded.has(row.offset)).map((row) => [row.offset, row]),
		);
		for (const record of this.readRows([...unread.values()])) {
			loaded.set(record.offset, record.entry);
			bytesRead += record.end - record.offset;
		}
		const settingsEntries = settingsRows.map((row) => loaded.get(row.offset) as SessionEntry);
		const settings: SessionRecovery["settings"] = { model: null, thinkingLevel: "off" };
		for (const entry of settingsEntries) {
			if (entry.type === "thinking_level_change") settings.thinkingLevel = entry.thinkingLevel;
			else if (entry.type === "model_change") settings.model = { provider: entry.provider, modelId: entry.modelId };
			else if (entry.type === "message" && entry.message.role === "assistant") {
				settings.model = { provider: entry.message.provider, modelId: entry.message.model };
			}
		}
		const entries = rows.map((row) => loaded.get(row.offset) as SessionEntry);
		return { header, leafId: entries.at(-1)?.id ?? null, entries, settings, settingsEntries, bytesRead };
	}

	/** Full history is explicit and on demand, including records before compaction. */
	readBranch(leafId?: string | null): SessionEntry[] {
		const leaf = this.leafLocation(leafId);
		return leaf ? this.readRows(this.branchRows(leaf)).map((row) => row.entry as SessionEntry) : [];
	}

	/** Restore extension deltas without loading unrelated message bodies. */
	readCustomEntries(customType: string, leafId?: string | null): CustomEntry[] {
		const leaf = this.leafLocation(leafId);
		return leaf ? this.readRows(this.branchRows(leaf, 0, customType)).map((row) => row.entry as CustomEntry) : [];
	}

	private leafLocation(id?: string | null): Location | undefined {
		if (id === null) return undefined;
		const row =
			id === undefined
				? this.db.prepare("SELECT * FROM entries WHERE kind != 'session' ORDER BY offset DESC LIMIT 1").get()
				: this.db
						.prepare("SELECT * FROM entries WHERE id = ? AND kind != 'session' ORDER BY offset DESC LIMIT 1")
						.get(id);
		if (id !== undefined && !row) throw new Error(`Session entry ${id} not found`);
		return row as Location | undefined;
	}

	private branchRows(leaf: Location, boundary = 0, customType?: string): Location[] {
		return this.db
			.prepare(`
			WITH RECURSIVE branch AS (
				SELECT * FROM entries WHERE offset = ?
				UNION ALL
				SELECT e.* FROM entries e JOIN branch b ON e.offset = b.parent_offset WHERE e.offset >= ?
			)
			SELECT * FROM branch ${customType === undefined ? "" : "WHERE kind = 'custom' AND custom_type = ?"}
			ORDER BY offset
		`)
			.all(
				...(customType === undefined ? [leaf.offset, boundary] : [leaf.offset, boundary, customType]),
			) as unknown as Location[];
	}

	/** Pages are chronological; without a cursor, return the newest page. */
	readPage({
		before,
		after,
		limit = 100,
	}: {
		before?: number;
		after?: number;
		limit?: number;
	} = {}): SessionHistoryPage {
		if (before !== undefined && after !== undefined) throw new Error("Choose before or after, not both");
		if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Page limit must be 1–500");
		const rows = (after !== undefined
			? this.db.prepare("SELECT * FROM entries WHERE offset >= ? ORDER BY offset LIMIT ?").all(after, limit)
			: this.db
					.prepare("SELECT * FROM entries WHERE offset < ? ORDER BY offset DESC LIMIT ?")
					.all(before ?? Number.MAX_SAFE_INTEGER, limit)) as unknown as Location[];
		if (after === undefined) rows.reverse();
		const entries = this.readRows(rows);
		const first = entries[0]?.offset ?? after ?? before ?? 0;
		const last = entries.at(-1)?.end ?? first;
		return {
			entries,
			before: first,
			after: last,
			hasEarlier: !!this.db.prepare("SELECT 1 FROM entries WHERE offset < ? LIMIT 1").get(first),
			hasLater: !!this.db.prepare("SELECT 1 FROM entries WHERE offset >= ? LIMIT 1").get(last),
		};
	}

	private readRows(rows: Location[]): IndexedSessionEntry[] {
		if (!rows.length) return [];
		const fd = openSync(this.file, "r");
		try {
			return rows.map((row) => {
				const buffer = Buffer.allocUnsafe(row.length);
				let count = 0;
				while (count < buffer.length) {
					const read = readSync(fd, buffer, count, buffer.length - count, row.offset + count);
					if (!read) throw new Error("Session file changed; sync the index before reading");
					count += read;
				}
				return { offset: row.offset, end: row.offset + row.length, entry: JSON.parse(buffer.toString("utf8")) };
			});
		} finally {
			closeSync(fd);
		}
	}

	close(): void {
		this.db.close();
	}
}
