# Codemode

Codemode is active by default in pi-mih. The model receives one stable execution tool and builds its own reusable tools from host primitives. Built-in read/edit/write/bash, tool search, plugin tools, and MCP tools are not exposed through codemode. Their native declarations are hidden while codemode is active; direct model calls are rejected. SDK hosts can opt out with `createCodemodeExtension({ defaultActive: false })`.

The standalone `@earendil-works/pi-codemode` package still supports caller-injected functions. The coding-agent extension intentionally injects only the capabilities documented here.

## Execution and loop control

Input is raw JavaScript source, executed as an async function body in a fresh QuickJS VM. No Node imports or ambient filesystem access exist inside the VM. External operations use the host interfaces. Paths resolve from the session working directory; filesystem and child-process operations run with the host process's authority, independently of built-in read/bash implementations. Existing permission extensions that intercept those built-ins do not automatically mediate these primitives.

Make exactly one top-level codemode call per response. Return `loop.next(results)` to append selected results and request another inference, or `loop.finish(answer)` to finish without an extra inference. Plain return, `text()`, `exit()`, or assistant prose does not finish the run. Missing decisions receive up to three corrections. Invalid batches are rejected before execution; cancellation and provider failures do not trigger corrections.

`finish` remains a tool result in the transcript and RPC events. The interactive UI renders its text as an assistant reply. Plain `--print` still prints only assistant text; use RPC for automated runs that need the finish payload.

An optional first line sets limits:

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 60000}
```

The output budget defaults to 10000 estimated tokens. Longer output is saved to a file and the result includes its path. The default script deadline is unlimited; cancellation still interrupts execution. Each VM has a 256 MiB heap limit. Failed scripts preserve partial output and do not roll back external effects or committed registry changes. Unawaited operations are cancelled at invocation end.

## Host contract

You build the harness you need from host primitives. There are no prebuilt read, write, edit, bash, search, or MCP tools in codemode. The tools object and ALL_TOOLS are empty; use host.tools for your own registered tools.

Required workflow for external operations: (1) write a reusable JavaScript module, (2) await host.modules.put, (3) await host.tools.register for an exported function, (4) await host.tools.call. Implement I/O using host primitives INSIDE the exported function; do not bypass tool registration with inline I/O in the top-level controller. The controller manages definitions and calls. When you need to understand the returned data, use loop.next(data), read the resulting observation in your next inference, then compose the requested answer and use loop.finish(answer). Returning unseen raw data with loop.finish does not perform reasoning or summarization. Do not ask the user to provide file contents that your primitives can read.

All host functions are async and accept one object (or no argument when shown). Source is JavaScript ES module text with named exports, no imports or Node globals. Module initialization must have no host operations. Each invocation has a fresh VM; use host.state for persistent state. Tool and hook names must start with their module id followed by a dot. Saving code creates an immutable revision; registering selects it. Re-registering the same name replaces the whole binding. Registration commits immediately, also if a later script action fails.

Example of defining an operation (adapt the module and schema to the actual task):
```js
const m = await host.modules.put({id: "math", source: 'export async function double({value}) { const result = value * 2; return {content: [{type: "text", text: String(result)}], structuredContent: result, details: {}}; }'});
await host.tools.register({name: "math.double", description: "Double a number", parameters: {type: "object", properties: {value: {type: "number"}}, required: ["value"]}, outputSchema: {type: "number"}, handler: {module: m.id, revision: m.revision, export: "double"}});
return loop.next(await host.tools.call({name: "math.double", args: {value: 21}}));
```

Module and registry API:
- host.modules.put({id, source}) -> {id, revision, exports: string[]}. Source limit 256 KiB. Returns only after validating the module.
- host.modules.list() -> [{id, revision, exports}]; host.modules.get({id, revision?}) -> module including source, or undefined.
- host.modules.remove({id}) removes its code versions, tools, hooks, and state. Already executing calls keep their loaded code.
- host.tools.register({name, description, parameters, outputSchema?, handler: {module, revision, export}}) -> definition. parameters is an object JSON Schema.
- An exported tool receives its args object and returns {content: [{type: "text", text: string} | {type: "image", data: base64, mimeType}], details, structuredContent?, isError?}. When outputSchema is declared, structuredContent must match it; host.tools.call returns structuredContent, otherwise joined text content. Failed calls throw.
- host.tools.call({name, args}) invokes a currently registered tool immediately, including one registered in this script. Calls use normal validation and tool hooks.
- host.tools.list(), host.tools.describe({name}), host.tools.unregister({name}). These see only model-defined tools, never built-ins.
- host.hooks.register({id, event, handler: {module, revision, export}}), host.hooks.list(), host.hooks.unregister({id}). Events: tool_call, tool_result, agent_start, agent_end. Export receives the event object. tool_call may return {block: true, reason}; tool_result may return {content?, structuredContent?, details?, isError?}; other events are notifications. Handlers run in registration order with a 30-second deadline. Guard against triggering your own hook recursively.
- host.registry.apply({tools?: ToolDefinition[], removeTools?: string[], hooks?: HookDefinition[], removeHooks?: string[]}) validates and commits a group of bindings together.
- host.calls.list() -> [{id, handler}]; host.calls.cancel({id}) cancels a running module invocation. Unregistering only prevents future calls.

File primitives (paths are relative to the working directory; no output truncation or line processing):
- host.fs.read({path, offset?: byteOffset, length?: byteCount, encoding?: "utf8" | "base64"}) -> {data: string, bytes: number, eof: boolean}. Default offset 0, length 65536, encoding utf8. Maximum length 8 MiB. Continue with offset += bytes until eof for a complete file. For byte-perfect chunking, use base64; UTF-8 chunks can split a character.
- host.fs.write({path, data: string, encoding?: "utf8" | "base64", append?: boolean}) -> {bytes}. Default replaces the file; parent directories must exist.
- host.fs.stat({path}) -> {size, mtimeMs, type}; host.fs.list({path}) -> [{name, type}].
- host.fs.mkdir({path, recursive?: boolean}), host.fs.rename({from, to}), host.fs.remove({path, recursive?: boolean}).

Process primitives:
- host.process.spawn({program, args?: string[], cwd?: string, env?: Record<string,string>}) -> {id, stdin, stdout, stderr}. No implicit shell: use program "bash" and args ["-c", command] when you need one.
- host.streams.read({id, maxBytes?: number, encoding?: "utf8" | "base64"}) -> {data, bytes, eof}; host.streams.write({id, data, encoding?}) -> {bytes}; host.streams.close({id}).
- host.process.wait({id}) -> {exitCode, signal}; host.process.terminate({id}). Drain stdout and stderr concurrently before waiting to avoid a full pipe blocking the child. These handles belong to the current script or module invocation; its end closes streams and terminates its process trees. They cannot be reused in later calls.

State and environment:
- host.env.info() -> {cwd, platform}; host.clock.now() -> {unixMs, monotonicMs}; host.clock.sleep({ms}).
- host.state.get({key}), host.state.set({key, value}), host.state.delete({key}). JSON state is scoped to the module (or top-level codemode) and current session branch. Writes commit immediately. Total runtime definitions and state limit: 4 MiB.
- host.session.history({offset?: number, limit?: number}) -> message entries from the current branch. Default limit 20, maximum 100. Runtime metadata is excluded.

Output with text(value), image(base64 image block), console.log(...), or the loop payload. store(key, value)/load(key) remain small per-branch JSON storage; unlike host.state, store writes commit only on script success. Module callbacks return their result directly; only the top-level codemode script chooses loop.next/finish.


## Lifecycle and persistence

Module revisions are SHA-256 hashes of their source. Tool/hook bindings store an explicit revision and export name. Saving another revision alone does not change bindings. Replacement affects future calls; executing calls retain the revision they started with. Unregistration prevents future calls and does not cancel active ones. Use `host.calls.cancel` for cancellation. Module removal removes all its revisions, bindings, and state; it does not undo external effects. A running removed revision can finish, including already-authorized effects.

Each callback receives a fresh VM. Module initialization cannot invoke host operations. Mutable closures are not persistent storage. `host.state` is scoped by module and session branch, and commits immediately. Modules, bindings, and state changes are recorded as `codemode-runtime` session entries. Resume and tree navigation replay definitions and state only; they never execute module code. Hook subscriptions are rebuilt for the selected branch. `tool_call` and `tool_result` hooks participate in the existing ordered extension pipeline; errors are handled by that pipeline.

Generated tools use ordinary schema validation, nested-call recording, and extension tool hooks. They are deferred registry entries and never modify the provider-facing codemode declaration. `host.tools.list/describe` explicitly discover the current model-owned registry. Built-in tool allowlists still apply at the session boundary: prefer `defaultTools: ["codemode"]` to a restrictive `--tools codemode` allowlist when newly named tools must register at runtime.

Process and stream handles last for one invocation; cross-turn process sessions are not implemented. Event hooks currently cover tool calls/results and agent start/end. General context rewriting, custom compaction, and arbitrary host extension loading remain outside this API.

## Models

`models` reaches the model catalog and runs non-LLM models with the session's credentials: classifiers, which answer typed questions about JSON state, and image models, which generate images. Chat models are listed but cannot be run from scripts. Which classifier and image models exist is described in [Use classifier models](models.md#use-classifier-models) and [Use image models](models.md#use-image-models).

```ts
type ModelType = "chat" | "image" | "classifier";

/** A catalog entry. `provider` and `id` identify it; other fields depend on the type. */
interface ModelInfo {
  type?: ModelType;
  provider: string;
  id: string;
  name: string;
  api: string;
  input: ("text" | "image")[];
  contextWindow?: number;
  [key: string]: unknown;
}

declare const models: {
  /** Every known model of a type, optionally for one provider. */
  getModelsOfType(type: ModelType, provider?: string): Promise<ModelInfo[]>;
  /** Models of a type whose provider has working credentials. */
  getAvailableOfType(type: ModelType, provider?: string): Promise<ModelInfo[]>;
  /** One catalog entry, or undefined. */
  getModelOfType(type: ModelType, provider: string, id: string): Promise<ModelInfo | undefined>;
  /** Answer `context.questions` about `context.state`; answers are in `result.answers` by question ID. */
  classify(model: ModelInfo, context: ClassifierContext): Promise<ClassifierResult>;
  /** Generate images from `context.input` text and image blocks; show `result.output` blocks with image(). Can take minutes. */
  generateImages(model: ModelInfo, context: ImagesContext): Promise<ImagesResult>;
};
```

`classify()` and `generateImages()` use only the `provider` and `id` of `model`, so `{ provider, id }` works as well. They do not throw on provider errors: check `stopReason` and `errorMessage`. At most four such calls run at once per script; more calls wait for a free slot, so `Promise.all()` over many items is fine. Their usage is added to the `codemode` tool result and counts toward the session cost.

Model IDs differ between providers, for example `typesafe/jev-latest` and `openrouter/typesafe/jev-1.13`. Use `models.getAvailableOfType(type)` to find the IDs that work with the current credentials.

### Classify

```ts
interface ClassifierContext {
  /** The data to classify. */
  state: Record<string, unknown>;
  /** Questions by ID. One call answers all of them. */
  questions: Record<string, ClassifierQuestion>;
}

type ClassifierQuestion =
  /** Pick one label. `criteria` maps each label to what it means. */
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  /** Score on an ordered scale. `criteria` describes each level, lowest first. */
  | { type: "score"; instructions: string; criteria: string[] }
  /** Yes or no. */
  | { type: "bool"; instructions: string; criteria: { true: string; false: string } };

interface ClassifierResult {
  provider: string;
  model: string;
  /** Answers by question ID. */
  answers: Record<string, ClassifierAnswer>;
  usage?: ModelUsage;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
}

type ClassifierAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  /** `score` is the expected level index, from 0 to `criteria.length - 1`. */
  | { type: "score"; score: number; confidence: number }
  /** Probability of `true`. */
  | { type: "bool"; probability: number };

/** Token counts and cost in USD, when the service reports them. */
type ModelUsage = { input: number; output: number; totalTokens: number; cost: { total: number } };
```

Classify several items by calling `classify()` once per item. This script sorts feedback messages, for example ones a tool returned earlier in the script:

```js
const jev = await models.getModelOfType("classifier", "typesafe", "jev-latest");
const results = await Promise.all(
  messages.map((message) =>
    models.classify(jev, {
      state: { message },
      questions: {
        sentiment: {
          type: "choice",
          instructions: "How does the user feel about the product?",
          criteria: { positive: "Satisfied or happy", negative: "Unhappy or frustrated", neutral: "Neither" },
        },
        urgency: {
          type: "score",
          instructions: "How urgently does this need a reply?",
          criteria: ["no reply needed", "reply this week", "reply today"],
        },
      },
    }),
  ),
);
return loop.next(results.map((result, i) =>
  result.stopReason === "stop"
    ? { message: messages[i], sentiment: result.answers.sentiment.choice, urgency: result.answers.urgency.score }
    : { message: messages[i], error: result.errorMessage },
));
```

### Generate images

```ts
interface ImagesContext {
  /** The prompt as text blocks, plus image blocks to edit or use as references. */
  input: (TextBlock | ImageBlock)[];
}

interface ImagesResult {
  provider: string;
  model: string;
  /** Generated images, and text blocks for models that also return text. */
  output: (TextBlock | ImageBlock)[];
  usage?: ModelUsage;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
}

type TextBlock = { type: "text"; text: string };
/** `data` is base64. */
type ImageBlock = { type: "image"; data: string; mimeType: string };
```

Show generated images with `image(block)`. Do not print `data` with `text()`, `console`, or `return`: it is large and the model cannot read it as text. `image()` also saves each image to a temp file and puts its path in the result, so a later turn can copy or move the file.

```js
// @options: {"timeout_ms": 300000}
const painter = await models.getModelOfType("image", "openrouter", "google/gemini-2.5-flash-image");
const result = await models.generateImages(painter, {
  input: [{ type: "text", text: "A red fox in the snow, watercolor" }],
});
if (result.stopReason !== "stop") return loop.next(result.errorMessage);
for (const block of result.output) {
  if (block.type === "image") image(block);
  else text(block.text);
}
return loop.finish("Image generated.");
```
