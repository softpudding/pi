# pi-mih loop-control validation

Validated on 2026-10-13 from this checkout. This is a smoke test of explicit loop control, not a claim about general task reliability. The real-model and binary results describe the initial implementation; the later single-controller guard is covered by the deterministic follow-up below.

## Initial implementation scope

- Sandbox helpers return an opaque control value. The runtime separates its `next` or `finish` tag from its payload before the existing return-value serialization.
- The payload uses the unchanged codemode output path, including formatting, truncation, images, storage, tool-result messages, and provider conversion.
- `finish` maps to the existing tool-result `terminate` flag. `next` uses ordinary continuation with the full previous context.
- The codemode extension appends a correction through `turn_end` when a completed response supplies no decision, including a native text-only stop. Three consecutive corrections are allowed before aborting.
- No core agent-loop, context-builder, message-converter, or renderer changes were made. Existing batch termination, queued user input, and trusted extension behavior remain in place.

## Build

Binary: `packages/coding-agent/dist/pi-mih`.

Built with Node 24.4.1 and Bun 1.3.11:

```sh
npm run build:offline
cd packages/coding-agent
bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv \
  ./dist/bun/cli.js ./src/utils/image-resize-worker.ts \
  ./src/extensions/codemode/worker.ts --outfile dist/pi-mih
npm run copy-binary-assets
```

The build uses the repository's existing assets and locally configured credentials. No provider keys or user configuration were changed.

## Real-model tasks

All models used the same built-in codemode instructions, `codemode.mode: "only"`, and `--thinking low`. No model-specific prompt patches were needed.

1. **Continue, then finish.** Read a file containing `19\n23\n`. The first script returns the file contents with `loop.next`. On the next inference, calculate the sum without reading the file again and return `loop.finish("MIH-<model>-next-finish:42")`. The identifying marker occurs in the original user prompt, not in the file.
2. **Finish directly.** Calculate `7 * 8` without an underlying tool and return `loop.finish` with the tagged answer `56`.
3. **Correct a native stop.** Calculate `8 * 9`. A test-only request observer removes tool declarations from the first request, forcing a text-only provider response. The codemode extension under test appends its reminder; the next request has the ordinary tool declarations and the model returns `loop.finish` with the tagged answer `72`.

The third task is fault injection, not a claim that these models naturally ignore the loop instructions. Removing declarations was necessary because the GLM endpoint still returned a tool call when the first trial used `tool_choice: "none"`. No production request-construction code was changed.

### RPC results

The compiled binary ran from `/tmp`, using its existing RPC mode. The client kept stdin open until `agent_settled`, then closed it for orderly shutdown.

| Provider/model | Continue → finish | Direct finish | Native stop → reminder → finish |
|---|---|---|---|
| `local-llm/qwen3.8-27b` | Pass, 2 requests | Pass, 1 request | Pass, 2 requests, 1 reminder |
| `zai-coding-cn/glm-5.3-flash` | Pass, 2 requests | Pass, 1 request | Pass, 2 requests, 1 reminder |
| `opencode-go/deepseek-v4.1-flash` | Pass, 2 requests | Pass, 1 request | Pass, 2 requests, 1 reminder |

The configured DeepSeek model ID includes `-flash`; no model named exactly `deepseek-v4.1` was available from the configured provider.

All nine final RPC scenarios produced the expected answer, reached `agent_settled`, and exited successfully. The last codemode result carried `terminate: true`; there was no inference after `finish`. The two-step task made exactly one nested `read` call.

The request observer recorded message bodies and tool declarations, not credentials or HTTP headers. In normal continuation, request message counts grew from 2 to 4: the previous messages were an unchanged prefix, followed by the assistant call and its result. Tool declarations also remained identical. Correction requests likewise retained the previous messages; tool declarations changed only because that scenario deliberately withheld them on the first request.

### Interactive results

All three models were also tested in separate tmux terminals, starting the compiled binary from `/tmp`. Each completed the two-step task, visibly returned `loop.next` followed by `loop.finish`, displayed the tagged answer ending in `:42`, and returned to an idle editor. Each made two provider requests with an unchanged message prefix.

For an interactive trial with the existing local configuration:

```sh
BIN="$PWD/packages/coding-agent/dist/pi-mih"
cd /tmp
"$BIN" --offline --model local-llm/qwen3.8-27b --thinking low --tools read,codemode
```

Select either of the other exact provider/model IDs above to repeat the task.

## Deterministic verification

All 201 targeted tests passed across nine test files (73 codemode tests and 128 coding-agent tests). They cover return payload/output equivalence, genuine versus forged control values, failures and cancellation, context-prefix preservation, native-stop correction, bounded correction, truncated scripts, and queued user input. Existing codemode, rendering, MCP, worker-path, tool-orchestration, and boundary tests were also exercised with the faux provider. The MCP startup test now finishes through codemode rather than assuming that a plain assistant response ends the run.

`npm run check` passes. The installed npm emits existing unknown-configuration warnings for `min-release-age`; dependency/security configuration was left unchanged.

### Single-controller follow-up

The codemode extension now rejects a response containing multiple codemode calls or codemode mixed with other top-level tools. Its `tool_call` hook checks the complete, persisted assistant message before every top-level call, including ordinary tools placed before codemode. No core scheduler change is needed.

All 217 targeted tests pass across the same nine files (73 codemode tests and 144 coding-agent tests). The 16 added cases verify:

- Both parallel and sequential scheduling reject two `next` calls, two `finish` calls, conflicting decisions in either order, and mixed ordinary/codemode calls in either order before any tool or script side effect.
- Every rejected call retains its ordinary call/result relationship; the next request preserves the original context prefix, and a consolidated script can finish normally.
- Concurrent nested calls through `Promise.allSettled` still work inside one controller script.
- Batches without codemode still execute, whether codemode is active or inactive.
- Repeated invalid batches exhaust the existing correction budget. The existing scheduler may invoke the faux provider once more with an already-aborted signal after a tool turn; no further response content or script execution occurs.

`npm run check` also passes, with the same pre-existing npm configuration warnings. The real-model trials above predate this follow-up; rebuilt-artifact verification is recorded below.

### Assistant-style finish rendering

Successful `finish` text output now uses the ordinary assistant component outside the codemode tool box. The change is presentation-only: results, loop metadata, transcript roles, and continuation behavior are unchanged. The assistant component accepts only the fields needed for display, so rendering does not require fabricated model identity or usage.

All 282 targeted tests pass across 13 files (209 coding-agent tests and 73 codemode tests), and `npm run check` passes with the existing npm configuration warnings. Renderer tests compare final output against an ordinary assistant reply byte-for-byte, including Markdown, Chinese text, narrow terminals, output padding, tool expansion, live updates versus replay, theme changes, and replaced/redacted result content. Partial, failed, and `next` results retain their tool presentation.

Source-mode tmux checks with an isolated faux provider passed in regular and fullscreen modes, including tool expansion, terminal resize, and reopening the saved session. Each live run used two requests (`next`, then `finish`) and retained exactly two assistant tool-call messages, with no synthetic final assistant message or correction. No real provider calls or user configuration changes were needed. Captures, summaries, and test logs are saved under `.artifacts/pi-mih-validation/finish-renderer-1791871727535/`. These checks used source mode; rebuilt-artifact verification follows.

### Rebuilt-artifact verification for the reported session

Session `01a133e7-4ca2-77f0-a669-3d7674476e18` exposed a stale build: its final codemode result already had `isError: false` and `loopControl: "finish"`, but the installed local `dist` renderer lacked assistant-style rendering. The old `pi-mih` binary was built at 12:15, before the 14:06 renderer update. Reopening a copy with that binary reproduced the collapsed final answer inside the tool box.

Rebuilt the Node bundles and `packages/coding-agent/dist/pi-mih` with the commands above at 14:23 on 2026-10-13. Both rebuilt runtimes were tested in tmux from `/tmp`:

- Reopening separate copies of the reported session displayed the full final answer with assistant Markdown outside the tool box.
- A fresh prompt through an isolated faux provider completed with one `finish` call, one inference, and the same assistant-style display.
- The original session's SHA-256 stayed unchanged. No real provider request or user-configuration change was needed.

Build logs and before/after captures are in `.artifacts/pi-mih-validation/reported-session-1791872445095/`. The global `pi` executable points at another checkout, so verification used the explicit rebuilt paths. From this repository, reopen the original session with:

```sh
./packages/coding-agent/dist/pi-mih --session 01a133e7-4ca2-77f0-a669-3d7674476e18
```

## Known limitations retained by the minimal change

- `finish` content remains a tool result even though the interactive CLI displays it like an assistant reply. RPC/JSON events still expose the tool result; plain `--print` still outputs only assistant text.
- On this machine, Bun 1.3.11 in one-shot JSON mode exited during codemode worker completion before emitting the tool result. This also reproduced in an isolated sandbox with ordinary `return 42`, without loop control. Node completed that reproduction normally; keeping an event-loop handle alive also allowed Bun to complete it. This pre-existing worker-lifetime issue was left unchanged to avoid expanding the implementation scope. The successful binary tests use RPC and interactive mode, whose input streams keep the process alive.
- The initial binary relied on the prompt's single-call instruction and the existing batch termination rule. The source now rejects invalid codemode batches before execution, as described above, while retaining the core scheduler.
- These are short, controlled tasks. Long-running tasks, additional providers, and large-context cache behavior need separate evaluation.

## Local evidence

Final RPC events, request snapshots, prompts, per-case assertions, and tmux captures are saved under:

```text
.artifacts/pi-mih-validation/rpc-1791864329876/
  summary.json
  <model>-<scenario>.events.jsonl
  <model>-<scenario>.requests.jsonl
  <model>-<scenario>.prompt.txt
  <model>-<scenario>.summary.json
  tui-summary.json
  tui-<model>.requests.jsonl
  tui-<model>.capture.txt
```

These artifacts are local and git-ignored. Initial one-shot JSON failures are retained separately under `.artifacts/pi-mih-validation/1791864053903/`.
