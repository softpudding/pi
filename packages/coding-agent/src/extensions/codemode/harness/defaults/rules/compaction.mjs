export function plan({ contextTokens, contextWindow, groups, purpose }, options) {
  const budget = purpose === "branch" ? Math.max(0, contextWindow - options.branchReserveTokens) : options.keepRecentTokens;
  let tokens = 0, firstKeptId = groups[0]?.id;
  for (let i = groups.length - 1; i >= 0; i--) {
    tokens += groups[i].tokens; firstKeptId = groups[i].id;
    if (tokens >= budget) break;
  }
  return { ...options, shouldCompact: options.enabled && contextTokens > contextWindow - options.reserveTokens, firstKeptId };
}

export function serialize({ messages, instruction, previousSummary, customInstructions }, options) {
  const text = content => typeof content === "string" ? content : (content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
  if (!Number.isSafeInteger(options.toolCallMaxChars) || options.toolCallMaxChars < 0) throw new Error("compaction.toolCallMaxChars must be a non-negative integer");
  const toolCall = call => {
    const documents = [];
    let args = call.arguments;
    // Decode the explicit custom-tool JSON envelope once for presentation only.
    if (call.name === "codemode" && args && Object.keys(args).length === 1 && typeof args.code === "string" && /^\s*\{\s*"/.test(args.code)) {
      try { args = JSON.parse(args.code); } catch { /* Invalid input remains visible as submitted. */ }
    }
    // Keep argument structure compact; source and other text requiring quoting are separate literal blocks.
    const shape = JSON.stringify(args, (key, value) => {
      if (typeof value !== "string" || !(value.length > 120 || /[\r\n\\"`]/.test(value) || call.name === "codemode" && ["code", "finish"].includes(key))) return value;
      const id = documents.length + 1;
      documents.push(value);
      return `[argument text ${id}, ${value.length} characters]`;
    }, 2);
    let remaining = options.toolCallMaxChars;
    const bounded = value => {
      const kept = value.slice(0, remaining);
      remaining -= kept.length;
      return kept + (kept.length < value.length ? "\n[truncated for summary]" : "");
    };
    const parts = [`[Tool call]: ${call.name}`, bounded(shape ?? "undefined")];
    for (const [index, document] of documents.entries()) {
      if (!remaining) { parts.push(`[${documents.length - index} argument texts omitted for summary]`); break; }
      const body = bounded(document);
      const fence = "`".repeat((body.match(/`+/g) || []).reduce((length, run) => Math.max(length, run.length + 1), 3));
      parts.push(`[Argument text ${index + 1}]\n${fence}text\n${body}\n${fence}`);
    }
    return parts.join("\n");
  };
  const parts = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    let value = text(m.content);
    if (m.role === "assistant") {
      value += (m.content || []).filter(c => c.type === "thinking").map(c => `\n[Thinking]: ${c.thinking}`).join("");
      value += (m.content || []).filter(c => c.type === "toolCall").map(c => "\n" + toolCall(c)).join("");
    }
    if (m.role === "toolResult" && value.length > options.toolResultMaxChars) value = value.slice(0, options.toolResultMaxChars) + "\n[truncated for summary]";
    parts.push(`[${m.role}]: ${value}`);
  }
  return `<conversation>\n${parts.join("\n\n")}\n</conversation>\n\n` + (previousSummary ? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n` : "") + instruction + (customInstructions ? `\n\nAdditional focus: ${customInstructions}` : "");
}

export function merge({ history, turn, branch, readFiles, modifiedFiles }) {
  let summary = history || "No prior history.";
  if (turn) summary += "\n\n---\n\n**Turn Context (split turn):**\n\n" + turn;
  if (branch) summary = "The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n" + summary;
  if (readFiles.length) summary += `\n\n<read-files>\n${readFiles.join("\n")}\n</read-files>`;
  if (modifiedFiles.length) summary += `\n\n<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`;
  return summary;
}
