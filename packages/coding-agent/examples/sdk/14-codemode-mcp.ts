/**
 * Codemode with model-authored tools
 *
 * The model defines its operations from file and process primitives. Existing built-in and MCP
 * tools are not exposed through codemode. Use defaultTools to select codemode without restricting
 * the names of tools the model can subsequently register.
 */

import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const cwd = process.cwd();

const resourceLoader = new DefaultResourceLoader({
	cwd,
	agentDir: getAgentDir(),
	extensionFactories: [createCodemodeExtension()],
});
await resourceLoader.reload();

const settingsManager = SettingsManager.create(cwd);
settingsManager.applyOverrides({ defaultTools: ["codemode"] });

const { session } = await createAgentSession({
	resourceLoader,
	settingsManager,
	sessionManager: SessionManager.inMemory(),
});

try {
	// Restores model-authored definitions for this session branch.
	await session.bindExtensions({});
	console.log("Active tools:", session.getActiveToolNames().join(", "));
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});
	await session.prompt("Use codemode to count the TypeScript files in src/ and list the three largest.");
	console.log();
} finally {
	session.dispose();
}
