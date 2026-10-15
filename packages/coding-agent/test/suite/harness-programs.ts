/** Source builders for faux-provider tests, never provided to real acceptance models. */
export function installHarnessFiles(files: Record<string, string>, when = "now"): string {
	return `{ const d = await host.harness.begin({base:"active"});
for (const [path,content] of Object.entries(${JSON.stringify(files)})) await host.harness.write({target:d,path,content});
const p = await host.harness.prepare(d);
await host.harness.activate({revision:p.revision,expectedActiveRevision:d.baseRevision,when:${JSON.stringify(when)}}); }`;
}

export function harnessToolFiles(
	source: string,
	name = "files.read",
	parameters: Record<string, unknown> = {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	},
	outputSchema?: Record<string, unknown>,
): Record<string, string> {
	const [module, exported] = name.split(".");
	return {
		[`modules/${module}.mjs`]: source,
		[`tools/${name}.yaml`]: JSON.stringify({
			name,
			description: `Operation ${name}`,
			parameters,
			outputSchema,
			handler: { module, file: `modules/${module}.mjs`, export: exported },
		}),
	};
}
