// Layout receives text/image items after explicit view handlers have rendered observations.
export function render({ output }, options) {
  const count = output.filter(item => item.type === "text" && !item.console).length;
  const items = [], logs = [];
  let index = 0;
  for (const item of output) {
    if (item.type === "image") items.push(item);
    else if (item.type === "text" && item.console) logs.push(item.text);
    else {
      const text = item.text;
      index++;
      items.push({ type: "text", text: options.labelItems && count > 1 ? `==> text ${index}/${count} <==\n${text}` : text });
    }
  }
  if (logs.length) items.push({ type: "text", text: `<${options.consoleTag}>\n${logs.join("\n")}\n</${options.consoleTag}>` });
  return { items, maxOutputTokens: options.maxOutputTokens };
}
