# 配置说明

`copilot-relay` 的运行配置在：

```text
~/.copilot-relay/config.yaml
```

第一次启动时会从包内模板生成。此后加载时，relay 会保留已有文本、注释、键的顺序、
未知的扁平标量键及显式值，只为缺失的键追加默认值。写入基于检查过的文件快照
（snapshot），原子替换解析后的目标，因此符号链接本身不被替换，已检测到的并发编辑
不会被覆盖。升级不会把已保存的值迁移为新默认值。

仅支持扁平标量 YAML。已知键的无效值、重复键（包括别名）及不受支持的语法会在写回前
报错，文件保留原样供你修正。`webSearchBackend` 留空合法，不代表应清空其他设置。
热重载是**只读（read-only）**的，只接受稳定、有效且包含全部已落盘键的文档；编辑器
保存中的片段或空文件不会替换上一次有效的运行时设置。请补回缺失键，不要靠删除键来
恢复默认值。写入机制的保证见[内部实现](ZH-Internals.md)。

要看补齐默认值后的全部配置项及哪些需要重启，运行 `copilot-relay status`。这些是
**磁盘上**的值，不能证明 daemon 已经加载。配置损坏时，`status` 输出不回显敏感内容的
诊断并以 `2` 退出；`stop` 仍可根据已验证的进程身份尝试恢复。见
[日志与问题排查](ZH-Logging-Troubleshooting.md)。

## 示例

```yaml
host: 127.0.0.1
port: 4142
copilotBaseUrl: https://api.githubcopilot.com
claudeSetup: true
logLevel: info
logRetentionDays: 3
thinkEffort: max
upstreamTimeoutSeconds: 180
webSearchBackend:
claudeUpstreamApi: chat-completions
gptModel: gpt-6-astra
opusModel: claude-opus-5.5
```

## 字段说明

| 字段 | 作用 |
| --- | --- |
| `host` | 本地 Claude 兼容 HTTP 服务监听地址。建议保持 `127.0.0.1`，只允许本机访问。 |
| `port` | 本地端口，默认 `4142`。 |
| `copilotBaseUrl` | GitHub Copilot API 地址。必须是绝对的 `http://` 或 `https://` 地址，且不能包含账号密码。一般不要改。参见 [copilotBaseUrl 规则](#copilotbaseurl-规则)。 |
| `claudeSetup` | 为 `true` 时，`start` 会自动更新 `~/.claude/settings.json`。 |
| `logLevel` | 只能是 `error`、`info`、`debug`。`debug` 除有界日志外还会自动捕获完整的已观察请求/响应正文；启用前先看[日志与问题排查](ZH-Logging-Troubleshooting.md)。其他值会导致启动失败。 |
| `logRetentionDays` | 普通 relay 日志与 debug 捕获保留的本地日历天数，包含今天；正整数，默认 `3`。活动/未知捕获受到保护，清理规则见[日志与问题排查](ZH-Logging-Troubleshooting.md)。 |
| `thinkEffort` | 请求未指定时使用的默认推理强度：`low`、`medium`、`high`、`xhigh`、`max`。 |
| `upstreamTimeoutSeconds` | 单个 Claude 请求等待上游 Copilot 调用的最长秒数，默认 `180`；`0` 禁用 relay 的总超时。 |
| `webSearchBackend` | bridge-managed WebSearch 使用的 Copilot Responses 模型；留空使用 `gptModel`。 |
| `claudeUpstreamApi` | Claude 上游协议：`chat-completions`（默认）、`auto` 或 `messages`。不改变非 Claude 模型的路由。 |
| `gptModel` | 非 Opus 请求使用的上游模型。 |
| `opusModel` | 请求模型名包含 `opus` 时使用的上游模型。 |

## 选择 Claude 的上游协议

先按原规则选择模型（`opusModel` 或 `gptModel`）。如果选中的上游 ID 以 `claude-`
开头，再由 `claudeUpstreamApi` 决定协议：

| 值 | 行为 |
| --- | --- |
| `chat-completions` | 默认值。保留经翻译的 Copilot `/chat/completions` 路径。 |
| `auto` | 仅在当前上游的缓存模型目录公布了 `/v1/messages` 时使用该原生接口，否则走翻译路径。 |
| `messages` | 强制 Claude 模型走原生 `/v1/messages`，即使目录未公布支持；上游拒绝仍作为错误返回。 |

所有模式下，非 Claude 模型都根据目录选择 chat/Responses。当前提供方的
`supported_endpoints` 决定使用 `/chat/completions` 还是 `/responses`，新增模型 ID
无需加入代码名单。两者都公布时，保留已有偏好：GPT-5.5、GPT-5.6、GPT-6 Astra
系列优先 Responses，其他模型优先 Chat；目录的排列顺序不会改变选择。接口元数据
缺失或格式错误时，保留旧偏好并标为未验证；显式空列表表示没有公布可用接口。
其他协议和非聊天类型仍不受支持，这不等于账号没有权限。

Claude 的 `chat-completions` 固定使用 Chat；目录排除该接口时报告协议策略冲突，
不会静默切换。`auto` 未找到原生支持时按目录选择翻译接口；`messages` 仍显式强制
原生接口，即使目录信息不同。深度检查、启动 preflight 和真实配置目标请求共用
这些规则。只有非成功 HTTP 返回 `unsupported_api_for_model`，且目录（或缺失的
元数据）与协议策略均允许时，才可从 Chat 向 Responses 重试一次；其他错误、拒答
以及已发送部分内容的流不会触发接口切换。

原生传输保留带签名的 thinking、缓存标记、原位置的 system 角色与控制字段；不会为了绕过拒答或错误而悄悄改走
另一个 API。发布默认值仍为 `chat-completions`。2026-09-30 的小规模匹配合成试验在
`low` effort 下测得热回合按 token 加权的缓存读取率：chat 99.8384%，native 99.7980%，
相差约 0.04 个百分点。第二次为平衡执行顺序而让 native 先执行的试验，在其冷回合拒答后
停止；完成的那次试验不能证明广泛无退化或计费成本等价。这些是隔离检查，不是对当前
生产 relay 的验证，端口 4142 未受影响。方法与用量见[内部实现](ZH-Internals.md)。
仍未证明历史拒答是推理内容扁平化导致的。

原生 bridge-managed WebSearch 只支持自动选择。声明 WebSearch 时，`any` 或显式强制
搜索在检索/SSE 之前返回 HTTP 400 JSON，每回合最多一次搜索。确定性的 relay 标记让续接时能够还原原始、带签名的上游历史。
旧 chat bridge 历史与 native bridge 历史不能透明互换：已有搜索会话应继续使用原路由，
切换后开始新会话。协议边界而不只是模型可用性，详见[内部实现](ZH-Internals.md)。

## 选择模型和 thinking effort

### 列出可用模型

模型是否可用取决于 Copilot 账号、组织策略及配置的网关。要获取 relay 上游公布的
完整模型目录，运行：

```sh
copilot-relay models
```

该命令每次都会向配置的 `copilotBaseUrl` 发起认证的 `GET /models`，复用 relay 的
缓存凭据、token 刷新逻辑及 `upstreamTimeoutSeconds`。没有可用缓存凭据时，现有的
设备登录流程可能要求你完成认证。输出保留上游原始 ID，排序并去重，不会添加
`[1m]` 等 relay 别名，也不会只列出 `gptModel` 和 `opusModel` 配置中的模型。
为确保显示安全，终端控制字符会被移除，敏感网关 URL 的尾部会被脱敏；普通模型 ID
保持不变。
空目录会明确提示，退出码为 `0`；配置、认证、网络、HTTP、超时及目录格式错误时
退出码为 `1`。本地超时与上游真正返回的 HTTP 504 会使用不同提示。

Relay 未运行或配置的模型 ID 已不在上游目录中时，仍可使用此命令。它不会绑定端口、
执行启动预检或推理探测、改变所选模型，也不会修改 Claude 设置。与其他命令一样，
配置加载器仍会把补齐默认值后的配置写回 `config.yaml`，认证过程也可能更新 token 缓存。

**公布在目录中不等于已验证可用。** 目录条目不能证明推理请求一定成功，也不能保证
兼容 relay 请求、工具或某个 effort 档位。选好模型后，启动流程会检查配置的 ID 并
发送探测请求；`copilot-relay status --deep` 则通过正在运行的 relay 检查真实请求。
相比之下，`copilot-relay status` 显示配置的 relay ID；本地 `GET /v1/models` 还会在
目录提供数据时返回缓存的 `context_window`、`max_input_tokens` 和 `max_tokens`。
这两者都不会拉取上游目录。

如果需要交互式选择器及其提供的 effort 元数据，也可运行 GitHub Copilot CLI
（`copilot`），然后**在其交互会话中**输入 `/model`。请使用与 relay 相同的账号。
该选择只影响 Copilot CLI 会话，不会修改 relay 配置；自建网关公布的目录可能不同。
不要把 bearer token 粘贴到命令、日志或 issue 中。

### 测试模型可用性

普通目录列表不执行推理。深度测试必须显式启用，并且**会消耗真实 Copilot 用量**。
建议先选择准确模型，避免测试整个目录：

```sh
copilot-relay models --deep --model claude-opus-5.5
copilot-relay models --deep --timeout 20 --total-timeout 120
copilot-relay models --deep --model gpt-6-astra --effort low --max-tokens 4096
```

简洁表格显示 `MODEL`、`STATUS`、`TIME` 和简短的 `RESULT`，最后只汇总非零结果。
模型 ID 只显示一次；长 ID 换行而不静默截断。每次串行探测完成后立即显示一行。
`*` 表示目录没有公布 effort 或接口元数据，不代表相关能力已被验证。

TTY 输出中，PASS 为绿色、FAIL 为红色、INCOMPLETE 为黄色，SKIPPED/NOT_TESTED
使用弱化颜色。`status` 和 `status --deep` 对健康状态、上游检查和版本不匹配使用相同
策略。文字状态始终是判断依据，颜色不会改变退出码。管道和 dumb 终端默认无颜色；
`NO_COLOR` 或 `FORCE_COLOR=0` 禁用 ANSI；`FORCE_COLOR=1`（也接受 `2`、`3`、
`true` 或空值）可明确启用。`NO_COLOR` 优先。`status --json` 始终不带颜色。

深度命令的常规启动消息保留在日志文件中，不再挤占表格；必要的登录提示和启动错误
仍可见。不会打印探测响应文本、工具参数或原始异常。未通过的探测显示生成的
`request_id`，重复的下一步建议会去重。

需要每个探测的安全证据时，在本次调用中加入详情选项：

```sh
copilot-relay models --deep --model claude-opus-5.5 --details
```

详情包括计划/实际接口、`route_source`（`catalog`、`legacy`、`policy` 或
`unavailable`）、已知 `advertised_endpoints`、`unknown_endpoints` 数量、准确的发送/
报告模型 ID、有效 effort/输出上限、客户端/上游 HTTP 状态、完成状态、关联 ID 和
捕获状态。不会打印不可信的未知接口字符串。`SKIPPED` 表示没有发送推理请求。
只有完整且实际存在的私有捕获才会显示 replay 命令。
它仍然是**新的真实探测**，不是离线查看之前的失败；见[日志与问题排查](ZH-Logging-Troubleshooting.md)。

| 状态 | 含义 |
| --- | --- |
| `PASS` | 所选模型返回已完成的非空文本。不代表验证了工具、所有 effort 或答案正确性。 |
| `INCOMPLETE` | 生成未完成。预算耗尽时的正数输出用量只能证明上游可达，不能当作完整回答。 |
| `FAIL` | HTTP/认证/网络失败、超时、拒绝、异常输出、缺失或不匹配的模型 ID、上游以 `model_not_supported` 拒绝的已列出模型、已完成但为空的响应。 |
| `SKIPPED` | 目录元数据不支持 relay 所需的接口/effort、模型不是聊天模型，或 ID 不安全/不规范。 |
| `NOT_TESTED` | 总期限耗尽或中断，当前探测被停止或后续探测未发起；不计为模型失败。 |

测试范围为 **isolated relay pipeline; not running-daemon health**，即隔离 relay
处理流程，而非正在运行的守护进程健康检查。CLI 使用合成请求经过正常的进程内
Messages handler、翻译、上游客户端、token 刷新和响应翻译。每次串行探测仅在本进程
路由中选择准确上游 ID，结束后恢复状态。如果直接把每个 ID 发给运行中的 daemon，
它们仍会被映射到 `gptModel`/`opusModel`，造成虚假的逐模型验证。此命令不会绑定端口、
重启 daemon 或修改模型配置/Claude 设置。检查运行中 daemon 的配置路由请用
`status --deep`。

| 选项 | 默认值 / 行为 |
| --- | --- |
| `--model` | 默认测试全部公布的 ID；指定值必须准确匹配目录。需要 `--deep`。 |
| `--details` | 显示每次探测的安全证据及捕获/replay 可用性。需要 `--deep`，不会增加探测或重试次数。 |
| `--max-tokens` | 每次 4096，并受目录中的输出上限及原生非流式输出上限约束。 |
| `--effort` | 按 `low`、`medium`、`high`、`xhigh`、`max` 选择高于 `none` 的公布最低档；仅当 `none` 是唯一公布的档位时才使用它，因为 relay 自身从不发送 `none`，且部分模型公布了它却拒绝它。无元数据时使用标为未验证的 `low`。明确不支持 effort 时省略该字段（`effort=omitted`）；目录不支持的显式覆盖值会跳过。 |
| `--timeout` | 每个模型 30 秒，同时不超过正数的 `upstreamTimeoutSeconds`。 |
| `--total-timeout` | 探测阶段总计 300 秒；目录查询和认证发生在此预算之前。 |

数字选项只接受不超过 2,147,483 的正整数；所有探测选项都需要 `--deep`。即使配置禁用
上游超时，深度测试仍有自己的期限。缺少接口元数据会标为未验证，而非视为支持证据。
模型匹配会移除 relay 已知的 GPT context 后缀。仅在通过原生 `/v1/messages` 探测目录
ID `claude-opus-5.5` 时，还接受已观察到的 provider 拼写 `claude-opus-5-5`。仅在通过
`/responses` 探测目录 ID `gpt-5.6-sol-fast` 时，还接受 `gpt-5.6-sol`：该目录项是
`gpt-5.6-sol` 的 priority 服务层级，其回复报告基础模型。对于不带日期的目录 ID，还接受
该 ID 加一个 `-YYYY-MM-DD` 快照日期，例如 `gpt-5.5` 对应的 `gpt-5.5-2026-04-23`；
带日期的 ID 必须完全一致。配置和 `--model` 仍使用目录拼写，其他不匹配仍失败，包括其他
`-fast` ID，以及上游改由其他模型应答的别名，例如由 `gpt-4.1-2025-04-14` 应答的 `gpt-4`。认证可刷新 token，现有的有界重试可能产生额外调用，但不会新增逐模型重试循环。Ctrl+C 会中止当前
探测，并把后续模型标为未测试。仅这些诊断调用会抑制共享流程的原始日志，正常 relay
日志不受影响。

深度测试退出码：`0` 所选模型全部通过；`1` 选项、模型选择、认证或目录查询失败；
`2` 任何其他未通过结果或无模型；`130` 中断。普通 `models` 的空目录仍以 `0` 退出。

### 在同一会话中切换模型

默认 `claudeUpstreamApi: chat-completions` 下，配置的 Opus 路由使用 Chat Completions，
配置的 GPT 路由在模型需要时使用 Responses。每个新请求按当前模型选择器决定目标，
并从该请求的字段和历史中解析 effort。请求接入后，即使配置在响应或 WebSearch
各阶段执行期间发生变化，它仍保留原来的路由和 effort 快照。

`tests/integration/model-effort-switching.test.ts` 把 relay 实际返回的 JSON/SSE 内容
带入后续请求，在两个方向上切换模型，覆盖工具结果、长工具名、零参数工具、thinking
文本、消息级 effort 控制和翻译路径 WebSearch 后续对话。测试通过严格的模拟上游请求
检查目标模型、effort、输出上限、工具调用与结果配对，以及流的完整结束。这是对 relay
本地转换和测试中编码的线上格式不变量的离线验证，**不是实际 Copilot 接受度的证明**，
包括从另一模型保留下来的工具 ID；也不代表缓存命中率保持不变。

原生 Messages 的跨协议迁移不在这组测试覆盖范围内。应选择目标模型支持的 effort；
认证、限流、网络故障、上下文上限和上游拒绝仍可能使请求失败。relay 不会静默替换
模型或 effort 来掩盖这些失败。合并或构建修复不会更新已运行的安装版 relay；
需要另外更新并重启该运行时。

### 选择兼容的 effort

`thinkEffort` 是默认值，不再覆盖请求。初始 effort 按以下顺序使用第一个非 null 的值：

1. Claude Code 原生字段 `output_config.effort`。
2. 兼容旧客户端的请求字段 `reasoning_effort`。
3. `config.yaml` 中的 `thinkEffort`；未配置时使用发布默认值。

例如，即使配置为 `thinkEffort: max`，请求中的
`output_config: {"effort": "low"}` 仍会使用 `low`。请求字段缺失或为 null 时使用默认值。
`thinking.budget_tokens` 不是 effort 档位，不会被换算成某个档位。格式不正确的显式
effort 返回 `400`，不会静默改用默认值。若
`capabilities.supports.reasoning_effort` 为 `false` 或合法的空列表，或者格式正确的
`supports` 对象省略了该键，表示模型不支持 effort：省略隐式默认值，但显式请求（包括
`none`）在推理/SSE 前返回本地 HTTP 400 `relay_unsupported_effort`。Copilot 以最后
一种方式列出 `gpt-4o`、`gpt-4.1`、`claude-haiku-4.5` 等较旧的聊天模型，它们都以
`invalid_reasoning_effort` 拒绝任何 effort。已生效的消息级 effort 也算显式请求。
原生历史会转发控制字段，因此待生效或带 `clear_at` 的 effort 控制同样被拒绝，
不会静默丢弃。缺少 `supports` 对象，或 `reasoning_effort` 为 true、null 或格式错误时
表示未知，而不是不支持。
档位列表非空时，普通请求仍保留选定档位，上游拒绝仍是错误；relay 不会替换档位。

可以在 Claude Code 会话中途切换 effort，无需清空历史。消息级 system `output_config`
的唯一键为 `effort` 时，可使用 `low`、`medium`、`high`、`xhigh` 或 `max`。
最新 user 回合之前的最后一个标记决定当前档位；仅包含工具结果的 user 回合也算。
位于该 user 回合之后的标记要等下一个 user 回合才生效。旧标记可以保留不同档位，
不必改写原始历史。

在翻译为 chat/Responses 的路径上，relay 把当前档位映射到上游请求字段，保留 system
文本与顺序，省略没有文本、只有控制信息的消息。额外/未知控制键、格式错误的值、
消息级 `none` 或 `clear_at` 仍会在推理请求/SSE 之前返回 HTTP 400 JSON。
原生 Messages 保留初始设置和逐消息控制字段，由上游解释。见[内部实现](ZH-Internals.md)。

翻译路径的 JSON/SSE 及 WebSearch 各阶段均使用选定档位；请求接入后的配置热重载
不会改变它。原生后续调用保留控制历史，因此追加 user/工具结果回合时，待生效标记
可能开始生效。启动 preflight 为接受 effort 的模型验证配置默认值；明确不支持
推理档位的模型则不发送 effort，日志显示 `think_effort=omitted`，不会声称已验证
一个实际未发送的档位。
保持翻译后的消息前缀不变可避免不必要的历史变动，但请求级 effort 变化仍可能使上游
缓存失效。原生逐消息 effort 才是协议提供的缓存保持机制，见
[官方 effort 指南](https://platform.claude.com/docs/en/build-with-claude/effort)。

在 `gptModel`、`opusModel` 和已设置的 `webSearchBackend` 中，所有支持 effort 的
目标都应接受配置默认值。搜索检索仍需要 Responses 内置搜索操作；普通聊天模型
可用不代表支持搜索工具。配置默认值只接受 `low`、`medium`、`high`、`xhigh`、`max`。
旧配置值 `minimal`
会被规范化为 `low`，不是独立档位。缺少 effort 元数据表示“未公布”，不是“支持所有档位”。

`thinkEffort: none` 不是合法的 relay 全局默认值。它和其他格式错误的显式值都会在认证、
上游探测和配置写回之前报错：

```text
Invalid thinkEffort. Valid values: low, medium, high, xhigh, max. "none" is not allowed as a configured default.
```

错误的文件会保留原样，供你修正；relay 不会通过写入 `max` 隐藏无效值。缺失的键仍使用
发布默认值。无效的热重载会记录错误，并保留上一次有效的运行时设置；修正文件后正常重载
会恢复。

这一限制针对配置默认值，而不是请求覆盖值。对于 GPT-5.6 Sol 等支持它的模型，显式请求
中的 `none` 仍会原样传递。它不是“使用默认值”的指令。

2026-09-05 查询的实时目录显示，`gpt-6-astra` 和 `claude-opus-5` 都支持 `low`、
`medium`、`high`、`xhigh`、`max`；Astra 未公布 `none`。更高 effort 通常会以更多
延迟和 token 消耗换取更多推理。切换任意模型时应重新检查选择器，而不是假设所有模型都
接受 `max`。

### Opus 5.5 兼容性

全新安装使用 `opusModel: claude-opus-5.5`；已有配置保留保存的值，包括
`claude-opus-5`。修改前先运行 `copilot-relay models`：账号权限、组织策略和网关
可用性仍然适用。2026-09-23 的认证目录查询及隔离 relay 验证确认了准确 ID
`claude-opus-5.5`，以及 JSON/SSE、自动工具调用及工具结果续接、对话续接、
`low`/`max` effort 和 WebSearch 最终回答重组。目录公布了全部五种配置 effort；
relay 不会为该 Opus ID 添加 `[1m]` 后缀。WebSearch 检索仍使用 `webSearchBackend`
或 `gptModel`。

**2026-09-23 的验证使用翻译路径：** 该模型的 `tool_choice` 类型 `tool` 和 `any`
返回 HTTP 400，自动工具选择可用。该观察不是对原生 API 能力的测量。Relay 会保留
上游错误，不会把必须执行的工具调用静默改成 `auto`。原生 bridge 搜索的限制见上文。
这些是请求级能力限制，不能据此断定认证失败。

2026-09-30 的隔离检查使用真实 Claude Code 2.1.285，在原生路径上完成了两个模型回合的
`Read` → 工具结果 → `OK`。最初两次请求因不支持 `safeguards` 收到 HTTP 400，随后
Claude Code 自行降低了请求能力。Relay 没有剥离该字段或绕过安全控制。这只是有限的
兼容性证据，不是当前生产验证；缓存计数及重放证据见[内部实现](ZH-Internals.md)。

### 更新 relay 配置

修改已有的键并保留其他设置。macOS 或 Linux：

```sh
${EDITOR:-vi} ~/.copilot-relay/config.yaml
```

Windows PowerShell：

```powershell
notepad "$env:USERPROFILE\.copilot-relay\config.yaml"
```

在 macOS/Linux 上，可选用 **Mike Farah 的 `yq` v4** 切换 GPT 路由并保留你的 Opus
选择；直接用编辑器不需要额外依赖：

```sh
cp -p ~/.copilot-relay/config.yaml ~/.copilot-relay/config.yaml.bak
yq -i '.gptModel = "gpt-6-astra" | .thinkEffort = "max"' ~/.copilot-relay/config.yaml
```

确认另一个配置模型支持后再用 `max`。全新安装的默认组合为：

```yaml
gptModel: gpt-6-astra
opusModel: claude-opus-5.5
thinkEffort: max
```

这些键支持热重载。如需立即验证两条路由，先等待正在进行的工作结束，再运行
`copilot-relay restart`，或通过服务管理器重启（见各平台服务页面）。启动会发送少量真实
上游请求并消耗 token；`restart` 会以前台方式运行 relay。`status --deep` 只向 GPT
路由发送一次真实请求，不是对两条路由的完整验证。

已有安装会保留已保存的模型选择，升级软件包不会迁移这些值。如果启动报告 Astra 不可用，
请编辑已生成的 `config.yaml`，选择账号支持的模型，例如**目录中存在时**使用
`gpt-5.6-sol`，并设置兼容的 effort。Relay 会明确失败，不会静默回退。需要撤销修改时，
恢复 `config.yaml.bak`。

### 使用模型的完整 context 和输出预算

Relay 配置保留规范 ID `gpt-6-astra`。Relay 向 Claude Code 暴露
`gpt-6-astra[1m]`，向 Copilot 只发送 `gpt-6-astra`。`[1m]` 控制 Claude Code 的
context 计数，不能扩大上游容量。2026-09-09 查询的实时目录公布了：

| 模型 | 总 context | 最大 prompt | 最大输出 |
| --- | ---: | ---: | ---: |
| `gpt-6-astra` | 1,000,000 | 872,000 | 128,000 |
| `claude-opus-5` | 1,000,000 | 936,000 | 64,000 |
| `claude-opus-5.5`（2026-09-23 验证） | 1,000,000 | 1,000,000 | 128,000 |
| `gpt-5.6-sol` | 1,050,000 | 922,000 | 128,000 |

这些值来自模型发现，并非运行时代码写死的限制，也不是通过生产环境中的百万 token
请求测得。应在总窗口内为输出（包括推理）预留空间。Relay 不会截短输入，也不会扩大
客户端明确指定的较小输出预算。Prompt 是否真正符合限制，仍由上游判定。
本地 `/v1/messages/count_tokens` 仅供预算参考，不是计费。文本使用可用 tokenizer，
每张图片固定计入 4096-token 余量，不对其 base64/URL 数据做 token 编码、解码或拉取。
原生 usage 分别报告非缓存输入、缓存读取和缓存写入，单独的原生 `input_tokens` 不是
完整 prompt 大小。实测计数及分母定义见[内部实现](ZH-Internals.md)。

流式和完整 JSON 响应都可以使用模型的完整输出上限。
Opus 5.5 公布的原生非流式输出上限为 16,000 token；超过时 relay 会向上游请求 SSE，
再为 JSON 调用方缓冲完整结果。1M prompt 上限不代表 1M 输入加 128K 输出能够一起
放入 1M 总窗口。

已有 Claude Code 配置需要明确选择新身份：

```sh
CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000 claude --model 'gpt-6-astra[1m]'
```

也可以在 Claude Code 中输入 `/model gpt-6-astra[1m]`。`claudeSetup: true` 只在没有
主要模型覆盖项时写入默认模型；它会保留已有模型选择和 shell wrapper。如果 wrapper
固定了其他 `--model`，也需要修改。
应使用配置模型的准确身份，不要假设内置别名具有相同的客户端 context 预算。

如果发现的 GPT 窗口并非恰好 1M，自动设置会使用不带后缀的模型 ID，并将
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 初始化为实际窗口。否则 Claude 的 `[1m]` 后缀会覆盖
该数值设置。以上述目录为例，手动配置 Sol 时可运行：

```sh
CLAUDE_CODE_MAX_CONTEXT_TOKENS=1050000 CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000 \
  claude --model gpt-5.6-sol
```

PowerShell 中用 `$env:CLAUDE_CODE_MAX_OUTPUT_TOKENS = "128000"` 赋值；需要时同样设置
`CLAUDE_CODE_MAX_CONTEXT_TOKENS`，再运行对应的 `claude` 命令。数值应以你的模型目录
为准，不要照搬其他账号的容量。Claude 设置、shell 环境、自动压缩和上游限制仍可能约束
实际可用窗口；自动设置不会禁用压缩。详见 Claude 的
[context 覆盖规则](https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id)。

如果响应可能超过已保存的超时，请明确设置：

```yaml
upstreamTimeoutSeconds: 0
```

该设置会热重载，只移除 relay 的总超时。客户端取消，以及客户端、上游和传输层自身
的超时仍然有效。全新安装的默认值仍为 `180`，已有值不会被迁移。

### 推荐的自动压缩窗口

对于文档中的 **1M 上下文 Opus 5.5 / GPT-6 Astra 模型对**，建议先使用保守的
**800K 自动压缩窗口**，并保持自动压缩启用。这是留有余量的 relay 建议，不是实测
最优值，也不能保证消除 API 错误。上方注明日期的目录给 Astra 872K prompt 上限和
128K 最大输出；从 1M 总窗口预留 128K 后同样剩余 872K。800K 目标再留约 72K，
用于工具输出、压缩和 token 估算误差。客户端扣除自身输出/缓冲预留后，可能更早压缩。

对当前会话生效并保存到用户设置：

```text
/autocompact 800k
```

只对一次启动生效，不修改已保存的设置：

```sh
claude --autocompact 800k
```

等价的用户设置片段为：

```json
{ "autoCompactWindow": 800000 }
```

环境变量覆盖必须使用纯数字 token 数量：

```sh
CLAUDE_CODE_AUTO_COMPACT_WINDOW=800000 claude
```

`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 优先于命令、启动参数和已保存设置，不要在这个
环境变量中填写 `800k`。移除环境覆盖后，`/autocompact auto` 恢复模型调优的默认值；
`claude --autocompact auto` 仅对一次启动恢复默认。托管设置可能覆盖交互命令保存的值。
见官方[自动压缩窗口说明](https://code.claude.com/docs/en/model-config)
和[环境变量参考](https://code.claude.com/docs/en/env-vars)。

如果网关公布更低限制，应使用更小的值。选窗口时可参考上界：
`min(最大 prompt, 总上下文 - 计划输出预留) - 额外余量`，并按会切换到的模型中最严格
的限制计算。工具/图片输出大、或本地 token 估算不确定时，应增加余量而不是扩大窗口。
部分客户端模型接近 1M 的默认值（约 967K）可能已经超过网关 872K 的输入限制。
`[1m]` 和客户端窗口设置都不能扩大上游容量。不要通过禁用压缩解决问题，也不要为
应用此建议而自动重写现有设置。

## copilotBaseUrl 规则

`copilotBaseUrl` 会在加载配置时校验，不满足以下条件时启动会直接失败：

- **必须是绝对的 `http://` 或 `https://` 地址。** 相对路径（`/tenant/v1`）、只写主机名
  （`api.githubcopilot.com`）、以及其他协议（`ftp://`、`file://`）都会被拒绝。允许使用
  明文 HTTP，所以 `http://127.0.0.1:8080` 这类本地网关是合法值。
- **地址里不能带账号密码。** `https://user:password@host` 会被拒绝。上游 HTTP 客户端
  在真正发请求时本来也不接受这种写法，放行只会把一个清晰的启动错误变成一个难懂的
  请求失败。
- **不能直接写引号、尖括号、空白字符和控制字符。** 在日志里，正是这些字符标记一个
  URL 到哪里结束；地址里带上它们，之后就没法再把整条 URL 识别出来，尾部会原样打印
  出去。请改用百分号编码：`'` 写成 `%27`，`"` 写成 `%22`，反引号写成 `%60`，
  `<`/`>` 写成 `%3C`/`%3E`，空格写成 `%20`，制表符写成 `%09`。编码后的写法会被接受，
  并原样使用。值**前后**的空格或制表符只会被去掉，和其他配置项一样。

错误信息只说明是哪个字段、违反了哪条规则，不会把你配置的值重复出来——因为这条信息
可能出现在终端或日志文件里。

### 日志和 `status` 里会显示什么

如果 `copilotBaseUrl` 带有路径、查询参数或 fragment——比如
`https://gateway.example/tenant/abc123` 这样的自建网关——只会显示它的 origin：

```text
copilot base url: https://gateway.example (path/query/fragment hidden)
```

`copilot-relay status` 和 `copilot-relay status --json` 里的 `copilotBaseUrl` 一行同理；
`~/.copilot-relay/logs/` 中错误信息里出现的上游地址也一样，会写成
`https://gateway.example[redacted]`。

这么做是因为网关路径里可能带着 token，而日志文件恰恰是报问题时最常被要求附上的东西。
不带路径的地址（比如默认的 `https://api.githubcopilot.com`）会完整显示——它里面没有
需要隐藏的内容。

## 热重载与重启

会热重载（对改动之后开始的请求生效）：

- `logLevel`
- `logRetentionDays`
- `thinkEffort`
- `upstreamTimeoutSeconds`
- `copilotBaseUrl`
- `webSearchBackend`
- `claudeUpstreamApi`
- `gptModel`
- `opusModel`

需要重启：

- `host`
- `port`
- `claudeSetup`

`host` 和 `port` 需要重启，是因为 HTTP 监听 socket 已经绑定，运行中不能自动搬到新的
host/port。`claudeSetup` 只在启动时读取一次，改了它要等下次启动才生效。

每个通过接入检查的请求都会在读取正文前快照路由、协议模式、超时、搜索后端、effort
默认值及目录视图。重载只影响新请求，不改变活动回合的重试或后续调用。凭据是例外：
每次尝试都会读取实时刷新的 token。

改 `gptModel` 会改变新请求的上游路由，但不会重写 `~/.claude/settings.json` 中已有的模型或
token 设置。切换模型时应检查这些设置；自动设置只补充缺失的预算值。

## Claude Code 配置

当 `claudeSetup: true` 时，`copilot-relay start` 会把下面的配置写入：

```text
~/.claude/settings.json
```

内容类似：

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:4142
ANTHROPIC_AUTH_TOKEN=<dummy local token>
CLAUDE_CODE_MAX_CONTEXT_TOKENS=<发现的 GPT context 窗口>
CLAUDE_CODE_MAX_OUTPUT_TOKENS=<两个配置模型中最大的已公布输出预算>
```

这里的 token 是本地 relay 占位值。真正访问 GitHub Copilot 用的是
`~/.copilot-relay/` 里的 GitHub/Copilot token。
两个预算变量仅在缺失时写入；明确设置的较小值会被保留。Relay 会按实际路由到的模型
限制每个请求的输出预算，因此从 Astra 切换到 Opus 时，共用的客户端设置不会让请求
超过 Opus 的上限。若网关没有提供有效的限制元数据，启动日志会说明限制不可用，
并保留客户端的显式预算，而不是猜测容量。`claudeSetup: false` 时，请自行配置这些
客户端变量。
设置写入同样使用快照及原子替换；不会覆盖格式错误或已经存在的空设置文件，其他无关
值也会保留。

本地占位 token **不是网络认证**。Host/Origin 与 JSON content-type 检查减少的是浏览器
来源滥用，不能阻止任意网络客户端。请保持 loopback 监听，见[架构](ZH-Architecture.md)。

### 模型选择器只保留 Opus 和 GPT-6 Astra

使用 Claude Code **2.1.242 或更新版本**时，将以下示例合并到用户级
`~/.claude/settings.json`，保留已有 relay 连接、预算、权限、hooks 及其他设置：

```json
{
  "model": "gpt-6-astra[1m]",
  "availableModels": ["opus", "gpt-6-astra[1m]"],
  "modelPicker": {
    "options": [
      { "model": "opus", "label": "Opus" },
      { "model": "gpt-6-astra[1m]", "label": "GPT-6 Astra" }
    ],
    "replaceBuiltInOptions": true
  },
  "env": {
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5.5"
  }
}
```

示例使用 relay 默认模型对：`opusModel: claude-opus-5.5` 与 `gptModel: gpt-6-astra`。
请让 Opus 覆盖值与实际配置的上游 ID 保持一致。Astra 的客户端 ID 使用 `[1m]` 表示
发现的一百万 token 窗口；如果网关公布其他窗口，应在 `model`、`availableModels`
和 `modelPicker.options` 中统一使用 relay 暴露的不带后缀 ID。后缀只影响客户端
上下文计算，不能扩大上游容量。

`modelPicker` 用这两个具名选项替换内置列表，避免继续推荐实际没有独立路由的 Sonnet、
Haiku 或 Fable。Claude Code 仍可能显示 **Default** 和当前会话模型，因此不能保证界面
恰好只有两行。`availableModels` 是选择允许列表，也会过滤 picker 项；`model` 只决定
启动默认值。使用 `/model` 选择 Opus 或 GPT-6 Astra，也可用 `/model gpt-6-astra[1m]`
明确选择 Astra。

Picker 设置应放在用户级、托管设置或 `--settings` 中，不能放在项目/本地设置中。
此示例不能扩展托管允许列表；没有托管列表时，用户/项目/本地的 `availableModels`
数组可能合并。若希望有效模型对保持精确，应清理你有权修改的设置中的旧条目，并检查
托管限制。普通前缀匹配下，仅设置允许列表不会限制 **Default**；组织级强制限制还需
在托管设置中使用 `enforceAvailableModels`。见官方
[模型配置](https://code.claude.com/docs/en/model-config)与
[modelPicker 参考](https://code.claude.com/docs/en/settings-reference#modelpicker)。

显式 `--model`、导出的 `ANTHROPIC_MODEL` 或恢复会话中保存的模型都可能覆盖启动选择；
若模型没有变化，请检查 shell wrapper 和更高优先级的设置。`claudeSetup` 保留已有
`model`、`availableModels` 和 `modelPicker`，不会安装或重置这个列表。Claude Code 可能
将被排除的别名替换为允许的模型，因此应核对实际选择的模型，而不能假定被排除的别名
一定报错。示例为手动选择，不会改变正在运行的 relay。

## 运行时文件

```text
~/.copilot-relay/
  config.yaml
  github_token
  copilot_token.json
  logs/copilot-relay.2026-07-25.log   <- 当前文件，本地零点轮转
  logs/copilot-relay.2026-07-24.log
  captures/<local-date>/<request-id>/   <- 仅 debug；私有完整正文
```

`github_token` 是登录来源。`copilot_token.json` 是短期 Copilot bearer token
缓存和刷新元数据。
