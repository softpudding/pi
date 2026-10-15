import { describe, expect, it } from "vitest";
import {
	type HarnessRequestRecord,
	inspectRequest,
	resolveInspectionQuery,
} from "../src/extensions/codemode/harness/inspection.ts";

const record: HarnessRequestRecord = {
	requestId: "q-first",
	revision: "r-first",
	inputSnapshot: "i-first",
	system: [{ id: "text", text: "A\u{1f600}B\n中文" }],
	description: "",
	provenance: [],
	estimatedTokens: 0,
	tokenEstimate: "characters/4",
	history: [],
	historyChars: 0,
	externalContributions: {},
	hostOwned: [],
};
describe("inspection page boundaries", () => {
	it("preserves Unicode and always advances at the smallest page size", () => {
		let page = inspectRequest(record, { section: "system", id: "text", limit: 2 });
		const pages = [page.text];
		while (page.next) {
			const query = resolveInspectionQuery(page.next);
			expect(query.requestId).toBe(record.requestId);
			expect(query.offset).toBeGreaterThan(page.offset);
			page = inspectRequest(record, query);
			pages.push(page.text);
		}
		expect(pages).toEqual(["A", "\u{1f600}", "B\n", "中文"]);
		expect(pages.join("")).toBe(record.system[0].text);
	});
	it("rejects malformed cursors and using a cursor with a different saved request", () => {
		for (const cursor of ["", "h2.e30", "h1.e30", "h1.@@", "h1.W10", "h1."])
			expect(() => resolveInspectionQuery({ cursor })).toThrow("Invalid inspect cursor");
		const page = inspectRequest(record, { section: "system", limit: 2 });
		expect(() => inspectRequest({ ...record, requestId: "q-second" }, resolveInspectionQuery(page.next!))).toThrow(
			"does not belong to this saved request",
		);
	});
	it("rejects split characters and out-of-range offsets, and handles empty content", () => {
		expect(() => inspectRequest(record, { section: "system", offset: 2, requestId: record.requestId })).toThrow(
			"splits a Unicode character",
		);
		expect(() => inspectRequest(record, { section: "system", offset: 100, requestId: record.requestId })).toThrow(
			"exceeds section length",
		);
		expect(inspectRequest(record, { section: "codemode" })).toMatchObject({
			text: "",
			offset: 0,
			totalChars: 0,
			eof: true,
			next: null,
		});
	});
});
