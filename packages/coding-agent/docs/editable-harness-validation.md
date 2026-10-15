# Editable Harness 验证记录

## 当前版本：输入协议、编辑归一化与转义边界

日期：2026-10-15。主任务仍是自行定义 sandbox reader、编辑 codemode 提示词和必要的目录规则、完整观察 README 后介绍项目。没有补发模型专用修复指令，没有失败案例 few-shot。根据用户本轮要求，GLM 改为 **`zai-coding-cn/glm-5.3`**；此前的 `glm-5.3-flash` 只作为历史实验保留。其他模型仍为 `openai/gpt-6-astra`、`opencode-go/deepseek-v4.1-flash`、`local-llm/qwen3.8-27b`，thinking low。

### 本轮实现与协议核对

1. **恢复条件式原文输入。** 支持 grammar/custom tools 的模型获得同一个 codemode custom tool：纯代码直接提交 JavaScript，需要数据或最终文字时提交 JSON `{code,data?}` / `{finish}`。其余模型使用 function tool 的 JSON schema。历史回放保留完整 data/finish；不会只取 code 而丢失数据。原文适配只解码一层明确的 JSON 对象，识别条件要求带引号的属性名后跟冒号；`{ "use strict"; ... }` 等合法 JavaScript 块保持源码。没有递归解码或猜测性反转义。
2. **原生编辑归一化进入完整调用链。** `host.harness.edit` 在严格 schema 校验前调用与 Pi 原生 edit 共用的 edits 容器归一化，接受数组、单个编辑对象、包含数组/对象的 JSON 字符串。只处理 edits 容器，不改 target、baseRevision、oldText/newText，不折叠原生旧式顶层 oldText/newText。草稿、基准版本、唯一匹配及重叠检查保持。
3. **通用输入指引。** 控制操作放 code，源码、prompt 和编辑文本放同次调用的 data 对象；结构化定义使用对象，在写文件时序列化为 JSON（也是合法 YAML）。oldText 尽量短且唯一，避免大段无关原文，所有替换匹配原文件，合并附近变更，禁止重叠。没有按模型或具体任务写特例。
4. **减少观察和恢复中的再次编码。** 新增可编辑的 `harness.prepare/edit/status/diagnostics` 展示器，直接呈现 diff、正文和状态摘要。参数错误只显示有界的结构/长度诊断；循环提醒列出已完成操作及域/路径，不重复编码全部入参。默认压缩规则把源码等字符串放进字面文本块，保留参数结构、可编辑预算和明确截断标记；不修改原始记录或工具返回值。
5. **修正定义错误定位。** prepare 对缺失或错误形状的 handler 报出具体定义路径和预期字段，草稿保留供修复。首版实验中的泛化 `Expected object` 容易让模型误改 prepare 句柄，而真正错误在工具定义里。

真实 `before_provider_request` payload 核对结果如下，不根据模型名称推断协议：

| 模型 | 实际 provider 声明 | 实际输入 |
|---|---|---|
| Astra | custom | JavaScript 原文；写定义时同一入口使用完整 JSON code/data 对象 |
| GLM 5.3 | function | JSON 参数对象 |
| DeepSeek | function | JSON 参数对象 |
| Qwen | function | JSON 参数对象 |

顶层工具始终只有 codemode。传输和 session 文件中的 JSON 转义仍是正常编码；解码后的模型观察包含实际换行、引号和反斜杠。提供原文入口不会让嵌套的 JavaScript 字符串自动变安全；需要作者文本时仍应使用 data。

### 固定 escaping-v3 二进制的主任务

| 运行 | 独立执行/协议错误 | README 任务 | 请求数 / 秒 |
|---|---:|---|---:|
| Astra 1 | 0 | 完成 | 6 / 86.0 |
| Astra 2 | 0 | 完成 | 6 / 86.3 |
| Astra 3 | 0 | 完成 | 6 / 84.3 |
| Astra 4 | 0 | 完成 | 6 / 85.0 |
| Astra 5 | 0 | 完成 | 7 / 80.6 |
| DeepSeek 1 | 0 | 未完成；请求 4 连接失败 | 4 / 54.2 |
| DeepSeek 2 | 0 | 完成 | 6 / 53.7 |
| DeepSeek 3 | 1 | 完成 | 8 / 57.0 |
| DeepSeek 4（补跑） | 3 | 完成 | 7 / 56.4 |
| GLM 5.3 / 1 | 2 | 完成 | 6 / 83.7 |
| GLM 5.3 / 2 | 0 | 完成 | 7 / 87.1 |
| GLM 5.3 / 3 | 3 | 完成 | 8 / 66.3 |
| Qwen 1 | 1 | 完成 | 11 / 722.3 |

**Astra 五次完整主任务均为零机制错误。GLM 5.3 与 DeepSeek 仍未稳定达到每次完整任务 ≤1 次错误。** 错误按独立失败操作计数，包括捕获或未 await 的失败；同一异常沿 primitive/tool 传播不重复计数。DeepSeek 4 的一个失败 controller 包含三个独立的错误观察，不能记成一次。Provider 连接失败单列保留，没有计作任务通过或机制错误。

| 运行 / 请求 | 具体错误 | 恢复与影响 |
|---|---|---|
| DeepSeek 3 / 4 | 观察环境和目录组成的对象时缺少 view | 后续改用字符串；先前成功操作保留 |
| DeepSeek 4 / 3 | 分别观察环境、stat、工具名称对象，三次缺少 view | 三条明确展示诊断；下一轮改为字符串 |
| GLM 5.3 / 1 / 3 | begin 后直接返回草稿对象，没有 next/finish | missing_decision；已创建草稿保留 |
| GLM 5.3 / 1 / 5 | 已展示 README 正文，又观察元数据对象但缺少 view | 正文保留并进入请求 6，不误判为未读取 |
| GLM 5.3 / 3 / 3 | 同一 edit 数组对相同 oldText 做两次替换，范围重叠 | 原生匹配拒绝；模块和工具文件已写入草稿，下一轮修复编辑 |
| GLM 5.3 / 3 / 5 | 使用未定义的 `read.result` 展示类型 | reader 成功但正文未展示；下一轮选择字符串 |
| GLM 5.3 / 3 / 6 | 展示正文后对元数据对象 observe，遗漏 view | 有效正文进入请求 7、8；没有回滚读取 |
| Qwen 1 / 5 | 对环境对象 `observe(env)`，缺少 view | 目录列表和 README stat 已成功保留；后续写入定义并完成任务 |

主任务中的 GLM 错误没有出现宿主错误反转义或源码损坏。剩余问题主要来自调用契约和展示选择；这不等于模型已经稳定理解整个框架，也不能推导为某模型永久无法使用它。

Astra controller 均没有直接调用任务 fs，实际经自建 reader 读取，目录与 prompt 进入真实后续请求；五份最终介绍及生效解释已复核。DeepSeek 2、4 则在探索阶段直接 list/stat 项目文件，README 正文随后通过自建 reader 读取；handler-only 目前仍是指引，不是运行时强制边界。GLM 5.3 三次没有直接 controller 文件 I/O，但解释有误差：第 1 次把 10,627 字节说成约 6 KB，第 2 次混用“激活后本请求已经更新”与“下一请求完全生效”，第 3 次把 Harness 能控制的范围说成“一切”。产物完成、错误阈值和设计理解分别记录。

Qwen 本次将带嵌套反引号和 `${...}` 的 handler 放进 data，写入、prepare 和调用均没有转义错误。请求 8 通过自建 reader 读取完整 README，直接观察正文字符串；请求 9 复查末尾，请求 10 用自建 view 展示 120 字节分页。它也在请求 5 直接 list/stat，并在编辑后的 guide 中允许临时直接使用原语。最终却把边界说成“完全隔离、工具是唯一通道”，还称在激活的同一 controller 读取，实际激活在请求 7、读取在请求 8。这些是理解与自述问题，单列于那一次展示异常之外。主任务新增 view 的源码即使 EOF 也会添加元数据头；本轮完整正文实际选择字符串展示，不能据此声称该 view 已通过完整正文最简展示验收。

### 新增展示器和固定请求分页

附加任务复用完成主任务后的会话副本，要求自行新增 handler/映射、激活后展示完整 README、确认原始返回值保留，并跨一次模型请求完整续读同一保存请求的 codemode 描述。该任务错误与主任务分开计数。

| 模型 / 二进制 | 独立错误 | 结果 |
|---|---:|---|
| Astra / escaping-v3 | 0 | 自建 `sandbox.read.text`，精确输出 README 正文；完整观察同一请求的 26,431 字符描述，页间推进请求 |
| DeepSeek / escaping-v3 | 0 | 自建 `sandbox.read_text`，只输出正文；完整观察固定请求的 26,099 字符描述 |
| GLM 5.3 / escaping-v3 | 6 | handler 与固定请求分页完成（25,641 字符）；仍增加不必要的完成/字节数头，严格展示验收未通过 |
| Qwen / escaping-v2 | 1 | 自建 `sandbox.read` view，精确输出正文；跨请求完整观察固定描述的 26,184 字符。该附加运行使用前一二进制，不冒充最终版本结果 |

GLM 5.3 附加任务具体失败：请求 4 两次 `host.state.set(key,value)` 使用位置参数且未 await，调用记录有失败，但 controller 返回 next；请求 5 `host.state.get(key)` 再次使用位置参数；请求 6 读取并未成功保存的值，访问 undefined.path；请求 7 两个元数据对象观察缺少 view。共六个独立错误，不能只算三个 isError controller。成功的描述页仍保留，最终五页确实对应同一 requestId/requestRevision。自建 handler 即使 eof=true 也输出 `[README.md: complete, 10627 bytes]`，与“正文及必要续读提示”不符，不能采信其“全部验证完成”的自述。

Qwen 附加任务请求 4 手工转录长 cursor 时改错字符，解码后的请求 ID 从 `q-af8…` 变成 `q-am8…`，宿主明确拒绝未知保存请求。请求 5 用先前程序化保存的 requestId 重新获取第一页，并链式使用接口返回的 next，正确读完同一记录。没有宿主串页；长游标被手工复制时的输入负担仍存在。该运行最终用结构化 finish 完成，handler 源码和答案没有发生额外转义错误。

实际 reader 返回与展示正文分别复核，并将实际数据交给纯规则 VM 再渲染，确认正文、必要提示和原始值保留。模型自己的观察前后比较不等于完整隔离证明；故意修改 handler 输入仍不影响工具返回的保证另由确定性测试覆盖。

### 本轮迭代记录与转义问题

不同二进制的结果不合并为当前版本成功率，失败与 provider 中断均保留：

- **escaping-v1**：Astra 三次完整主任务均零错误，另有一次连接失败和一次 OAuth 刷新超时；DeepSeek 两次完整主任务零错误，另一次连接失败；Flash GLM 错误为 6 / 4 / 1，前两次未完成完整验收；Qwen 完成，2 次错误。Flash GLM 暴露 YAML 标量中的冒号和缺少 handler 后错误定位不清的问题，促成 v2 的通用定位诊断。
- **escaping-v2**：Astra 五次完整主任务零错误，另一次连接失败；DeepSeek 三次完整任务错误为 1 / 0 / 2，另一次连接失败；Qwen 完成，6 个独立错误。GLM 切换为非 Flash 后重新从空白会话执行三次，错误为 **0 / 0 / 2**，均完成。切换前的 Flash GLM 第一次完成但有 8 次错误，第二次未完整观察 README，第三次按用户换模型要求中止，均不计入当前 GLM 结果。
- **escaping-v3**：仅修正 code 原文入口把 `{ "use strict"; ... }` 误判为 JSON 的边界并补回归测试。默认 Harness 与 v2 一致；不能把不同试验的随机错误变化归因于此修复。

v2 GLM 5.3 附加任务仍有一次真实的输入转义错误：把包含反引号和 `${...}` 的 handler 放进外层模板字符串，解析失败且尚无副作用。后续修复后，又在 activate(now) 同请求使用两个新 view（两次 unknown view），以及把整个 page.next 再套进 cursor（一处类型错误），共 4 次。其后两页完整 README 均按新 handler 呈现、固定请求描述也完整读完。v3 同一附加任务未出现该语法错误，但出现上面的 state/view 误用。data 减少了一层源码字符串编码，不能强制模型选用它。

v2 Qwen 主任务的 6 次错误为：把 begin 句柄再次嵌套进 draft；把 inspect 草稿状态的 id 当作 draft 字段；reader 对象交给诊断数组展示器；一次 controller 中三次把页的 text 字符串交给要求完整 page 对象的 harness.detail。它最终完整读取、观察并介绍 README，没有输入源码转义错误。

### 确定性验证与证据

特殊字符用例覆盖引号、反引号、`${...}`、反斜杠、字面 `\\n`、真实 LF/CRLF 与中文。实际 provider 适配器测试核对 Responses/Completions 的 custom/function 声明、输入与历史回放；faux provider 集成测试经过完整 codemode → host.harness.edit → 原生匹配 → read → observe 链路，覆盖两种输入协议与四种 edits 容器形式。另验证错误 target、过期基准、非法容器、重复/重叠替换、字面反斜杠不匹配时草稿不被错误修改。没有用真实 API 运行 suite 单测。

最终原文边界修复后，input-protocol 与 agent-session-codemode-input **23 项通过**；本轮其余相关测试分批通过，包括 AI constrained-sampling 8 项、AI validation 11 项、输出/上下文/循环等 61 项，以及 inspection/inspect/loop/observe 55 项。批次有重叠，不相加为总数。`npm run check`、离线构建、Bun 独立二进制编译和资源复制通过。npm 仍输出仓库已有的 min-release-age 配置提示，代码检查没有诊断。

最终二进制 SHA-256：`59333954ddd017ed2b3ab72a139e8247bd615ec75e56bc9c27d22c0c34bbd725`。冻结副本和原始证据位于 [escaping-v3-1792034676046](../../../.artifacts/pi-mih-validation/escaping-v3-1792034676046/)。每次保留 requests/events/session、逐轮输入、定义、错误和答案；`independent-failure-review.json` 按独立操作计数，`read-coverage-review.json` 检查实际解码后的 provider 工具结果，`manual-review.json` 区分任务、阈值、边界与解释。

原始 summary 保留旧统计，不覆盖：它按失败轮次计数，且会漏掉失败 controller 中保留的有效观察。修正复核要求完整 README 字面覆盖进入最终答复前的真实请求，允许多页，但不以结构化返回中存在全文代替模型已经观察。默认概览单独观察约 2,139 字符、58 行（含宿主包装），已复核主任务没有宿主输出截断。

原任务 SHA-256：`15b4b620ead36a331d066c70967651f87534d8fba6cbd38f5d4eae707224ed2a`；README 为 10,627 字节，SHA-256：`d4f05a91fe0de78d1b99d8b8d69c66e7522c493814cc4bd2ed344e4d60b10ce1`。全部日志不采集认证 header。前两版证据分别在 [escaping-v1](../../../.artifacts/pi-mih-validation/escaping-v1-1792033352281/) 与 [escaping-v2](../../../.artifacts/pi-mih-validation/escaping-v2-1792033978762/)，GLM 模型切换记录见 v2 的 `model-selection.json`。未提交代码。

[最终校验](../../../.artifacts/pi-mih-validation/escaping-v3-1792034676046/final-verification.json) 确认 13 次主任务启动均使用同一二进制、25 个默认 Harness 文件与源码一致、任务和 README 未改变，临时配置链接已清理。Qwen 完整正文逐字进入请求 9、10、11；没有省略末尾换行。[逐项人工复核](../../../.artifacts/pi-mih-validation/escaping-v3-1792034676046/manual-review.json) 包含实际 provider model 字段，GLM 三次均为 `glm-5.3`。三版目录均无残留认证配置链接，`git diff --check` 通过。

复验脚本 `run-more.mjs` 固定使用上述冻结二进制。配置好相同 provider 后，可复制到新目录，从仓库根目录显式运行真实模型；不要覆盖已有样本：

```bash
run_dir=".artifacts/pi-mih-validation/escaping-recheck-$(date +%s)"
mkdir -p "$run_dir"
cp .artifacts/pi-mih-validation/escaping-v3-1792034676046/run-more.mjs "$run_dir/run.mjs"
PI_VALIDATION_MODELS=astra PI_VALIDATION_START=1 PI_VALIDATION_COUNT=5 node "$run_dir/run.mjs"
PI_VALIDATION_MODELS=ds,glm53 PI_VALIDATION_START=1 PI_VALIDATION_COUNT=3 node "$run_dir/run.mjs"
PI_VALIDATION_MODELS=qwen PI_VALIDATION_START=1 PI_VALIDATION_COUNT=1 node "$run_dir/run.mjs"
```

自动 summary 需要结合 `audit-tools/` 中的独立错误、全文覆盖、协议和附加任务复核脚本，以及人工检查答案与 controller 源码，不应单独用 pass 字段代表严格验收。

## 历史：2026-10-14 Astra 零机制错误验收

日期：2026-10-14。根据下文 Astra 基线暴露的问题修改通用契约，重新编译并固定 v3 二进制及默认定义后测试。原 README 任务、模型配置和任务文件保持不变；没有添加针对失败案例的 few-shot、模型专用分支或人工修复提示。Astra 使用 `openai/gpt-6-astra`，其余三个模型 ID 与历史记录一致，均为 thinking low。

### 机制修改

1. **草稿返回值可以直接组合。** 旧接口的 `begin()` 返回 `{draft,baseRevision}`，但 `write({target:d})` 拒绝 baseRevision。现在 read/write/edit/remove/prepare/discard 均接受该句柄；提供的 baseRevision 必须与草稿一致，错误在副作用前拒绝。激活仍保留活动版本冲突检查。
2. **分页位置和请求绑定在同一个游标里。** 起始查询指定 section/requestId/id/limit；续读直接传递 `page.next`，其中只有 `{cursor,limit}`。游标绑定保存请求、section、block 和位置，不再要求调用者自行组合 requestId 与 offset。跨 next、激活、会话恢复仍读取原记录，不重新生成历史内容；响应继续区分 requestRevision 与 activeRevision。
3. **原生最终文字交给可编辑 loop 决定。** 正常结束、没有工具调用且非空的 assistant 文字产生 `assistant_finish`，默认 loop 接受它。`{finish}` 和程序化 `loop.finish` 保留；有工具的响应仍只能调用一次 codemode，脚本仍须返回 next/finish。空响应、异常或截断结束不因此成为完成。模型可编辑 loop 拒绝普通文字或追加恢复指令。这是执行前落实的新协议，不是事后将旧版 missing_decision 改算成功。

inspect 的精简返回、显式 view、请求版本固定和原始工具值不变的契约保持。默认概览实测约 **1,927–1,928 字符、50 行**；增加 reader 后约 2,090 字符、52 行。全部已复核主任务均没有宿主输出截断。默认 `pi.read` 直接输出原生 read 正文及必要提示，递归 dump 仍须显式选择。

### 固定二进制的原任务结果

| 运行 | 独立执行/协议错误 | README 任务 | 请求数 / 秒 |
|---|---:|---|---:|
| Astra 1 | 0 | 完成 | 7 / 109.3 |
| Astra 2 | 0 | 完成 | 7 / 97.7 |
| Astra 3 | 0 | 完成 | 7 / 100.4 |
| Astra 4 | 0 | 未完成；请求 4 连接失败 | 4 / 59.7 |
| Astra 5 | 0 | 完成 | 7 / 114.4 |
| Astra 6（补跑） | 0 | 完成 | 7 / 97.7 |
| DeepSeek 1 | 4 | 完成 | 11 / 119.5 |
| DeepSeek 2 | 2 | 完成 | 13 / 106.0 |
| DeepSeek 3 | 1 | 完成；此错误是目录不存在 | 11 / 156.6 |
| GLM 1 | 3 | 完成 | 10 / 96.7 |
| GLM 2 | 6 | 未完成；没有修改 codemode 提示词 | 19 / 154.4 |
| GLM 3 | 4 | 完成 | 10 / 86.2 |
| Qwen 1 | 0 | 完成；另有一次未抛异常的草稿误用 | 12 / 864.1 |

**Astra 五次完整执行均零错误，且均符合本任务的设计预期。** 每次自行定义 `sandbox.read`，修改提示词和目录，激活后通过自建 reader 完整读取 README；全文逐字出现在最终介绍之前的真实 provider 请求中。controller 没有直接使用任务 fs 原语，最终介绍、域边界和生效时机解释均已人工复核。第 4 次在约 15 秒后收到 provider `Connection error`，空响应、零 usage；只完成了草稿准备，不能算通过，也没有从样本中删除。五次成功不是“五次启动全部成功”，也不是未来任意任务零错误的保证。

**DeepSeek、GLM 仍未达到稳定 ≤1 次错误。** 表中计数包含捕获的调用失败；同一异常沿 primitive/tool 传播只算一次，同一非法双调用批次只算一次。GLM 2 的七个 codemode 错误结果对应六个独立错误；GLM 3 另有一次不抛异常的 missing_decision，所以不能只计三个错误结果。目录 ENOENT、provider 失败、语义误用与最终解释问题分别说明，不混称为宿主故障。

### v3 的具体失败和恢复

| 运行 / 请求 | 失败 | 恢复及影响 |
|---|---|---|
| DeepSeek 1 / 3 | 对环境与目录对象调用 observe，遗漏 view | 原查询已成功；下一轮改为字符串观察 |
| DeepSeek 1 / 5、6 | 将 data 传成 JSON 字符串，要求对象 | 两次在执行前被拒绝；请求 7 不再传 data，改用源码中的字符串数组 join 构造文件。真实 provider schema 正确声明 data 为 object，没有发现适配层将其改成 string |
| DeepSeek 1 / 8 | activate(now) 后同一请求使用新 `sandbox.read` view | 工具读取成功，但输出固定旧请求版本，报 unknown view；next 后新 view 可用 |
| DeepSeek 2 / 9 | tool YAML 的 additionalProperties 放在定义根层，未放进 parameters | prepare 拒绝未知字段；请求 11 修正缩进后激活 |
| DeepSeek 2 / 12 | 对读取元数据对象 observe，遗漏 view | 同轮后续 README 字符串观察保留，全文实际进入请求 13；没有回滚读取或丢掉有效观察 |
| DeepSeek 3 / 3 | 在任务目录中查询不存在的 `docs`，ENOENT | 后续改查安装资源路径；属于环境探测失败 |
| GLM 1 / 1 | observe 的第二参数传字符串，而非 `{view}` | 请求 2 改为直接观察字符串 |
| GLM 1 / 4 | 观察环境对象遗漏 view | 后续改用明确的字符串输出 |
| GLM 1 / 6 | 工具名 `read.text` 与 handler.module `read_text` 不匹配 | prepare 拒绝；改为 `read_text.read` 后成功 |
| GLM 2 / 1、6 | observe 第二参数是字符串 | 两次独立调用形式错误 |
| GLM 2 / 5、7 | 对 begin 返回对象 observe，遗漏 view | begin 的草稿已创建并保留；后续改为 debug.dump，但重复创建了草稿 |
| GLM 2 / 9 | 同一响应生成两个 codemode 调用，将 code 和 data 拆开 | 整批拒绝；计一次批次错误，后续合并到单次输入 |
| GLM 2 / 13 | handler 调用 `host.fs.stat(path)`，要求 `{path}` | 改写 handler 并重新激活后读完；其“VM 参数形式不同”的诊断不正确 |
| GLM 3 / 3 | 成功写入后只返回普通对象，没有 next/finish | missing_decision；写入保留，下一轮继续准备 |
| GLM 3 / 4、7、9 | 分别观察 prepare、activate、读取元数据对象，均遗漏 view | 三次展示错误；候选、待激活版本和成功正文观察均保留。请求 10 实际收到完整 README 后给出介绍 |

Qwen 没有执行或协议异常，但请求 5 新建了另一份草稿，只准备提示词，遗漏上份草稿中的模块和工具。它从 diff 自行发现，丢弃两份草稿并重建完整版本；这是一次实质性流程错误，不能用“零异常”掩盖。其 `totalCharsReported` 还误填页数，但另行取得并核对了完整描述长度与目录位置。

除 Astra 和 GLM 3 外，其余主任务都出现 controller 直接调用任务 fs 的行为；handler-only 仍是指引而非强制隔离。最终解释也有误差：DeepSeek 1 将它说成强制边界、声称 view 不进入上下文；DeepSeek 3 和 GLM 1 错称在激活的同一 controller 验证了 reader；GLM 2 没有修改提示词且误解 stat 参数；Qwen 一面正确说明描述从下一请求生效，一面声称 now 立即更新 requestRevision。实际轨迹与解释分开记录，不以模型自述代替证据。

离线验收修正了一个统计遗漏：DeepSeek 2 和 GLM 3 的 controller 虽发生展示错误，但完整 README 的有效观察已保留并进入后续 provider 请求。旧自动检查要求 controller 整体成功，错误地判为“未观察全文”；新复核按真实工具结果的字面全文覆盖判定，原 summary 没有覆盖。

### 自建展示器与跨请求分页

附加任务从各模型第一份完成原任务的会话副本开始，要求自行新增展示类型和 handler，完整展示 README，并在两次模型请求间续读同一保存请求的 codemode 描述。没有给出实现代码；所有重试使用相同附加任务和初始会话副本。

| 模型 | 请求数 / 独立错误 | 展示与分页结果 |
|---|---:|---|
| Astra | 7 / 0 | 新增 `sandbox.read` view，正文与 README 完全一致；两页完整观察同一请求的 23,243 字符描述，跨 next 后 requestId/revision 一致 |
| DeepSeek | 4 / 0 | 新增 `sandbox.body`，只输出正文；六页完整观察同一保存请求的 22,949 字符描述 |
| GLM | 16 / 1 | 新增 `read_text.summary`；分页完整覆盖 22,597 字符，但 view 仍增加多余元数据头，严格展示验收失败 |
| Qwen | 7 次请求、6 次完整响应 / 2 | 达到 20 分钟上限；尚未写入或激活新 view，也未开始 codemode 分页，未完成 |

Astra 的前两次附加尝试分别在请求 2、3 遇到 provider `Connection error`，均约 15 秒、空响应、没有执行错误，但任务未完成；第三次完成。三份记录都保留，因此本轮 Astra 总计有三次连接中断（原任务一次、附加任务两次），没有计作通过。最终附加任务确认新 view 仅从激活后的下一次请求使用，没有绕过版本约定。

GLM 的异常发生在请求 2：handler 源码写入第一份草稿，映射却写进新建的第二份草稿，prepare 报 `Harness file not found: views/read_text.mjs`。它随后把源码写入第二份草稿恢复。另在请求 12–14 未更新保存的 cursor，反复读取 offset 16000；这不是宿主串页。自建 handler 即使 eof=true 仍输出 `[read README.md | offset=0 bytes=10627 eof=true]`，不符合“正文及必要续读提示”，其最终“全部验证完成”的自述不成立。

Qwen 请求 2 将 handler 源码放入外层模板字符串，未转义内层反引号，报反斜杠 unexpected token（codemode.js:20:28）；尚未执行 begin。请求 3 输出了 43,810 字符的可见分析文字，实际工具输入却为 `code:"..."` 和占位 data，报 `unexpected token in expression: '...'`（codemode.js:1:15），同样没有副作用。请求 4 查询状态，5、6 分别测试普通字符串及源码作为 data 的传递；这三次均有效 next，均驱动了后续请求。第 7 次推理中达到运行器上限，并非 loop 漏驱动或执行恢复预算耗尽。本地 provider 注册扩展没有改写源码的逻辑，仅凭这些日志不能进一步区分模型生成与服务端工具解析的责任；可确定的是宿主实际收到了上述非法输入。没有将它记作观察 handler 的渲染错误。

读取结果与展示文字分别检查；模型的观察前后 stringify 比较只能证明提交 observe 未修改局部值。handler 对数据副本的隔离由确定性测试中故意修改 handler 输入的案例验证，不能仅凭该比较声称测试了延后渲染的全部阶段。[附加任务人工复核](../../../.artifacts/pi-mih-validation/inspect-views-v3-1791984219461/followup-manual-review.json) 和各运行 `strict-review.json` 保存字面正文、逐页范围及版本证据。

### 检查与可复核产物

`npm run check`、`npm run build:offline`、Bun 独立二进制编译及资源复制通过。inspection/inspect/runtime/loop/context 五文件 **73 项**通过，output/observe/input/primitives 四文件 **21 项**通过；loop 修改格式后 **40 项**复测通过，与前批重叠不累加。覆盖完整草稿句柄和错误基线、非法游标及参数覆盖、跨请求/激活/分支/恢复、Unicode 分页边界、可编辑普通最终文字策略，以及展示失败不抹掉成功操作。npm 仍有仓库已有的 min-release-age 配置提示，代码检查无诊断。

当时二进制 SHA-256 为 `1461d8f80ea4081465e95b1ecb1048acd738dfdefc883c84cd180e08d3cf8c4a`。冻结副本及完整证据位于 [inspect-views-v3-1791984219461](../../../.artifacts/pi-mih-validation/inspect-views-v3-1791984219461/)；[人工复核](../../../.artifacts/pi-mih-validation/inspect-views-v3-1791984219461/manual-review.json) 将任务完成、错误阈值、边界、解释和 provider 中断分开。每次保存原始请求、源码、调用结果、会话、定义和答案；`independent-failure-review.json`、`read-coverage-review.json` 和 `manual-review.json` 提供逐轮证据与 session 行号。旧版失败仍在下文及其冻结目录中。

[最终文件校验](../../../.artifacts/pi-mih-validation/inspect-views-v3-1791984219461/final-verification.json) 确认 13 次主任务的二进制 hash 一致、25 个默认定义与源码一致、README 和任务文本未改变；临时认证配置链接全部移除。任务 SHA-256 仍为 `15b4b620ead36a331d066c70967651f87534d8fba6cbd38f5d4eae707224ed2a`。`git diff --check` 通过；未提交代码。

## Astra 基线：原任务五次独立运行

日期：2026-10-14。按新增验收要求，在未修改的 v2 二进制上加入 `openai/gpt-6-astra`，执行同一个 README 任务五次。thinking low，独立会话，无 few-shot 或模型专用指引；任务和 README 的 hash 与下文相同。

| 运行 | 独立错误 | README 任务 | 请求数 / 秒 |
|---|---:|---|---:|
| Astra 1 | 2 | 完成 | 9 / 163.6 |
| Astra 2 | 2 | 完成 | 10 / 246.6 |
| Astra 3 | 0 | 完成 | 7 / 105.7 |
| Astra 4 | 1 | 完成 | 10 / 155.0 |
| Astra 5 | 1 | 完成 | 7 / 123.9 |

五次均自建 `sandbox.read`、编辑提示词和目录，完整 README 经工具读取并进入最终介绍前的推理；没有 controller 直接使用任务 I/O。**只有一次零错误，未达到稳定零错误要求。** 具体失败及恢复如下：

- Astra 1、2、4 的请求 3：`const d=await begin(); write({target:d,...})`。begin 返回 `{draft,baseRevision}`，但 target 校验只允许 `{draft}`，因此拒绝本应可组合的返回值。begin 已成功，草稿 edit 数仍为 0；后续 inspect 找回草稿，改为 `{draft:draftId}` 后写入成功。
- Astra 1 请求 8、Astra 5 请求 6：给出完整中文最终文字。旧规则判为 missing_decision，额外请求分别改用 `{finish}`；没有重复读取。
- Astra 2 请求 8：`inspect({section:"codemode",offset:21000,limit:2000})` 未提供 requestId。旧协议拒绝续读；后续从第一页开始，直接传递 page.next 完成目录查询。此前成功的 AGENTS 读取结果保留。

这三类问题促成后续的可组合草稿句柄、绑定请求的分页游标和由可编辑 loop 接受原生最终文本。没有把旧失败重新算成成功。

旧版附加任务从 Astra 1 的会话副本开始：7 次请求、0 次执行/协议错误。模型新增并激活 `sandbox.text` 展示器，正文输出与 10,627 字节 README 完全一致；分两页观察了同一保存请求的 22,088 字符 codemode 描述，页间推进模型请求，requestId/revision 保持一致。默认概览均未截断，原生 read 展示未出现元数据递归展开。

证据：[运行与人工复核](../../../.artifacts/pi-mih-validation/inspect-views-astra-1791982832817/manual-review.json)、[附加任务严格复核](../../../.artifacts/pi-mih-validation/inspect-views-astra-1791982832817/followups/strict-review.json)。前两次的观察扩展只采集了 messages，漏采 Responses 的 input；它们的全文观察由保存的 Harness request.messages 和实际输出核对，不能声称已完整捕获原始 provider payload。修正采集器后，第 3–5 次均保存完整 input，逐字核对通过。五次失败都保留，未只选择采集修正后的样本。

旧二进制 SHA-256 为 `cf899f030f0fbd0a7497965815a8533babd8bca262396293f953fad26ad2e93e`；25 个默认定义、任务和 README 校验未改变。各会话保存逐轮源码、原始请求、结果、失败位置和最终答案，临时认证链接已移除。

## 历史：精简 inspect、显式展示器和请求分页

日期：2026-10-14。本轮替换上一轮默认递归观察。原 README 任务文本保持不变；两个编译版本各运行 DeepSeek/GLM 三次、Qwen 一次，另在最终版本的已完成会话副本中验证自建展示器和跨请求分页。没有添加失败案例 few-shot、模型专用分支或补发 README 修复指令。

### 契约与实现

- `inspect()` 的返回范围本身缩小为组成元数据：版本、待生效状态、草稿、文件目录、上下文 ID/长度、来源依赖和 view 映射。完整 system、codemode 描述和接口文档不再包含其中。实测默认概览正文 **1,927 字符、50 行**，包括宿主包装约 **1,975 字符、54 行**；相较所报告 session 的 44,361 字符、747 行，未触发输出截断。
- `inspect({section:"system"|"codemode"|"provenance",...})` 分页读取保存的实际生成结果；默认 4,000、最多 12,000 个 UTF-16 字符，不拆开代理对。`next` 包含完整查询和 `requestId`。非零 offset 缺少 requestId、未知请求或错误 block ID 均拒绝；不会换成当前请求或重新执行生成规则。`requestRevision` 与 `activeRevision` 分开；记录随会话分支恢复。
- `observe(value,{view})` 只保存值快照和展示类型。字符串直接显示，对象/数组缺少 view 或名称不存在则明确失败，不推断类型、不自动递归展开。默认 `pi.read` 精确返回 `result.text`；原生 read 的正文和续读提示保留，元数据只留给代码。`debug.dump` 必须显式选择。
- 展示映射位于 `agent.yaml → codemode.output.views → policies/views.yaml`，handler 源码默认在 `rules/views.mjs`。映射和源码都能经过草稿、校验、激活修改。输出固定使用请求版本，即使 `activate(now)`，新展示器也从下一次请求可用。布局规则只接收转换后的文本/图片。
- 展示错误包含输出项、view、可用名称和定义入口，记为 `presentation` 错误。有效观察和已经发生的调用保留；不回滚写入、不重放副作用，也不会误报为缺少 loop 决策。首版试验暴露默认 handler 的参数错误不够明确，最终版增加完整对象输入诊断、工具命名空间诊断及 controller 状态生命周期说明；没有放宽调用契约。

本轮新增必需的 `codemode.output.views` 定义；旧会话的定义不会被静默迁移。本文下面的递归观察协议仅作为历史记录。

### README 任务的重复实验

模型仍为 `opencode-go/deepseek-v4.1-flash`、`zai-coding-cn/glm-5.3-flash`、`local-llm/qwen3.8-27b`。thinking low，独立配置和会话，只声明 codemode，关闭重试、自动压缩、MCP、skills 和项目指引。任务 SHA-256：`15b4b620ead36a331d066c70967651f87534d8fba6cbd38f5d4eae707224ed2a`；10,627 字节 README SHA-256：`d4f05a91fe0de78d1b99d8b8d69c66e7522c493814cc4bd2ed344e4d60b10ce1`。

首版：DeepSeek 独立错误数 **0 / 2 / 0**，前两次完成，第三次完整读取但最终介绍中途结束，缺少 Harness 关系和修改说明，严格判为未完成；GLM **6 / 1 / 7**，第一次连续恢复预算耗尽、后两次完成；Qwen **7**，完成。Qwen 的四个失败轮次中，一轮包含四个独立错误展示，不能只算一次。首版二进制 SHA-256：`dfc0619a368d795c515adb39851177a22fe4430948ed3a407049b7214b452717`。

最终版固定后：

| 模型 / 次数 | 独立执行/协议错误 | README 任务 | 请求数 / 秒 |
|---|---:|---|---:|
| DeepSeek 1 | 2 | 完成 | 10 / 117.3 |
| DeepSeek 2 | 1 | 未完成；读取后下一次 provider 请求连接失败 | 8 / 66.2 |
| DeepSeek 3 | 1 | 完成 | 9 / 134.0 |
| GLM 1 | 10 | 完成 | 20 / 113.9 |
| GLM 2 | 2 | 完成 | 9 / 93.5 |
| GLM 3 | 3 | 完成 | 9 / 77.8 |
| Qwen 1 | 2 | 读取和介绍完成；请求/分页解释有误 | 6 / 919.4 |

计数包含捕获后的调用失败；同一异常沿 primitive/tool 传播不重复计数。连接失败单列，不算调用机制错误。完成要求 reader 确由模型定义、提示词和工具说明进入真实 provider 上下文、完整 README 经 reader 读取并进入 finish 前的推理、最终确有中文介绍；不会将 `finish` 或自动脚本的 `pass` 单独当作通过证据。

**仍未达到两个主要模型稳定 ≤1 次错误的目标。** 最终版的错误包括缺少 view、把字符串传给对象展示器、错误使用 data/跨 controller 局部状态、YAML/工具命名空间、精确编辑匹配、位置参数 stat 和漏选 finish。明确诊断可支持恢复，但重复试验没有证明更少的调用错误。默认展示的冗余已消除，显式选择 view 仍然是模型要遵守的新契约；不能把可读性改善等同于整体稳定性达标。

部分 controller 直接使用了任务 fs 原语，例如 DeepSeek 2 请求 3 直接 stat/read README。handler-only 仍是指引，不是强制边界；模型也可能自己 `JSON.stringify` 或选择 debug.dump，框架不会把这些显式输出偷偷改写成简洁展示。`current-review.json` 中原名为 `controllerIO` 的字段实际还会包含 handler 内部的调用：这些原语也共享 controller 的宿主调用 ID，必须结合 controller 源码区分，不能仅凭该字段判为越过 handler。Astra 补测的审计将它改名为 `executionIO`，直接 I/O 另行审阅源码。框架解释准确性另外复核：最终版 DeepSeek 3 把实现中的 `host.fs.read` 误写成 `host.fs.image`，GLM 2 错称上下文也在当前 controller 内立即改变，GLM 3 错称在激活的同一个 controller 调用了 reader。实际 journal/请求/调用轨迹与这些自述不同，完成 README 产物不代表全部解释正确。

首版 DeepSeek 3 的 finish 输入本身只有 935 字符、结束于半句话；provider 返回 stopReason=toolUse，没有长度错误，宿主输出没有截断。原自动验收将其记为完成，人工复核在 `manual-review.json` 单独纠正，原始 summary 保留。

最终版 Qwen 只在 `inspect({section:"codemode"}).text` 的默认第一页搜索 `read.file`，忽略了 eof/next，将“第一页未找到”错误解释成“工具未进入上下文、loop.next 复用同一请求”。真实 provider 描述和 requestRevision 已经更新。它的两个执行错误分别为通过错误属性名 `out.agent_yaml` 取到 undefined 后传给 pi.read，以及把带 Markdown 反引号的最终答案嵌入 JavaScript 模板字符串导致语法错误；修复后没有继续该错误调用，但最终分页解释仍错误。此前将第一个错误概括为“把字符串传给 pi.read”不够准确，这里按实际调用更正。

### 最终版原三个模型的逐项错误

以下请求编号均从对应独立运行的 1 开始。表中计入被捕获的失败，连接失败和最终解释错误另外说明。

| 运行 / 请求 | 实际失败 | 恢复与影响 |
|---|---|---|
| DeepSeek 1 / 6 | `observe({diagnostics,...})` 未指定 view，展示失败 | 草稿写入、prepare 已成功且保留；请求 7 选择 `debug.dump`，激活并读 README |
| DeepSeek 1 / 9 | 直接给出最终文字，没有 codemode 的 finish 决策 | 请求 10 改用结构化 `{finish}` 完成 |
| DeepSeek 2 / 3 | `return observe(JSON.stringify(...))` 返回 undefined，没有 next/finish | 请求 4 恢复 next；完整读取后请求 8 出现 provider `Connection error`，最终介绍未完成。连接失败不计入那 1 次协议错误 |
| DeepSeek 3 / 4 | `host.fs.list({path:"tools"})` 在真实项目目录中得到 ENOENT，异常被 catch | 一次目录探测失败，没有阻断 next；后续经 Harness 定义 reader。此项属于环境探测，不能等同于宿主机制故障 |
| GLM 1 / 1 | `observe(r.text,"pi.read")` 的第二参数是字符串，要求 `{view:...}` | 请求 2 改为直接观察字符串 |
| GLM 1 / 3 | `host.fs.list("tools")` 使用位置参数，要求 `{path}` | 异常被 catch；请求 4 改成对象参数 |
| GLM 1 / 4、6 | 分别对目录列表、begin 返回对象调用 observe，均遗漏 view | 两次独立展示错误；请求 5 改成字符串输出，请求 6 已创建的草稿保留供后续使用 |
| GLM 1 / 7 | 从不存在的 `host.__data` 读取源码 | 请求 8 换成外层 `data`，但仍没有提交该输入 |
| GLM 1 / 8 | 当前调用未携带 data，却读取 `data.moduleSrc`，触发 undefined 属性错误 | 请求 9 在同一次 codemode 输入中携带 data，写入成功 |
| GLM 1 / 10 | `prepare` 发现 tool YAML 的 description 双引号未闭合 | 请求 11 修改该行；没有激活错误定义 |
| GLM 1 / 12 | 工具名 `sandbox.read` 不属于 handler.module `sandbox-read` 命名空间 | 请求 13 开始改名，但又出现下面的编辑目标错误 |
| GLM 1 / 13 | 在 tool YAML 中编辑实际位于 prompt 的文字，`edits[1].oldText` 匹配不到 | 请求 14 将两个编辑分别应用到正确文件，成功 |
| GLM 1 / 17 | reader 内部执行 `host.fs.stat(path)`，要求 `{path}` | 请求 18 修改 handler 并重新激活；请求 19 读完、20 结束 |
| GLM 2 / 5 | reader 内部执行 `host.fs.stat(path)` | 请求 6 删除不必要的 stat 调用，准备并激活新版本 |
| GLM 2 / 7 | 拼接后的 README 字符串传给要求完整对象的 `pi.read` | 请求 8 改为 `observe(full)`，完整正文进入后续推理 |
| GLM 3 / 2 | 拼接后的定义源码字符串传给 `pi.read` | 请求 3 改为直接观察字符串 |
| GLM 3 / 4 | 草稿写入之后观察对象没有 view | 写入保留；请求 5 对该草稿 prepare，以字符串展示结果 |
| GLM 3 / 8 | 普通文字结束，遗漏 finish | 请求 9 改用结构化 `{finish}` |
| Qwen 1 / 2 | 实际 key 为 `"agent.yaml"`，却使用 `out.agent_yaml`；undefined 被送给 `pi.read` | 同一脚本后续 console 输出保留，模型可以继续；没有回滚此前读取 |
| Qwen 1 / 5 | 最终答案的 Markdown 反引号终止了 JavaScript 模板字符串，报 `expecting ';'` | 请求 6 改成字符串数组拼接并 finish；本可使用已有的结构化 `{finish}` 避免源码转义 |

上述失败均可在各运行的 `response-audit.json` 和 `independent-failure-review.json` 定位；实际源码和宿主结果保存在 `events.jsonl`。展示失败不会被诊断成“没有驱动 loop”；缺少 next/finish 的纯协议错误才进入协议纠正。最终解释不准确的情况见前文，不能因为执行恢复成功而忽略。

### 自建展示器与跨请求续读

附加任务使用各模型第一份已完成 README 的会话副本，不替代上面的独立运行。只给出能力验证要求，没有提供 handler 源码或操作步骤。离线复核分别统计查询范围和实际观察范围：将观察到的页正文逐字匹配保存的 description，并验证不同当前 requestId 下查询同一保存请求；read 展示单独去掉全局输出编号后与 README 对比。

| 模型 | 自建并激活展示器 | 固定请求完整续读 | 自建 read 展示 | 附加执行/展示错误 |
|---|---|---|---|---:|
| DeepSeek | `files.text` | 2 页，22,433 字符 | 与正文完全一致 | 0 |
| GLM | `read.plain` | 6 页，22,348 字符 | 多出非必要的 `[eof] size=…` 行 | 1 |
| Qwen | `readBody` | 2 页，22,229 字符；仅观察页摘要 | 与正文完全一致；局部读取有续读提示 | 0 |

GLM 最初把 `page.text` 传给 `harness.detail`，收到明确错误后改用完整 page，随后沿同一 requestId 完成续读。它声称 `activate(now)` 使新 view 当次可用，这一解释不正确；实际轨迹在激活后先 next，再调用新 view。其自建 handler 的 EOF 元数据也不满足“正文及必要续读提示”的严格展示要求，不能用自动附加任务的 pass 掩盖这两点。默认 `pi.read` 没有该问题。

Qwen 的两次 inspect 调用完整覆盖同一份保存请求，但只将页首 200/180 字符和长度、版本信息回传给模型，因此仅证明数据取齐和版本核对，不能记作模型观察了完整 codemode 描述。它实际在 next 后调用新 view，最终却又将输出规则说成“按当前 active 实时套用”，将工具返回值说成不可变快照；这些解释仍不准确。输出固定在请求版本，observe 记录的是快照，原始 JavaScript 返回对象仍可由代码修改。

原始工具值不变由调用轨迹、模型读取元数据，以及确定性测试中故意修改 handler 输入的隔离检查共同验证；观察前后的 stringify 比较本身不能代替 handler 执行后的隔离测试。

### 确定性检查、二进制与证据

`npm run check`、编译和 `git diff --check` 通过。Standalone observe 17 项通过；coding-agent 的 output/inspect/observe/runtime 四文件 34 项、loop/inspection 两文件 39 项通过；最终错误定位修改后 output/observe 12 项复测通过（有重叠，不累加）。另通过 context/input/renderer 的相关检查。覆盖缺少/未知 handler、正文及原生续读提示、快照不变、即刻激活仍固定旧输出规则、跨请求和重启分页、Unicode 边界、失败后保留副作用与正确循环恢复。去掉随机 requestId 的 bootstrap 注入后，原有上下文前缀稳定性测试恢复通过；请求 ID 只通过 inspect 查询。

最终二进制为 `packages/coding-agent/dist/pi-mih`，与独立验收目录的 `bin/pi-mih-views-v2` 相同，SHA-256：`cf899f030f0fbd0a7497965815a8533babd8bca262396293f953fad26ad2e93e`。25 个默认定义文件逐个校验与最终验收版本一致。运行目录保留各自二进制/默认资源，避免后续编译改变既有验收环境。npm 仍有仓库已有的 `min-release-age` 配置提示，代码检查无诊断。

- [首版记录](../../../.artifacts/pi-mih-validation/inspect-views-1791974809285/)、[最终版记录](../../../.artifacts/pi-mih-validation/inspect-views-v2-1791975284772/)。
- 每轮 `current-review.json`、`independent-failure-review.json`、`read-coverage-review.json`，以及原始 `events.jsonl`、`requests.jsonl`、session、定义和答案。失败记录全部保留。
- [附加能力严格复核](../../../.artifacts/pi-mih-validation/inspect-views-v2-1791975284772/followups/strict-review.json)、各模型 `summary.json` 和完整轨迹。
- `build.json`、`assets.json`、`prompt.txt` 固定程序、默认定义和任务。运行器与离线复核脚本保留在验收目录；重新运行时使用新的目录，避免混入已有 JSONL。


## 历史：可编辑的递归观察输出

日期：2026-10-14。在之前的 28 次实验之后，新增 `observe(value)`，将工具数据与模型观察内容分开，再用两个编译版本各运行 DeepSeek/GLM 三次、Qwen 一次。任务文本、模型配置和独立会话方式保持不变；没有加入失败案例 few-shot 或模型专用逻辑。

### 实现与证据

`observe(value)` 同步提交结构化快照，返回 undefined；不修改原始值，不选择 next/finish。显示逻辑沿已有 `agent.yaml → codemode.output → rules/output.mjs#render` 链路执行。默认 `observe` 导出按字段路径和类型展示，字符串保留实际换行、引号和反斜杠，围栏长度适配内容中的反引号；没有终止换行时明确标记。模型可通过正常 Harness 编辑/准备/激活流程修改这个函数或整个输出规则。渲染固定在请求版本，新规则从下一次请求生效。

此次还修复一个诊断缺口：QuickJS 在异步宿主调用返回错误时丢失原始调用栈。现在桥接层在发起调用时捕获位置，错误保留 controller 及 handler 文件、版本与行号。回归测试在修复前收到的 stack 只有 `Error: read failed`；修复后包含 `modules/example.mjs@r-test:3`。会话测试同时验证了真实 provider 消息中的两层调用位置和失败前已输出的观察。

最终二进制为 `packages/coding-agent/dist/pi-mih`，与实验使用的 `pi-mih-observe-stack` 相同，SHA-256：`9409e0fc0bdff094d5227f51cf50ed8a9e9b980a4327c65d907c1c9b7ef94f43`。第一版 `pi-mih-observe` 的 SHA-256 为 `52cbae0cc5d3344c03f6145ef99980a466a725e5bea56fa0a4731c0bb93155c1`；两个版本的默认定义文件完全相同，第二版只改变异步错误位置传递。

### 重复实验

第一版的独立执行/协议错误：DeepSeek **2 / 0 / 1**，GLM **1 / 2 / 11**，Qwen **0**；七次均完成任务。Qwen 另有一次未输出 inspect 结果，下一轮重新读取，因此完整复核记为 **1**。GLM 第三次在缺少 handler 错误位置时反复探测参数形态，导致语法、schema 和版本冲突等后续错误；这促成第二版的调用栈修复。

第二版固定后，连续实验结果如下。计数包含被 catch 的失败；同一错误沿 primitive → tool 传播不重复计数，同一轮发生两个独立失败则计两次。

| 模型 / 次数 | 独立执行/协议错误 | 完成 README 任务 | controller 直接调用任务 I/O | 请求数 / 秒 |
|---|---:|---|---|---:|
| DeepSeek 1 | 1 | 是 | 无 | 6 / 58.4 |
| DeepSeek 2 | 2 | 是 | 无 | 9 / 55.5 |
| DeepSeek 3 | 0 | 是 | stat README | 6 / 85.0 |
| GLM 1 | 2 | 是 | 无 | 7 / 82.4 |
| GLM 2 | 1 | 是；按行 reader 去掉了末尾 LF | 无 | 10 / 93.1 |
| GLM 3 | 2 | 是 | 无 | 10 / 78.5 |
| Qwen 1 | 1 | 是 | list 根目录、stat README | 10 / 492.6 |

模型 ID 仍是 `opencode-go/deepseek-v4.1-flash`、`zai-coding-cn/glm-5.3-flash` 和 `local-llm/qwen3.8-27b`。**两主要模型在整个任务中稳定 ≤1 次错误的目标仍未达到。** 当前证据支持输出可读性和错误定位修复有效，不能据此宣称成功率已稳定，或将剩余问题归结为模型永久无法使用此框架。

最终版本的具体失败：DeepSeek 1 先直接输出最终正文，未选择 finish；DeepSeek 2 错误解构 begin 返回值，随后把 data 与 finish 一起提交；GLM 1 漏写 target，最后又直接输出正文；GLM 2 误用位置参数 stat；GLM 3 尝试在 prompt 源文件中编辑生成后的目录文本，随后误用位置参数 stat；Qwen 在构造观察对象时使用未声明的 toolYaml，而不是 data.toolYaml，在 helper 调用前触发 ReferenceError。GLM 2/3 都在收到带模块行号的错误后，下一轮直接编辑了相应调用。未加入修复这些案例的提示词。

### 观察与完整读取的复核

复核解码后的真实 provider tool-result 文本，而非 JSONL 的表面转义。匹配到的 `agent.yaml` 和 README 文本含实际换行；源码中的字面量 `\\n` 仍保持字面量。没有发现 helper 编码/渲染失败。真实任务没有要求模型修改输出规则，模型沿用了默认规则；编辑规则后的版本生效、原始数据不变、失败恢复和原文保真由 faux-provider 会话测试验证。

原自动验收的 `pass` 不作为最终结论，另存以下复核：

- **独立错误计数**：第一版 DeepSeek 1 在一轮中分别查询不存在的 `tools` 和 `modules` 任务目录，两次失败不能合并成一次。
- **跨观察的全文覆盖**：第一版 GLM 1 分别观察 README 的前 3000 字符和剩余部分；GLM 3 分页读取。后续请求中同时存在的完整文字逐段核对，不能要求单条 tool result 必须含全文。
- **终止换行**：第二版 GLM 2 的 reader 按行 split/pop/join，返回值恰好是 README 去掉最后一个 LF。所有文字已读取、观察并用于介绍；记录 `readerOmittedFinalNewline: true`、`exactReaderCoverage: false`，不声称逐字节还原。默认观察规则标明没有终止换行；它为排版加入的围栏前换行不能作为原始值保真的证据。
- **边界与自述**：直接在 controller 调用 fs 的情况单独记录；handler-only 仍是默认指引，不是运行时强制边界。部分模型把这一指引说成强制隔离，或把“目录中展示”说成唯一发现方式，这些自述不作为实现证据。

任务 SHA-256 仍为 `15b4b620ead36a331d066c70967651f87534d8fba6cbd38f5d4eae707224ed2a`，README SHA-256 仍为 `d4f05a91fe0de78d1b99d8b8d69c66e7522c493814cc4bd2ed344e4d60b10ce1`。运行记录分别位于 [observe-1791971005791](../../../.artifacts/pi-mih-validation/observe-1791971005791/) 和 [observe-stack-1791971529990](../../../.artifacts/pi-mih-validation/observe-stack-1791971529990/)。后者的 `iteration-review.json` 汇总两版；各运行保存原始请求、事件、会话、reader 定义、答案、完整读取复核、独立错误计数和人工复核。

确定性验证：`npm run check` 通过。观察机制初轮 standalone 4 文件 86 项、coding-agent 6 文件 78 项通过；调用栈修复后 standalone 3 文件 74 项、coding-agent 2 文件 42 项复测通过。不同批次有重叠，不累加。覆盖结构化快照、字符串保真、动态围栏、原值不变、规则编辑/请求版本、失败后观察保留、无隐式循环决策、桥接预算和异步错误位置。`git diff --check` 通过；仍有仓库已有的 npm `min-release-age` 配置提示。

## 前一轮历史：调用契约与结构化输入

以下保留此前五个版本、28 次真实模型实验（DeepSeek/GLM 各 13 次，Qwen 补充 2 次）的记录，不代表最新二进制。任务文本始终不变，没有加入针对失败轨迹的 few-shot 解答或模型专用分支。实现与接口见 [设计及迁移说明](editable-harness.md) 和 [Codemode](codemode.md)。

## 本轮最终结果

当时的最终二进制保留为 `packages/coding-agent/dist/pi-mih-final`，SHA-256 为 `6faaa5d6a7bd0afe445d97d482de9cba1bae7d025c8d272a2d3e2d3653b720ac`。该版本固定后，每个主要模型从空白会话重复三次；没有挑选最好的一次作为结论。

| 模型 / 次数 | 执行或协议错误 | 完成全部任务 | controller 直接调用任务 I/O 原语 | 请求数 / 秒 |
|---|---:|---|---|---:|
| DeepSeek 1 | 0 | 是 | 第 2 次请求直接读取 README，之后也用自定义 reader 完整读取并观察 | 4 / 56.9 |
| DeepSeek 2 | 0 | 是 | 无 | 8 / 69.4 |
| DeepSeek 3 | 1 | 是 | 第 7 次请求直接 stat；内容均经自定义 reader 读取 | 8 / 55.1 |
| GLM 1 | 3 | **否**：最后 `loop.finish(null)`，没有项目介绍 | 无 | 15 / 120.5 |
| GLM 2 | 3 | 是 | 无 | 10 / 111.5 |
| GLM 3 | 2 | 是 | 无 | 8 / 76.4 |

模型分别为 `opencode-go/deepseek-v4.1-flash` 和 `zai-coding-cn/glm-5.3-flash`。六次运行都自行创建了模块和工具定义、修改 codemode 提示词、激活版本、通过 reader 完整读取 README，且全文和新工具说明进入后续真实 provider 请求。GLM 1 缺少最后的介绍，因此只完成了前面的产物与读取步骤。

错误计数包括脚本解析、接口参数、定义校验、输出 schema、编辑匹配和 loop 协议失败；即使模型捕获异常，也计入。一次失败沿 primitive → 内部工具传播只算一次；修复前再次调用另算一次。最终这些运行每个失败响应只有一个独立错误。有效 `finish(null)` 没有执行错误，但属于任务未完成，单独判定，不能用合法结束掩盖失败。

DeepSeek 三次均满足“执行/协议错误 ≤ 1”，并完成用户要求的产物和介绍；GLM 三次均超标。默认指引还要求任务 I/O 放在 handler 内，DeepSeek 1/3 没有完全遵守。当前运行时允许 controller 访问这些原语，这一条仍是指引而非强制边界。**若同时要求全程遵守此项设计，最终六次里只有 DeepSeek 2 满足全部条件。**

## 调用机制的修改

1. **返回值不再隐式转换。** handler 返回什么，`host.tools.call` 就收到什么；`outputSchema` 仅校验。Pi 的 content/structuredContent 展示包装由宿主生成。Harness read/write/edit 单独返回 `{text, details, harness}`，保留原生文件编辑算法与截断信息。
2. **代码与内容分开。** 顶层仍只有 codemode，输入可以是 `{code, data?}` 或 `{finish}`。模块源码、文件内容、prompt 文本可以作为 data 传入，避免在 controller 字符串中再次转义；最终文本不需要编码成 JavaScript。程序化 `loop.finish(value)` 保留。
3. **使用普通 JavaScript 作用域。** 宿主绑定放在外层，`const tools = ...` 等常见局部声明不再撞上隐藏函数参数。QuickJS 加载已有依赖提供的标准 TextEncoder/TextDecoder 扩展，编译二进制也包含该资源。
4. **接口说明和参数校验共用 schema。** 全部 `host.*` 函数使用同一套声明生成器与校验绑定。参数错误一次列出缺失/非法字段、完整函数签名和用途；校验在副作用前完成。输出 schema 错误也给出字段位置。没有增加位置参数别名、放宽版本冲突检查或自动补写模型的定义。
5. **区分执行失败和循环错误。** 可编辑 loop 规则收到具体 outcome、错误及已完成操作，执行失败和协议纠正使用独立预算。失败提醒不会把“代码尚未运行到 next”说成“忘记 next”，也不自动重放已有副作用。
6. **工具可发现性来自定义。** 目录根据工具 schema 生成完整调用形式，选择、分组、详细度和预算仍由 Harness 定义控制；未定义工具错误给出当前可用名称。没有重新开放内置 read/bash 等工具。

这些修改去除了宿主制造的转换、作用域和字符串编码负担，但没有消除模型需要理解的全部约束。模块导入、工具命名、YAML、版本激活、返回 schema 和结束协议仍然同时存在。

## 重复实验与剩余问题

每列列出该版本连续实验的执行/协议错误数；第一版各一个样本，其余各三个。不同版本的结果不合并成某一个版本的成功率。

| 版本 | 主要变化 | DeepSeek | GLM |
|---|---|---|---|
| `contracts-1791964581549` | 原始返回值、作用域和 loop outcome | 0 | 2 |
| `repeated-1791965141486` | Harness 文本结果、标准编码 API | 1 / 0 / 1 | 4 / 2 / 2 |
| `repeated-1791966125677` | `{code,data?}` 与 `{finish}` | 1 / 1 / 0 | 1 / 3 / 1 |
| `repeated-1791966696328` | Harness 接口共享声明与校验 | 0 / 1 / 1 | 1 / 5 / 7 |
| `repeated-1791967248760` | 全部 host 接口共享声明与校验、输出字段诊断 | 0 / 0 / 1 | 3 / 3 / 2 |

第一版 GLM 有一次读取不存在的 `structuredContent` 后得到 undefined，脚本没有抛错，却需要额外 inspect/read。人工复核将其与 TextDecoder 错误一起计为 2 次。该版 GLM 最后只返回 `done`；第二版 GLM 3 只返回“全部任务完成”，两者都没有给出项目介绍，不能把自动检查中的 finish 当成任务完成。

最终版本的失败轨迹：

- DeepSeek 3：`oldText` 把原文 `Changes` 写成 `changes`，精确编辑失败；读取原文后修复。正常本地变量 `const tools`、data 中的模块源码和结构化最终文本均可使用。
- GLM 1：第 5 次请求在 handler 中调用 `host.fs.stat(args.path)`；错误已经包含 `host.fs.stat({path})` 的完整签名，第 6 次仍调用未修正的 handler。随后把 handler 换成调试返回值，却保留原 outputSchema，第 8 次再次失败。最后读完并观察 README 后用 null 结束，没有介绍。
- GLM 2：一次 positional stat 参数错误；一次直接输出普通文字而没有 codemode；一次同时传入 `finish` 和 `data`，被拒绝后用合法 `{finish}` 完成。
- GLM 3：导入不存在的 `pi:host`；修复导入后，工具名仍不在其模块命名空间内。再次修改后完成。

完整契约改善了诊断，但没有让 GLM 稳定遵守契约；增加接口描述也没有呈现单调改善。模型可以使用 data，却仍常选择在 code 中嵌入模块源码。以上支持的结论是“GLM 在当前框架与配置下未达标”，不能推导为这个模型永远不能完成。相比原始 codemode，本设计新增了定义与激活协议；这些额外概念仍是需要继续简化的设计成本。

补充 Qwen：第一版 2 次错误后完成；结构化输入版本的补测中，reader、提示词和全文观察已完成，但模型调用不存在的顶层 `finish` 工具，随后达到 20 分钟上限，没有合法结束。因此第二次不通过；这不是最终二进制的 Qwen 验收。

## 验收复核与证据

任务文本 SHA-256 为 `15b4b620ead36a331d066c70967651f87534d8fba6cbd38f5d4eae707224ed2a`，五个版本完全一致。README 仍为 10,627 字节，SHA-256 为 `d4f05a91fe0de78d1b99d8b8d69c66e7522c493814cc4bd2ed344e4d60b10ce1`。每次使用独立配置/会话，thinking low，关闭重试、自动压缩、MCP、skills 和项目指引；只暴露 codemode。没有给模型补发修复指令。

复核修正了三个验收器问题，原始结果未覆盖：

1. DeepSeek 最终第 2 次分三页读取，原检查错误地要求单次 reader 返回全文。复核按实际 reader 调用顺序拼接，逐字比较 README，再确认对应 controller 的全文结果进入第 8 次 provider 请求；没有放宽完整读取和观察条件。
2. 没有合法 finish 时，原检查曾匹配到缺少 controllerId 的响应，错误标记 Qwen“在 finish 前观察全文”。现在必须先有真实、成功的 finish。
3. `answer.md` 包含宿主的 `Script completed` 包装，并不等于模型给出了介绍。人工检查最终 assistant 消息与工具结果，识别出 GLM 的 `null`、`done` 和仅声称完成的结果。

最终产物和审计位于 [repeated-1791967248760](../../../.artifacts/pi-mih-validation/repeated-1791967248760/)：

- [跨版本汇总与人工复核](../../../.artifacts/pi-mih-validation/repeated-1791967248760/iteration-review.json)；`automatedTaskChecksPassed`、`taskComplete`、`errorThresholdMet` 和 `strictDesignAcceptance` 分开保存。
- 每个运行目录中的 `events.jsonl`、`requests.jsonl`、`sessions/*.jsonl`、`response-audit.json`、`reader-definitions.json`、`read-coverage-review.json`、`answer.md`；最终六次另有 `manual-review.json`。
- `build.json`、`assets.json`、`prompt.txt` 固定二进制、默认定义与任务；日志不保存认证 header，临时凭证配置链接已删除。

有效介绍的项目定位、包结构和使用方式与 README 相符，但不代表所有自述都准确。例如 DeepSeek 1 错称开始时已有同名 reader；实际初始目录为空。也没有验证这些生成 reader 对任意编码、超大文件或恶意输入的通用正确性。

## 本轮确定性验证与复现

`npm run check` 通过，编译独立二进制通过。相关测试分阶段运行：结构化输入、loop、agent 集成与 renderer 共 68 项通过；全部 host 契约、runtime、Harness context 与 input 共 33 项通过；输出字段诊断修改后重跑 runtime/primitives 共 22 项通过。Standalone 的 sandbox/worker shutdown/modules/loop-control/encoding 组 81 项通过，data 修改后相关 22 项复测通过。不同批次有重叠，不相加作为总测试数。`git diff --check` 通过。npm 仍有仓库现有的 `min-release-age` 配置提示。

配置好指定 provider 后，从仓库根目录使用新的目录执行以下命令。脚本显式调用真实模型；默认对两个主要模型各跑三次，`PI_VALIDATION_QWEN_ONLY=1` 改为一次 Qwen。

```bash
run_dir=".artifacts/pi-mih-validation/repeated-$(date +%s)"
mkdir -p "$run_dir"
cp .artifacts/pi-mih-validation/repeated-1791967248760/run.mjs "$run_dir/"
node "$run_dir/run.mjs"
python3 .artifacts/pi-mih-validation/repeated-1791967248760/review-pages.py "${run_dir##*/}"
python3 .artifacts/pi-mih-validation/repeated-1791967248760/review-iterations.py "${run_dir##*/}"
```

运行器仍保留原始自动判定，离线复核独立写文件；真实结果应结合全文覆盖、最终答案和 controller 源码审阅，不应直接把 `summary.json.pass` 当成全部验收结论。

## 初版历史记录

以下记录对应旧二进制 `b8a849…a360`，保留当时的实验与循环复核，不代表当前实现的协议或本轮验收结论。三个指定模型当时最终完成主要任务产物；GLM 和 Qwen 依赖循环纠正。重启后均能调用已有 reader，但 Qwen 没有经过下一轮推理观察新内容。

### 环境与验收方式

- 执行程序：`packages/coding-agent/dist/pi-mih`，Bun 1.3.11 编译的独立二进制。
- 二进制 SHA-256：`b8a84969698ceff636dc87f86bebd220e87b9db97074e034abb88f2d0c58a360`。最终源码重新编译后 hash 相同。
- 任务目录：仓库根目录；目标 `README.md` 为 10,627 字节，SHA-256 为 `d4f05a91fe0de78d1b99d8b8d69c66e7522c493814cc4bd2ed344e4d60b10ce1`。
- 每个模型使用独立 agent 配置与会话。关闭 MCP、skills、项目指引、prompt templates、自动压缩和请求自动重试，默认只启用 codemode；thinking 为 low。
- 三者获得相同自然语言任务：自由探索 agent 的组成，自行定义 sandbox 层文本 reader，修改 codemode 提示词及必要的目录规则，让 reader 进入原生上下文；完整读取 README，观察结果后用中文介绍项目，并解释定义、生效和上下文的关系。
- 没有提供 reader 源码、工具定义模板或本次任务的操作脚本。通用入口、接口签名和 next/finish 指引来自默认 Harness。

验收读取实际 `before_provider_request` payload、RPC 事件及会话 journal；不以模型自述为证据。检查激活快照中的模块确实调用 `host.fs.read`、reader 的嵌套调用成功、返回内容含完整 README、修改后的 prompt 和工具说明出现在后续 codemode 描述中、顶层工具始终只有 codemode。原脚本只检查最终存在 finish，未检查逐轮协议遵守、纠正次数及新读取结果是否进入后续推理。日志不记录认证 header；运行结束移除临时凭证配置链接。

### 主要任务结果

| 模型 | 结果 | 请求数 | 用时 | 自定义工具 | 脚本错误 | 循环纠正 |
|---|---|---:|---:|---|---:|---:|
| `opencode-go/deepseek-v4.1-flash` | 完成 | 9 | 83.4 秒 | `sandbox.read` | 0 | 0 |
| `zai-coding-cn/glm-5.3-flash` | 纠正后完成 | 11 | 149.0 秒 | `fs.readText` | 3 | 3 |
| `local-llm/qwen3.8-27b` | 纠正后完成 | 7 | 573.5 秒 | `sandbox.read` | 0 | 1 |

27 次实际请求均只声明 codemode。三个 reader 都由模型写入 Harness 的 module/tool 文件后激活，没有调用旧的注册接口，也没有获得预置的 read/bash 等任务工具。三个模型都实际修改了 `prompts/codemode.prompt`，完整读取 README 后给出了与文件内容相符的中文介绍。

**DeepSeek** 创建 reader，并修改目录生成代码，增加 `guaranteed` 配置：指定工具优先排列、显示完整 schema，且不被目录预算裁掉。这是对生成规则和配置语言的自行扩展，不需要增加宿主 setter。新增工具第一次进入原生描述是在第 8 次请求。它正确区分了 `now` 对当前 controller 新调用的影响和下一次推理才看到的新描述。

**GLM** 依靠现有 `select: all` 目录策略，只添加工具实现、工具定义和提示词。第 6 次请求起原生描述已包含 `fs.readText`。它曾调用尚未定义的 `fs.stat`，被运行时拒绝；随后误把 `host.tools.call` 的结构化返回值当作原始工具 envelope，又在最终字符串中产生引号错误。这三个错误均由模型自行修正，没有补发人工指导或工具代码。

**Qwen** 创建了带字节翻页和 UTF-8 解码的 reader，修改提示词并把目录详细度改为 `full`。第 6 次请求起说明进入原生描述。第 6 次响应直接用普通文字完成介绍，没有调用 codemode；宿主追加循环纠正消息后，第 7 次才调用 finish。因此“脚本错误为 0”不代表循环协议全程正确。它明确指出当前请求描述已经固定，`now` 仅使新调用立即可用，新的描述从下一次请求呈现。其耗时和生成量明显较高，不能据此宣称已经达到效率目标。

三者都能从 `agent.yaml` 跟随引用理解 system、description、目录和执行绑定。它们偶尔把“每次推理请求”宽泛称为“每次 codemode 调用”，或把逻辑域分离称为“完全隔离”；实际生效时机以请求和版本记录为准，当前任务后端仍是宿主真实文件系统。

| 模型 | 未缓存 input | cache read | output |
|---|---:|---:|---:|
| DeepSeek | 70,297 | 122,496 | 10,758 |
| GLM | 42,985 | 88,832 | 3,975 |
| Qwen | 47,893 | 63,635 | 16,555 |

以上为各 provider 返回的 usage 总和，不是统一 tokenizer 下的比较。原始 usage 和成本元数据保留在日志中。

### 重启后复用

主要任务结束后关闭进程，再用同一个二进制和原 session 文件启动，要求复用已有 reader。三个模型恢复后的**首个 provider 请求**均已包含此前的 reader 说明；三者均实际调用成功，没有重新建立草稿、写定义、prepare 或 activate。

| 模型 | 复用结果与观察范围 | 请求数 | 用时 |
|---|---|---:|---:|
| DeepSeek | 复用成功；完整新结果进入下一次推理 | 2 | 12.8 秒 |
| GLM | 复用成功；只回传新结果前 800 字符 | 2 | 24.4 秒 |
| Qwen | 复用成功；缺少观察新结果的推理轮次 | 3 | 75.7 秒 |

Qwen 两次把保留绑定 `tools` 用作局部变量，被语法检查拒绝，各触发一次循环纠正；第三次修正为 `toolList` 后成功调用。它在同一 controller 内读取并 finish，答案正文已写在读取前生成的代码里，读取后的 `full` 变量没有用于内容分析。它没有执行“观察新结果后再介绍”的流程，旧历史中的 README 可以解释答案为何仍然正确。GLM 也只把新结果前 800 字符回传给模型。这些附加记录证明恢复后的发现与调用能力，不能算作三次完整的独立内容理解验收。主要任务中三个模型的完整读结果均已进入后续推理。

### 失败记录与修复

1. 初次编译运行中，三个进程都在首次模型请求前退出。独立最小程序复现了 Bun 编译程序在等待 `Worker.terminate()` 时丢失最后一个活动句柄的问题。修复关闭阶段的存活句柄，并新增 [二进制回归测试](../../codemode/test/worker-shutdown.test.ts)。该测试修复前稳定失败，修复后通过。
2. 修复启动后的第一次探索中，DeepSeek 完成；GLM 的首次请求遇到连接错误；Qwen 把 `inspect()` 结果直接 `finish`，未完成任务。三者的失败/成功日志均保留。
3. 补充了共享 codemode 指引：探索、prepare 和新数据观察应使用 next；只有全部任务和解释完成后才 finish；列出已有绑定，避免重名。随后三个模型从空白会话使用相同指引重新执行，结果见上表。没有为单个模型提供特殊实现或调整通过标准。

这是一轮明确要求创建 reader 的验收，不证明简短普通任务中模型总会自发创建、复用工具，也不是稳定成功率或长任务质量基准。没有验证任意模型生成的 reader 对所有编码、极大文件或错误输入都正确。

### 循环协议复核

复核覆盖第一次探索、最终主要任务和重启复用，共 44 次模型请求。按 session 的 assistant/toolResult/custom_message 顺序核对，并用真实 provider 请求验证后续消息。纠正消息通过 `entry_appended` / journal 的 `custom_message` 记录，不能只统计 codemode 的执行错误或 `message_end`。

| 阶段 | 模型 | 纠正次数 | 具体原因（请求编号从 1 开始） |
|---|---|---:|---|
| 第一次探索 | DeepSeek | 2 | 第 1 次局部 `const tools` 与注入参数重名；第 7 次 finish 字符串中 Markdown 反引号未转义 |
| 最终主要任务 | GLM | 3 | 第 6 次调用未定义的 `fs.stat`；第 7 次误读已解包的 reader 返回值；第 10 次 finish 字符串引号未转义 |
| 最终主要任务 | Qwen | 1 | 第 6 次直接输出文字，没有 codemode 调用 |
| 重启复用 | Qwen | 2 | 第 1、2 次局部 `const tools` 与注入参数重名 |

其余运行没有纠正。共 8 次纠正中，7 次是脚本异常，源码均写有 `return loop.next/finish(...)`，但执行未能成功返回；只有 1 次是纯文字响应遗漏循环决策。另有两处不会触发纠正的流程问题：第一次探索的 Qwen 把 inspect 结果直接 finish、任务未完成；重启复用的 Qwen 读取后直接 finish、未观察新数据。GLM 第一次探索的连接错误属于 provider 失败，没有进入纠正流程。

在这些记录中，27 个成功 next 均有后续请求并携带对应结果，8 个成功 finish 均设置 terminate 并结束当前任务；未发现有效决策被调度器丢失。最终主要任务中，DeepSeek 第 7 次、GLM 第 9 次、Qwen 第 5 次的完整 README 输出，分别出现在下一次 provider 请求中。这只能证明本次记录的调度和数据传递正确，不能证明模型总能选择正确的结束时机。

当时实现的问题是信息被过早简化：turn_end 把结果压成 `controlled: boolean`，loop.decide 只收到 `{controlled, corrections}`。脚本语法错误、任务工具异常、没有调用 codemode、正常返回但遗漏决策，都会得到相同的“未正确驱动循环”提醒，并消耗同一连续纠正预算。失败脚本没有成功提交 loop 决策是合理的；把所有失败都解释成协议误用，会掩盖真正原因，也限制模型编写不同恢复策略。

当时提出的后续方向是分别暴露执行失败、缺少决策、非法批次和 next/finish 等结果及已完成调用，让 Harness 的 loop 规则决定恢复方式。验收也应分别报告任务产物、协议纠正、执行恢复和新数据观察顺序；有效 finish 只证明结束请求合法，不自动证明用户任务完成。该次复核只修改文档，没有修改运行协议或重新调用模型；上述后续方向已在本文前半部分的本轮实现中落实。原始 `summary.json` 的 pass 保留为当时较宽检查的历史结果，不代表完整过程验收。

### 确定性验证

- `npm run check` 通过：格式、类型、运行时依赖、入口图、安装锁和 browser smoke 检查。
- coding-agent 的 17 个相关测试文件：246 通过、2 跳过。
- codemode 的 worker shutdown、modules、sandbox、loop-control：78 通过。
- 最终指引更新后重跑 4 个直接相关测试文件：54 通过，不重复计入上面的总数。
- `git diff --check` 通过。npm 仍打印已有的 `min-release-age` 配置识别提示；代码检查无诊断。

覆盖内容包括原生 Harness read/write/edit 和目标域、候选冻结与冲突、替换/撤销/回滚、pending 取消、分支与恢复、旧调用及其嵌套工具/hook 的版本隔离、模型原生上下文、可编辑提醒/历史/输出、压缩后能力保留，以及候选压缩失败时保留旧活动版本和历史并如实记录摘要 usage。

### 证据与复现

最终运行目录：[harness-1791960157452](../../../.artifacts/pi-mih-validation/harness-1791960157452/)。主要文件：

- [汇总](../../../.artifacts/pi-mih-validation/harness-1791960157452/summary.json)、[人工核对用指标](../../../.artifacts/pi-mih-validation/harness-1791960157452/review-metrics.json)、[重启复用汇总](../../../.artifacts/pi-mih-validation/harness-1791960157452/resume-summary.json)。
- [逐轮循环复核](../../../.artifacts/pi-mih-validation/harness-1791960157452/loop-audit.json)：保留每轮 session 路径及行号、实际 loop 结果、脚本错误、纠正次数、调度核对和完整 README 进入下一次请求的记录。
- [编译 hash 与默认定义资源 manifest](../../../.artifacts/pi-mih-validation/harness-1791960157452/build.json)、[统一任务](../../../.artifacts/pi-mih-validation/harness-1791960157452/prompt.txt)。
- 各模型目录内的 `events.jsonl`、`requests.jsonl`、`native-descriptions.json`、`sessions/*.jsonl`、`final-harness/`、`answer.md` 和 `resume/`。
- 启动失败：[harness-1791959668108](../../../.artifacts/pi-mih-validation/harness-1791959668108/)；首次探索：[harness-1791960036247](../../../.artifacts/pi-mih-validation/harness-1791960036247/)。

产物位于本地忽略目录，不包含在代码提交中。配置好上述 provider 的认证和本地模型适配器后，从仓库根目录执行：

```bash
npm run build:offline
cd packages/coding-agent
bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv ./dist/bun/cli.js ./src/utils/image-resize-worker.ts ./src/extensions/codemode/worker.ts --outfile dist/pi-mih
npm run copy-binary-assets
cd ../..

run_dir=".artifacts/pi-mih-validation/harness-$(date +%s)"
mkdir -p "$run_dir"
cp .artifacts/pi-mih-validation/harness-1791960157452/{run,review,resume}.mjs "$run_dir/"
node "$run_dir/run.mjs"
node "$run_dir/review.mjs"
node "$run_dir/resume.mjs"
```

使用新的输出目录，避免覆盖或混入既有运行。三个脚本分别执行主要任务、导出定义/请求证据和重启复用；真实 provider 调用只由显式运行这些脚本触发。
