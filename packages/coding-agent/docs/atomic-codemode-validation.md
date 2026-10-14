# Atomic codemode validation

Validated on 2026-10-13 using the compiled executable from this checkout.

## Build

Binary: `packages/coding-agent/dist/pi-mih` (macOS ARM64).

SHA-256: `a8bdf811e60a518e3e0993fe1917dce0e38d1876a0d04f498a0277c7b423bd92`.

```sh
npm run build:offline
cd packages/coding-agent
bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv \
  ./dist/bun/cli.js ./src/utils/image-resize-worker.ts \
  ./src/extensions/codemode/worker.ts --outfile dist/pi-mih
npm run copy-binary-assets
```

The final instruction update was rebuilt with `npm run build` in `packages/coding-agent`, followed by the same Bun compilation. No dependencies or user credentials were changed.

## Acceptance task

All three models received exactly this prompt:

> 请阅读当前项目根目录下的 README.md，并基于 README 用中文介绍这个项目。过程中请先基于 host 原子能力自行编写并注册可复用的文件读取工具，再调用你注册的工具读取 README；不要直接在顶层脚本中读取文件。

No reader implementation, module source, or model-specific prompt was supplied. The normal codemode declaration supplies the atomic API and a generic arithmetic registration example.

Each run used the compiled binary in RPC mode, with this repository as its working directory. The client held stdin open until `agent_settled`, then closed it. Isolated settings selected `defaultTools: ["codemode"]`, disabled retries and compaction, and reused configured provider authentication. Project extensions, skills, context files, and MCP were disabled for this controlled task; the existing local provider adapter was retained. The request observer recorded only model/messages/tool declarations, without credentials or headers.

## Results

| Model | Model-authored reader | Requests | Result |
|---|---|---:|---|
| `zai-coding-cn/glm-5.3-flash` | `fileread.readFile` | 2 | Pass |
| `opencode-go/deepseek-v4.1-flash` | `fsread.readText` | 2 | Pass |
| `local-llm/qwen3.8-27b` | `fread.readFile` | 3 | Pass after one syntax correction |

For every model, the trace shows:

1. `host.modules.put` saved model-authored JavaScript containing a chunked `host.fs.read` loop.
2. `host.tools.register` bound its export with an input schema.
3. `host.tools.call` invoked that reader through Pi's nested-tool pipeline.
4. The successful reader returned the complete 10,627-byte project README; its text was compared with the actual file.
5. `loop.next` exposed the data to the next inference; `loop.finish` delivered a Chinese introduction covering the project's purpose, customization, interfaces, packages, and setup.

All three runs reached `agent_settled` and exited with status 0. Every provider request declared only `codemode`; no built-in read/edit/write/bash, discovery, or MCP tool was called. Tool declarations remained identical throughout each run, and every previous request's messages remained an unchanged prefix of the next. Message counts were `[2, 4]`, `[2, 4]`, and `[2, 4, 7]` respectively.

Qwen initially used unescaped Markdown backticks inside a JavaScript template literal while composing the final answer. The script failed before any operation, the ordinary correction loop reported the error, and Qwen rewrote the answer as an array of strings. It did not repeat the successful read.

## Exploratory failures and limit of this result

The first trial used only “read README and introduce the project.” GLM and DeepSeek called `host.fs.read` directly and finished with raw README text. General instructions were strengthened to explain registration and why unseen data should return through `loop.next` before interpretation.

With those instructions and the short task, GLM and DeepSeek then passed. GLM repaired an invalid reader result envelope; Qwen still skipped registration while successfully summarizing the README. The final acceptance prompt above therefore includes the user's explicit registration requirement and was run unchanged on all three models.

This establishes that all three models can construct and use registered readers from primitives. It does not establish reliable spontaneous registration when the task omits that requirement. Direct primitive calls remain technically available to controller scripts; the registration workflow is instructed rather than enforced by an extra host policy.

## Deterministic checks

`npm run check` passes. The installed npm reports its existing `min-release-age` configuration warnings; lint and type checks have no diagnostics.

255 targeted tests across 15 files pass. They cover module evaluation and namespace isolation, initialization without host effects, timeouts, registry changes and validation, unregistration, active revision replacement, explicit cancellation, branch navigation and resume, hooks and state, binary file chunks, bounded concurrent stdout/stderr, child cleanup, legacy tool exclusion, loop recovery, output rendering, and request boundaries. The coding-agent suite uses the faux provider; real providers were used only by the explicit binary acceptance runs.

## Evidence and reproduction

Local, git-ignored evidence:

```text
.artifacts/pi-mih-validation/atomic-1791891310785/
  build.json
  prompt.txt
  summary.json
  review.json
  run.mjs
  review.mjs
  <model>/events.jsonl
  <model>/requests.jsonl
  <model>/sessions/*.jsonl
  <model>/generated-<module>-<revision>.mjs
  <model>/answer.md
  <model>/summary.json
```

Run `node .artifacts/pi-mih-validation/atomic-1791891310785/run.mjs` from the repository root to repeat with the current binary and configured providers. This makes real model requests and creates a new evidence directory. The runner uses isolated configuration and removes its temporary credential symlinks afterward.

The two exploratory rounds are retained in `atomic-1791891091395/` and `atomic-1791891176241/` under the same evidence root.
