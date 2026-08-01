# 内部实现

[架构](ZH-Architecture.md)里画出的那些边界，背后的精确机制都在这一页。本页面向任何
需要改动中继、又不想弄坏那些代价高昂才学到的东西的人 —— 无论是人还是编码智能体。

这里给出源码路径和符号名，方便检索。行号刻意不写：行号会过期，名字不会。

## 模块地图

```text
src/
  main.ts                     CLI 入口（citty）：auth、start、stop、restart、status
  server.ts                   Hono app、请求日志、health/root 接口
  start.ts                    启动序列与热重载接线
  stop.ts                     进程发现与关停升级
  restart.ts                  stop + start
  status.ts                   检测、健康探测、--deep、--json、退出码
  auth.ts                     GitHub device login 命令

  routes/claude.ts            POST /v1/messages、count_tokens、GET /v1/models

  claude/
    types.ts                  用到的那部分 Claude Messages 类型
    translate.ts              非流式 Claude <-> Copilot 翻译
    stream.ts                 Copilot chunk -> Claude SSE 状态机
    web-search.ts             由中继托管执行的 WebSearch
    web-search-stream.ts      resolveWebSearchStreamDecision
    tool-names.ts             Claude <-> Copilot 工具名规范化
    utils.ts                  共用翻译辅助函数

  copilot/
    client.ts                 认证 HTTP 客户端、重试、计时
    chat.ts                   chat 抽象、路由、think effort
    responses.ts              Responses API 翻译、prompt_cache_key
    types.ts                  上游 payload 类型

  lib/
    app-config.ts             readAppConfig()、写回、热重载
    config.ts                 配置文件管道
    defaults.ts               发布默认值
    paths.ts                  ~/.copilot-relay 布局，import 时解析
    auth.ts                   token 存储与刷新调度
    models.ts                 路由 + thinkEffort 校验
    preflight.ts              启动期上游验证
    lifecycle.ts              pid 文件、findRelayOnPort、findRelayProcessIds
    log.ts                    formatLogValue、轮转、保留
    redact.ts                 纯函数 URL/密钥脱敏
    claude-settings.ts        ~/.claude/settings.json 管理
    tokenizer.ts              count_tokens 启发式
    upstream-diagnostics.ts   上游错误上下文采集
    error.ts                  错误整形
    state.ts                  运行期状态
    version.ts                构建版本
```

## 配置解析、写回与重载

`src/lib/app-config.ts` 里的 `readAppConfig()` 解析配置，并把结果**写回**
`~/.copilot-relay/config.yaml`。由此产生了本代码库中最容易被误解的一点：

> 一个已有安装的每个键都已经落盘。那条路径上的 `?? defaultConfig.x` 兜底再也不会
> 被用到。

所以**修改发布默认值只对全新安装生效**。这是刻意的。用户配置里的值属于用户；不要
加迁移机制去把新默认值推给已有安装。曾经短暂存在过一个 `configVersion` 机制正是为
了这件事，后来在 #26 里作为不必要的复杂度被移除。

### 热重载与需要重启

热重载 —— 对改动之后开始的工作生效：

`logLevel`、`logRetentionDays`、`thinkEffort`、`upstreamTimeoutSeconds`、
`copilotBaseUrl`、`webSearchBackend`、`gptModel`、`opusModel`

需要重启：

`host`、`port`、`claudeSetup`

`host` 和 `port` 动不了，因为监听 socket 已经绑定。`claudeSetup` 在启动时读取一次，
所以改它在下次启动之前什么都不会变。改 `gptModel` 会立刻改变上游请求路由，但不会
重写已经保存在 `~/.claude/settings.json` 里的模型 —— 那是启动时写的。

一次重载会记录它应用了什么：

```text
info Config reloaded: logLevel=debug thinkEffort=xhigh upstreamTimeoutSeconds=180
```

新增一个键意味着同时更新 `config.default.yaml`、README，以及**两种语言**的
[配置说明](ZH-Configuration.md)。

## 请求翻译

`src/claude/translate.ts` 处理双向非流式 payload：Claude 请求 -> Copilot chat 请求，
以及 Copilot 响应 -> Claude 响应。它在两种协议形状之间映射 tool call 和
thinking/text block。

`src/claude/tool-names.ts` 在出站时把 Claude 工具名规范化成 Copilot 可接受的名字，
入站时再映射回来。Claude Code 的工具名不总是合法的上游标识符，而一个带着规范化后
名字的响应，与客户端注册的那个工具对不上。

`src/claude/types.ts` 只定义代理需要的那部分 Claude Messages API 类型。它刻意不是
完整的 Claude SDK —— 一个用不到的类型就是没有测试覆盖的维护成本。

## chat 与 Responses

`src/copilot/chat.ts` 是 routes 和启动 preflight 共用的内部 chat 抽象。它应用模型
路由、think effort 和请求日志，并为配置的 GPT 系模型选择 Copilot `/responses`。

`src/copilot/responses.ts` 在 Copilot Responses API 与 chat-completion 风格结果之间
翻译。它之所以存在，是因为 `gpt-5.6-sol`（默认 `gptModel`）以及
`gpt-5.5`/`gpt-5.6` 系列的其余成员在上游走 `/responses`，而 Opus 走
`/chat/completions`。

两个上游 API，一个面向 Claude 的协议。Claude Code 永远不会知道是哪一个服务了它的
请求。

## 流式

`src/claude/stream.ts` 把流式 Copilot chat chunk 转换成 Claude SSE 事件。它是一个
状态机，因为 Claude 要求 text、thinking、tool use 的 content block 按正确顺序显式
start/delta/stop —— 而 Copilot 的 chunk 流里没有这种分帧信息。

### 声明 WebSearch 不再需要放弃流式

Claude WebSearch 由中继托管执行：中继通过 Copilot `/responses` 加
`web_search_preview` 执行搜索，然后把检索到的上下文再送一次模型，最后返回 Claude
的 `server_tool_use` / `web_search_tool_result` block。最后那次调用保留客户端的其他
工具，所以模型可以在同一回合里对搜到的内容采取行动。

由此带来的问题是：中继必须先知道模型是否选择了 `web_search`，才能在普通补全和桥接
路径之间做选择。以前的做法是：只要请求**声明**了这个工具，就强制 `stream: false`
—— 而 Claude Code 每一个回合都会声明它，于是几乎所有流量都付出了"先缓冲补全、再回放
成合成 SSE"的代价。

`src/claude/web-search-stream.ts` 里的 `resolveWebSearchStreamDecision` 只把决策
阶段读到"足以判定是否会发生搜索"为止，并且边读边把消费掉的 chunk 发出去：

- **没有搜索** —— 这个回合和普通流式流没有区别
- **有搜索** —— 响应被累积起来，原样交给桥接路径

**文本永远不能作为判据。** Copilot 经常在调用工具之前先写一段开场白（"我这就去
搜索。"）。把已经出现的内容当成"不会有搜索"的证据，会让随后的 `web_search` 调用逃过
拦截，以一个名为 `WebSearch` 的**客户端** `tool_use` 抵达 Claude Code —— 这是一个
畸形回合，因为客户端认为这个工具本该由服务端执行。只有具名的 tool call 或
`finish_reason` 才能作数。`tests/unit/web-search-stream.test.ts` 固定了这一点。

当开场白已经流出之后才检测到搜索时，搜索 block 会接在已打开的那条消息上，而不是另
起一条，从而得到原生顺序 `text` → `server_tool_use` → `web_search_tool_result` →
`text`。

## Prompt 缓存

长时间的 Claude Code 会话每次请求都会重发一大段基本不变的前缀（system prompt、工具
定义、之前的回合）。这段前缀上的 prompt 缓存命中，是输入 token 成本和延迟的主要杠杆。
这里有两个承重的中继行为，都在真实 Copilot 上游上验证过。

### `/responses` 需要稳定的 `prompt_cache_key`

`gpt-5.6-sol` —— 以及其他只走 `/responses` 的模型，比如 `gpt-5.5`/`gpt-5.6` 系列的
其余成员 —— 只有在每个请求都带着稳定的 `prompt_cache_key`、把请求钉在同一个后端上
时，才会返回 prompt 缓存命中。没有这个 key，即使前缀逐字节相同，`cached_tokens` 也
会在多个回合之间随机掉到 0。

`buildResponsesRequestPayload` 派生一个按会话的 key：

- 优先使用客户端会话 id（Claude Code 会发送稳定的 `metadata.user_id`，在
  `payload.user` 上体现）；
- 没有 user id 时，退化为 system prompt 的哈希。

key 本身是一个 SHA-256 摘要（`cr-` 加 32 位十六进制字符），所以
`prompt_cache_key` 本身不会暴露它是从哪个标识符派生出来的。

**但这并不等于整个请求做了匿名化。**
`buildResponsesRequestPayload` 在设置 `prompt_cache_key` 的同时，还会单独设置
`user: sanitizeUserIdentifier(payload.user)`。`src/copilot/chat.ts` 里的
`sanitizeUserIdentifier` 只是把字符串截断到 64 个字符 —— 它不做哈希 —— 因此
Claude Code 发来的那个标识符会原样出现在同一个请求的 `user` 字段里转发到上游。
`/chat/completions` 路径也是同样的转发方式。

实践建议：把 `metadata.user_id` 当作 GitHub Copilot 会看到的值来对待，不要在里面
放密钥或个人信息。对缓存 key 做哈希保护的是缓存路由值，不是这个标识符。

端到端实测（`gpt-5.5`、稳定 user id、大前缀）：预热之后稳态 `cache_read` 命中约
100%，而没有 key 时是恒定的 0。`gpt-5.6-sol` 走同一条 `/responses` 路径和同一套
缓存 key 机制，因此行为一致。

在 `/responses` 系模型之间切换 `gptModel` 并不能换回什么缓存收益：
`/chat/completions` 系模型（例如 `gpt-5.4`）之所以能缓存，也只是因为它们的前缀稳定；
而 `gpt-5.5`/`gpt-5.6` 系列带上 key 之后能达到同样的命中率。

### assistant 的 `thinking` 保留在上游历史里

缓存命中依赖前缀在多个回合之间逐字节稳定。Claude Code 会在 assistant 历史里回放
`thinking` block，中继把它们作为上游 assistant 内容转发出去。

在转发前剥掉 `thinking` 会重写这段前缀，从而**让缓存失效**。在一个超过缓存阈值的
8 回合会话上实测：转发 `thinking` 时命中率约 99%（每回合 130 个全价 token）；剥掉之
后掉到约 88%、约 1066 个全价 token。

所以 `thinking` 是被**刻意**保留在上游历史里的。它是让前缀保持稳定的一部分，不是可
以顺手削掉的开销。

## Token

`github_token` 是长期登录/刷新来源。

`copilot_token.json` 缓存短期 Copilot bearer token 及元数据：

```json
{
  "refreshedAt": 0,
  "refreshIn": 0,
  "token": "..."
}
```

启动时，如果缓存的 Copilot token 还有超过 60 秒有效期就复用；否则用 `github_token`
刷新。刷新定时器必须使用 `unref()`，以免让短命的命令一直活着。

token 值永远不会被记录。生命周期日志只包含路径和调度信息。

## 生命周期：status 和 stop 问的是不同的问题

`src/lib/lifecycle.ts` 暴露两种检测策略，而**它们必须保持不同**：

| 命令 | 函数 | 策略 |
| --- | --- | --- |
| `status` | `findRelayOnPort` | 端口匹配时用 pid 文件，否则用端口监听检查。绝不做全局进程扫描。 |
| `stop` | `findRelayProcessIds` | 做全局扫描，因为清理任意端口上的残留进程正是它的目的。 |

不要把两者"统一"。给 `status` 加上全局扫描，会让它报告一个"端口上根本没人监听"的
中继（#33）；把 `stop` 收窄到单端口，则会留下残留进程。

无论 `status` 报告什么，**pid 和地址必须来自同一条记录**。把用一种方式找到的 pid 和
用另一种方式取到的地址配在一起，正是 #33 里"活的 pid 旁边打印出一个死端口"的成因。

### 退出码是一份契约

| 退出码 | 含义 |
| --- | --- |
| `0` | 进程活着**并且**健康探测通过 |
| `1` | 没有中继在运行 |
| `2` | 在运行但不可用 —— 健康探测失败，或请求了 `--deep` 且失败 |

一边打印 `FAILED` 一边以 `0` 退出，会让每一个脚本调用方把坏掉的中继当成正常
（#34）。

`--deep` 会额外经由 Copilot 发一个真实请求。它是唯一能证明中继真的可以服务 Claude
Code 的检查，因为 `/healthz` 和 `/v1/models` 都不访问上游。它是可选的，因为要花掉
一点 token。

### 关停：只调用 `server.close()` 关不掉

`server.close()` 会等待已有连接结束，而一个空闲的 Claude Code keep-alive socket 自己
永远不会结束。于是关停会一直挂着，直到 `stop` 升级为 `SIGKILL` —— 而 `SIGKILL` 会跳
过 pid 文件清理，并且照样把流切断（#35）。

处理函数必须立即调用 `closeIdleConnections()`，并在一个**短于 `stopProcess` 的 5 秒
超时**的宽限期之后调用 `closeAllConnections()`。宽限期等于或超过那个超时，就等于把
这个 bug 放回去。

## 日志不变量

两条都是从一个涨到 9.3 GB 的日志里学来的。

### 一条日志，一行物理行

`src/lib/log.ts` 里的 `formatLogValue` **同时**需要 `compact: true` 和
`breakLength: Infinity`。

Node 文档读起来像是默认的 `compact: 3` 就够了 —— 并不够。那个数字统计的是被合并的
内层元素个数，不是阈值，所以它只会折叠嵌套深度不超过该计数的 payload。在一个真实的
4 层错误 payload 上：

| 设置 | 产生行数 |
| --- | --- |
| `compact: 3` | 10 |
| `compact: 1` | 22 |
| `compact: true` | **1** |

`tests/unit/log-format.test.ts` 固定了这一点；不要把它"简化"掉。多行 dump 还会打断
[日志与问题排查](ZH-Logging-Troubleshooting.md)里的每一条 `grep` 配方 —— 因为搜索
返回的会是某个 payload 的第一个片段，而不是匹配的那条日志。

payload 的边界是深度 6、100 个数组元素、每个字符串 4000 字符。超出这些限制的值会在
日志里被截断，而不是丢弃。

### 保留策略需要轮转

当前文件是 `copilot-relay.<本地日期>.log`，按写入逐次解析路径，因此无需定时器即可在
本地零点轮转。

保留策略按**文件名里的日期**判断文件年龄，对没有日期戳的文件退化为按 mtime 判断。
之所以优先用文件名，是因为 mtime 会被备份、`cp` 以及编辑器碰一下文件而改写，这些都
会悄悄拉长或缩短保留窗口。

在轮转存在之前，保留策略按 mtime 给唯一一个从不轮转的文件计龄，而每一次追加都会刷新
那个 mtime，于是它一次都没有够到过删除条件。

用本地日期而不是 UTC：`logRetentionDays` 是一个"我要保留几天"的、面向人的设置；而
UTC 戳会让格林尼治以西的人在本地下午的正中间发生文件切换。

日志体量由时间限定，而不是由大小限定。这是接受的取舍（#25）。

### 脱敏

`src/lib/redact.ts` 是纯函数，覆盖那些可能在 path、query string 或 fragment 里携带
凭据的 URL。日志文件是用户唯一被要求粘贴到 issue 里的文件（#47），所以一个携带 token
的网关路径绝不能活着进到日志里。`copilotBaseUrl` 校验拒绝原始引号、尖括号、空白和
控制字符也是同一个理由：这些字符在日志行里标记着一个 URL 的结束，因此含有它们的值
之后无法被识别为一个完整 URL，其尾部就会不经脱敏地打印出来。

## 测试

```sh
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
```

### 重定向 home 目录

任何触碰日志或配置路径的测试套件，**必须在 import `src/` 之前重定向 home 目录**。
`src/lib/paths.ts` 在 import 时就从 `os.homedir()` 解析，所以只有在设置好环境变量
之后再用动态 `import()`，重定向才会生效：

```ts
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-relay-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const { readAppConfig } = await import("../../src/lib/app-config")
```

必须**同时设置 `HOME` 和 `USERPROFILE`**。Node 在 Windows 上读 `USERPROFILE`，而 CI
会跑 `windows-latest`，所以只设 `HOME` 会让重定向在那里悄无声息地失效。不这么做的话，
测试每跑一次都会写进开发者真实的 `~/.copilot-relay/logs`。

### mock 上游

集成测试让 Hono app 跑在本地 mock 的 Copilot HTTP server 之上。它们绝不可以调用真实
服务 —— CI 上不行，本地也不行。

### 文档的结构性测试

`tests/unit/wiki-docs.test.ts` 用机器强制文档契约本身：`wiki/` 是扁平的、每个 `EN-`
页面都有对应的 `ZH-` 页面、每个相对链接都能解析、
`.github/workflows/publish-wiki.yml` 的发布变换不会留下坏链接。它从磁盘读文件，不从
`src/` import 任何东西，因此不需要 home 重定向。
