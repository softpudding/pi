export function compose({ base, project, skills, environment, userPromptConfig, external }) {
  const blocks = [];
  if (userPromptConfig.forceSystemPrompt !== undefined) {
    blocks.push({ id: "external_forced", text: userPromptConfig.forceSystemPrompt });
  } else {
    blocks.push({ id: "preamble", text: userPromptConfig.customPrompt || base });
    blocks.push({ id: "docs", text: "Pi documentation (read when working on pi itself):\n" + JSON.stringify(environment.docs) + "\nRead relevant .md files completely and follow their cross-references." });
    if (userPromptConfig.appendSystemPrompt) blocks.push({ id: "addendum", text: userPromptConfig.appendSystemPrompt });
    if (project.length) blocks.push({ id: "project_context", text: project.map(f => `<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`).join("\n\n") });
    if (skills.length) blocks.push({ id: "skills", text: "Read relevant skill files using a task reader you define.\n" + skills.map(s => `${s.name}: ${s.description}\n${s.filePath}`).join("\n\n") });
    for (const [id, text] of Object.entries(external.sections || {})) if (text) blocks.push({ id, text });
    if (external.guidelines.length) blocks.push({ id: "external_rules", text: external.guidelines.join("\n") });
    blocks.push({ id: "cwd", text: environment.cwd });
    const before = external.systemBefore || {}, after = external.systemAfter || {};
    const text = content => typeof content === "string" ? content : (content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
    const previous = text(before.content), current = text(after.content);
    if (previous !== current) {
      if (current.startsWith(previous)) blocks.push({ id: "external_context", text: current.slice(previous.length) });
      else blocks.splice(0, blocks.length, { id: "external_context", text: current });
    }
    for (const id of new Set([...Object.keys(before.sections || {}), ...Object.keys(after.sections || {})])) {
      if (before.sections?.[id] === after.sections?.[id]) continue;
      const index = blocks.findIndex(block => block.id === id);
      if (index >= 0) blocks.splice(index, 1);
      if (after.sections?.[id]) blocks.push({ id, text: after.sections[id] });
    }
  }
  return blocks;
}
