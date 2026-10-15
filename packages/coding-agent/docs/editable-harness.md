# 可编辑的 Harness：表达、编辑与 Pi 迁移

状态：已实现第一版，并根据真实模型轨迹修正调用契约和循环恢复。各轮结果与失败记录见 [验证记录](editable-harness-validation.md)。本文保留表达与迁移契约；可调用接口见 [Codemode](codemode.md)，实现后的边界见第 9 节。上一版注册式原型基线为 `11bd1dd1c`，其历史实验见 [原子工具验证](atomic-codemode-validation.md)。

2026-10-15 的新任务改为由 Astra、GLM 5.3、DeepSeek 自建 read/write/edit，创建并局部修改 Python 文件，逐次错误及输入协议见 [文件工具验证](codemode-file-tools-validation.md)。

## 1. 要解决的问题

上一版模型可以保存 module、注册内部工具和 hook，但不能仅通过读取一份定义，理解自己的 system prompt、工具说明、历史、提醒和循环行为是如何形成的。这些策略仍分散在 Pi 的 TypeScript 实现中。

目标是给模型一份小型、可执行的 agent 定义。例如，模型读到 `agent.yaml`，发现 system prompt 来自 `prompts/system.prompt`，工具目录来自当前 codemode 内部工具与 `rules/catalog.mjs`，循环纠正来自 `policies/loop.yaml` 和提醒模板。它能沿引用继续读取，并准确找到要修改的地方。

这份定义必须是运行依据。只导出一份说明文档、只开放追加 prompt 的 setter，或让模型修改 Pi 源码，都不满足这个目标。

## 2. 已确定的边界

1. **模型 API 的顶层工具始终只有 `codemode`。** 新定义的是 codemode 内部可调用的工具。它们不进入 provider 的顶层 `tools`，也不能被模型直接发起顶层 tool call。
2. **Harness 与任务执行环境使用独立接口。** `host.harness` 访问自身定义；文件、进程等任务能力走执行环境接口。两者可以位于不同进程或机器。
3. **Harness 编辑直接复用 Pi 原生 read/write/edit。** 模型通过 `host.harness.read/write/edit` 调用这些能力，不必先基于 `host.fs` 编写并注册编辑器。这三个入口不是新增的顶层工具。
4. **定义文件管理内部工具和 hook。** 模型不再调用 `host.modules.put`、`host.tools.register/unregister`、`host.hooks.register/unregister` 或 `host.registry.apply` 修改第二套注册状态。加载生效定义后，宿主构造执行索引。
5. **新增与修改已有行为使用同一机制。** 默认 prompt、组织规则、循环提醒及其生成逻辑，也必须是可读取、可编辑的定义。
6. **保存与生效分离。** 编辑发生在草稿中，完整候选版本通过显式激活生效。运行中的调用、会话恢复和分支切换有确定语义。
7. **上下文组织属于可编辑策略。** 展示哪些内部工具、描述粒度、分组和预算均可改变；3000 token 是目录的默认预算。

顶层 codemode 按 provider 能力选择输入协议：支持 free-form/custom tool 的模型默认提交 JavaScript 原文，包括编写 module、文件内容和编辑文本的调用；按普通 JavaScript 语法使用字符串和对象，无需 JSON 包装或 data。同一个入口仍接受显式 JSON 对象 `{code,data?}` 或 `{finish}`。其他模型使用 function tool 的 JSON 输入。JSON 输入中的 code 与 finish 只能选一个；原文调用没有额外 data。适配层只解码一层明确的 JSON 对象，不猜测文档转义；历史回放保留 data/finish 的完整参数。

对于 JSON 调用，推荐 `code` 负责调用与控制，文件内容、module 源码、prompt 文本及编辑 oldText/newText 放进 `data`，通过外层 `data` 绑定读取，避免在 JSON 内再叠一层 JavaScript 字符串编码。free-form 调用直接在 JavaScript 中编写这些值。结构化定义和映射用对象表示，在写入文件时序列化；`.yaml` 文件也接受 JSON。最终答案可以直接作为正常助手文本输出，也可以放进 `finish`，不要求模型把答案编码成 JavaScript 字符串。程序化完成仍可 `return loop.finish(value)`。无工具调用、正常结束且有正文的助手响应作为 `assistant_finish` 交给可编辑循环规则，默认接受；空响应或截断响应不能据此结束。这不增加顶层工具，也不改变 Harness 的草稿、验证和激活边界。

当前 `host.fs` 直接访问宿主真实文件系统，路径以会话 `cwd` 解析；它并不是 QuickJS 的独立文件系统，也没有工作区根目录限制。新增 `host.harness` 建立独立访问契约，不会自动把现有 `host.fs/process` 变成操作系统隔离环境。后续独立执行环境可以替换这些原子接口的后端，Harness 协议不随之改变。

协议由宿主按本次路由后的模型与工具声明确定，通过 `host.input-contract: {syntax,jsonEnvelope}` 传入 Harness。`rules/input.mjs` 选择对应的输入说明；模型只看到“提交 JavaScript 原文”或“通过 code/data 提交”，无需辨认 provider 协议。默认 guide 只进入工具描述，不再同时注入 system 或固定 guidelines。`policies/input.yaml` 提供参数说明，描述规则可以返回 `parameterDescriptions: {code?,data?,finish?}`；宿主只替换展示文本，参数类型和执行校验不变。无效 JSON 的错误只说明当前输入问题，不建议切换到另一种协议。

## 3. 模型看到的 agent 定义

### 3.1 文件集合

Harness 对外提供一个逻辑文件集合，不暴露其物理存储路径。一个版本可以包含：

```text
agent.yaml                     # 根定义：内容来源、组合方式、循环与压缩
prompts/
  system.prompt                # 默认角色与任务指引
  codemode.prompt              # codemode 操作指引
  input-javascript.prompt      # 本次支持原文输入时使用
  input-json.prompt            # 本次使用 code/data 时使用
  loop-retry.prompt            # 循环协议纠正文本
  loop-execution.prompt        # 执行失败恢复文本
  loop-exhausted.prompt        # 恢复预算耗尽的文本
  compact-system.prompt        # 摘要推理使用的 system prompt
  compact-initial.prompt       # 首次摘要指令
  compact-update.prompt        # 更新摘要指令
  compact-turn.prompt          # 分段摘要指令
  compact-branch.prompt        # 分支摘要指令
policies/
  input.yaml                   # 参数说明与可选 envelope 文本
  catalog.yaml                 # 内部工具目录的筛选、分组和预算
  history.yaml                 # 历史角色、摘要包装
  output.yaml                  # 输出排版与默认预算
  views.yaml                   # 展示类型到 handler 的映射
  loop.yaml                    # 循环规则的参数
  compaction.yaml              # 压缩触发、保留和摘要预算
rules/
  system.mjs                   # 组装 system prompt 的小函数
  codemode.mjs                 # 组装 codemode 描述
  input.mjs                    # 按本次宿主契约选择输入说明
  catalog.mjs                  # 内部工具目录的选择和渲染
  history.mjs                  # 历史呈现规则
  output.mjs                   # 输出排版规则
  views.mjs                    # 基础观察展示器
  loop.mjs                     # 解释结果并选择后续动作
  compaction.mjs               # 生成保留与摘要计划
tools/*.yaml                   # codemode 内部工具定义
hooks/*.yaml                   # 事件规则的绑定
modules/*.mjs                  # 内部工具和 hook 的实现
```

这里的 JavaScript 是输入输出明确的小程序，不导入 Pi 内部对象，不包含 provider 客户端或事件订阅样板。源文件存放在 Harness 定义中，与执行时使用哪套环境是两个维度。例如，文件读取工具的实现保存在 `modules/files.mjs`，执行时通过任务环境原子接口读取项目文件。

宿主另外提供只读参考资料：定义格式、原子接口契约、输入数据结构和当前宿主限制。默认定义会引用这些资料。模型可以修改说明的组织方式；编辑文字不会改变接口的真实签名或增加宿主能力。

全部 `host.*` 的 TypeScript 函数声明与入参校验由同一份 schema 生成，包括 Harness、内部调用和任务原子能力，返回结构也在声明中展示。调用无效时，在任何效果发生前一次报告全部 schema 错误，并附完整签名。内部工具的返回值不符合 outputSchema 时也报告字段级错误。这里的声明是注入接口的契约，不是要导入的模块，也不产生额外顶层工具。

首次运行与压缩后，模型都能取得一个很短的入口说明：本次请求使用哪个版本，根文件是 `agent.yaml`，在 codemode 中调用 `host.harness.read` 即可读取。它不需要先猜测文件路径或创建任务文件工具。

### 3.2 根定义示例

以下是随 npm 包和二进制分发的默认根定义：

```yaml
format: pi-harness/v1
context:
  system:
    render: rules/system.mjs#compose
    inputs:
      base: { file: prompts/system.prompt }
      project: { source: project.instructions }
      skills: { source: project.skills }
      environment: { source: environment }
      userPromptConfig: { source: user.prompt-config }
      external: { source: external.contributions }
  history:
    render: rules/history.mjs#project
    inputs:
      history: { source: session.history }
    options: { file: policies/history.yaml }
codemode:
  description:
    render: rules/codemode.mjs#describe
    inputs:
      input:
        render: rules/input.mjs#describe
        inputs:
          contract: { source: host.input-contract }
          javascript: { file: prompts/input-javascript.prompt }
          json: { file: prompts/input-json.prompt }
        options: { file: policies/input.yaml }
      guide: { file: prompts/codemode.prompt }
      api: { source: host.api-reference }
      views: { source: codemode.views }
      nestedTools:
        render: rules/catalog.mjs#render
        inputs:
          tools: { source: codemode.tools }
        options: { file: policies/catalog.yaml }
  tools:
    definitions: [tools/*.yaml]
  hooks:
    definitions: []
  output:
    render: rules/output.mjs#render
    options: { file: policies/output.yaml }
    views: { file: policies/views.yaml }
loop:
  decide: rules/loop.mjs#decide
  options: { file: policies/loop.yaml }
  reminders:
    retry: { file: prompts/loop-retry.prompt }
    execution: { file: prompts/loop-execution.prompt }
    exhausted: { file: prompts/loop-exhausted.prompt }
compaction:
  plan: rules/compaction.mjs#plan
  serialize: rules/compaction.mjs#serialize
  merge: rules/compaction.mjs#merge
  options: { file: policies/compaction.yaml }
  prompts:
    system: { file: prompts/compact-system.prompt }
    initial: { file: prompts/compact-initial.prompt }
    update: { file: prompts/compact-update.prompt }
    turn: { file: prompts/compact-turn.prompt }
    branch: { file: prompts/compact-branch.prompt }
```

初版语言只需要少数构造：

| 构造 | 含义 |
|---|---|
| `file` | 读取同一个定义版本中的文本或配置文件 |
| `source` | 取得有类型、有来源记录的运行数据 |
| `render`、`decide`、`plan` | 调用定义包内模块的命名导出；各位置规定输入输出类型 |
| `inputs`、`options` | 显式连接输入和配置，便于读取与追踪 |
| `definitions` | 加载内部工具或 hook 定义；不扩大顶层工具集合 |

文件引用统一相对于定义包根目录。根定义必须能解释完整依赖关系。工具 glob 按路径排序，重名报错；hook 用显式有序路径列表，执行顺序不依赖异步加载的完成顺序。引用缺失、依赖循环、未知字段或无效导出在 prepare 时报告。

普通修改落在文本和配置上；复杂选择逻辑才需要修改小函数。文件名是可理解的入口，不是固定的可编辑对象名单，根定义可以引用新增文件。

例如 `policies/catalog.yaml` 的初始内容可以是：

```yaml
select: all
detail: summary
groupBy: module
budgetTokens: 3000
```

这些值是 `rules/catalog.mjs` 的输入，不是散落在 Pi 中的另一套固定设置。模型可以改参数，也可以替换解释这些参数的规则。

### 3.3 输入与输出契约

宿主提供的数据应描述 agent 的直接工作对象：

| 输入 | 内容 |
|---|---|
| `session.history` | 当前分支的消息、摘要、稳定条目 ID 和已有呈现修改；合法消息组另由 compaction.plan 接收；不含定义文件全文 |
| `codemode.tools` | 所选定义快照派生的内部工具名称、描述、schema、分组与版本；候选预览使用候选集合 |
| `host.input-contract` | 本次实际工具声明的输入形式 `{syntax:"javascript"或"json",jsonEnvelope:boolean}`；路由后生成，不依赖会话选择的虚拟模型 |
| `codemode.views` | 本次快照的 `{definitions,handlers}`，包含映射文件路径与实际 view 名称、handler 引用 |
| `project.instructions`、`project.skills` | 已加载的项目材料及其来源；读取这些输入不意味着可通过 Harness 编辑其工作区原件 |
| `environment` | cwd、模型上下文容量等构造上下文所需的事实 |
| `user.prompt-config` | 用户设置的 system/append prompt 及其来源 |
| 事件与状态 | 本次循环结果、纠正次数、调用结果、显式持久状态及来源 ID |

运行输入与定义版本分开：工具使用记录或会话内容变化不要求创建一个新的定义版本。每次请求固定一份输入快照，供实际构造、预览和来源追踪使用。

上下文规则输出有名字的 system 内容块、codemode 描述、消息引用或变换，以及提醒的文本、实际角色、插入位置和作用范围。历史默认按现有 Pi 行为呈现；模型修改的是下一次请求的呈现规则，原始会话记录保留。

例如，system 组合函数可以只操作这些直接输入。下面仅示意函数边界，完整默认规则还需承接当前 Pi 的其余内容：

```javascript
export function compose({ base, project, environment }) {
  return [
    { id: "preamble", text: base },
    { id: "project_context", text: project.map(file => file.content).join("\n\n") },
    { id: "cwd", text: environment.cwd }
  ];
}
```

宿主负责将这些块变成请求中的 system 内容，记录输入到输出的来源；函数无需处理消息存储、provider 类型或网络协议。

循环规则输出结构化决策，例如继续、结束、追加纠正提醒或报告协议错误。压缩规则输出保留哪些消息组、摘要哪些范围、使用什么 prompt 与预算；摘要请求由宿主执行。模型无需编写调用 LLM 的网络代码。

上下文渲染与 prepare 使用无外部副作用的规则执行环境：只接收声明的输入和配置，不开放文件写入、进程、注册变更或递归模型调用。工具和事件 hook 使用各自的执行接口。规则仍用现有 QuickJS 机制执行，保留取消与资源限制。

### 3.4 解释当前上下文

模型需要同时看到“定义是什么”和“本次请求实际由什么生成”。来源追踪应能返回：

```text
request q42 / harness r17 / inputs s93
  system.preamble
    ← prompts/system.prompt @ r17
    ← rules/system.mjs#compose @ r17
  codemode.description / Nested tools
    ← policies/catalog.yaml @ r17
    ← rules/catalog.mjs#render @ r17
    ← codemode.tools @ r17
  reminder loop-retry
    ← loop.decide @ r17
    ← prompts/loop-retry.prompt @ r17
    ← turn result e126：缺少有效循环决策
```

预览还要报告完整文本、展示与省略的条目、token 用量以及相对上个版本的差异；无法精确计数时标明估算。追踪以内容块和消息为单位，不要求逐 token 记录。

“System reminder”是用途，不自动意味着 `system` 角色。当前 Pi 的循环纠正使用 custom message，随后转换为 `user` 消息；迁移时必须显式表达这一行为。

### 3.5 数据、观察与循环决策

工具返回 `{source, size}` 时，代码需要完整数据，模型需要正文。默认递归展开对象会重复展示元数据；源码经过 JSON.stringify 后又增加转义负担。

因此分开返回值、显式展示和循环决策：

```javascript
const info = await host.harness.inspect();
observe(info, {view: "harness.overview"});
const result = await host.harness.read({path: "agent.yaml"});
observe(result, {view: "pi.read"});
return loop.next();
```

底层 `observe(value,{view})` 只同步保存数据快照和 view 名称，返回 undefined，不推断对象类型、不修改原值、不决定循环。字符串和原始标量直接展示；对象或数组必须指定 view。缺失/未知 view 明确报告名称、可用类型和定义入口，不回退为递归 dump。

`agent.yaml` 的 `codemode.output.views` 引用 `policies/views.yaml`，其中每个名称映射到 `file.mjs#export`。handler 接收完整对象，返回字符串。例如原生 read handler 只执行 `return result.text`，正文和原生续读提示原样展示，其余元数据留给代码。默认预置 `harness.overview`、`harness.detail`、`pi.read` 和显式调试用 `debug.dump`；`harness.prepare`、`harness.edit`、`harness.status`、`harness.diagnostics` 分别展示候选预览与字面 diff、原生编辑结果、生命周期状态和诊断，不再要求把源码或补丁序列化成 JSON 观察。

模型可通过草稿、prepare、activate 编辑映射和源码。prepare 校验映射及可调用导出；handler 在纯规则 VM 中运行。输出布局 `codemode.output.render` 接收展示转换后的 text/image 项，继续控制排版和预算。两者使用请求版本，即使 controller 中 activate(now)，也从下一次请求生效。

默认 codemode 描述根据 `codemode.views` 展示当前名称，不把上述默认名称当成固定契约。固定 bootstrap 使用 `observe((await host.harness.read({path:"agent.yaml"})).text)`；删除或改名展示器不会破坏自举入口。内部 `host.harness.edit` 的说明只描述草稿、版本和原文件匹配规则，源码怎样进入 codemode 由输入说明统一负责。

展示异常是 `error.kind: presentation`、循环状态 `execution_failed`，不是 `missing_decision`。成功观察和已完成操作保留，不接受脚本的 finish；已提交副作用和成功脚本的 store 写入不回滚。恢复时可以重新观察已保存数据，不必重复工具操作。原始工具返回值始终不受展示变换影响。

`inspect()` 同时缩小返回范围：默认只返回版本、待生效状态、草稿元数据、文件目录、context 部分的 ID/字符数、来源依赖和 view 映射；不返回完整 prompt、codemode 描述或接口文档。`inspect({section:"system",id})`、`inspect({section:"codemode"})`、`inspect({section:"provenance"})` 查询实际保存的生成结果，定义源码继续用 read。

详情页返回 text、offset、totalChars、eof 和 next。默认每页 4000 个 UTF-16 代码单元，上限 12000，不拆代理对。next 是 null 或 `{cursor,limit}`，直接传给 `inspect(page.next)`。不透明游标把 requestId、section、id 和位置绑定在一起；续读不再接受手工拼接的 offset 或覆盖请求选择器。requestId 唯一标识请求，不等同于定义 revision；两次请求即使 revision 相同也不能混页。requestRevision 表示保存内容的版本，activeRevision 表示查询时活动版本。立即激活、loop.next、恢复及压缩不会重算旧内容；无效游标、未知或当前分支不可见的请求明确报错。

## 4. Harness 编辑协议

### 4.1 原生 read/write/edit 的复用方式

`host.harness.read/write/edit` 是固定的宿主入口。空的内部工具目录也不影响模型读取和修改自己的定义，避免“先造编辑器才能造第一个工具”的自举问题。

适配层复用 [read.ts](../src/core/tools/read.ts)、[write.ts](../src/core/tools/write.ts)、[edit.ts](../src/core/tools/edit.ts) 的实现和参数语义：

| 能力 | 保留的原生语义 | Harness 特有语义 |
|---|---|---|
| read | `path`、从 1 开始的行号 `offset`、行数 `limit`，截断和继续读取提示 | 读取指定快照或草稿中的逻辑文件 |
| write | `path`、`content`，创建或完整替换，自动创建父目录 | 只修改草稿 |
| edit | `path`、`edits: [{ oldText, newText }]`；所有替换匹配原文件、位置唯一且不重叠；返回 diff | 只修改草稿；保留原生 BOM、换行和匹配处理 |

包装层额外接受定义目标，统一返回 `{text,details,harness}`：text 是原生结果文本（包含继续读取提示），details 保留截断或 diff/patch，harness 标识版本、草稿修订及逻辑路径。模型无需处理 Pi 展示用的 content/structuredContent envelope。不能将 edit 简化成仅返回“成功”，否则模型无法检查实际 diff。

严格校验前复用原生 edits 容器归一化：接受编辑数组、单个编辑对象，或包含这两者的 JSON 字符串。只处理 edits 容器，不变更目标、版本或文档字符串，不支持猜测性反转义。oldText 应尽量短且在原文件中唯一；远距离变更可批量提交不重叠的替换，附近变更合并处理，不能让后一个替换匹配前一个替换的产物。

这些操作不通过 `ctx.executeTool("read")` 查找当前工作区 read，也不重新向模型开放 read/write/edit/bash 顶层声明。它们是 Harness 专用适配器，使用固定的 Harness 后端，调用记录归属 `host.harness.*`。

当前三个原生工具已有 `ReadOperations`、`WriteOperations`、`EditOperations` 扩展点，可以承接定义存储。但只设置一个不同的 cwd 不够：

- `execute` 会优先使用 `ctx.cwd`，不能传入项目上下文后意外覆盖 Harness 目标。
- [path-utils.ts](../src/core/tools/path-utils.ts) 的 read 路径修正仍访问本地文件系统，需要可替换解析或逻辑路径适配，不能探测任务目录作为回退。
- [file-mutation-queue.ts](../src/core/tools/file-mutation-queue.ts) 用宿主路径和 realpath 构造队列键；Harness 队列必须区分会话、分支、草稿和逻辑文件。
- 原生 read 的超长单行提示会建议 bash。Harness 适配不能建议通过任务 bash 访问定义；需要给出 Harness 可执行的诊断或继续读取方式。

复用编辑算法和结果语义，单独实现目标解析与存储。绝对宿主路径、`..` 逃逸和指向定义包外的链接不属于 Harness 文件协议。底层可用文件或对象存储，调用者不依赖存储方式。

### 4.2 草稿、候选版本与激活

已实现的管理接口如下：

```javascript
host.harness.inspect()
// -> requestId, requestRevision, activeRevision, pendingActivation, drafts, files, context, sources, views, viewDefinitions

host.harness.begin({ base: "active" })
// -> draft, baseRevision

host.harness.read({
  target: { revision: "request" }, // 或 { revision: "r17" }、{ draft: "d18" }
  path: "agent.yaml", offset: 1, limit: 100
})

host.harness.write({
  target: { draft: "d18" }, path: "prompts/system.prompt", content: "..."
})

host.harness.edit({
  target: { draft: "d18" }, path: "policies/catalog.yaml",
  edits: [{ oldText: "budgetTokens: 3000", newText: "budgetTokens: 1500" }]
})

host.harness.remove({ target: { draft: "d18" }, path: "tools/obsolete.yaml" })

host.harness.prepare({ draft: "d18" })
// -> revision, baseRevision, draftSequence, diagnostics, preview, diff
// preview.inputSnapshot 标识预览输入

host.harness.activate({
  revision: "r18", expectedActiveRevision: "r17", when: "next_request"
})

host.harness.cancelActivation({ revision: "r18" })
// 只取消仍处于 scheduled 状态的这个候选，不能撤回已经生效的版本
```

`inspect/begin/remove/prepare/activate/cancelActivation` 是定义存储与生命周期操作，不是任务环境的文件工具。`request` 指产生当前模型响应的请求所使用的版本，`active` 指当前已发布版本；二者在立即激活后可能不同，不能混为“最新”。

`begin()` 返回的完整 `{draft,baseRevision}` 句柄可直接作为 read/write/edit/remove 的 target，并直接传给 prepare/discard，无需丢弃字段后重新拼装。显式传入的 baseRevision 必须与草稿基准一致；仅 `{draft}` 也可定位已有草稿。激活仍通过 expectedActiveRevision 检查当前活动版本，避免覆盖并发变更。

prepare 在草稿的一个确定修订上捕获所有文件，校验格式、依赖、schema 和可调用导出，构造不可变候选快照。模块检查不执行工具动作，预览不实际生成付费摘要。实际摘要生成只能在执行计划时发生。

prepare 后继续修改草稿不会改变候选版本。激活指定候选，检查 `expectedActiveRevision`，冲突则返回错误，不覆盖新状态。无效候选不会部分更新 prompt、目录或内部工具。

### 4.3 两种生效边界

| 时机 | 语义 |
|---|---|
| `next_request`，默认 | 当前 controller 及其调用结束后，在下一次模型请求构造前统一切换；包括 `loop.next` 引起的推理 |
| `now`，显式选择 | 在 controller 的宿主调用边界发布新版本，随后由 controller 发起的新内部调用可以使用新版；本次已发出的模型请求保持原版本 |

`now` 用于“创建内部工具、立即调用”的链路，不允许热改正在执行的栈。每条已经开始的内部工具调用链固定 handler、嵌套调用解析和相关 hook 版本；未来请求的 system prompt、描述和提醒统一使用新版本。当前 controller 的控制返回按启动时契约解释，新循环策略用于后续调度。

一次只允许一个待生效切换；后续不同变更需要先取消它。挂起记录包含候选和预期基准；到达边界时再次检查，不因恢复或分支操作而盲目应用。`next_request` 返回的是 scheduled 状态，不能声称版本已经生效。若本轮 finish，没有下一次请求，则等待下一次用户输入或其他合法调度。

上下文规则在真实输入上仍可能失败。切换前必须对实际输入构造并验证完整请求；失败则保留原活动版本并报告来源。已经激活的规则若在后续输入上失败，停止该次请求构造，保留诊断和显式恢复入口；不能把旧 prompt 与新调用表拼在一起悄悄发送。

## 5. 内部工具和 hook 的文件表达

一个 `tools/read.yaml` 可以是：

```yaml
name: files.read
description: 读取任务环境中的文本文件
parameters:
  type: object
  properties:
    path: { type: string }
  required: [path]
outputSchema:
  type: string
handler:
  module: files
  file: modules/files.mjs
  export: read
```

`modules/files.mjs` 由模型编写，接收参数并直接返回数据，例如字符串或 `{text,size,eof}`。`host.tools.call` 收到相同的值；`outputSchema` 只验证该值，不做解包、拼接或转换。失败用异常表达，Pi 展示所需的 envelope 由宿主构造。文件属于 Harness；执行中的 `host.fs` 操作作用于任务环境。

prepare 将文件和导出解析为该候选版本内的不可变 handler 引用。保留明确的 module ID，作为 `host.state` 的默认命名空间；同一 module ID 不能指向冲突的实现文件。模型无需自己传代码 hash 或再调用注册接口。

新增匹配的工具文件并激活，即可通过 `host.tools.call({ name, args })` 调用。修改后激活用于替换；删除定义或移出加载范围用于撤销。未被目录展示的工具仍可调用，展示策略不决定调用权限。`host.tools.list/describe` 可保留为只读执行视图。

默认目录同时展示完整调用示例。`host.fs.stat` 等原子能力直接在 handler 中调用，不意味着存在名为 `fs.stat` 的内部工具。未知工具错误列出当前可用名称，并指出同名原子能力的直接调用方式。宿主注入在外层作用域，controller 可以正常声明 `const tools` 等局部变量。

hook 同样用文件表达 `id`、`event` 和 `handler`。先承接现有 `tool_call`、`tool_result`、`agent_start`、`agent_end` 四类事件；绑定顺序来自根定义。上下文与循环规则采用前述专用输入输出契约，不能靠一个任意事件对象把 Pi 的整个 ExtensionAPI 暴露给模型。

默认定义包的内部工具与模型 hook 集合为空。原生 read/write/edit 只用于 `host.harness` 的固定编辑入口，不能在工具定义中引用一个原生 read/bash 名字，重新获得预置任务工具。

宿主可以复用现有嵌套调用基础设施做参数校验、取消、结果 hook 和执行记录，但内部工具不得被普通 `setActiveTools`、tool search 或 allowlist 自动提升为顶层声明。即使内部实现暂时借用 Pi 的注册表，定义快照仍是唯一事实来源，候选执行集合必须与 provider 声明集合分开。

## 6. 如何把当前 Pi 变成这种表达

### 6.1 当前实现与目标位置

下面区分需要迁出的策略和继续复用的执行机制。目标路径是上文定义包内的逻辑路径，不是要求模型编辑左列的 Pi 源码。

| 当前位置与行为 | 目标表达 | 宿主继续负责 |
|---|---|---|
| [system-prompt.ts](../src/core/system-prompt.ts)：默认角色、rules、docs、project context、skills、cwd 的组装 | `prompts/system.prompt` 与 `rules/system.mjs`；各段有稳定 ID 和来源 | system 内容块的合法性、编码与请求提交 |
| [resource-loader.ts](../src/core/resource-loader.ts)：加载 SYSTEM.md、APPEND_SYSTEM.md、项目指引和 skills | 有来源的 `user.prompt-config`、`project.instructions`、`project.skills`；根定义明确使用方式 | 资源发现、外部输入读取和来源记录 |
| [codemode/tool.ts](../src/extensions/codemode/tool.ts)、[api.ts](../src/extensions/codemode/api.ts)：固定描述、guidelines 与注册教程 | `prompts/codemode.prompt`、`rules/codemode.mjs`，引用只读接口契约；新增可编辑 Nested tools 生成规则 | 顶层 codemode 的实际 schema、代码/数据与 finish 输入协议、宿主接口实现 |
| [codemode/index.ts](../src/extensions/codemode/index.ts)：单 controller 检查、恢复、提醒、turn_end continuation | `rules/loop.mjs`、`policies/loop.yaml`、三份提醒模板 | 在执行前拦截非法批次、取消、事件投递、控制值校验和调度 |
| [codemode/execute.ts](../src/extensions/codemode/execute.ts)：输出排版、截断、错误说明、finish 映射 | `rules/output.mjs` 将观察数据转换为模型内容，`policies/output.yaml` 定义预算和布局选项 | observe 数据快照、QuickJS 执行、截断、错误诊断、流和图片资源、结果落盘、已选择动作的执行 |
| [codemode/runtime.ts](../src/extensions/codemode/runtime.ts)：module hash、注册表、四类 hook、state、custom entry 恢复 | module/tool/hook 文件与快照激活；state 独立保存 | handler 执行、schema 校验、资源清理、状态存储 |
| [agent-session.ts](../src/core/agent-session.ts)：初始 prompt、下一轮刷新、loadout、forced prompt 和隐藏声明投影 | 每次请求只消费一份定义快照和一个 ContextPlan | 会话协调、用户输入、模型路由、请求边界 |
| [session-manager.ts](../src/core/session-manager.ts)：分支、compaction、context edit 与上下文投影 | `session.history` 输入与可编辑的 history/compaction 策略 | 原始事件、分支 ancestry、稳定 ID、快照和状态持久化 |
| [messages.ts](../src/core/messages.ts)：custom、branch summary、compaction summary、bash 结果的文本包装 | 提醒/摘要模板与 `rules/history.mjs` 中的呈现规则 | 合法消息类型转换、工具调用与结果关系 |
| [compaction.ts](../src/core/compaction/compaction.ts)、[utils.ts](../src/core/compaction/utils.ts)、[branch-summarization.ts](../src/core/compaction/branch-summarization.ts) | 压缩/分支摘要的 prompt、保留策略、预算、历史序列化策略与摘要合并规则 | 合法切分检查、摘要请求执行、usage、取消、失败后不提交无效检查点 |
| [settings-manager.ts](../src/core/settings-manager.ts)：默认压缩参数及覆盖 | 初始有效策略导入 `policies/compaction.yaml`，来源与宿主上限单独记录 | 用户配置读取与外部限制 |
| [agent-loop.ts](../../agent/src/agent-loop.ts)：prepare、推理、工具执行、事件和队列 | 被解释器选择的上下文与后续动作 | LLM 传输、流解析、重试、调度与中断 |

### 6.2 先把固定文本和纯策略移出宿主

第一步要盘点每一段模型可见内容，建立“现有函数/常量 → 定义文件 → 请求中的位置”映射。默认 system prompt 不只有一段角色文字；只搬 `preamble` 会遗漏 rules、文档提示、项目内容、skills 和 cwd。

为每种规则提供窄输入，把当前策略抽取为定义包内的小函数。不要把 `buildSystemPrompt` 整段代码连同 Pi imports 搬进 module，也不要把 `native: pi.defaultPrompt` 当作迁移完成。模型必须能继续读到有意义的组合逻辑。

资源发现可以继续由宿主执行，但输入进入上下文的选择与排版必须可见。例如，Pi 当前根据工具可见性决定是否显示 skills 提示，这是一条上下文策略，应由默认规则表达，不能留作无来源的隐藏分支。

用户提供的 SYSTEM.md、APPEND_SYSTEM.md 和项目指引保持独立来源。模型编辑 Harness 的组合逻辑或自己的 prompt 文件，不应通过同一个编辑操作覆盖这些外部原件。导入初始有效配置后，应记录其来源；后续 reload 或用户覆盖也要生成可观察的输入变化，不能无声地覆盖模型保存的定义。

### 6.3 在“每次请求”接入，而不是只接 before_agent_start

当前 `before_agent_start` 在用户发起一轮运行时处理 prompt。一次 `loop.next` 引起的新推理不等于一次新的用户运行，因此仅增加这个 hook 无法实现下一次推理生效。

现有关键入口是 `AgentSession._installAgentNextTurnRefresh`、`_preparePromptAndToolLoadout`、`_installAgentRequestProjection`，以及 core loop 的 `prepareNextTurnWithContext`、`prepareRequest`。还要处理 SDK 的 `context` handlers 和最后的消息转换。

目标请求构造顺序为：

```text
收取本次合法输入与已完成调用结果
  → 解析当前分支的活动版本/待生效版本
  → 固定候选版本和输入快照
  → 由该版本的策略决定历史保留、必要压缩和提醒
  → 执行必要的摘要计划，得到候选检查点和历史输入
  → 生成 system、codemode 描述、历史与提醒
  → 校验消息关系、顶层工具集合和上下文容量
  → 提交版本切换、检查点与本次请求来源记录
  → provider 适配与推理
```

现有 prepareRequest 会重新从 `SessionManager.buildSessionProjection()` 取得 canonical context。新投影必须接入这一权威路径，不能在更早阶段改一次 messages，随后被它覆盖。模型路由若改变容量或触发重新压缩，也要沿同一条构造路径刷新输入。

候选版本需要压缩时，先计算候选检查点，不提前覆盖活动会话投影。整体校验成功后再提交可恢复的一致状态；失败时保留旧版本与旧投影。已经发生的摘要请求及其成本如实记录，不因候选失败而假装没有执行。

system prompt、工具描述和 executable bindings 必须指向同一个有效快照。已有 system sections 和工具声明 delta 可以继续用于记录，但不能使实际 provider 请求落后于定义。

当前 forced prompt 投影只改变请求、不记录完整替换文本，隐藏声明投影又会过滤历史中的工具变化。这些机制需要纳入统一来源记录，防止出现“session 日志能解释一套内容，provider 实际看到另一套内容”。

### 6.4 将运行时注册改为从文件加载

复用当前 runtime 的模块验证、不可变代码引用、执行 VM、state 和取消机制。新的加载器从快照生成内部工具/hook 集合，再整体发布。

移除模型可写的 module/registry API，更新 `api.ts` 和默认教程，避免两套定义来源并存。Pi 内部的 `pi.registerTool` 可以暂时作为执行适配细节，但它不能再承担模型定义的持久化事实，也不能产生新的顶层工具。

现有 `_executeNestedToolCall` 每次从当前全局 callable 集合取实现。仅保留旧 module 字符串不足以保证整条调用链版本一致；需要让嵌套执行器接收调用链固定的工具/hook 快照，继续复用 `runToolCall` 的校验、取消和记录。

删除或替换不应立即销毁仍被调用或历史版本引用的代码。执行索引通过差异更新或整体替换构建，物理版本清理由引用关系决定。避免用不断追加 hidden tombstone 工具模拟永久撤销。

本设计不保留旧写接口，也不要求兼容旧 `codemode-runtime` 会话格式。新格式会话作为恢复验收基线；遇到旧实验状态要明确报告格式不兼容，不能静默丢弃后假装恢复成功。若以后需要迁移已有成果，应另行定义显式导入，不能通过保留两套运行时写接口处理。

### 6.5 提醒、历史和压缩也要有可读来源

保留 next/finish 控制值，但执行失败和协议错误必须分别处理。例如 handler 抛错后没执行到 `return loop.next`，应提示修复该异常及检查已完成的副作用，而不是说模型忘了驱动循环。

宿主向 `loop.decide` 提供 `{outcome,state,reminders}`。outcome 明确区分 `next`、`finish`、`assistant_finish`、`execution_failed`、`missing_decision`、`invalid_batch` 和 `invalid_tool`，并携带调用 ID、结构化错误、已完成操作及效果记录。assistant_finish 携带正常助手最终正文 text，规则可以接受或要求继续；空响应和截断响应仍归 missing_decision。state 是规则自己维护的 JSON 状态，每次 agent run 从 `{}` 开始。规则返回 `{action:"accept"|"continue"|"stop",state,reminder?,text?}`，可以直接生成提醒文本。提醒名称及模板由根定义提供。

默认策略分别允许三次执行恢复与三次协议纠正；有效 next/finish/assistant_finish 重置计数。错误、恢复策略、预算和提醒都有可读来源。宿主不自动重跑脚本，已完成的外部操作和 Harness 修改不回滚。模型可以替换计数和恢复逻辑；宿主仍负责控制值验证、批次拦截和调度。

`messages.ts` 中的摘要前后缀、custom message 的实际 role、历史呈现规则，以及压缩代码中的首次/更新/分段摘要 prompt 都需要迁移。工具结果序列化时当前还有 2000 字符截断策略，它也属于模型应能理解的内容选择策略。

压缩的默认参数来自当前有效设置，而不是硬编码复制一次默认值。当前基础默认是 reserveTokens=16384、keepRecentTokens=20000，但存在按 provider/model 配置的覆盖值。合法消息分组、拒绝截断摘要等执行校验留在宿主；保留什么、摘要如何组织、分配多少预算由定义决定。

当前压缩的文件追踪只识别 read/write/edit 名称。新增 `host.harness.read/write/edit` 后需要携带目标域，不能把 Harness 编辑算成项目文件变更；模型内部工具的文件效果也不能仅凭一个自定义工具名字推断。

### 6.6 与原生扩展、SDK 和模型路由的衔接

现有原生扩展可以修改 system prompt、context、工具结果和 continuation。它们是迁移中最容易遗漏的内容来源。

原生扩展继续存在时，必须登记其贡献顺序、输入输出与来源，作为根定义可引用的外部贡献。它的 TS 实现可以暂时保持宿主所有，但不能让模型误以为所有贡献都能通过定义文件编辑。模型控制的规则必须迁出；尚未迁出的贡献在 inspect 中明确标记。

SDK 主动关闭 codemode 的路径不由本设计改造。pi-mih 的可编辑模式始终只声明 codemode。模型路由、凭证、provider 协议和网络重试继续由宿主执行，规则只看到影响上下文的容量等事实。

默认定义资源必须随 npm 包和编译后二进制分发，并通过 [config.ts](../src/config.ts) 的资源路径机制定位；不能依赖源码 checkout 或 `__dirname`。需要同步包资源清单与 `copy-assets/copy-binary-assets`，不要让二进制运行时找不到 `agent.yaml`。

## 7. 版本、恢复与上下文成本

定义快照、运行状态和请求呈现是三类记录：

- **定义快照**：文件内容、格式版本、模块引用、内部工具/hook、上下文与循环规则。
- **运行状态**：持久的 module 状态和调用记录；不因换代码默认清空。纠正计数只属于当前运行，重启不会续跑中断的循环。
- **请求记录**：使用的定义版本、输入快照、最终内容及来源；不能只存一个最终大字符串而丢掉组成关系。

会话持久化保存活动版本、待生效切换、草稿和状态变更。恢复与分支切换重建定义和状态，不重放文件写入、工具调用或摘要推理；进程、流和 VM 句柄不恢复。分支之间的未完成草稿不能互相覆盖。取消、崩溃或分支切换时，中断中的调用标记为中断，不自动续跑。

压缩只改变模型对历史的呈现，定义和状态不能依赖自然语言摘要保存。压缩后的下一次请求，从当前定义和内部工具集合重新生成目录。回滚定义不回滚外部文件或自动还原业务状态；改变状态结构要显式迁移，在旧调用排空后切换命名空间或状态版本。

上一版要求 codemode 描述固定，工具通过显式 list/describe 发现。新方案允许主动展示目录并编辑 system prompt，这会改变请求内容，可能影响缓存前缀。新的目标是：未变化的内容保持确定性；变化的内容由明确版本和来源解释。不能再把“所有请求的 codemode 描述完全相同”作为通过标准。

目录预算默认 3000 token；省略项、展示详细度、排序和分组都可查看和修改。能力长期存在与内容长期可见分开，模型主动选择隐藏工具时仍可通过内部目录查询发现它。

## 8. 建议实施顺序与验收

| 阶段 | 工作 | 完成条件 |
|---|---|---|
| A：默认行为可读 | 建立定义格式、默认文件、数据来源和解释器输出契约；抽取 system/codemode/循环默认策略 | 给定同一输入，默认规则可对照当前输出；每段内容能追到定义或明确的外部贡献 |
| B：专用编辑闭环 | 适配原生 read/write/edit，加入草稿、prepare、preview、activate | 模型能读取当前版本、编辑 system.prompt，下一次推理生效；失败候选不污染活动版本 |
| C：内部工具文件化 | 用定义文件替代模型注册 API，接入固定调用链快照与目录生成 | 新建、替换、撤销内部工具均无需 register；provider 始终只有 codemode |
| D：请求构造统一 | 接管初次请求和每次 next 的上下文构造，迁移 reminders/history/compaction 策略 | 恢复、压缩、分支与原生扩展贡献均可追踪；不存在遗漏的旧拼装入口 |
| E：二进制与模型验收 | 分发默认定义资源，执行真实模型任务并检查请求记录 | 从编译二进制完成下面的端到端任务 |

阶段 A/B 的窄闭环不代表整个 Pi 已经完成表达迁移。D 阶段完成前，inspect 和文档必须列出仍由宿主固定的上下文策略。

确定性验收使用现有 suite harness 与 faux provider，重点覆盖：

1. `host.harness.read/write/edit` 参数与 diff 语义、逻辑路径限制、取消、并发编辑，以及无 `host.fs` 后端时仍能编辑定义。
2. prompt、YAML、module 和工具定义一起 prepare；引用错误不会产生部分生效，检查后的草稿修改不会改变已保存候选。
3. `loop.next` 的下一次请求使用新 system prompt 和目录；实际 provider 请求、来源记录与内部执行集合一致。
4. 顶层只有 codemode；管理能力和生成的内部工具不会被自动声明为顶层工具。
5. 已启动调用及其嵌套调用/hook 固定旧版；新调用使用新版，撤销不会自动取消旧调用。
6. 压缩、恢复与分支切换保留定义和状态；外部效果不重放，待生效切换不跨错分支。
7. 与旧基线比较时区分有意变化：目录描述可变、定义文件化、管理接口可用；保留 next/finish、取消和结果关系的验证。

真实验收使用编译后二进制与 `zai-coding-cn/glm-5.3`、`opencode-go/deepseek-v4.1-flash`、`local-llm/qwen3.8-27b`、`openai/gpt-6-astra`。2026-10-15 起 GLM 改用非 Flash 版本；历史 Flash 结果单独保留，不计入当前 GLM 验收：

- 只给定义入口，模型能解释当前 system prompt、目录、提醒与循环来自哪里。
- 模型通过 `host.harness` 编辑一个已有 prompt 和一个目录策略，观察预览后启用，下一次请求呈现改变。
- 模型通过创建实现文件和内部工具定义，自行获得 README 读取能力；生效后在 codemode 内调用，观察内容，再介绍项目。不得预置任务 reader，不得调用旧注册 API，不得新增顶层工具。
- 经过压缩或重启后继续使用这项能力，能从目录或定义发现它；另测撤销和版本恢复。

每次真实验收记录最终 provider tools、请求内容、版本切换、嵌套调用与成本。沿用 [上一轮验证](atomic-codemode-validation.md) 的区分：明确要求创建工具的任务通过，不等于模型在简短任务中一定会自发复用或创建工具。

## 9. 实现对应与当前边界

实现入口：

- `extensions/codemode/harness/definition.ts`：逻辑路径、YAML/引用/导出校验、纯规则执行、默认资源加载。
- `harness/store.ts`：原生 read/write/edit 适配、串行草稿修改、不可变版本、激活和会话 journal。
- `runtime.ts`：定义派生的内部执行表、固定调用链、上下文生成、目录和请求来源记录。
- `harness/compaction.ts` 与 `AgentSession`：候选摘要检查点、历史投影、容量检查、提交以及摘要 usage 记录。
- `harness/defaults/`：实际可读可编辑的默认 agent 定义，随包和二进制分发。

已迁出的内容包括 system/codemode 文本和生成规则、目录选择与预算、历史呈现、循环纠正、输出排版与预算、压缩及分支摘要的保留/序列化/合并策略。native context 贡献在规则之后没有第二次覆盖机会；默认 system 规则显式处理其增加、替换与 section 修改。

仍由宿主负责：provider 传输、凭证、路由与重试，VM 资源与取消，最小入口提示和 codemode 实际输入 schema，结果截断/落盘/图片转换/执行错误诊断，原生扩展代码与外部资源发现。`inspect({section:"provenance"})` 的保存正文列出这些部分。token 预算使用字符数除以 4 的估算，不是 provider tokenizer 的精确值。

原生恢复命令 `/harness restore <revision|initial>` 在模型无法构造请求时仍可用。prepare 验证当前输入上的上下文渲染，不能证明规则对所有未来输入都正确；未来失败会停止请求并提供来源诊断。版本没有物理自动回收，已保存版本供回滚与分支恢复使用。任务文件/进程后端仍是宿主真实环境，尚未引入独立 OS 容器。
