/**
 * The `codemode` tool as an extension. The CLI loads it as a built-in extension; SDK users
 * add `createCodemodeExtension()` to their extension factories.
 *
 * Codemode is active by default and hides prebuilt tool declarations while active.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { loadCodemodeExecutor } from "./execute.lazy.ts";
import type { CodemodeRuntime, HarnessLoopOutcome } from "./runtime.ts";
import { CODEMODE_TOOL_NAME, type CodemodeToolDetails, createCodemodeToolDefinition, isCodemodeTool } from "./tool.ts";

export const CODEMODE_LOOP_REMINDER_TYPE = "codemode-loop-reminder";

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
			runtime ??= loadCodemodeExecutor().then((module) => new module.CodemodeRuntime(pi, options.models ?? true));
			const current = await runtime;
			await current.sync(ctx);
			return current;
		};
		pi.on("session_start", async (_event, ctx) => {
			if (isCodemodeActive(pi)) await getRuntime(ctx);
		});
		pi.on("session_tree", async (_event, ctx) => {
			if (runtime) await (await runtime).sync(ctx);
		});
		pi.on("session_shutdown", async () => {
			if (runtime) (await runtime).close();
		});
		pi.registerCommand("harness", {
			description: "Inspect Harness versions or recover: /harness restore <revision|initial>",
			handler: async (args, ctx) => {
				const current = await getRuntime(ctx);
				const [command, revision] = args.trim().split(/\s+/);
				if (command === "restore" && revision) {
					if (!ctx.isIdle()) throw new Error("Wait for the current invocation before restoring the Harness");
					await current.harness.recover(revision, ctx);
				} else if (command && command !== "status")
					throw new Error("Usage: /harness status | /harness restore <revision|initial>");
				ctx.ui.notify(
					JSON.stringify({
						activeRevision: current.harness.activeRevision,
						requestRevision: current.harness.requestRevision,
						pending: current.harness.pending,
					}),
					"info",
				);
			},
		});
		let loopState: Record<string, unknown> = {};
		pi.on("agent_start", () => {
			loopState = {};
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
						"Only codemode is available. Define your own tools as Harness files, activate them, then call them through host.tools.call.",
				};
			}
		});
		pi.on("turn_end", async (event, ctx) => {
			if (
				event.outcome !== "completed" ||
				event.message.role !== "assistant" ||
				ctx.signal?.aborted ||
				!isCodemodeActive(pi)
			) {
				return;
			}
			const toolCalls = event.message.content
				.filter((part) => part.type === "toolCall")
				.map(({ id, name }) => ({ id, name }));
			const results: HarnessLoopOutcome["results"] = event.toolResults.map((result) => {
				const details = result.details as Partial<CodemodeToolDetails> | undefined;
				return {
					toolCallId: result.toolCallId,
					toolName: result.toolName,
					isError: result.isError,
					loopControl: details?.loopControl,
					error: result.isError
						? (details?.error ?? {
								kind: "host",
								message: result.content
									.filter((p) => p.type === "text")
									.map((p) => p.text)
									.join("\n"),
							})
						: undefined,
					calls: details?.calls ?? [],
				};
			});
			const controller = results.find((result) => result.toolName === CODEMODE_TOOL_NAME);
			const finalText = event.message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			const assistantFinish =
				toolCalls.length === 0 && event.message.stopReason === "stop" && finalText.trim() !== "";
			const outcome: HarnessLoopOutcome = {
				status:
					toolCalls.length > 1
						? "invalid_batch"
						: toolCalls.some((call) => call.name !== CODEMODE_TOOL_NAME)
							? "invalid_tool"
							: controller?.isError
								? "execution_failed"
								: controller?.loopControl === "next" || controller?.loopControl === "finish"
									? controller.loopControl
									: assistantFinish
										? "assistant_finish"
										: "missing_decision",
				...(assistantFinish ? { text: finalText } : {}),
				toolCalls,
				results,
			};
			const decision = await (await getRuntime(ctx)).decideLoop(outcome, loopState, ctx);
			loopState = decision.state;
			if (decision.action === "accept") return;
			const exhausted = decision.action === "stop";
			if (exhausted) ctx.abort();
			return {
				entries: [
					{
						type: "custom_message" as const,
						customType: CODEMODE_LOOP_REMINDER_TYPE,
						content: decision.text ?? "",
						display: true,
						details: {
							outcome,
							state: loopState,
							exhausted,
							revision: decision.revision,
							reminder: decision.reminder,
							role: "user",
						},
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
