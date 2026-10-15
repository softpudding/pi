# Codemode

Codemode is active by default in pi-mih. The provider receives only `codemode`; reusable tools, hooks, prompts, context rules and compaction policies come from an editable, versioned Harness definition. Built-in read/edit/write/bash, tool search, plugin and MCP tools are not callable from codemode. SDK hosts can opt out with `createCodemodeExtension({ defaultActive: false })`.

The standalone `@earendil-works/pi-codemode` package still supports caller-injected functions. This document describes the coding-agent extension. See [Editable Harness](editable-harness.md) for the design and Pi migration map.

## Execution and loop control

The single codemode tool follows the provider's input protocol. The OpenAI completions, Responses, Azure Responses and Codex Responses adapters use a custom tool when the routed model enables `supportsOpenAIGrammarTools` and the tool declares a supported grammar. Those calls default to raw JavaScript, including calls that author module source, file contents or edit text. Use ordinary JavaScript strings and objects directly; neither a JSON wrapper nor `data` is required. An explicit JSON object `{code, data?}` / `{finish}` remains available. Other declarations use the function tool's JSON schema. No Markdown fences. There is still only one provider tool.

This protocol selection is host logic, not a decision for the model. After routing each request, the host supplies `host.input-contract: {syntax:"javascript"|"json",jsonEnvelope:boolean}`. The editable `rules/input.mjs` selects `prompts/input-javascript.prompt` or `prompts/input-json.prompt`; the model receives only the applicable instructions. `policies/input.yaml` supplies field descriptions and optional-envelope wording. Malformed envelopes report the invalid input without suggesting another protocol.

The default `rules/codemode.mjs` assembles those instructions, `prompts/codemode.prompt`, current views, capability references and the internal tool catalog once in the tool description. The system prompt does not duplicate the guide; there is no second fixed codemode guidelines list. A description rule may return `{text,catalog?,parameterDescriptions?:{code?,data?,finish?}}`. Parameter descriptions are strings applied to the declaration for this request; omitted descriptions are removed, and types, required fields and executable validation remain host-owned. Prepare previews these descriptions and activation applies them on the next request. Provider-specific branches belong in the rule and this developer documentation.

Supply exactly one of `code` and `finish` in JSON input. `code` is an async function body executed in a fresh QuickJS VM; optional `data` is an object supplied in the same call and available through the outer `data` binding. For JSON calls, prefer file contents, module source, prompt text and edit old/new text in `data`, then pass those fields to the relevant functions. Preserve the document's own quotes, backslashes, template literals and newlines; only the tool protocol's JSON encoding is needed. Do not encode these data strings as another JavaScript string or serialize `data` itself into a string. `data` exists only for the current invocation; a raw source call has no supplied data and follows normal JavaScript literal syntax.

The custom-tool adapter carries raw input in `code`. Before schema validation, codemode decodes one explicit JSON object starting with a quoted property, or leaves JavaScript unchanged. Malformed JSON is rejected before execution; ordinary JavaScript blocks are not treated as objects. No repeated decoding or document unescaping occurs. History replay to a custom-tool provider retains a complete JSON argument object whenever it contains `data`, `finish` or other fields; source-only calls retain their raw source.

Supply structured definitions, schemas and policy mappings as objects. Code can serialize them with `JSON.stringify(value,null,2)` when writing a definition file; JSON is accepted in `.yaml` files. Source modules and prompts remain literal strings. Serialization for storage is separate from observation: select a view or a string when displaying text to the model.

When using tools, a response uses one top-level codemode call. Call `observe(text)` for strings or `observe(result,{view:"name"})` for objects, then return `loop.next()` to inspect results in another inference. After observing the evidence, deliver the final answer as normal assistant text without a tool call, or through `{finish: answer}`. Neither requires encoding the answer as JavaScript. Code can also return `loop.finish(value)` for programmatic completion. The two codemode finish forms use the same output rules and `finish` outcome; a normal nonempty assistant completion produces `assistant_finish` with its text. The editable default loop rule accepts all three. Plain return, `observe()`, `text()` and `exit()` do not select a code loop decision. Empty or truncated responses do not count as completion. Default loop rules allow three execution recoveries and three protocol corrections independently; their rules, budgets and reminders are editable.

Standard `TextEncoder` and `TextDecoder` are available, including streaming UTF-8 decoding across byte chunks. There are no Node imports or ambient filesystem access. Host bindings live outside the script's local scope: ordinary declarations such as `const tools = await host.tools.list()` are valid. JavaScript examples below can be raw free-form input or the JSON `code` field, except those explicitly using supplied `data`.

`finish` remains a tool result in the transcript and RPC events. The interactive UI renders its text as an assistant reply. Plain `--print` prints assistant text only; use RPC when automation needs the finish payload.

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 60000}
```

This optional first line overrides invocation limits. The default script deadline is unlimited; each execution VM has a 256 MiB heap limit. Output defaults to 10000 estimated tokens, with longer output saved to a file. Layout and the default budget come from `codemode.output` in `agent.yaml`. Truncation, image handling and execution-error diagnostics remain host mechanisms. Unawaited operations are cancelled when an invocation ends. Completed external effects, Harness edits and activations survive a later script failure.

## Discover and edit the Harness

The system bootstrap identifies the request revision and `agent.yaml`. Read that root to discover how the current context is constructed:

```js
observe((await host.harness.read({ path: "agent.yaml" })).text);
return loop.next();
```

The root connects files and host inputs through small JavaScript rules. Defaults include:

| Files | Behavior |
|---|---|
| `prompts/system.prompt`, `rules/system.mjs` | Role, instructions, project material, skills, external contributions and cwd |
| `prompts/codemode.prompt`, `rules/codemode.mjs` | Codemode instructions and description |
| `prompts/input-*.prompt`, `policies/input.yaml`, `rules/input.mjs` | Instructions for the current input contract and parameter descriptions |
| `policies/catalog.yaml`, `rules/catalog.mjs` | Nested tools selection, detail, grouping and estimated token budget |
| `policies/history.yaml`, `rules/history.mjs` | Message presentation, summary wrappers and reminder roles |
| `policies/loop.yaml`, `rules/loop.mjs`, `prompts/loop-*.prompt` | Execution recovery, protocol correction decisions and text |
| `policies/compaction.yaml`, `rules/compaction.mjs`, `prompts/compact-*.prompt` | Retention, summary budgets, serialization and summary merging |
| `policies/output.yaml`, `rules/output.mjs` | Controller output layout and default budget |
| `policies/views.yaml`, `rules/views.mjs` | Explicit observation view mappings and pure text handlers |
| `tools/*.yaml`, explicit hook paths, `modules/*.mjs` | Internal callable tools and event handlers |

All host functions are async and take one object argument unless shown otherwise. Every `host.*` function declaration and input validator comes from the same schema, covering Harness editing, internal calls/state and task primitives. Invalid arguments are rejected before effects; the error lists all schema violations and the complete function signature, rather than reporting missing fields one at a time. `begin()` returns a draft handle `{draft,baseRevision}` accepted directly by editing operations and `prepare/discard`. `inspect().drafts` contains status records `{id,baseRevision,sequence}`. Internal tool return-schema errors also identify invalid fields.

The Harness editing API is:

- `host.harness.inspect()` returns only composition metadata: requestId, requestRevision, activeRevision, pending activation, draft metadata, file names, context IDs and character lengths, source dependencies and available view mappings. Prompt bodies, the full codemode description and interface documentation are absent. Observe with `view:"harness.overview"`.
- `host.harness.inspect({section:"system"|"codemode"|"provenance",id?,requestId?,limit?})` starts reading saved generated output. `id` selects a system block; omitting it selects the full system text. Pages contain `{requestId,requestRevision,activeRevision,section,id?,text,offset,totalChars,eof,next}`. Observe with `view:"harness.detail"`. Default limit: 4000 UTF-16 characters, maximum 12000; pages never split a surrogate pair. `next` is null or `{cursor,limit}` accepted directly by `inspect(page.next)`. The opaque cursor binds the saved request, section, block and position; continuation does not accept separate selectors or offsets. Invalid cursors and unknown request IDs never fall back to current output. Definition source still uses `read`.
- `host.harness.begin({base?:"active"|"request"|revision})` returns `{draft,baseRevision}`. Pass the whole handle as `target` in read/write/edit/remove and directly to `prepare/discard`. A supplied `baseRevision` must match the draft's base; `{draft}` alone also identifies a draft.
- `host.harness.read({target?:{revision:"request"|"active"|revision}|{draft},path,offset?,limit?})` uses native Pi read semantics: a 1-based **line** offset and line count. Default target is `request`.
- `host.harness.write({target:{draft},path,content})` creates or replaces a definition file.
- `host.harness.edit({target:{draft},path,edits:[{oldText,newText}]})` uses native Pi matching and diff semantics. Keep each `oldText` as small as possible while unique; do not pad it with unchanged regions. Match all edits against the original file, never the result of earlier replacements. Batch distant disjoint changes, merge nearby ones, and never overlap or nest edits. Before strict validation, the shared native normalizer also accepts a single edit object or one JSON string containing the edits array/object. Only this container is normalized: targets, revisions and document strings are unchanged, malformed inputs still fail, and there is no guessed unescaping or top-level legacy `oldText/newText` conversion.
- `host.harness.remove({target:{draft},path})` removes a draft file; `host.harness.discard({draft})` drops a draft without deleting prepared versions.
- `host.harness.prepare({draft})` validates references, exports, options and pure context rendering, then freezes an immutable candidate. Returns `{revision,baseRevision,draftSequence,diagnostics,preview,diff}`. Invalid candidates throw; malformed definition objects identify their location and expected fields, and tool/hook handler errors identify the definition file. The draft remains available for repair. Further draft edits do not change that candidate.
- `host.harness.activate({revision,expectedActiveRevision,when?:"next_request"|"now"})` performs a compare-and-swap against the current active version. Default `next_request` schedules activation before the next inference, including `loop.next`. `now` also enables new root calls in the current script.
- `host.harness.cancelActivation({revision})` cancels the one pending activation. Roll back by activating an older prepared revision against the current active revision.

Read/write/edit return `{text,details,harness}`. `text` contains the native result text and continuation notices; `details` preserves truncation and diff/patch data. `harness` identifies the domain, path and version/draft. Native presentation envelopes stay inside the host. Read continuation notices must be followed. Revisions are read-only. Paths are logical names, with no absolute paths, `..`, OS links or task-directory fallback. The adapter calls Pi's native algorithms with a dedicated backend and mutation queue; it does not call a task read/edit tool. Limits: 32 drafts, 256 KiB per file, 4 MiB per snapshot and 48 KiB per line.

Example JSON controller, with the authored addition supplied as `data.addition` in the same call:

```js
const d = await host.harness.begin();
const prompt = await host.harness.read({target:d,path:"prompts/system.prompt"});
await host.harness.write({target:d,path:"prompts/system.prompt",content:prompt.text + data.addition});
const p = await host.harness.prepare(d);
observe(p, {view:"harness.prepare"});
observe(await host.harness.activate({revision:p.revision,expectedActiveRevision:d.baseRevision}), {view:"harness.status"});
return loop.next();
```

Pure rules receive `(inputs, parsedOptions)` in isolated QuickJS VMs with no host APIs, a 5-second timeout and a 64 MiB heap. They can compose context but cannot perform external effects. Read the default rules and `host.definition-reference` for the input/output contracts. Summary inference, credentials and provider transport remain host operations.

## Observe structured data

Tool values, presentation and loop decisions are separate. `host.tools.call` returns handler data; `observe(value,{view})` records a JSON snapshot and explicit view; `loop.next()` requests another inference. `observe` is synchronous, returns undefined, and changes neither the value nor the loop decision. Functions, symbols, bigints, non-finite numbers and cycles are rejected. Nested undefined values follow JSON conventions. Observations share the output order and limits with text and images.

The mapping is discoverable at `agent.yaml → codemode.output.views → policies/views.yaml`. The `codemode.views` source contains `{definitions,handlers}` from the request snapshot; the default description lists these actual names and handler references. Renaming or removing a mapping updates the next request's list. The fixed bootstrap observes native read's `.text` and does not depend on any view name. Names in the examples below are defaults, not reserved identifiers. Each name maps to a `file.mjs#export` reference. The pure handler receives the complete observed value and must return a string. For a new tool returning `{source,size}`, the model can add `files.source: rules/file-view.mjs#render` and this module:

```js
export function render(result) {
  return result.source;
}
```

After preparing, activating and advancing to the next request:

```js
const result = await host.tools.call({name: "files.read", args: {path: "example.ts"}});
observe(result, {view: "files.source"});
return loop.next();
```

Strings and primitive values display directly without a view. Objects and arrays require one. Missing or unknown names produce an explicit presentation error listing available views and the definition entry. There is no implicit traversal or field-name guessing. The default `pi.read` handler returns exactly `result.text`, including native continuation hints and excluding metadata. `harness.overview` displays composition; `harness.detail` displays a page and continuation query. Recursive inspection requires the explicit `debug.dump` view.

Additional default views accept complete operation results:

- `harness.prepare`: candidate/base revision, diagnostics, system block sizes, description length, catalog selection and literal unified diffs. Full generated prompts stay in `preview` for code; observe selected preview strings directly when needed.
- `harness.edit`: the native edit acknowledgement and unified patch, falling back to the native diff when a patch is absent.
- `harness.status`: draft, activation and removal status fields, without traversing unrelated data.
- `harness.diagnostics`: an array of strings or `{message,severity?,path?,line?,column?}` records, with literal messages.

Mappings and handler source use the normal draft/prepare/activate lifecycle. Prepare validates names, references and exports. Views run before layout: `codemode.output.render` receives `{output}` containing rendered text/image items and parsed output policy options, and returns `{items,maxOutputTokens}`. Views and layout use the request revision, including after activation with `when:"now"`; changes become available on the next request. They cannot alter tool returns, perform effects or choose loop decisions.

A presentation failure produces `error.kind:"presentation"` and loop outcome `execution_failed`, retaining completed calls and successful observations. It rejects finish, but does not undo completed effects or successful script store writes. Repair the view and observe retained data; the host never reruns operations automatically. A handler's own output stays local; the controller chooses what to observe.

`text(string)` still emits literal text. `text(object)`, `console.log(object)` and object loop payloads still use JSON; these are diagnostic paths, not source/diff presentation. Transport and session JSON escape newlines as usual; decoded provider text contains actual source newlines, quotes and backslashes. The host does not guess encodings or unescape document content.

## Define and call internal tools

There is no writable registry API: `host.modules.put`, `host.tools.register/unregister`, `host.hooks.register/unregister` and `host.registry.apply` have been removed. The `tools` object and `ALL_TOOLS` are empty. Definitions in an active Harness snapshot are the sole source of callable capabilities.

To create a task tool, write an ES module and a matching tool definition into a Harness draft, prepare and activate it, then call `host.tools.call`. Implement task I/O inside the exported handler. The controller edits definitions and orchestrates calls. Observe new data with `loop.next` before composing an answer from it.

For example, `tools/math.yaml` (JSON is valid YAML):

```yaml
name: math.double
description: Double a number
parameters:
  type: object
  properties:
    value: { type: number }
  required: [value]
outputSchema: { type: number }
handler:
  module: math
  file: modules/math.mjs
  export: double
```

`modules/math.mjs`:

```js
export function double({value}) {
  return value * 2;
}
```

After activation: `await host.tools.call({name:"math.double",args:{value:21}})` returns `42`. This adds no provider tool. The default catalog puts its description and a complete call example into codemode's **Nested tools** section on the next request. Tool selection, detail, grouping and the 3000 estimated-token default are editable through the catalog policy and rule. Hidden catalog entries remain callable. Primitives such as `host.fs.stat` are called directly inside handlers; they do not become tools named `fs.stat`. Unknown-tool errors list the available names and identify matching primitives.

- `host.tools.list()` and `host.tools.describe({name})` are read-only views of the selected snapshot.
- Tool names must begin with their module ID and a dot. A module ID cannot refer to conflicting implementation files.
- Handlers receive args and return data directly: objects, arrays, strings, numbers, booleans or null. `host.tools.call` returns that value unchanged. `outputSchema` validates the value without extracting or converting it. Throw for failures; an object containing `isError` is still ordinary data. The host builds native Pi presentation envelopes internally.
- Module initialization has no host access, imports or Node globals. Each invocation has a fresh VM; closures do not persist.
- Replacement edits a file and activates a new snapshot. Removal deletes its definition or removes it from `agent.yaml`'s loading list, then activates.
- Hooks use `{id:"module.hook",event,handler:{module,file,export}}`, loaded from an explicit ordered list. Events: `tool_call`, `tool_result`, `agent_start`, `agent_end`. `tool_call` may return `{block,reason}`; `tool_result` may return `{content?,structuredContent?,details?,isError?}`. Notifications return nothing. Hooks have a 30-second deadline. Avoid recursive self-triggering.
- Result hooks operate on native presentation envelopes. Changing only `content` preserves the handler's return value. Explicitly changing `structuredContent` replaces it; the replacement must still satisfy `outputSchema`.
- `host.hooks.list()` lists the selected hooks. `host.calls.list()` returns `{id,handler,revision}` records; `host.calls.cancel({id})` interrupts an invocation.

## Task environment primitives

These operations are independent of Harness storage. This backend accesses the **real host filesystem**, with cwd-relative paths and no workspace-root confinement. QuickJS isolation does not provide OS isolation for these capabilities. Native read/bash permission extensions do not automatically mediate primitive calls.

- `host.fs.read({path,offset?:byteOffset,length?:byteCount,encoding?:"utf8"|"base64"})` → `{data,bytes,eof}`. Defaults: offset 0, length 65536, UTF-8; maximum length 8 MiB. Continue with `offset += bytes` until `eof`. Use base64 for byte-perfect chunking across UTF-8 character boundaries.
- `host.fs.write({path,data,encoding?,append?})` → `{bytes}`; parent directories must exist. `host.fs.stat({path})` → `{size,mtimeMs,type}`; `host.fs.list({path})` → `[{name,type}]`.
- `host.fs.mkdir({path,recursive?})`, `host.fs.rename({from,to})`, `host.fs.remove({path,recursive?})`.
- `host.process.spawn({program,args?:string[],cwd?,env?:Record<string,string>})` → `{id,stdin,stdout,stderr}`. No implicit shell; use program `bash` with args `["-c",command]` for shell syntax.
- `host.streams.read({id,maxBytes?,encoding?})` → `{data,bytes,eof}`; `host.streams.write({id,data,encoding?})` → `{bytes}`; `host.streams.close({id})`.
- `host.process.wait({id})` → `{exitCode,signal}`; `host.process.terminate({id})`. Drain stdout/stderr concurrently before waiting. Handles belong to one invocation; cleanup closes streams and terminates process trees.
- `host.env.info()` → `{cwd,platform}`; `host.clock.now()` → `{unixMs,monotonicMs}`; `host.clock.sleep({ms})`.
- `host.state.get({key})`, `host.state.set({key,value})`, `host.state.delete({key})`: immediate JSON state, scoped by module and session branch, capped at 4 MiB. Controller `store(key,value)` / `load(key)` instead commit on script success.
- `host.session.history({offset?:0,limit?:20})` returns raw branch message entries, maximum 100, excluding definition metadata.

Output helpers are `observe(value,{view?})`, `text(value)`, `image(block)` and `console.log(...)`. Only the controller chooses `loop.next/finish`.

Process exit preserves unread stdout/stderr for later reads in the same invocation. The host keeps pipes in pull mode so process cleanup cannot silently discard buffered output. Large outputs still require concurrent draining to avoid pipe backpressure blocking exit.

## Loop outcomes and recovery

`loop.decide` receives `{outcome,state,reminders}` plus parsed policy options. `outcome.status` is one of `next`, `finish`, `assistant_finish`, `execution_failed`, `missing_decision`, `invalid_batch`, or `invalid_tool`. `assistant_finish` includes `text` and requires a normal stop, nonempty text and no tool calls. It also contains the top-level `toolCalls` and `results`; each result includes `toolCallId`, `toolName`, `isError`, optional `loopControl` and structured `error`, and the completed primitive/nested `calls` with their arguments, status and effects.

The rule returns `{action:"accept"|"continue"|"stop",state,reminder?,text?}`. State is arbitrary JSON owned by the rule, initialized to `{}` at agent start. `reminders` maps the names configured in `agent.yaml` to prompt text; optional generated `text` overrides the selected template. The host records the outcome and new state with each recovery message.

The default rule accepts `next`, `finish` and `assistant_finish`, resetting both counters. A custom rule can inspect the final text and request more work instead. The rule counts execution failures and protocol mistakes separately using `maxExecutionRecoveries` and `maxCorrections`. Execution reminders include the actual error and completed operations, warning that effects were not undone. Missing-decision reminders apply when a script succeeded without a decision or a response is empty or truncated. Illegal tool batches have their own outcome. Provider failures and cancellation do not consume either budget. The host never automatically reruns a failed script.

Asynchronous host-call failures retain the JavaScript call site. Errors inside handlers identify the module file, revision and line, alongside the controller call site. QuickJS does not automatically retain that caller after the host responds, so the bridge captures the stack when the call starts and attaches the host error message on rejection.

Top-level input validation happens before codemode runs. Its diagnostic contains bounded schema errors and an argument shape/length summary, with short values displayed literally; it does not echo entire source documents as encoded JSON. Original arguments remain in the tool-call record. Default recovery reminders identify completed operations by name and, where available, domain/path instead of repeating their serialized arguments.

## Versions, context and recovery

Each snapshot hashes the complete definition file set. New root calls use the active snapshot; an in-flight tool chain, its nested calls and hooks retain their original snapshot. Activation does not cancel running calls. Request presentation and output rendering use the request snapshot, so `now` cannot rewrite an inference already sent.

Before a scheduled activation commits, the host constructs and validates the complete candidate request. If the candidate requires compaction, it stages the summary checkpoint first. Failed rendering, invalid message relations or capacity checks preserve the old active version and history; paid summary usage is still recorded. The host does not silently mix old context with new tools.

Snapshots, drafts, pending activation and module state are journaled as `codemode-harness-v1` entries. `codemode-harness-request-v1` records a unique requestId, inputs, final messages, catalog, dependencies and revision. Detail inspection reads these saved results without rerunning context rules. Different requests may share a definition revision but have different inputs. Pages remain readable across activation, resume and compaction on the same branch; requests from other branches are unavailable. Resume and branching replay state without replaying task effects. Compaction rebuilds the catalog from definitions; it does not erase tools. Rollback does not undo task files or business state. The earlier `codemode-runtime` experimental format is rejected explicitly.

The editable default compaction serializer retains tool argument structure and moves source, long strings and strings requiring quoting into separately labelled literal text blocks. Block delimiters accommodate backticks in the text. `policies/compaction.yaml` sets `toolCallMaxChars` (default 8000) per tool call; shortened and omitted text is explicitly marked. Tool results retain their observed text, subject to the separate `toolResultMaxChars` budget. This projection changes summary-model input only; recorded arguments, definition files and tool returns remain unchanged.

If an active rule fails on a later input, request construction stops with a source-tagged error. The user can run `/harness status` or `/harness restore <revision|initial>` while idle, without needing a working model request. This command is a native recovery entry, not a provider tool.

Updated bundled defaults initialize new Harness sessions. Resume preserves the session's versioned definitions, including model edits; it does not overwrite them with new bundled prompts.

Host-owned behavior remains explicit in `inspect({section:"provenance"})`: transport, credentials, routing/retries, VM limits/cancellation, the bootstrap pointer, codemode's input schema, output truncation/spill/image/error mechanics and native extension execution/resource discovery. Default rules consume native extension contributions after the native context pipeline. Their original TypeScript remains host-owned; their contribution and its use are recorded.


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
