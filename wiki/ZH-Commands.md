# 命令

`copilot-relay` 是一个带多个命令的可执行文件。本页列出每个命令做什么、有哪些选项、读写和联系
什么，以及如何退出。设置保存在 `~/.copilot-relay/config.yaml`，见[配置说明](ZH-Configuration.md)。

`--help` 或 `-h` 打印 CLI 或某个命令的用法，并以 `0` 退出：

```sh
copilot-relay --help
copilot-relay models --help
```

没有 `--version` 选项：`copilot-relay --version` 打印 `No version specified` 并以 `1` 退出。
`copilot-relay status` 会打印运行它的 CLI 的版本；有中继在运行时，还会打印该中继报告的版本，
中继不报告版本时显示 `unknown`。

## 一览

| 命令 | 作用 | 联系 |
| --- | --- | --- |
| `start` | 在前台运行中继 | GitHub、Copilot |
| `stop` | 停止找到的每个中继，不限端口 | 无 |
| `restart` | 先执行 `stop`，再执行 `start` | GitHub、Copilot |
| `status` | 显示配置端口上的中继是否在运行、是否可用 | 中继；加 `--deep` 时经中继联系 Copilot |
| `auth` | 用设备码登录 GitHub | GitHub |
| `models` | 列出、搜索或测试 Copilot 的模型 | GitHub、Copilot |
| `usage` | 显示 Copilot 套餐与配额 | GitHub |
| `cache` | 从本地日志报告 prompt 缓存命中率 | 无 |
| `replay` | 离线重放 debug 捕获 | 无 |

`start`、`restart`、`stop`、`status`、`auth` 和 `models` 像中继一样加载 `config.yaml`：文件
不存在时创建它，缺少的键以默认值补上，已有的键保持原样。无法解析、或含有中继拒绝的值的文件不会
被重写。`usage` 读取该文件，但从不写它。`cache` 和 `replay` 不读取它。

## `start`

```sh
copilot-relay start
```

在前台运行中继的 HTTP 服务，直到收到 `SIGINT` 或 `SIGTERM`。它没有选项。它依次：

1. 加载 `config.yaml`。文件无法加载时，在登录之前就停在这一步。
2. 读取保存在 `~/.copilot-relay/github_token` 的 GitHub token。没有保存的 token 时，发起设备码
   登录：在日志中给出一个 URL 和一个代码，等到代码输入完成，再保存新 token。
3. 获取 Copilot token。保存在 `~/.copilot-relay/copilot_token.json` 的 token 剩余时间超过
   60 秒时复用它，否则用 GitHub token 换取一个新的。GitHub 拒绝签发 Copilot token 时，再执行
   一次设备码登录，并重试换取一次。
4. 执行启动预检：Copilot 的模型目录必须列出 `gptModel` 和 `opusModel`，且两者都要能回答一个
   简短的请求。否则记录 `Startup preflight failed:` 及原因，并以 `1` 退出。
5. 在 `host` 和 `port` 上监听，把 pid 写入 `~/.copilot-relay/copilot-relay.pid`，并记录
   `copilot-relay listening on <url>`。
6. `claudeSetup: true`（默认）时，用本地中继端点更新 `~/.claude/settings.json`。这一步失败
   只会记录日志，中继继续运行。

运行期间，它会应用 `config.yaml` 的变更，但[配置说明](ZH-Configuration.md)中“热重载与重启”
一节列为需要重启的键除外。设置了 `upstreamProxy` 时，它对 GitHub 和 Copilot 的请求都经过该
代理。它把日志写到 `~/.copilot-relay/logs/`，并对日志和 debug 捕获应用 `logRetentionDays`。

收到 `SIGINT` 或 `SIGTERM` 时，它停止接受连接，立即关闭空闲连接，两秒后关闭其余连接，然后删除
pid 文件。

启动失败时以 `1` 退出，例如端口已被占用。收到信号后以 `0` 退出；关闭服务失败时以 `1` 退出。

要让中继在注销或重启后继续运行，请把它注册为服务：
[Windows 任务计划程序](ZH-Windows-Service.md)、[macOS LaunchAgent](ZH-macOS-LaunchAgent.md)
或 [Linux systemd 用户服务](ZH-Linux-systemd.md)。

## `stop`

```sh
copilot-relay stop
```

停止本机上的每个 copilot-relay 服务，不限端口。它没有选项。

它从 pid 文件、在配置端口上监听的进程以及进程列表中收集候选进程，只向已确认是 copilot-relay 服务
的进程发送信号：先发 `SIGTERM`，五秒后进程仍在运行就发 `SIGKILL`。一个都没有找到时，记录
`No existing copilot-relay instance found`。除非 pid 文件指向的进程仍在运行，否则它会删除该文件。

它不需要有效的 `config.yaml`。文件无法加载时，它记录这一点，仍然停止能确认的中继，只是没有配置
端口作为线索。文件能加载时，它还会对日志应用 `logRetentionDays`。

停止了找到的每个中继，或一个都没有找到时，以 `0` 退出；无法检查进程，或无法停止找到的中继时，
以 `1` 退出。

服务管理器可能在 `stop` 之后再次启动中继；每个服务页面都说明了 `stop` 与对应服务管理器的关系。
为什么 `stop` 搜索所有端口，而 `status` 只检查配置端口，见[内部实现](ZH-Internals.md)中的
“生命周期：status 和 stop 问的是不同的问题”。

## `restart`

```sh
copilot-relay restart
```

像 `stop` 一样停止找到的每个中继，再像 `start` 一样在同一个进程里启动一个：新中继在运行
`restart` 的终端前台运行。它没有选项。

与 `stop` 不同，它需要有效的 `config.yaml`：文件无法加载时，它在停止任何东西之前就以 `1` 退出。
无法停止正在运行的中继时，也以 `1` 退出。此后它的退出方式与 `start` 相同。

升级后运行它，让中继提供你安装的版本。由服务管理器运行的中继应通过该服务管理器重启；见
[日志与问题排查](ZH-Logging-Troubleshooting.md)中的“新版本似乎没有生效”。

## `status`

```sh
copilot-relay status
copilot-relay status --deep --json
```

| 选项 | 说明 |
| --- | --- |
| `--deep` | 另外通过 Copilot 发送一个真实请求。证明中继端到端可用；会消耗少量 token。 |
| `--json` | 输出机器可读的 JSON。 |

显示配置端口上的中继是否在运行、是否可用。pid 文件的端口与配置端口一致时，它从 pid 文件找到这个
中继，否则从在该端口上监听的进程找到它；它从不报告其他端口上的中继。对正在运行的中继，它请求
`/healthz`，通过后再请求 `/v1/models`；加 `--deep` 时还会发送一个简短的 `POST /v1/messages`，
经中继到达 Copilot。`/healthz` 和 `/v1/models` 从不联系 Copilot。

第一行显示运行 `status` 的 CLI 的版本。对正在运行的中继，`version` 一行显示该中继报告的版本；
中继不报告版本时显示 `unknown`；与已安装版本不一致时，显示不一致，并给出重启它的命令。

| 退出码 | 含义 |
| --- | --- |
| `0` | 有中继在运行，并通过了 `/healthz`，以及给出时的 `--deep`。版本不一致仍以 `0` 退出。 |
| `1` | 配置端口上没有中继在运行。 |
| `2` | `/healthz` 或 `--deep` 失败、`config.yaml` 无法加载，或无法确认进程状态。 |

脚本可以依赖这些退出码；见[内部实现](ZH-Internals.md)中的“退出码是一份契约”，以及
[架构](ZH-Architecture.md)中的“廉价接口能证明什么，不能证明什么”。

## `auth`

```sh
copilot-relay auth
```

用设备码登录 GitHub，即使已经保存了 GitHub token 也是如此。它没有选项。它在日志中给出一个 URL 和
一个代码，等到代码输入完成，再把新 token 写入 `~/.copilot-relay/github_token`。随后获取 Copilot
token：保存在 `~/.copilot-relay/copilot_token.json` 的 token 剩余时间超过 60 秒时复用它，否则用
新的 GitHub token 换取一个新的。GitHub 返回账号时，它记录登录的 GitHub 账号。它不启动中继。

它的请求经过 `upstreamProxy`，所以只能通过代理访问 GitHub 时，先在 `config.yaml` 中设置
`upstreamProxy`。完成时以 `0` 退出；某一步失败时以 `1` 退出，包括 `config.yaml` 无法加载。

没有保存 GitHub token 时，`start` 和 `models` 会执行同样的设备码登录，所以 `auth` 用于提前登录，
或替换已保存的 token。`usage` 从不登录。两个 token 文件见
[日志与问题排查](ZH-Logging-Troubleshooting.md)中的“Token 缓存问题”。

## `models`

```sh
copilot-relay models                                   # 列出
copilot-relay models opus                              # 按 ID 或显示名称搜索
copilot-relay models --deep --model claude-opus-5.5    # 测试一个模型
```

| 参数或选项 | 说明 |
| --- | --- |
| `[SEARCH]` | 按 ID 或显示名称查找模型，并打印要用的配置行。 |
| `--deep` | 通过隔离的中继管线发送真实推理探测；消耗 Copilot 用量。 |
| `--details` | 显示每次探测的安全请求、路由与重放证据（需要 --deep）。 |
| `--model` | 只测试这个确切的上游 ID（需要 --deep）。 |
| `--effort` | 探测 effort 覆盖值；否则使用公布的最低 effort，或未经验证的 low。 |
| `--max-tokens` | 每次探测的输出预算（默认 4096；受目录限制约束）。 |
| `--timeout` | 每次探测的超时秒数，须为正数（默认 30；受配置的超时约束）。 |
| `--total-timeout` | 所有探测的总超时秒数，须为正数（默认 300）。 |

列出 Copilot 模型目录中登录账号可用的模型。不加引号的多个词组成一个搜索；搜索会打印匹配的模型，
以及选择其中一个的 `config.yaml` 行。`--deep` 发送真实请求，目标是 `--model` 给出的 ID，或目录中
的每个模型，经过在命令自身进程内构建的中继管线，而不是正在运行的中继；它会消耗 Copilot 用量。
其他所有选项都需要 `--deep`，搜索也不能与它同时使用：先找到 ID，再用 `--deep --model <id>` 测试。
它像 `start` 一样加载 `config.yaml` 并登录；加 `--deep` 时，设备码提示输出到 stderr。

| 退出码 | 含义 |
| --- | --- |
| `0` | 打印了列表、搜索有匹配，或每个 `--deep` 探测都通过。 |
| `1` | 搜索没有匹配（会打印最接近的模型）、某个选项无法使用、`--model` 的 ID 不在目录中，或加载配置、登录、加载目录、执行检查失败。 |
| `2` | 有 `--deep` 探测没有通过，或没有任何探测运行。 |
| `130` | `SIGINT` 或 `SIGTERM` 中断了 `--deep`。 |

如何选择模型，以及如何阅读 `--deep` 的输出，见[配置说明](ZH-Configuration.md)中的
“选择模型和 thinking effort”。

## `usage`

```sh
copilot-relay usage
copilot-relay usage --json
```

| 选项 | 说明 |
| --- | --- |
| `--json` | 把套餐与配额字段打印成一个 JSON 对象。 |

显示已保存 GitHub token 所属账号的 Copilot 套餐，以及每项配额还剩多少。它把
`~/.copilot-relay/github_token` 中的 token 发给 GitHub；`config.yaml` 设置了 `upstreamProxy` 时
经过该代理，因此不需要中继在运行。它从不登录，不换取 Copilot token，也不写入任何东西，包括日志。
成功时打印报告并以 `0` 退出；否则在 stderr 打印一行原因（例如没有保存的 token）并以 `1` 退出。
字段与消息见[日志与问题排查](ZH-Logging-Troubleshooting.md)中的“Copilot 套餐与配额”。

## `cache`

```sh
copilot-relay cache
copilot-relay cache --hourly --since 2d
```

| 选项 | 说明 |
| --- | --- |
| `--hourly` | 按本地小时显示趋势。不加 --since 时覆盖最近 24 小时。 |
| `--daily` | 按本地日期显示趋势。不加 --since 时覆盖每个保留的日期。 |
| `--since` | 时间窗口的起点：一段时长（如 6h 或 2d），或 ISO 日期或时间。不加它时，汇总覆盖最近 24 小时。 |
| `--model` | 只统计名称包含这段文本的模型，不区分大小写。 |
| `--json` | 把各行打印成 JSON 数组。 |
| `--goal` | 命中率目标，单位为百分比，最多两位小数。低于它的命中率显示为红色。 |

根据 `~/.copilot-relay/logs/` 下中继日志文件的 `completion` 条目，按上游路由报告每个模型的输入中
有多少由 prompt 缓存提供。`--goal` 默认为 `95`，`--hourly` 和 `--daily` 不能同时使用。它既不联系
中继，也不联系 Copilot，不读取 `config.yaml`，也不写入任何东西。任何报告，包括空报告，都以 `0`
退出；选项无法使用，或日志目录无法读取时，在 stderr 说明原因并以 `1` 退出。报告本身见
[Prompt 缓存](ZH-Prompt-Caching.md)中的“测量命中率”。

## `replay`

```sh
copilot-relay replay <request-id>
copilot-relay replay /absolute/path/to/capture-directory
```

| 参数 | 说明 |
| --- | --- |
| `<TARGET>` | 请求 ID 或捕获目录 |

离线地把一份 debug 捕获送入中继当前的请求处理，并把结果与录制内容比较。只有中继在
`logLevel: debug` 下处理过的请求才有捕获，位于
`~/.copilot-relay/captures/<local-date>/<request-id>/`。ID 会在这些日期目录中查找，同一个 ID
出现在两个日期下时会被拒绝；明确给出的目录可以不在 `~/.copilot-relay` 之内。重放不打开 socket，
不使用真实凭据，不写入 token、配置或新的捕获，也不读取 `config.yaml`。

`MATCH` 以 `0` 退出，`DIFF` 或 `INCOMPLETE` 以 `2` 退出，`MISSING` 或 `MALFORMED` 以 `1` 退出。
每种结论的含义，以及为什么不能整份分享捕获，见
[日志与问题排查](ZH-Logging-Troubleshooting.md)中的“Debug 捕获与离线重放”。
