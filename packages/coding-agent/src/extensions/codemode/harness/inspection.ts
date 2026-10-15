/** Inspection reads saved request results, never re-executes context rules. */
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { Provenance } from "./definition.ts";

export interface HarnessRequestRecord {
	requestId: string;
	revision: string;
	inputSnapshot: string;
	system: { id: string; text: string }[];
	description: string;
	catalog?: unknown;
	provenance: Provenance[];
	estimatedTokens: number;
	tokenEstimate: string;
	history: { role: string; hash: string }[];
	historyChars: number;
	externalContributions: unknown;
	hostOwned: string[];
}

const detailSection = Type.Union([Type.Literal("system"), Type.Literal("codemode"), Type.Literal("provenance")]);
const pageLimit = Type.Integer({ minimum: 2, maximum: 12000 });
const startQuery = Type.Object(
	{
		section: Type.Optional(Type.Union([Type.Literal("overview"), detailSection])),
		requestId: Type.Optional(Type.String()),
		id: Type.Optional(Type.String()),
		limit: Type.Optional(pageLimit),
	},
	{ additionalProperties: false },
);
export const inspectionQuerySchema = Type.Union([
	startQuery,
	Type.Object(
		{ cursor: Type.String({ maxLength: 4096 }), limit: Type.Optional(pageLimit) },
		{ additionalProperties: false },
	),
]);
export type InspectionQuery = Static<typeof inspectionQuerySchema>;
const cursorData = Type.Object(
	{
		requestId: Type.String(),
		section: detailSection,
		id: Type.Optional(Type.String()),
		offset: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	},
	{ additionalProperties: false },
);
type ResolvedQuery = Static<typeof startQuery> & { offset?: number };

export function resolveInspectionQuery(query: InspectionQuery): ResolvedQuery {
	if (!("cursor" in query)) return query;
	try {
		if (!/^h1\.[A-Za-z0-9_-]+$/.test(query.cursor) || query.cursor.length > 4096) throw new Error();
		const decoded: unknown = JSON.parse(Buffer.from(query.cursor.slice(3), "base64url").toString("utf8"));
		if (!Check(cursorData, decoded)) throw new Error();
		return { ...decoded, limit: query.limit };
	} catch {
		throw new Error("Invalid inspect cursor. Pass a saved page's next object to host.harness.inspect unchanged.");
	}
}

export function inspectRequest(record: HarnessRequestRecord, query: ResolvedQuery) {
	if (query.requestId !== undefined && query.requestId !== record.requestId)
		throw new Error("Inspection cursor does not belong to this saved request");
	const section = query.section;
	if (!section || section === "overview") throw new Error("Detail inspection requires a section");
	if (query.id !== undefined && section !== "system") throw new Error("id selects a system block only");
	let body: string;
	if (section === "system") {
		const blocks = query.id === undefined ? record.system : record.system.filter((block) => block.id === query.id);
		if (!blocks.length)
			throw new Error(
				`Unknown system block ${query.id}. Available IDs: ${record.system.map((block) => block.id).join(", ")}`,
			);
		body = blocks.map((block) => block.text).join("\n\n");
	} else if (section === "codemode") body = record.description;
	else
		body = JSON.stringify(
			{
				inputSnapshot: record.inputSnapshot,
				outputs: record.provenance,
				externalContributions: record.externalContributions,
				hostOwned: record.hostOwned,
			},
			null,
			2,
		);
	const offset = query.offset ?? 0;
	const limit = query.limit ?? 4000;
	if (offset > 0 && !query.requestId) throw new Error("Inspection continuation has no saved request");
	if (offset > body.length) throw new Error(`inspect offset ${offset} exceeds section length ${body.length}`);
	// Offsets count UTF-16 code units, like String.slice. Never split a surrogate pair.
	if (offset > 0 && /[\uDC00-\uDFFF]/.test(body.charAt(offset)) && /[\uD800-\uDBFF]/.test(body.charAt(offset - 1)))
		throw new Error("inspect offset splits a Unicode character; use the previous page's next object");
	let end = Math.min(body.length, offset + limit);
	if (end < body.length && /[\uD800-\uDBFF]/.test(body.charAt(end - 1)) && /[\uDC00-\uDFFF]/.test(body.charAt(end)))
		end--;
	return {
		section,
		...(query.id === undefined ? {} : { id: query.id }),
		offset,
		text: body.slice(offset, end),
		totalChars: body.length,
		eof: end === body.length,
		next:
			end === body.length
				? null
				: {
						cursor: `h1.${Buffer.from(
							JSON.stringify({ requestId: record.requestId, section, id: query.id, offset: end }),
						).toString("base64url")}`,
						limit,
					},
	};
}
