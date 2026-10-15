/** Editable summary policy; the host supplies a credential-free inference operation. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import {
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	getCompactionGroups,
} from "../../../core/compaction/compaction.ts";
import { computeFileLists, createFileOps, extractFileOpsFromMessage } from "../../../core/compaction/utils.ts";
import { type SessionEntry, sessionEntryToContextMessages } from "../../../core/session-manager.ts";
import { combineUsage } from "../../../core/usage-totals.ts";
import { object, string } from "../primitives.ts";
import { evaluate, fileText, type HarnessSnapshot, runRule, yamlValue } from "./definition.ts";

export interface HarnessCompactionPlan extends CompactionSettings {
	shouldCompact: boolean;
	firstKeptId?: string;
	summaryFraction: number;
	turnFraction: number;
	branchMaxTokens: number;
	toolResultMaxChars: number;
	toolCallMaxChars: number;
}
export type SummaryExecutor = (request: {
	system: string;
	prompt: string;
	maxTokens: number;
	revision: string;
}) => Promise<{ text: string; usage: Usage }>;

export async function planCompaction(
	snapshot: HarnessSnapshot,
	entries: SessionEntry[],
	contextTokens: number,
	contextWindow: number,
	signal?: AbortSignal,
	purpose = "compaction",
): Promise<HarnessCompactionPlan> {
	const definition = snapshot.definition.compaction;
	const groups = getCompactionGroups(entries);
	const options = yamlValue(fileText(snapshot.files, definition.options.file), definition.options.file);
	const value = object(
		await runRule(
			snapshot.files,
			definition.plan,
			{ contextTokens, contextWindow, groups, purpose },
			options,
			signal,
		),
	);
	for (const key of [
		"reserveTokens",
		"keepRecentTokens",
		"branchMaxTokens",
		"toolResultMaxChars",
		"toolCallMaxChars",
	]) {
		if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0)
			throw new Error(`compaction.${key} must be a non-negative integer`);
	}
	for (const key of ["summaryFraction", "turnFraction"])
		if (typeof value[key] !== "number" || Number(value[key]) <= 0 || Number(value[key]) > 1)
			throw new Error(`compaction.${key} must be in (0,1]`);
	if (typeof value.enabled !== "boolean" || typeof value.shouldCompact !== "boolean")
		throw new Error("Invalid compaction trigger decision");
	if (value.firstKeptId !== undefined && !groups.some((group) => group.id === value.firstKeptId))
		throw new Error("Compaction plan must select a legal group ID");
	return value as unknown as HarnessCompactionPlan;
}

async function summarize(
	snapshot: HarnessSnapshot,
	plan: HarnessCompactionPlan,
	messages: AgentMessage[],
	kind: "initial" | "update" | "turn" | "branch",
	execute: SummaryExecutor,
	sources: Record<string, unknown>,
	previousSummary?: string,
	customInstructions?: string,
	replaceInstructions?: boolean,
	signal?: AbortSignal,
): Promise<{ text: string; usage: Usage }> {
	const definition = snapshot.definition.compaction;
	const projected = await evaluate(
		snapshot,
		snapshot.definition.context.history,
		{ ...sources, "session.history": { messages, entries: [] } },
		"summary.history",
		[],
		signal,
	);
	const instruction =
		replaceInstructions && customInstructions
			? customInstructions
			: fileText(snapshot.files, definition.prompts[kind].file);
	const prompt = string(
		await runRule(
			snapshot.files,
			definition.serialize,
			{
				messages: projected,
				instruction,
				previousSummary,
				customInstructions: replaceInstructions ? undefined : customInstructions,
			},
			plan,
			signal,
		),
		"compaction.serialize result",
	);
	const maxTokens =
		kind === "branch"
			? plan.branchMaxTokens
			: Math.floor(plan.reserveTokens * (kind === "turn" ? plan.turnFraction : plan.summaryFraction));
	if (maxTokens <= 0) throw new Error("Summary token budget must be positive");
	return execute({
		system: fileText(snapshot.files, definition.prompts.system.file),
		prompt,
		maxTokens,
		revision: snapshot.revision,
	});
}

export async function compactWithHarness(
	snapshot: HarnessSnapshot,
	plan: HarnessCompactionPlan,
	preparation: CompactionPreparation,
	execute: SummaryExecutor,
	sources: Record<string, unknown>,
	customInstructions?: string,
	signal?: AbortSignal,
): Promise<CompactionResult> {
	let history = preparation.previousSummary ?? "No prior history.";
	let usage: Usage | undefined;
	if (preparation.messagesToSummarize.length || !preparation.isSplitTurn) {
		const result = await summarize(
			snapshot,
			plan,
			preparation.messagesToSummarize,
			preparation.previousSummary ? "update" : "initial",
			execute,
			sources,
			preparation.previousSummary,
			customInstructions,
			undefined,
			signal,
		);
		history = result.text;
		usage = result.usage;
	}
	let turn: string | undefined;
	if (preparation.isSplitTurn && preparation.turnPrefixMessages.length) {
		const result = await summarize(
			snapshot,
			plan,
			preparation.turnPrefixMessages,
			"turn",
			execute,
			sources,
			undefined,
			customInstructions,
			undefined,
			signal,
		);
		turn = result.text;
		usage = usage ? combineUsage(usage, result.usage) : result.usage;
	}
	const files = computeFileLists(preparation.fileOps);
	const summary = string(
		await runRule(
			snapshot.files,
			snapshot.definition.compaction.merge,
			{ history, turn, branch: false, ...files },
			plan,
			signal,
		),
		"compaction.merge result",
	);
	return {
		summary,
		usage,
		tokensBefore: preparation.tokensBefore,
		firstKeptEntryId: preparation.firstKeptEntryId,
		details: { ...files, harnessRevision: snapshot.revision, usageRecordedSeparately: true },
	};
}

export async function summarizeBranchWithHarness(
	snapshot: HarnessSnapshot,
	plan: HarnessCompactionPlan,
	entries: SessionEntry[],
	execute: SummaryExecutor,
	sources: Record<string, unknown>,
	customInstructions?: string,
	replaceInstructions?: boolean,
	signal?: AbortSignal,
): Promise<{ summary: string; usage: Usage; details: unknown }> {
	const first = plan.firstKeptId ? entries.findIndex((entry) => entry.id === plan.firstKeptId) : 0;
	const messages = entries.slice(Math.max(0, first)).flatMap(sessionEntryToContextMessages);
	const files = createFileOps();
	for (const message of messages) extractFileOpsFromMessage(message, files);
	const fileLists = computeFileLists(files);
	const result = await summarize(
		snapshot,
		plan,
		messages,
		"branch",
		execute,
		sources,
		undefined,
		customInstructions,
		replaceInstructions,
		signal,
	);
	const summary = string(
		await runRule(
			snapshot.files,
			snapshot.definition.compaction.merge,
			{ history: result.text, branch: true, ...fileLists },
			plan,
			signal,
		),
		"branch merge result",
	);
	return {
		summary,
		usage: result.usage,
		details: { ...fileLists, harnessRevision: snapshot.revision, usageRecordedSeparately: true },
	};
}
