export function describe({ input, guide, api, views, nestedTools }) {
  const names = Object.entries(views.handlers).map(([name, handler]) => `- ${JSON.stringify(name)}: ${handler}`);
  const viewGuide = `Observation views for this request (definitions: ${views.definitions}):\n` +
    (names.length ? names.join("\n") : "No object views are defined; observe selected strings directly.");
  return {
    text: [input.text, guide, viewGuide, api, "Nested tools\n" + nestedTools.text].join("\n\n"),
    parameterDescriptions: input.parameterDescriptions,
    catalog: nestedTools
  };
}
