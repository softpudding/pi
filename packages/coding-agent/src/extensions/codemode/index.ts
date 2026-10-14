/**
 * The `codemode` tool as an extension. The CLI loads it as a built-in extension; SDK users
 * add `createCodemodeExtension()` to their extension factories.
 *
 * Codemode is active by default and hides prebuilt tool declarations while active.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { loadCodemodeExecutor } from "./execute.lazy.ts";
import type { CodemodeRuntime } from "./runtime.ts";
import { CODEMODE_TOOL_NAME, type CodemodeToolDetails, createCodemodeToolDefinition, isCodemodeTool } from "./tool.ts";

export const CODEMODE_LOOP_REMINDER_TYPE = "codemode-loop-reminder";
const MAX_LOOP_CORRECTIONS = 3;

export interface CodemodeExtensionOptions {
	/** Activate codemode by default. SDK users may opt out and select their own initial tools. */
	defaultActive?: boolean;
	/** Expose the model catalog and classifiers to scripts as `models`. Default: `true`. */
	models?: boolean;
}

function isCodemodeActive(pi: ExtensionAPI): boolean {
	return pi.getActiveTools().includes(CODEMODE_TOOL_NAME) && pi.getAllTools().some(isCodemodeTool);
}

export function createCodemodeExtension(options: CodemodeExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		let runtime: Promise<CodemodeRuntime> | undefined;
		const getRuntime = async (ctx: ExtensionContext) => {
			runtime ??= loadCodemodeExecutor().then((module) => new module.CodemodeRuntime(pi));
			const current = await runtime;
			current.sync(ctx);
			return current;
		};
		pi.on("session_start", async (_event, ctx) => {
			if (isCodemodeActive(pi)) await getRuntime(ctx);
		});
		pi.on("session_tree", async (_event, ctx) => {
			if (runtime) (await runtime).sync(ctx);
		});
		pi.on("session_shutdown", async () => {
			if (runtime) (await runtime).close();
		});
		let corrections = 0;
		pi.on("agent_start", () => {
			corrections = 0;
		});
		pi.on("tool_call", (event, ctx) => {
			if (event.parentToolCallId !== undefined || !isCodemodeActive(pi)) return;
			// The complete assistant message is persisted before any tool is prepared. Check it
			// for every top-level call, including ordinary tools placed before codemode.
			const entry = ctx.sessionManager
				.getBranch()
				.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
			if (entry?.type !== "message" || entry.message.role !== "assistant") return;
			const calls = entry.message.content.filter((part) => part.type === "toolCall");
			if (
				calls.length > 1 &&
				calls.some((call) => call.name === CODEMODE_TOOL_NAME) &&
				calls.some((call) => call.id === event.toolCallId)
			) {
				return {
					block: true,
					reason:
						"Invalid codemode batch: codemode must be the only top-level tool call in a response. No calls in this batch were executed. Combine all operations into one codemode script; use Promise.allSettled for independent calls inside it, then return loop.next(results) or return loop.finish(answer).",
				};
			}
			if (event.toolName !== CODEMODE_TOOL_NAME) {
				return {
					block: true,
					reason:
						"Only codemode is available. Define and register your own tools with host primitives, then call them through host.tools.call.",
				};
			}
		});
		pi.on("turn_end", (event, ctx) => {
			if (event.outcome !== "completed" || ctx.signal?.aborted || !isCodemodeActive(pi)) {
				return;
			}
			const controlled = event.toolResults.some((result) => {
				const control = (result.details as Partial<CodemodeToolDetails> | undefined)?.loopControl;
				return (
					result.toolName === CODEMODE_TOOL_NAME && !result.isError && (control === "next" || control === "finish")
				);
			});
			if (controlled) {
				corrections = 0;
				return;
			}

			const exhausted = corrections >= MAX_LOOP_CORRECTIONS;
			if (exhausted) ctx.abort();
			else corrections++;
			return {
				entries: [
					{
						type: "custom_message" as const,
						customType: CODEMODE_LOOP_REMINDER_TYPE,
						content: exhausted
							? "Loop control protocol error: no valid codemode loop decision after three corrections. The run was stopped, not successfully finished."
							: "You did not correctly control the agent loop with codemode. Your response has not finished the task. Call codemode exactly once, with no sibling top-level tool calls, and return loop.next(results) to continue, or return loop.finish(answer) to finish. If you already have the answer, use return loop.finish(answer) now; do not repeat completed tool actions. Prior messages and results remain in context.",
						display: true,
						details: { attempt: corrections, exhausted },
					},
				],
				continue: !exhausted,
			};
		});
		pi.registerTool({
			...createCodemodeToolDefinition({
				appendEntry: (customType, data) => pi.appendEntry(customType, data),
				models: options.models ?? true,
				getRuntime,
			}),
			defaultActive: options.defaultActive ?? true,
		});
	};
}

export default createCodemodeExtension();
