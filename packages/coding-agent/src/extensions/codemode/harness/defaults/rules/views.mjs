// Explicit value-to-text handlers. Select a name from policies/views.yaml in observe(value,{view}).
export function read(result) {
  if (typeof result?.text !== "string") throw new TypeError("pi.read expects the complete read result object {text: string, ...}. Strings can be observed directly without a view.");
  return result.text;
}

export function detail(result) {
  if (typeof result?.text !== "string" || !["system", "codemode", "provenance"].includes(result.section)) throw new TypeError("harness.detail expects a detail page returned by host.harness.inspect({section,...}).");
  return result.text + (result.next ? `\n\n[Continue this saved request with host.harness.inspect(${JSON.stringify(result.next)})]` : "");
}

export function diagnostics(items) {
  if (!Array.isArray(items)) throw new TypeError("harness.diagnostics expects a diagnostic array.");
  if (!items.length) return "Diagnostics: none";
  return items.map(item => {
    if (typeof item === "string") return item;
    if (typeof item?.message !== "string") throw new TypeError("Each diagnostic must be a string or {message, severity?, path?, line?, column?}.");
    const location = [item.path, item.line, item.column].filter(value => value !== undefined).join(":");
    return [item.severity, location, item.message].filter(value => value !== undefined && value !== "").join(": ");
  }).join("\n");
}

export function prepare(result) {
  if (typeof result?.revision !== "string" || !Array.isArray(result.diff) || !result.diff.every(text => typeof text === "string")) throw new TypeError("harness.prepare expects the complete host.harness.prepare result.");
  const lines = [`Prepared revision: ${result.revision}`, `Base revision: ${result.baseRevision}`, diagnostics(result.diagnostics)];
  const preview = result.preview;
  if (preview) {
    if (Array.isArray(preview.system)) lines.push("System blocks: " + preview.system.map(block => `${block.id} (${block.text.length} characters)`).join(", "));
    if (typeof preview.description === "string") lines.push(`Codemode preview: ${preview.description.length} characters; observe prepared.preview.description directly to examine it.`);
    if (typeof preview.estimatedTokens === "number") lines.push(`Estimated context tokens: ${preview.estimatedTokens}`);
    if (Array.isArray(preview.catalog?.shown)) lines.push(`Catalog shown: ${preview.catalog.shown.join(", ") || "none"}`);
    if (Array.isArray(preview.catalog?.omitted) && preview.catalog.omitted.length) lines.push(`Catalog omitted: ${preview.catalog.omitted.join(", ")}`);
  }
  lines.push(result.diff.length ? "Changes:\n" + result.diff.join("\n") : "Changes: none");
  return lines.join("\n");
}

export function edit(result) {
  if (typeof result?.text !== "string" || result.harness?.domain !== "harness") throw new TypeError("harness.edit expects the complete host.harness.edit result.");
  const diff = result.details?.patch ?? result.details?.diff;
  if (typeof diff !== "string") throw new TypeError("harness.edit expects a native edit patch or diff in details.");
  return result.text + "\n\n" + diff;
}

export function status(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new TypeError("harness.status expects a Harness draft or activation status object.");
  const fields = ["status", "draft", "baseRevision", "revision", "requestRevision", "draftSequence", "path"];
  const lines = fields.filter(key => result[key] !== undefined).map(key => {
    if (!["string", "number"].includes(typeof result[key])) throw new TypeError(`harness.status expects a scalar ${key}.`);
    return `${key}: ${result[key]}`;
  });
  if (!lines.length) throw new TypeError("harness.status expects a Harness draft or activation status object.");
  return lines.join("\n");
}

export function overview(info) {
  if (info?.section !== "overview") throw new TypeError("harness.overview expects the overview returned by host.harness.inspect(). Other operation results need their own view or selected text.");
  const lines = [
    `Request: ${info.requestId ?? "(none yet)"}`,
    `Request revision: ${info.requestRevision}`,
    `Active revision: ${info.activeRevision}`,
    `Pending activation: ${info.pendingActivation ? info.pendingActivation.revision : "none"}`,
    `Drafts: ${info.drafts.length ? info.drafts.map(d => `${d.id} (base ${d.baseRevision}, edit ${d.sequence})`).join("; ") : "none"}`,
    `Definition files (${info.files.length}):\n${info.files.join("\n")}`,
  ];
  if (info.context) {
    lines.push("Request context (characters):");
    for (const block of info.context.system) lines.push(`system/${block.id}: ${block.chars}`);
    lines.push(`codemode: ${info.context.codemode.chars}`, `history: ${info.context.history.messages} messages, ${info.context.history.chars} characters`);
  }
  lines.push("Sources:");
  for (const source of info.sources) lines.push(`${source.output} <- ${source.dependencies.join(", ")}`);
  lines.push(`Views (${info.viewDefinitions}):`);
  for (const [name, handler] of Object.entries(info.views)) lines.push(`${name}: ${handler}`);
  lines.push('Read definition source with host.harness.read({path}); inspect saved output with {section:"system",id}, {section:"codemode"}, or {section:"provenance"}. Observe page.text directly and continue with inspect(page.next) until next is null.');
  return lines.join("\n");
}

// Deliberately verbose debugging only; never selected implicitly.
export function dump(value) {
  const sections = [];
  const visit = (value, path) => {
    if (value !== null && typeof value === "object") {
      sections.push(`${path} (${Array.isArray(value) ? "array" : "object"})`);
      for (const [key, child] of Object.entries(value)) visit(child, `${path}[${JSON.stringify(key)}]`);
    } else sections.push(`${path}: ${String(value)}`);
  };
  visit(value, "$");
  return sections.join("\n");
}
