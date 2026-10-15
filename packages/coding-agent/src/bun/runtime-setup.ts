import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";
// Bun loads .wasm imports as files: embedded in compiled executables, evaluating to a readable path.
import quickjsEncodingPath from "quickjs-wasi/encoding.so";
import quickjsWasmPath from "quickjs-wasi/quickjs.wasm";
import { APP_NAME, setEmbeddedQuickJSWasmPaths } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
setEmbeddedQuickJSWasmPaths(quickjsWasmPath, quickjsEncodingPath);
