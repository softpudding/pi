export function project({ history }, options) {
  return history.messages.filter(m => m.role !== "system" && !(m.role === "bashExecution" && m.excludeFromContext)).map(m => {
    if (m.role === "custom") return { role: options.customRole, content: m.content, timestamp: m.timestamp };
    if (m.role === "compactionSummary" || m.role === "branchSummary") {
      const prefix = m.role === "compactionSummary" ? options.compactionPrefix : options.branchPrefix;
      const suffix = m.role === "compactionSummary" ? options.compactionSuffix : options.branchSuffix;
      return { role: "user", content: prefix + m.summary + suffix, timestamp: m.timestamp };
    }
    if (m.role === "bashExecution") {
      let text = `Ran \`${m.command}\`\n` + (m.output ? `\`\`\`\n${m.output}\n\`\`\`` : "(no output)");
      if (m.cancelled) text += "\n\n(command cancelled)";
      else if (m.exitCode) text += `\n\nCommand exited with code ${m.exitCode}`;
      if (m.truncated && m.fullOutputPath) text += `\n\n[Output truncated. Full output: ${m.fullOutputPath}]`;
      return { role: "user", content: text, timestamp: m.timestamp };
    }
    return m;
  });
}
