/** Host integration only. This interface is never exposed to model programs. */
import type { AgentTool, AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "../../../core/extensions/types.ts";
import type { CodemodeRuntime } from "../runtime.ts";

type RuntimeGetter = (ctx: ExtensionContext) => Promise<CodemodeRuntime>;
const runtimes = new WeakMap<object, RuntimeGetter>();

export function attachHarnessRuntime(definition: { execute: object }, get: RuntimeGetter): void {
	runtimes.set(definition.execute, get);
}

export function getHarnessRuntime(
	definition: ToolDefinition | undefined,
	ctx: ExtensionContext,
): Promise<CodemodeRuntime> | undefined {
	return definition && runtimes.get(definition.execute)?.(ctx);
}

export type HarnessExecutor = (
	parentId: string,
	name: string,
	args: unknown,
	tools: AgentTool[],
	signal?: AbortSignal,
) => Promise<AgentToolCallOutcome>;
