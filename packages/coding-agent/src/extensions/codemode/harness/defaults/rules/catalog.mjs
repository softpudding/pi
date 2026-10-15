function example(schema, name = "value", depth = 0) {
  if (depth > 8 || !schema || typeof schema !== "object") return null;
  if ("const" in schema) return schema.const;
  if ("default" in schema) return schema.default;
  if (schema.examples?.length) return schema.examples[0];
  if (schema.enum?.length) return schema.enum[0];
  const variant = schema.anyOf?.[0] ?? schema.oneOf?.[0];
  if (variant) return example(variant, name, depth + 1);
  const type = Array.isArray(schema.type) ? schema.type.find(t => t !== "null") : schema.type;
  if (type === "object") return Object.fromEntries((schema.required ?? []).map(key => [key, example(schema.properties?.[key], key, depth + 1)]));
  if (type === "array") return [];
  if (type === "number" || type === "integer") return schema.minimum ?? 0;
  if (type === "boolean") return false;
  if (type === "string") return `<${name}>`;
  return null;
}

export function render({ tools }, options) {
  const shown = [], omitted = [], lines = [];
  const budget = Math.max(0, options.budgetTokens * 4);
  let group = "", chars = 0;
  for (const tool of tools) {
    if (options.select !== "all" && !options.select.includes(tool.name)) { omitted.push(tool.name); continue; }
    const heading = options.groupBy === "module" && group !== tool.handler.module ? `\n[${tool.handler.module}]\n` : "";
    const schema = options.detail === "full" ? JSON.stringify({ parameters: tool.parameters, outputSchema: tool.outputSchema }) : JSON.stringify(tool.parameters);
    const call = JSON.stringify({ name: tool.name, args: example(tool.parameters) });
    const row = heading + `- ${tool.name}: ${tool.description}\n  ${schema}\n  Call example (replace example values): await host.tools.call(${call});\n  Returns the handler's value unchanged; outputSchema only validates it.\n`;
    if (chars + row.length > budget) { omitted.push(tool.name); continue; }
    group = tool.handler.module; chars += row.length; lines.push(row); shown.push(tool.name);
  }
  const text = lines.join("") || "(none displayed; host.tools.list() lists all active internal tools)";
  return { text, shown, omitted, estimatedTokens: Math.ceil(text.length / 4), tokenEstimate: "characters/4" };
}
