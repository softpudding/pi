# Model in, Human out

Status: explicit codemode loop control is implemented experimentally in pi-mih. The implementation adds scheduling metadata and correction messages without changing result formatting, provider-message conversion, or append-only context. Model-authored tools, memory hooks, and compaction strategies remain design explorations.

## Thesis

As models become more capable, more of an agent's operating strategy should be authored by the model rather than fixed by human-written harness code.

An agent can be understood as three parts:

- **Model:** reasoning and generation.
- **Harness:** orchestration, context construction, memory management, tool integration, scheduling, and other machinery around the model.
- **Sandbox:** the execution environment and the boundaries on what generated programs can access and affect.

These are useful responsibilities, not necessarily separate processes. In particular, a sandbox may execute code that performs harness responsibilities.

Our long-term hypothesis is that more of the strategy currently implemented inside the harness could become model-controlled. The human-defined substrate would provide execution semantics, authorized capabilities, storage, and lifecycle boundaries. Existing mechanisms that already express the model's decisions can remain in place.

"Human out" means moving humans out of prescribing the agent's operating procedures. It does not mean removing the user's goals, control, or ability to interrupt. "Model in" means giving the model executable ways to author those procedures, not merely more settings to choose from.

## Why codemode is the starting point

Traditional tool-calling agents let the model choose actions and indirectly signal whether to continue working. The harness interprets tool calls as a reason to continue and a response without tool calls as completion. Human-written code also determines much of the context policy: append interactions, include tool results, and eventually compact the accumulated conversation.

[Codemode](codemode.md) moves some of that procedure into model-written JavaScript. The model can compose tool calls, branch on results, run independent operations concurrently, handle failures, retain state, and choose what output returns to its next inference.

For example, a script can:

```text
Model authors a procedure:
  search
  fetch relevant items concurrently
  classify results
  retain useful state
  return only unresolved cases as the tool result
```

The generated procedure controls part of the agent's information processing. Choosing which tool results the model subsequently observes is already a form of context construction.

Constructing the latest tool result is therefore already supported. Wrapping that operation in another context API would add little. What is missing is explicit model-authored control over whether another inference happens at all, independently of tool use. Further questions concern reusable tools and procedures that govern future results, memory additions, and compaction.

Earlier prompts, scripts, and tool results continue through Pi's normal context pipeline. They remain part of the prefix until an existing compaction boundary.

The underlying shift is:

> The model decides which behavior needs deliberation, which behavior should become an executable procedure, and when that procedure should change.

## Exploration 1: model-controlled loop

### Problem

Pi's ordinary tool-calling loop uses this default rule, apart from queued input, failures, and explicit host-side overrides:

```text
Model response
  ├─ tool calls → execute tools → prepare context → next inference
  └─ text without tool calls → complete the run
```

Modern tool-calling models are commonly trained around this convention. The model can influence the loop, but the harness still derives continuation from the response's shape. Calling a tool implicitly requests another inference; writing only text implicitly ends the run.

These are different decisions. A script may have enough information to finish immediately after executing a tool. Conversely, the model may need another reasoning step without calling any underlying tool. The proposal makes that decision executable instead of inferring it from tool use.

### Example

Change codemode's top-level return from an arbitrary result into a control value:

```js
return loop.finish(msg);   // End the current agent run and deliver msg.
return loop.next(results); // Continue with results as newly appended context.
```

These are alternative returns, not two sequential actions. A script can choose between them based on execution results:

```js
const result = await tools.bash({ command: "git diff --check" });
if (result.exit_code !== 0) {
  return loop.next({ failures: result.output });
}
return loop.finish("The diff has no whitespace errors.");
```

A passing check can finish the verification task without another inference just to restate the result. A failing check supplies evidence for the next reasoning step. A script can also return `loop.next(...)` without calling any underlying tool.

### Direction: return a decision, not just data

The proposed normal path is:

```text
Model authors a codemode script
  → sandbox executes it
  → host validates its returned control value
      ├─ loop.next(results) → append results → prepare context → next inference
      └─ loop.finish(msg)   → deliver final answer → end the current run
```

| Return | Meaning |
|---|---|
| `loop.next(results)` | End this script, append the selected results, and request one next model inference, subject to external limits and cancellation. |
| `loop.finish(msg)` | End this script and the current autonomous run, delivering `msg` as the final answer without another inference. |

The helpers construct structured control values. They do not invoke the LLM from inside the sandbox, and calling a helper without returning its value does not commit a decision. The host applies the decision only after successful script completion and validation. No persistent VM or recursive model call is required.

For the first experiment, `results` can be text or JSON-serializable data and `msg` is final-answer text. `results` is the new context suffix, not a replacement conversation or a way to select higher-priority message roles. The host retains required call/result records, user input, and applicable instructions. The payload is appended once, not both as a tool result and as a duplicate context message.

Control metadata travels separately from rendered output. The host must not parse tool-result text, `text()`, `image()`, console output, or assistant prose for loop commands. Existing output helpers retain their output semantics but never select continuation. On `next`, their model-visible output and the selected `results` form the codemode result; on `finish`, other output stays in the execution record without requiring another inference.

`loop.finish(msg)` closes the codemode call/result pair without an extra inference. In the minimal implementation, `msg` remains ordinary codemode output in the transcript and JSON events; no synthetic assistant message or new result-to-message conversion is introduced. The interactive CLI renders successful `finish` text output as an ordinary assistant reply outside the tool box, including during session replay. Tool expansion does not hide that reply. Plain print mode still prints only assistant text. The session remains available for later user input; finishing a run does not shut down Pi or discard queued user messages.

A response must contain exactly one codemode call and no other top-level tool calls. Two scripts could return conflicting decisions, or an ordinary sibling tool could perform a side effect outside the controlling script. The codemode extension therefore checks the complete assistant response before each top-level call executes. Multiple codemode calls, or codemode mixed with other top-level tools, reject the entire batch through ordinary error results before any tool implementation or script runs. The existing bounded correction then asks the model to consolidate its operations into one script. This rule also applies under sequential scheduling; serializing competing controllers would not resolve the ambiguity.

Batching and concurrency belong inside that one script, for example `const results = await Promise.allSettled([...]); return loop.next(results);`. Nested tool calls retain their existing execution and permission checks. Use the existing `codemode.mode: "only"` setting to route underlying tools through scripts. The core scheduler is unchanged: `finish` still uses the existing `terminate` flag, now from the sole top-level call. Batches without codemode, queued user input, and trusted extension scheduling keep their existing behavior.

### Model training and missing decisions

This changes the execution contract, not just the prompt. In this mode, a text-only model response is not successful completion. Nor do a plain `return results`, an omitted return, or `exit()` implicitly mean `next` or `finish`. Text alongside a valid controller call can be commentary, but only the returned control value decides normal continuation.

Current models may still emit a conventional final answer without calling codemode. Instructions and examples must teach explicit completion. A missing or invalid decision should produce a bounded corrective inference asking for a valid control return; exhausting that recovery budget reports a protocol error, not successful completion. Silently treating prose as `finish` would restore the old rule.

A script exception or missing control return commits no loop decision. Existing output and store-success rules remain unchanged; the correction is a separate appended message, not a replacement tool result. Allow three consecutive corrections, then abort with a visible protocol error. Do not automatically rerun a script whose tools may already have changed the outside world. Truncated model-generated scripts must not execute. Cancellation and provider failures do not trigger protocol corrections.

The harness still implements execution, validation, recovery, permission checks, budgets, and interruption. What moves to the model is the ordinary decision to continue or finish. Recovery is an exceptional protocol repair, not a competing task strategy. This experiment does not change the authority of user input or trusted host extensions.

## Preserve the context prefix

### Problem

Explicit loop control does not require reconstructing the whole context before every inference. Editing an earlier message changes the prefix and prevents reuse of the old cached suffix from that point. Reducing the number of input tokens does not necessarily reduce inference cost.

### Example

```text
Previously committed context
  + assistant codemode call
  + results selected by loop.next(results) and permitted hook additions
  → next inference selected by the model's control return
```

For example, a script can retain a full test log outside the model context and return only failures. Once that result has entered the context, later scripts leave it in place. A correction or updated conclusion is appended.

### Direction

The model constructs the **new context appended to the next inference**. During ordinary continuation on the same branch and model, previously committed model-visible content keeps its order and representation.

This constraint includes the system prompt and tool declarations as represented to the provider. An append-only session log is insufficient if request preparation rewrites the actual provider input. Keeping a prefix stable preserves the opportunity for cache reuse; it does not guarantee a cache hit.

Continuation is selected by `loop.next`, while memory and context procedures prepare additions for that selected inference. They do not independently schedule extra inferences. Pi retains tool execution, cancellation, transport retries, and user-input handling as substrate responsibilities; these are distinct from the model's normal continuation decision.

Compaction is the necessary boundary when accumulated context approaches Pi's configured capacity threshold. Pi rebuilds the context there, incurring the associated cache loss, then resumes appending to the new prefix. Model-authored compaction uses that existing boundary.

## Exploration 2: model-defined tools

### Problem and example

A model may repeatedly write the same procedure to run tests, parse failures, preserve full logs, and return a concise result. Codemode can execute each script, but reusable tool definitions and their lifecycle remain a separate capability.

The model could define a tool for that procedure, revise its parser after encountering a new failure format, and remove it when the workflow is no longer useful. This includes defining new tools and modifying or withdrawing existing tools within the permitted registry.

### Direction

Tool changes govern future execution. Earlier calls, results, and descriptions remain recorded. Removing a tool makes it unavailable for future calls; a stale call receives an ordinary unavailable-tool result.

A candidate design keeps a stable provider-facing execution and discovery interface, such as codemode, while definitions change behind that interface. The model discovers new definitions through appended tool results. Registering a helper must not silently regenerate an earlier inline tool catalog or leading prompt.

This matters for existing tools too. Changing native provider tool schemas can change the cached prefix. Pi already records tool changes as transcript deltas, but [some providers require a complete checkpoint](extensions.md#activate-tools-dynamically), which can invalidate that prefix. Dynamic registration alone therefore does not establish compatibility with this design.

The stable interface is a candidate, not a selected API. Its value would be letting the model evolve executable capabilities and the observations they produce while preserving the committed provider prefix.

## Exploration 3: model-defined memory and hooks

### Problem and example

Different tasks benefit from different retained state. A debugging task may need failing cases and eliminated hypotheses; a repository migration may need per-file progress and unresolved compatibility decisions. A fixed memory format may fit neither.

The model could define a task record, update it after tools complete, and retrieve relevant records before the next inference. A **hook** is a stored procedure invoked at a specified lifecycle boundary. The host provides those boundaries; the model authors what the procedure does there.

### Direction

Explore model control over memory representation, extraction, retrieval, retention, and the hooks that maintain it. For example:

```text
Tool execution completes
  → a stored procedure updates task records and evidence references
Before the next scheduled inference
  → a stored procedure retrieves relevant records
  → useful additions enter the new context suffix
```

Stored memory can change without rewriting messages already sent to the model. A revised conclusion enters the conversation as new information. Records already present in the prefix need not be reinserted on every turn.

Keep three things distinct:

- **Session history:** recorded interactions and execution outcomes.
- **Model context:** the committed prefix plus newly appended content, rebuilt only at existing boundaries such as compaction.
- **Retained state:** mutable memory, artifacts, and reusable procedures outside the model context.

Conclusions should retain references to their evidence so that a bad memory decision can be inspected and corrected. Large raw results can stay outside the prompt and be retrieved when needed. Omitting a raw result before its first insertion is compatible with preserving the prefix.

Pi's extensions offer useful lifecycle integration points, but trusted host extensions have broader powers than this proposal requires. Model-authored hooks need an explicit execution contract for state updates and context additions. They do not require unrestricted extension loading or a persistent VM.

## Exploration 4: model-defined compaction strategy

### Problem and example

Context cannot grow indefinitely. As it approaches the configured threshold, compaction must leave room for subsequent inference and tool results. Pi already has automatic compaction, manual compaction, and overflow recovery.

At that boundary, a debugging task might retain exact compatibility constraints, the current failing test, established conclusions, and references to full logs. A migration task might instead emphasize completed files, pending work, and decisions that must remain consistent.

### Direction

Keep Pi's existing compaction path and explore model-authored policy for what to retain verbatim, what to summarize, what can be retrieved later, and how to organize the resulting context. The existing [`session_before_compact` hook](compaction.md#session_before_compact) is a possible integration point.

Actual history compaction replaces part of the provider context. The old prefix cannot be assumed reusable across that replacement. Afterward, ordinary append-only continuation resumes from the compacted context. The design accepts this necessary cost at the compaction boundary and measures it, including summary generation and the processing of the new prefix.

Filtering a large tool result before appending it is also useful, and codemode already supports it. That slows context growth. Appending a summary of material already in the context does not remove the original material or free context capacity.

Model-authored compaction is a hypothesis about better retention, not a guarantee. Validation must check that required instructions, unresolved obligations, and evidence needed for the task survive, while preserving valid message roles and tool-call/result relationships.

## Procedures should reduce repeated work

These capabilities should let the model turn repeated reasoning into reusable procedures. They do not require an additional full inference before every ordinary inference.

For example, a stored test-processing procedure can handle known output formats directly and return unexpected output for the next normal model response to inspect. The model can then revise the procedure. Any extra model calls used for memory extraction or summarization must be included in the cost evaluation.

Procedure persistence and VM persistence are separate choices. Stored code and explicit state may be enough. Experiments with reusable procedures should demonstrate a useful repeated workflow before introducing more machinery.

## What remains in the substrate

The working principle is:

> The model may revise its strategy without silently revising its authority.

The substrate must give generated programs dependable semantics for loop control, tool execution, registration, storage, lifecycle hooks, interruption, and output delivery. User-imposed resource limits and access boundaries remain enforceable outside the generated strategy. Memory additions and compaction must preserve applicable instructions and valid model requests.

These contracts are not reasons to freeze workflow policy. We should ask of each fixed harness behavior: is it required for execution or an external constraint, or is it merely a strategy that humans currently prescribe?

Pi's branch-aware sessions are a useful foundation for defining the scope of tools, memory, and hooks. Branch navigation does not undo external effects such as file writes or remote API calls. Likewise, sandboxing generated JavaScript does not automatically sandbox the tools it can call.

## Pi foundations and current limits

The existing implementation provides several useful building blocks:

- `packages/codemode/src/runtime/`: fresh QuickJS execution environments, a host bridge, cancellation, and output handling.
- `packages/coding-agent/src/extensions/codemode/execute.ts`: tool composition, discovery, model helpers, and branch-aware store integration.
- `packages/coding-agent/src/core/agent-session.ts`: nested calls through the normal tool pipeline, session state, and existing compaction integration.
- `packages/agent/src/agent-loop.ts`: the existing tool-calling loop, host-side continuation and termination controls, and request preparation. These are integration points, not the proposed model-facing protocol.
- [Extensions](extensions.md): tool registration and lifecycle integration points. These are host-side capabilities, not automatically available to codemode scripts.
- [Compaction](compaction.md): existing thresholds, retained history, and custom summarization hooks.

Codemode already selects its output and supports explicit retained state. Its VM state is temporary; explicit store writes persist only on successful execution. Tool effects are not rolled back on script failure. Scripts do not currently expose general tool registration or installation of lifecycle hooks.

Codemode's declaration can include an inline tool catalog. Preserving its name and input schema alone is insufficient if registering a tool changes that description. Any stable-interface experiment must account for the entire declaration and its provider representation.

The minimal implementation adds `loop.next` and `loop.finish` as sandbox globals. Their payload becomes the ordinary return value; only a separate `loopControl` field crosses the worker bridge. The codemode tool records that field in result details and maps `finish` to the existing `terminate` flag. A `tool_call` handler rejects invalid top-level codemode batches before execution; a `turn_end` handler appends correction messages through Pi's existing boundary API. Core agent-loop, context-construction, and message-conversion behavior are unchanged. The codemode renderer presents successful `finish` output with the assistant message component without adding a transcript entry. The other exploratory APIs remain unimplemented.

## Experiment and validation

The initial implementation has been exercised with three configured models through the compiled pi-mih binary. See [validation results and limitations](model-in-human-out-validation.md) for the tasks, request traces, interactive checks, and reproduction commands.

Start by isolating explicit loop control from the other three directions. Verify that a script can finish after a tool call without another inference, and can request another inference without an underlying tool call. This establishes the new scheduling contract before adding reusable tools, memory hooks, or custom compaction.

A later workflow could exercise all four directions together:

```text
Model defines a reusable test tool and task-memory procedure
  → calls produce concise results and update retained state
  → loop.next(results) selects continuation
  → results and relevant memory are appended
  → the next inference reuses the committed prefix
Model revises or withdraws a procedure as the task changes
  → the change affects future execution and is reported through appended content
Pi reaches its compaction threshold before a requested next inference
  → the model-authored strategy constructs the compacted context
  → append-only continuation resumes
Model's script determines the task is complete
  → loop.finish(msg) delivers the answer without another inference
```

Compare this against ordinary Pi with codemode. The experiment needs to show value beyond writing another one-off script or relying on existing state storage.

Loop verification should cover exactly one next request for `next`, no extra request for `finish`, and no duplicate payload or final answer. Include text-only responses, missing control returns, rejection of multiple controllers and mixed top-level batches before side effects, concurrency inside one script, unaffected non-codemode batches, script failures after tool effects, truncated scripts, cancellation racing with a return, queued user input, and resume without replaying completed effects. Verify that diagnostic text resembling a control value cannot control the loop and that recovery is bounded.

Mechanical verification should inspect actual provider requests, including prompt and tool declarations, rather than relying only on session-log structure. Check prefix stability between compactions, prospective tool changes, hook ordering and failure behavior, resumed or branched state, and valid compaction output. A deterministic faux provider can check request construction without paid model calls; actual cache behavior requires provider-level measurements.

Task-level evaluation should measure correctness, retained constraints, recovery from bad memory decisions, repeated procedure-writing effort, latency, cached and uncached input, and total inference cost. For loop control, measure protocol compliance, corrective inferences, premature completion, unnecessary continuation, and avoided final-answer inferences with current models. Include tool discovery, hook execution, and compaction overhead. Context size alone is insufficient.

## Open design questions

- How reliably can current models learn explicit `next` and `finish` from instructions and examples, and when is training on this protocol necessary?
- How should control values and final answers be persisted and delivered across interactive, print, RPC, and SDK modes, including eventual multimodal payloads?
- How should explicit decisions interact with extension continuation hooks, queued input, and recovery while preserving user control and avoiding duplicate requests?
- What minimal capability lets the model define, replace, and withdraw permitted tools behind a stable provider interface?
- How are changed tool definitions discovered without repeatedly appending an entire catalog?
- Which lifecycle boundaries should model-authored hooks use, and how do ordering, cancellation, and failure work alongside existing extensions?
- How do tools, memory, and procedure versions persist across turns, resume, and branches?
- What history and artifact references can memory procedures inspect without first loading that material into model context?
- What form should model-authored compaction policy take, and how should Pi validate its output and recover from failure?
- Which repeated task demonstrates enough benefit over existing codemode to justify each new capability?
