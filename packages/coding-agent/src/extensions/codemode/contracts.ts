/** One source for host API parameter validation and model-facing function declarations. */
import { type CodemodeTool, renderDeclarations, schemaToType } from "@earendil-works/pi-codemode";
import { type TSchema, Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { normalizeEditReplacements } from "../../core/tools/edit.ts";
import { inspectionQuerySchema } from "./harness/inspection.ts";

const draftTarget = Type.Object(
	{ draft: Type.String(), baseRevision: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);
const revisionTarget = Type.Object({ revision: Type.String() }, { additionalProperties: false });
const fileResult = Type.Object({
	text: Type.String(),
	details: Type.Optional(Type.Unknown()),
	harness: Type.Object({
		domain: Type.Literal("harness"),
		path: Type.String(),
		revision: Type.Optional(Type.String()),
		draft: Type.Optional(Type.String()),
		draftSequence: Type.Optional(Type.Integer()),
	}),
});
const preview = Type.Object({
	system: Type.Unknown(),
	description: Type.String(),
	catalog: Type.Optional(Type.Unknown()),
	parameterDescriptions: Type.Optional(
		Type.Object({
			code: Type.Optional(Type.String()),
			data: Type.Optional(Type.String()),
			finish: Type.Optional(Type.String()),
		}),
	),
	provenance: Type.Unknown(),
	inputSnapshot: Type.String(),
	estimatedTokens: Type.Number(),
});
const inspectionSection = Type.Union([Type.Literal("system"), Type.Literal("codemode"), Type.Literal("provenance")]);
const inspectionNext = Type.Object({
	cursor: Type.String(),
	limit: Type.Integer(),
});
const inspectionMeta = {
	requestId: Type.Optional(Type.String()),
	requestRevision: Type.String(),
	activeRevision: Type.String(),
};

interface Contract {
	description: string;
	inputSchema: TSchema;
	outputSchema: TSchema;
	optionalInput?: boolean;
	prepareInput?: (input: unknown) => unknown;
}

const harnessContracts: Record<string, Contract> = {
	inspect: {
		description:
			"Default: compact composition overview, including this request's view mappings. Detail section system (optional block id), codemode, or provenance reads saved request output. Pages default to 4000 UTF-16 characters, maximum 12000. Continue with inspect(page.next); its opaque cursor binds the saved request, section and position across loop.next and activation. next is null at EOF. Active may differ from requestRevision after activation now. Definition source uses read, never inspect.",
		inputSchema: inspectionQuerySchema,
		optionalInput: true,
		outputSchema: Type.Union([
			Type.Object({
				section: Type.Literal("overview"),
				...inspectionMeta,
				pendingActivation: Type.Optional(
					Type.Object({ revision: Type.String(), expectedActiveRevision: Type.String() }),
				),
				drafts: Type.Array(
					Type.Object({ id: Type.String(), baseRevision: Type.String(), sequence: Type.Integer() }),
				),
				files: Type.Array(Type.String()),
				context: Type.Optional(
					Type.Object({
						system: Type.Array(Type.Object({ id: Type.String(), chars: Type.Integer() })),
						codemode: Type.Object({ id: Type.String(), chars: Type.Integer() }),
						history: Type.Object({ id: Type.String(), messages: Type.Integer(), chars: Type.Integer() }),
					}),
				),
				sources: Type.Array(Type.Object({ output: Type.String(), dependencies: Type.Array(Type.String()) })),
				views: Type.Record(Type.String(), Type.String()),
				viewDefinitions: Type.String(),
			}),
			Type.Object({
				...inspectionMeta,
				section: inspectionSection,
				id: Type.Optional(Type.String()),
				offset: Type.Integer(),
				text: Type.String(),
				totalChars: Type.Integer(),
				eof: Type.Boolean(),
				next: Type.Union([inspectionNext, Type.Null()]),
			}),
		]),
	},
	begin: {
		description:
			"Create a mutable draft from a revision; default base is active. The returned handle can be passed directly as read/write/edit/remove target and to prepare/discard. Its baseRevision is the activation precondition.",
		inputSchema: Type.Object({ base: Type.Optional(Type.String()) }),
		optionalInput: true,
		outputSchema: Type.Object({ draft: Type.String(), baseRevision: Type.String() }),
	},
	read: {
		description:
			"Read definition text with native Pi continuation notices. Default target is request; offset is a 1-based line number and limit a line count. Follow continuation notices. Its text field is displayable as a plain string.",
		inputSchema: Type.Object({
			target: Type.Optional(Type.Union([draftTarget, revisionTarget])),
			path: Type.String(),
			offset: Type.Optional(Type.Integer({ minimum: 1 })),
			limit: Type.Optional(Type.Integer({ minimum: 1 })),
		}),
		outputSchema: fileResult,
	},
	write: {
		description:
			"Create or replace a logical definition file, including parents. Revisions are read-only; writes require a draft.",
		inputSchema: Type.Object({ target: draftTarget, path: Type.String(), content: Type.String() }),
		outputSchema: fileResult,
	},
	edit: {
		description:
			"Replace unique, disjoint regions of the original draft file using native Pi matching. Keep oldText as small as possible while unique; avoid large unchanged regions. Match all edits against the original, not earlier replacements; merge nearby changes and never overlap or nest edits. Requires a draft target; baseRevision, when supplied, must match the draft. Native normalization accepts one edit object or a JSON string containing an array/object before validation. Document text is never guessed or unescaped. The result contains the native patch.",
		prepareInput: (input) =>
			input && typeof input === "object" && !Array.isArray(input)
				? { ...input, edits: normalizeEditReplacements((input as Record<string, unknown>).edits) }
				: input,
		inputSchema: Type.Object({
			target: draftTarget,
			path: Type.String(),
			edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), { minItems: 1 }),
		}),
		outputSchema: fileResult,
	},
	remove: {
		description: "Remove one logical file from a draft.",
		inputSchema: Type.Object({ target: draftTarget, path: Type.String() }),
		outputSchema: Type.Object({ draft: Type.String(), path: Type.String(), draftSequence: Type.Integer() }),
	},
	discard: {
		description: "Discard a draft; already prepared immutable revisions remain available.",
		inputSchema: draftTarget,
		outputSchema: Type.Object({ status: Type.Literal("discarded"), draft: Type.String() }),
	},
	prepare: {
		description:
			"Validate references, exports and pure context rendering, then freeze a candidate. No task tool executes. Later draft edits cannot change this revision. Retain revision and baseRevision to activate it. Returns literal diffs, diagnostics and generated preview content.",
		inputSchema: draftTarget,
		outputSchema: Type.Object({
			revision: Type.String(),
			baseRevision: Type.String(),
			draftSequence: Type.Integer(),
			diagnostics: Type.Array(Type.Unknown()),
			preview,
			diff: Type.Array(Type.String()),
		}),
	},
	activate: {
		description:
			"Compare-and-swap the active version; conflicts reject the change. Default next_request schedules before the next inference. Explicit now enables new calls in this controller, without changing its already-sent context or in-flight tool chains. Only one activation may be pending. Older prepared revisions can be activated for rollback; external effects and state are not rolled back.",
		inputSchema: Type.Object({
			revision: Type.String({ description: "Immutable candidate revision returned by prepare." }),
			expectedActiveRevision: Type.String({
				description:
					"Active revision this change is based on: baseRevision from begin/prepare, or an explicitly inspected activeRevision for rollback.",
			}),
			when: Type.Optional(Type.Union([Type.Literal("next_request"), Type.Literal("now")])),
		}),
		outputSchema: Type.Object({
			status: Type.Union([Type.Literal("scheduled"), Type.Literal("active")]),
			revision: Type.String(),
			requestRevision: Type.String(),
		}),
	},
	cancelActivation: {
		description: "Cancel the scheduled activation of this revision.",
		inputSchema: Type.Object({ revision: Type.String() }),
		outputSchema: Type.Object({ status: Type.Literal("cancelled") }),
	},
};

const pathInput = Type.Object({ path: Type.String() });
const idInput = Type.Object({ id: Type.String() });
const keyInput = Type.Object({ key: Type.String() });
const nameInput = Type.Object({ name: Type.String() });
const encoding = Type.Union([Type.Literal("utf8"), Type.Literal("base64")]);
const byteCount = Type.Integer({ minimum: 1, maximum: 8 * 1024 * 1024 });
const byteOffset = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const chunk = Type.Object({ data: Type.String(), bytes: Type.Integer(), eof: Type.Boolean() });
const written = Type.Object({ bytes: Type.Integer() });
const handler = Type.Object({ module: Type.String(), file: Type.String(), export: Type.String() });
const tool = Type.Object({
	name: Type.String(),
	description: Type.String(),
	parameters: Type.Record(Type.String(), Type.Unknown()),
	outputSchema: Type.Optional(Type.Unknown()),
	handler,
});
const contracts: Record<string, Contract> = {
	...Object.fromEntries(
		Object.entries(harnessContracts).map(([name, contract]) => [`host.harness.${name}`, contract]),
	),
	"host.tools.list": {
		description:
			"List all internal tools in the selected active snapshot, including entries omitted from the displayed catalog.",
		inputSchema: Type.Object({}),
		optionalInput: true,
		outputSchema: Type.Array(tool),
	},
	"host.tools.describe": {
		description: "Get one internal tool definition, or undefined if the name is not defined.",
		inputSchema: nameInput,
		outputSchema: Type.Unknown(),
	},
	"host.tools.call": {
		description:
			"Call a defined internal tool. Returns its handler's data unchanged, with or without outputSchema. Failed calls throw. Primitives are direct host functions, not tool names.",
		inputSchema: Type.Object({
			name: Type.String(),
			args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
		outputSchema: Type.Unknown(),
	},
	"host.hooks.list": {
		description: "List hooks in the selected active snapshot.",
		inputSchema: Type.Object({}),
		optionalInput: true,
		outputSchema: Type.Array(Type.Object({ id: Type.String(), event: Type.String(), handler })),
	},
	"host.calls.list": {
		description: "List active internal invocations and their pinned revisions.",
		inputSchema: Type.Object({}),
		optionalInput: true,
		outputSchema: Type.Array(Type.Object({ id: Type.String(), handler, revision: Type.String() })),
	},
	"host.calls.cancel": {
		description: "Interrupt one active invocation.",
		inputSchema: idInput,
		outputSchema: Type.Unknown(),
	},
	"host.state.get": {
		description: "Read module- and branch-scoped JSON state; missing keys return undefined.",
		inputSchema: keyInput,
		outputSchema: Type.Unknown(),
	},
	"host.state.set": {
		description:
			"Immediately persist module- and branch-scoped JSON state, capped at 4 MiB. An omitted value deletes the key.",
		inputSchema: Type.Object({ key: Type.String(), value: Type.Optional(Type.Unknown()) }),
		outputSchema: Type.Unknown(),
	},
	"host.state.delete": {
		description: "Delete a module- and branch-scoped state key.",
		inputSchema: keyInput,
		outputSchema: Type.Unknown(),
	},
	"host.session.history": {
		description:
			"Read raw branch message entries, excluding definition metadata. Defaults: offset 0, limit 20; maximum limit 100.",
		inputSchema: Type.Object({
			offset: Type.Optional(byteOffset),
			limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
		}),
		optionalInput: true,
		outputSchema: Type.Array(Type.Unknown()),
	},
	"host.env.info": {
		description: "Inspect the task execution environment.",
		inputSchema: Type.Object({}),
		optionalInput: true,
		outputSchema: Type.Object({ cwd: Type.String(), platform: Type.String() }),
	},
	"host.fs.read": {
		description:
			"Read task-file bytes. Defaults: offset 0, length 65536, encoding utf8. Maximum length 8 MiB. Continue offset += bytes until eof. UTF-8 chunks may split a character; base64 preserves exact bytes.",
		inputSchema: Type.Object({
			path: Type.String(),
			offset: Type.Optional(byteOffset),
			length: Type.Optional(byteCount),
			encoding: Type.Optional(encoding),
		}),
		outputSchema: chunk,
	},
	"host.fs.write": {
		description: "Write a task file; parent directories must exist. Default encoding utf8; append defaults to false.",
		inputSchema: Type.Object({
			path: Type.String(),
			data: Type.String(),
			encoding: Type.Optional(encoding),
			append: Type.Optional(Type.Boolean()),
		}),
		outputSchema: written,
	},
	"host.fs.stat": {
		description: "Inspect a task-file path; size is in bytes and mtimeMs is epoch milliseconds.",
		inputSchema: pathInput,
		outputSchema: Type.Object({
			size: Type.Number(),
			mtimeMs: Type.Number(),
			type: Type.Union([Type.Literal("directory"), Type.Literal("file")]),
		}),
	},
	"host.fs.list": {
		description: "List immediate directory entries in the task filesystem.",
		inputSchema: pathInput,
		outputSchema: Type.Array(
			Type.Object({
				name: Type.String(),
				type: Type.Union([Type.Literal("directory"), Type.Literal("file"), Type.Literal("symlink")]),
			}),
		),
	},
	"host.fs.mkdir": {
		description: "Create a task directory; recursive defaults to false.",
		inputSchema: Type.Object({ path: Type.String(), recursive: Type.Optional(Type.Boolean()) }),
		outputSchema: Type.Unknown(),
	},
	"host.fs.rename": {
		description: "Rename a task path.",
		inputSchema: Type.Object({ from: Type.String(), to: Type.String() }),
		outputSchema: Type.Unknown(),
	},
	"host.fs.remove": {
		description: "Remove a task path; recursive defaults to false.",
		inputSchema: Type.Object({ path: Type.String(), recursive: Type.Optional(Type.Boolean()) }),
		outputSchema: Type.Unknown(),
	},
	"host.clock.now": {
		description: "Read wall and monotonic clocks.",
		inputSchema: Type.Object({}),
		optionalInput: true,
		outputSchema: Type.Object({ unixMs: Type.Number(), monotonicMs: Type.Number() }),
	},
	"host.clock.sleep": {
		description: "Wait for a duration in milliseconds, respecting cancellation.",
		inputSchema: Type.Object({ ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483647 })) }),
		outputSchema: Type.Unknown(),
	},
	"host.process.spawn": {
		description:
			"Start a task process without an implicit shell. Arguments are separate strings. cwd defaults to task cwd; env extends the inherited environment. Handles belong to this invocation.",
		inputSchema: Type.Object({
			program: Type.String(),
			args: Type.Optional(Type.Array(Type.String())),
			cwd: Type.Optional(Type.String()),
			env: Type.Optional(Type.Record(Type.String(), Type.String())),
		}),
		outputSchema: Type.Object({
			id: Type.String(),
			stdin: Type.String(),
			stdout: Type.String(),
			stderr: Type.String(),
		}),
	},
	"host.process.wait": {
		description:
			"Wait for process exit. Drain stdout and stderr concurrently before waiting to avoid pipe deadlocks.",
		inputSchema: idInput,
		outputSchema: Type.Object({
			exitCode: Type.Union([Type.Integer(), Type.Null()]),
			signal: Type.Union([Type.String(), Type.Null()]),
		}),
	},
	"host.process.terminate": {
		description: "Terminate the process tree.",
		inputSchema: idInput,
		outputSchema: Type.Unknown(),
	},
	"host.streams.read": {
		description: "Read a process stream. Defaults: maxBytes 65536, encoding utf8; maximum 8 MiB. Continue until eof.",
		inputSchema: Type.Object({
			id: Type.String(),
			maxBytes: Type.Optional(byteCount),
			encoding: Type.Optional(encoding),
		}),
		outputSchema: chunk,
	},
	"host.streams.write": {
		description: "Write a process stream; default encoding utf8.",
		inputSchema: Type.Object({ id: Type.String(), data: Type.String(), encoding: Type.Optional(encoding) }),
		outputSchema: written,
	},
	"host.streams.close": {
		description: "Close an invocation-owned stream.",
		inputSchema: idInput,
		outputSchema: Type.Unknown(),
	},
};

const declarations = Object.entries(contracts).map(([name, contract]) => {
	const inputSchema = { ...contract.inputSchema };
	const outputSchema = { ...contract.outputSchema };
	return {
		name,
		...contract,
		inputSchema,
		outputSchema,
		signature: `(args${contract.optionalInput ? "?" : ""}: ${schemaToType(inputSchema)}): Promise<${schemaToType(outputSchema)}>`,
		execute: () => undefined,
	};
});

export const HOST_API_DECLARATIONS = renderDeclarations({ globals: declarations });

export function bindHostContract(name: string, execute: CodemodeTool["execute"]): CodemodeTool {
	const declaration = declarations.find((entry) => entry.name === name);
	if (!declaration) throw new Error(`Missing host API contract: ${name}`);
	return {
		...declaration,
		execute: (input, call) => {
			const supplied = input === undefined && declaration.optionalInput ? {} : input;
			const args = declaration.prepareInput ? declaration.prepareInput(supplied) : supplied;
			if (!Check(declaration.inputSchema, args)) {
				const errors = Errors(declaration.inputSchema, args).map(
					(error) => `${error.instancePath || "/"}: ${error.message}`,
				);
				throw new Error(
					`Invalid arguments for ${declaration.name}:\n${errors.join("\n")}\nContract: ${declaration.name}${declaration.signature}\n${declaration.description}`,
				);
			}
			return execute(args, call);
		},
	};
}
