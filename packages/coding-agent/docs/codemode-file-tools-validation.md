# Codemode 文件工具验证（2026-10-15）

本文保留各轮原始结果。最新的请求契约与提示词去重复验见文末；不同二进制的成绩不合并计算。

本轮将 free-form 的默认调用方式改为 JavaScript 原文，包括编写 module、文件内容和编辑文本的调用。JSON 调用继续推荐 `code` 承载控制、`data` 承载源码与编辑文本。两种协议都保留显式 `{code,data?}` / `{finish}`，没有新增反转义、隐式转换或针对模型错误的 few-shot。

九次有效运行全部完成了工具定义、写入、读取、局部编辑和再次读取。但只有 Astra 三次均无发现的错误。GLM 有两次发生调用失败，另一次有未抛异常的 stdout 读取错误；DeepSeek 第三次有一次 JavaScript 属性访问错误。

## 测试条件

- 使用重新编译的独立二进制和冻结的 Harness 资源，`--thinking low`。每个模型连续运行三次，三个模型之间并行。
- 每次 pi 实例都有独立的空工作目录、agent 配置和 session 目录。模型不继承上次生成的工具、任务文件或对话。
- provider 顶层工具始终只有 `codemode`，初始内部工具集合为空。没有预置 read/write/edit，没有人工提供实现或中途修正模型调用。
- 测试扩展只记录实际 provider 请求、工具调用和结果，并在调用前后同步保存 `hello.py` 的内容与 SHA-256；不修改输入或返回值。
- 关闭自动重试和压缩。保留所有失败及恢复过程。
- 这里的 sandbox 指任务执行环境；后端仍为宿主真实文件系统。独立 cwd 不等于 OS 沙箱隔离。

二进制 SHA-256：`9a6c75efb1ea80c29a3332026afd776c6da516306f5f83e9b4d82cd3b9ca60db`。

产物根目录：[file-tools-1792038230519](../../../.artifacts/pi-mih-validation/file-tools-1792038230519/)。其中 `build.json` 包含资源哈希，`run.mjs` 是测试驱动，`verification.json` 是独立核验结果。每个运行目录保留 `requests.jsonl`、`events.jsonl`、`files.jsonl`、`definitions.json`、`summary.json`、会话和前后两个 Python 快照。

统一 query：

```text
请自行探索当前 agent 的能力定义方式，在 sandbox（当前任务目录）中使用原子能力，自行定义并激活可复用的 read、write、edit 三个内部工具，随后通过 codemode 调用你定义的工具完成以下任务：
1. 用 write 创建 hello.py，运行这个 Python 文件应输出 hello world；用 read 读取并核对内容。
2. 用 edit 修改同一个 hello.py，使其运行时输出 bye world；只修改必要的文本，不要用 write 全文覆盖，再用 read 核对修改后的内容。
工具的实现方式由你自行决定，任务文件仅放在当前目录。最后用中文简要报告完成情况和实际编辑范围。
```

## 逐次结果

“失败调用”按失败的顶层 codemode 执行计数；同一次执行中的多个展示错误合计一次，明细单独列出。保守纳入模型自己写出的 JavaScript 和工具 schema 错误，不把它们全部归因于输入协议。该计数不包含未抛异常的逻辑错误。

| 模型 | 有效运行目录 | 完成任务 | 失败调用 | edit 实际参数 | 其他已观察问题 |
|---|---|---|---:|---|---|
| `openai/gpt-6-astra` | `astra-1` | 是 | 0 | `hello` → `bye` | 无 |
| 同上 | `astra-2` | 是 | 0 | `hello` → `bye` | 无 |
| 同上 | `astra-3` | 是 | 0 | `hello` → `bye` | 无 |
| `zai-coding-cn/glm-5.3` | `glm53-1` | 是 | 3 | `hello` → `bye` | 见下方展示与 controller I/O 记录 |
| 同上 | `glm53-2` | 是 | 0 | `hello world` → `bye world` | 首次运行丢弃 stdout，下一次请求重跑修复 |
| 同上 | `glm53-3` | 是 | 3 | `hello` → `bye` | 修复后观察源码仍主动使用 JSON 编码 |
| `opencode-go/deepseek-v4.1-flash` | `ds-4` | 是 | 0 | `hello world` → `bye world` | 观察源码主动使用 JSON 编码 |
| 同上 | `ds-5` | 是 | 0 | `hello world` → `bye world` | 观察源码主动使用 JSON 编码 |
| 同上 | `ds-6` | 是 | 1 | `hello world` → `bye world` | 属性访问错误，见下 |

所有有效运行均正常结束，没有 provider 请求失败。DeepSeek 的首次启动遗漏了本机 provider 扩展，模型调用前提示没有 API key；对应 `ds-1` 及终止的 `ds-2/3` 占位实例均为零请求。修正测试配置后使用 `ds-4/5/6` 完成三次有效运行，原始记录保留，不计入模型成绩。

## 具体失败与恢复

### GLM 第一次：三次失败调用

[调用与错误记录](../../../.artifacts/pi-mih-validation/file-tools-1792038230519/glm53-1/summary.json)。

1. 请求 3：`begin()` 返回完整句柄后，模型调用 `prepare({draft})`，把句柄对象嵌入应为字符串的 `draft` 字段。报 `/draft: must be string`。此前四个定义文件已成功写入草稿。
2. 请求 4：恢复时猜测草稿 ID 为 `d1`，报 `Unknown Harness draft d1`。随后通过 inspect 找到真实 ID，prepare 和 activate 成功。
3. 请求 8：对 write 返回对象、edit 返回对象和运行结果对象分别调用不带 view 的 `observe`，产生三条“object/array requires an explicit view”诊断。它们属于一次 presentation 失败。文件写入、两次 read 和局部编辑均已执行；宿主没有回滚，也没有自动重做副作用。模型下一次调用结束任务。

### GLM 第二次：没有失败调用，但有一次逻辑错误

[调用与结果记录](../../../.artifacts/pi-mih-validation/file-tools-1792038230519/glm53-2/summary.json)，[实际输出](../../../.artifacts/pi-mih-validation/file-tools-1792038230519/glm53-2/events.jsonl)。

请求 4 先执行了一次 `await host.streams.read({id:pr.stdout})` 并丢弃结果，再进入循环读取剩余输出。因此观察结果为 `run1 output:`，后面为空。请求 5 明确重跑 Python，正确收集 `hello world`，随后完成 edit 和 `bye world` 验证。

这次不能称为“全程无错误”：零异常计数没有覆盖 stdout 被主动丢弃的问题。文件内容和编辑结果一直正确。

### GLM 第三次：三次失败调用

[调用与错误记录](../../../.artifacts/pi-mih-validation/file-tools-1792038230519/glm53-3/summary.json)。

1. 请求 2：两次调用 `observe(result.text,{view:"pi.read"})`。`pi.read` 要求完整 `{text,...}` 对象，传入字符串导致两条展示类型错误。下一次改为传完整 read 对象。
2. 请求 4：工具名为 `fs.edit`，模型把 handler.export 也写成 `fs.edit`；实际模块导出为 `edit`。prepare 报 `Expected file.mjs#export: modules/fs.mjs#fs.edit`，修复三个 export 后成功。
3. 请求 7：模型自己的 read schema 将 `offset`、`length` 都列为 required，但调用只传 `path`。write 已成功，read 校验失败。下一次补齐参数，读取已有文件后继续编辑，没有重复 write。

### DeepSeek 第三次：一次 JavaScript 属性访问错误

[调用与错误记录](../../../.artifacts/pi-mih-validation/file-tools-1792038230519/ds-6/summary.json)。

请求 2 用 `r[p] = res.text` 保存多个 Harness 文件，其中 key 是 `agent.yaml`；观察时却调用 `observe(r.agent.yaml)`。因为 `r.agent` 不存在，报 `TypeError: cannot read property 'yaml' of undefined`。下一次改用字符串 key 访问后继续。这是模型代码的属性访问错误，没有发生输入解码或转义错误。

## edit 的范围与文件核验

核验同时检查调用参数与同步文件快照，不能只依据最终 diff 判断调用是否提供了整份新文件：

- 九次运行都自行定义、激活并调用了 read/write/edit。每次只有一次成功 write、一次成功 edit，以及编辑前后两次成功 read；全部文件读写发生在各自的 `workspace/hello.py`。
- Astra 三次、GLM 第一次和第三次只传 `oldText:"hello"`、`newText:"bye"`：连续替换范围为 5 → 3 个字符。
- DeepSeek 三次和 GLM 第二次传 `hello world` → `bye world`：11 → 9 个字符，是局部替换，但多携带了不变的 ` world`。这四次未达到最小连续文本范围。
- 没有一次 edit 参数携带整份文件。九份文件均由 21 字节变成 19 字节，引号、print 调用及末尾换行保持不变。没有用已定义的 write 工具替代 edit。
- 模型生成的 edit handler 都通过读取原文、匹配、拼接，再调用 `host.fs.write` 写回完成编辑。因此它们在工具调用语义上是局部编辑，在底层文件写入上仍是完整写回；本轮没有验证原位字节修改。

独立审查两个快照均只有一条常量 `print` 语句后，逐份运行全部 18 个 Python 快照。九个初始版本 stdout 均为 `hello world\n`，九个最终版本均为 `bye world\n`，退出码全部为 0。只验证了本任务的小型 ASCII 文件，不能据此认定这些自生成工具已覆盖大文件、并发或所有编码边界。

## 输入协议及仍存在的引导缺口

实际 provider 请求确认：Astra 收到 `custom` 工具，GLM 和 DeepSeek 收到 `function` 工具，三者均只声明 codemode。三组请求都包含本轮更新后的协议指引。

Astra 三次共 15 次 codemode 调用全部使用 JavaScript 原文，包括定义 module 和写入 Python，没有转成 JSON envelope，没有使用 data。任务和调用均无错误，符合此次 free-form 默认入口的目标。

GLM 三次都没有采用 data；DeepSeek 仅第二次把 module 源码和工具定义放入 data。其余 JSON 调用仍把文档嵌进 code。data 是建议而非校验要求，这些调用合法，但不能把本轮结果描述为“JSON 模型已经稳定采用 data”。本轮没有发生实际的源码转义或解析失败。

另有两个不产生异常的行为偏差：

- DeepSeek 前两次和 GLM 第三次把 read 正文 `JSON.stringify` 后交给 observe，重新引入了模型观察层的转义。该转义由模型显式生成，宿主没有强制转换返回值。
- GLM 和 DeepSeek 的三次运行均直接在 controller 中使用 process/streams 来运行 Python，没有把这部分 I/O 放进内部 handler。read/write/edit 本身都通过自定义 handler 执行。Astra 前两次额外定义了 run 工具，第三次只读取核对，由独立验收执行快照。

这些现象说明：本轮已经达成 free-form 原文默认调用和自定义文件工具任务闭环，但“所有模型中途无错”“所有 edit 都取最小范围”“JSON 模型稳定采用 data”“展示始终无额外转义”尚未全部达成。没有为这些具体失败追加 few-shot 或修改测试 query 后重算成绩。

## 本地验证

- `npm run check` 通过；npm 仍输出仓库已有的 `min-release-age` 配置提示。
- coding-agent：`codemode-input-protocol.test.ts`、`suite/agent-session-codemode-input.test.ts`，23 项通过。
- ai：`constrained-sampling.test.ts`、`validation.test.ts`，19 项通过。
- `npm run build:offline`、Bun 编译和 `copy-binary-assets` 成功。
- 独立文件核验脚本验证九个不同 cwd、唯一顶层工具、实际输入协议、两个文件状态、调用范围及 18 次 Python 输出。

## 请求契约与引导去重复验

本轮修正模型需要自行判断输入协议的问题。宿主按本次路由后的实际模型和工具声明生成 `host.input-contract`，可编辑的 `rules/input.mjs` 据此选择一种入口说明。Astra 看到提交 JavaScript 原文及可选 JSON envelope；JSON 模型只看到 `code/data` 和 `finish`。参数描述来自 `policies/input.yaml`；无效 envelope 只报告输入错误，不再建议切换协议。`host.harness.edit` 的契约只描述编辑、匹配和版本约束。

默认 guide 只进入 codemode 描述，system 和固定 guidelines 不再重复注入。展示器目录来自请求快照的 `codemode.views`；宿主启动说明使用 `observe(readResult.text)`，不依赖可被删除或改名的展示器。模型修改 guide、参数描述及展示器映射后，下一次请求使用新版本。恢复已有会话仍使用其保存的 Harness 定义，不自动覆盖模型编辑过的文件。

验收继续使用上面的同一 query、三个同一模型和独立目录。没有增加针对失败案例的 few-shot，也没有在运行中给模型补充指令。

### 最终二进制及逐次结果

产物：[input-guidance-final-1792042760000](../../../.artifacts/pi-mih-validation/input-guidance-final-1792042760000/)。二进制 SHA-256：`b48a96a855de2b01f1a14ae7f65cbb7786d78f93605c4fe9b059121d6057e587`。

“失败回合”包括执行异常、展示失败和遗漏 loop 决策；模型生成的实现错误也保守计入。已经捕获的诊断性失败另列，未抛异常的行为偏差不隐去。自动审计原始字段 `mechanismFailureTurns` 会连诊断回合一起标记，人工核对结果与原始记录同时保留。

| 模型 / 运行 | 请求数 | 文件任务完成 | 失败回合 | 成功 edit 参数 | 中文完成说明与编辑范围 |
|---|---:|---|---:|---|---|
| Astra / `astra-1` | 6 | 是 | 0 | `hello` → `bye` | 有 |
| Astra / `astra-2` | 6 | 是 | 0 | `hello` → `bye` | 有 |
| Astra / `astra-3` | 6 | 是 | 0 | `hello` → `bye` | 有 |
| GLM 5.3 / `glm53-1` | 8 | 是 | 2，另 1 回合诊断 | `hello` → `bye` | 有 |
| GLM 5.3 / `glm53-2` | 9 | 是 | 4 | `hello` → `bye` | 无，仅 `finish("done")` |
| GLM 5.3 / `glm53-3` | 6 | 是 | 3 | `hello` → `bye` | 无，finish 返回结果对象 |
| DeepSeek / `ds-1` | 8 | 是 | 1 | `hello world` → `bye world` | 有 |
| DeepSeek / `ds-2` | 8 | 是 | 1 | `hello` → `bye` | 有 |
| DeepSeek / `ds-3` | 9 | 是 | 1 | `hello world` → `bye world` | 有 |

九次都自行定义、激活并调用了 read/write/edit；九份最终文件均正确。完整满足中文报告要求的是七次。Astra 达到三次零机制错误，DeepSeek 达到每次不超过一次，GLM 未达到该标准。没有据此认定 GLM 的问题不可通过设计改善。

### 具体错误

- **DeepSeek 1，请求 1**：读取 `agent.yaml` 和概览后没有返回 loop 决策。收到 `missing_decision` 提醒后继续。
- **DeepSeek 2，请求 1**：`observe(readResult.text,{view:"harness.overview"})` 把字符串交给要求 inspect 概览对象的 handler，产生展示错误。
- **DeepSeek 3，请求 3**：解构得到 draft ID 后，向 `host.harness.write` 传 `target:draft`，没有对象包装，报 `/target: must be object`。修复后成功。
- **GLM 1，请求 1**：把 `agent.yaml` 的字符串正文交给 `harness.detail`，该 handler 要求 inspect 详情页对象。
- **GLM 1，请求 5**：自定义三个 handler 没有等待异步 `host.fs` 调用。write 提前返回后调用资源被关闭，写入被取消；read 访问 Promise 的字段得到 undefined；edit 把不存在的 `eof` 误判为文件过大。请求 6 捕获 stat/read 的 `ENOENT` 检查现场，并正确返回 next；它是前一次失败的诊断，不另计一个独立机制错误。请求 7 将 handler 改为 async/await 后完成任务。自动标记数为 3，失败 controller 数为 2。
- **GLM 2，请求 1**：遗漏 loop 决策。
- **GLM 2，请求 3**：把三个工具定义拼成一个多文档 YAML 文件，prepare 拒绝；当前定义契约是一文件一个工具。
- **GLM 2，请求 4**：重新 begin 得到从 active 创建的新草稿，却试图删除仅存在于前一个草稿的文件，报 `Harness file not found`。
- **GLM 2，请求 6–7**：请求 5 已准备好工具候选，但请求 6 又创建、准备并激活了一个空改动草稿，工具没有进入 active。这个错误本身未抛异常。请求 7 对不存在的工具 describe 返回 undefined，随后 `JSON.stringify(...).slice(...)` 抛错。请求 8 重新定义并激活成功；错误激活与后续属性错误的完整过程均保留。
- **GLM 3，请求 1、4**：均使用 `return observe(...)`，没有返回 loop 决策；请求 4 的草稿写入和 prepare 已成功，不因协议提醒回滚。
- **GLM 3，请求 2**：把 `{agent:正文,catalog:正文}` 交给 `harness.detail`，不是该 handler 的详情页形状。

GLM 2 在最后一次调用还丢弃了第一次运行的 stdout，只展示退出码；独立执行快照确认其内容确实输出 hello world。GLM 2、3 的 finish 值缺少所需中文说明。以上偏差不算作新的异常回合，但不能称为全程正确。

### 协议、文本和编辑范围核验

- 核对全部 66 次实际 provider 请求：Astra 的 18 次声明均为 `custom`，GLM 和 DeepSeek 的 48 次均为 `function`，顶层只有 codemode。每次描述都包含对应入口说明；system 没有重复 guide；JSON data 字段没有其他协议的建议。
- Astra 的 15 次 codemode 调用都使用 JavaScript 原文，没有 data。GLM 三次均未采用 data，DeepSeek 仅第二次在定义文件时采用一次 data。没有强制拒绝其余合法 JavaScript 字符串输入。本轮没有输入转义或源码解析失败，但不能据此说 JSON 模型已稳定采用推荐输入方式。
- 七次成功 edit 使用最小连续范围 `hello` → `bye`；DeepSeek 第 1、3 次多带了不变的 ` world`，属于局部替换，但不是最小范围。没有一次成功 edit 携带整份新文件，也没有用自定义 write 代替 edit。
- GLM 1 调用了两次 write，第一次 handler 提前返回且实际写入被取消；修复后只有一次成功创建。其他八次各调用一次 write。九次最终编辑均保持 print 语法、引号和末尾换行，文件从 21 字节变为 19 字节。各 edit handler 仍通过底层 `host.fs.write` 完整写回匹配后的内容，本轮不声称实现原位字节编辑。
- `verification.json` 核对调用、文件 SHA-256 和语法；实际运行全部 18 份前后快照及 9 份最终工作目录文件，均得到预期 stdout 和退出码 0。其 `fileTaskComplete` 只表示文件任务，不包括最终自然语言报告。
- 仍观察到 GLM 对 read 结果主动 `JSON.stringify`，以及 GLM/DeepSeek 在 controller 直接使用进程原语；因此也不能宣称观察层总是无转义、所有任务 I/O 都已封装在内部工具中。

### 前置实验与额外修复

本轮共保留 20 次尝试，没有用成功重跑覆盖失败记录。最终九次之前的 11 次记录如下：

| 批次 | 运行 | 结果 |
|---|---|---|
| [input-guidance-1792042132056](../../../.artifacts/pi-mih-validation/input-guidance-1792042132056/) | Astra 1、2 | 完成，0 次失败 |
| 同上 | Astra 3 | 请求 2 provider 返回 `Connection error.`，未完成；不计为机制错误或成功 |
| 同上 | GLM 1、2、3 | 均完成，各 1 次失败：激活字段错误、observe 对象缺 view、字符串传给 pi.read |
| 同上 | DeepSeek 1 | 完成，1 次句柄形状错误；另外一次预期的重复匹配拒绝被脚本捕获。模型还错误地把唯一字符当作重复匹配用例，短暂生成 `bye worLd` 后修复；不能称为全程正确 |
| 同上 | DeepSeek 2 | 完成，3 次失败；请求 6 读取旧验收报告，不能作为独立探索成绩 |
| 同上 | DeepSeek 3 | 完成，0 次异常，但发生宿主 stdout 丢失，重复 write/edit 后恢复 |
| [input-guidance-clean-1792042490000](../../../.artifacts/pi-mih-validation/input-guidance-clean-1792042490000/) | Astra 4 | 完成，0 次失败 |
| 同上 | DeepSeek 4 | 完成，2 次失败：字符串传给 pi.read、嵌套 draft 句柄；edit 匹配包含引号的完整字符串 |

两个前置批次的二进制 SHA-256 为 `eb0183d20329aec58fd8c512e31b18e0f68bd73bf26287e42dd4dd67115e1d01`。发现历史报告被读取后，补充批次及最终批次从各自复制的资源目录排除全部 validation Markdown，名单保存在 `excluded-reports.json`。没有删除仓库中的报告，未修改 query、默认 guide 或普通接口文档来提示答案；最终九次未观察到读取历史验收报告。

stdout 丢失是可复现的宿主问题：短进程退出时，ChildProcess 清理会恢复未消费的管道并丢弃数据，`wait()` 之后再 `streams.read()` 得到空串。现已在注册管道时保持 pull 模式，保留退出后尚未读取的 stdout/stderr，同时保留背压与调用结束清理。Node 和 Bun 下均验证短进程先 wait、延迟后逐块读取仍得到完整数据；大输出仍需并行排空管道避免死锁。最终二进制包含此修复。

### 本轮本地验证

- `npm run check` 通过；仅有 npm 已有的 `min-release-age` 配置提示。
- 11 个相关测试文件、125 项通过，涵盖路由后输入协议选择、真实适配器声明、可编辑字段描述、guide 单一注入、展示器改名、JSON 错误、编辑归一化和文本保真、输出快照及循环恢复。
- 新增 stdout/stderr 延迟读取回归通过；另在 Bun 下直接核验相同读取顺序。
- `npm run build:offline`、Bun 二进制编译、`copy-binary-assets` 和 `git diff --check` 通过。

本轮解决了本次 review 指出的协议选择和规则重复问题。剩余错误主要集中于展示器输入形状、草稿与激活状态、显式 loop 决策以及异步 handler；GLM 的可靠性目标仍未达成，不能把这次引导整理当作全部可用性问题已经解决。
