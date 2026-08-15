/**
 * Current date hint.
 *
 * Pi has no built-in notion of the current date, so the model cannot reason
 * about "today" unless it is told. This extension injects today's date into
 * the LLM context before each agent run.
 *
 * Behavior:
 * - Injected once per session per day: only the first user message of a day
 *   in a session carries the date; later messages the same day do not.
 * - When the date changes within the same session (or a resumed session is
 *   continued on a later day), the new date is injected again.
 * - Dedup walks the active branch (`buildContextEntries`), so switching to a
 *   branch (/tree) that lacks today's hint re-injects it.
 *
 * The hint is stored as a custom_message entry in the session file, so it
 * survives restarts and stays in context without being re-injected.
 *
 * Install: copy to ~/.pi/agent/extensions/current-date-hint.ts, then /reload.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "current-date-hint";
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

/** Local date as "YYYY-MM-DD 星期X", e.g. "2025-06-20 星期五". */
function localDate(now: Date): string {
	const iso = [
		now.getFullYear(),
		String(now.getMonth() + 1).padStart(2, "0"),
		String(now.getDate()).padStart(2, "0"),
	].join("-");
	return `${iso} 星期${WEEKDAYS[now.getDay()]}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (_event, ctx) => {
		const today = localDate(new Date());

		// Skip when the active branch already carries today's hint.
		for (const entry of ctx.sessionManager.buildContextEntries()) {
			if (entry.type !== "custom_message" || entry.customType !== CUSTOM_TYPE) {
				continue;
			}
			const injected = (entry.details as { date?: string } | undefined)?.date;
			if (injected === today) {
				return;
			}
		}

		return {
			message: {
				customType: CUSTOM_TYPE,
				content: `今天是 ${today}。`,
				// false: silent context hint. Set to true to render it in the TUI.
				display: false,
				details: { date: today },
			},
		};
	});
}
