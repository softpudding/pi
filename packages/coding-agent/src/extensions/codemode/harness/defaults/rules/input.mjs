export function describe({ contract, javascript, json }, options) {
  const text = contract.syntax === "javascript" ? javascript : json;
  if (contract.syntax !== "javascript" && contract.syntax !== "json") throw new Error("Unknown codemode input syntax");
  return {
    text: text + (contract.syntax === "javascript" && contract.jsonEnvelope
      ? "\n" + options.envelope + "\n" + Object.entries(options.parameters).map(([name, description]) => `${name}: ${description}`).join("\n")
      : ""),
    parameterDescriptions: contract.jsonEnvelope ? options.parameters : {}
  };
}
