# Windows：后台保活

推荐使用系统内置的任务计划程序 Task Scheduler，并以当前用户身份创建任务。

## 一次性准备

用普通用户打开 PowerShell：

```powershell
npm install -g copilot-relay@latest
copilot-relay auth
```

## 创建任务

```powershell
$node = (Get-Command node).Source
$main = Join-Path (npm root -g) "copilot-relay\dist\main.js"

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$main`" start"

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 10 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

Register-ScheduledTask `
  -TaskName "copilot-relay" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Run copilot-relay for Claude Code" `
  -Force

Start-ScheduledTask -TaskName "copilot-relay"
```

### 务必确认执行时间上限真的生效了

注册完立刻做一次这个检查。它决定了 relay 是能一直跑，还是三天后无声无息地死掉：

```powershell
(Get-ScheduledTask -TaskName "copilot-relay").Settings.ExecutionTimeLimit
```

**期望值是 `PT0S`。** 如果显示 `PT72H`，说明设置没生效 —— PowerShell 的
`[TimeSpan]::Zero` 并不总能序列化成 `PT0S`，而且失败时没有任何提示。这种情况下直接改
XML：

```powershell
$task = Get-ScheduledTask -TaskName "copilot-relay"
$task.Settings.ExecutionTimeLimit = "PT0S"
Set-ScheduledTask -InputObject $task
(Get-ScheduledTask -TaskName "copilot-relay").Settings.ExecutionTimeLimit  # PT0S
```

### 为什么是这些设置

对一个长期运行的服务来说，任务计划程序的默认值基本都是错的。

**`-ExecutionTimeLimit ([TimeSpan]::Zero)`** 是坑最深的一个。默认值是 **`PT72H`，也就是
3 天** —— 到时间后任务计划程序会**终止**这个任务。一个完全健康的 relay 会在 72 小时后
死掉，而且因为看起来像正常结束，任何地方都不会报错。零表示没有上限。务必按上面的方法
确认它生效了。

**`-DontStopIfGoingOnBatteries`** 和 **`-AllowStartIfOnBatteries`** 在笔记本上都必须加，
因为两个底层默认值都跟你作对：`StopIfGoingOnBatteries` 默认为 `true`（一拔电源
Windows 就停掉任务），`DisallowStartIfOnBatteries` 也默认为 `true`（用电池时根本不启动）。

注意 `-DisallowStartIfOnBatteries` **不是** cmdlet 参数 —— 那是底层 XML 属性的名字。把它
传给 `New-ScheduledTaskSettingsSet` 没有任何作用，应该用 `-AllowStartIfOnBatteries`。

**直接执行 `node.exe`**，而不是把任务的程序设成 `powershell.exe`。微软的文档写明，停止
任务「只会停止由计划任务启动的那个程序的实例。要停止其他进程，必须使用 TaskKill 命令」。
也就是说，停止操作可靠覆盖的是**任务的程序本身** —— 那个程序再启动的东西，都属于文档里
说的「其他进程」。

如果任务的程序是 `powershell.exe`，relay 就是它的子进程，而停止任务并没有被文档保证能
覆盖到 relay。直接调 `node dist\main.js start`，relay 就是任务自己的程序，停止操作正好
覆盖你想停的那个东西。

（npm 在 Windows 上全局安装会生成无扩展名、`.cmd` 和 `.ps1` 三种垫片，
`(Get-Command copilot-relay).Source` 指向的就是其中之一。`.ps1` 垫片是脚本而不是独立
进程 —— 它在调用它的 PowerShell 宿主里运行并从那里启动 node —— 所以多出来的那一层来自
「把 `powershell.exe` 设成任务的程序」这个选择，而不是垫片本身。）

**`-RestartCount 10`、间隔 1 分钟** 限制重试次数。这些设置属于 `RestartOnFailure`，
**只在任务失败时生效** —— 进程以 `0` 退出算正常结束，所以正常的 `copilot-relay stop`
永远不会被它们重新拉起。relay 启动时会校验上游 Copilot 访问，失败则 `exit(1)`；登录瞬间
网络往往还没就绪，第一次失败是正常的。十分钟内重试十次，既能覆盖慢速网络，又不会对着
真正的配置错误无限重试。

`-MultipleInstances IgnoreNew` 本来就是默认值，这里显式写出来是为了表明意图：绝不允许
第二个实例和第一个并存。

## 如何确认它真的能用

### 最快的办法

```powershell
copilot-relay status
```

```text
copilot-relay 0.2.5
  process    running (pid 93744, up 1h 16m)
  listening  http://127.0.0.1:4142
  health     ok (9ms)
  models     gpt-5.6-sol[1m], claude-opus-5
  upstream   not checked (use --deep)
  log        C:\Users\you\.copilot-relay\logs\copilot-relay.2026-07-25.log
  config     C:\Users\you\.copilot-relay\config.yaml (logLevel=info, thinkEffort=max)
```

加上 `--deep` 会额外发一个真实请求经由 Copilot 走一遍 —— 这是唯一能证明 relay 真的可以
为 Claude Code 服务的检查。它会消耗少量 token，所以默认不做：

```powershell
copilot-relay status --deep
```

退出码便于脚本使用：`0` 运行中且可达，`1` 未运行，`2` 运行中但不可用（健康检查失败，或 `--deep` 失败）。`--json` 输出
机器可读格式。

在 Windows 上尤其推荐用它 —— 下面手动的第三层是一段多行 `Invoke-RestMethod` 加手写 JSON
body，而 `status --deep` 只有一条命令。

### 手动执行这三层

`status` 已经替你跑了这三层。理解它们仍然有价值，因为**前两层在一个根本无法处理任何请求
的 relay 上也会通过** —— 在没有装 CLI 的机器上排查时也用得上。

### 第一层 —— 进程还活着吗？

```powershell
Get-ScheduledTask -TaskName "copilot-relay" | Select-Object State
Get-ScheduledTaskInfo -TaskName "copilot-relay" |
  Select-Object LastRunTime, LastTaskResult, NumberOfMissedRuns

Invoke-RestMethod http://127.0.0.1:4142/healthz
```

期望 `State: Running`、`LastTaskResult: 267009`（表示**正在运行**，不是错误）、以及
`ok : True`。这个接口是静态处理器：它只能证明有个端口在监听，别的什么都证明不了，完全
不会访问 GitHub Copilot。

### 第二层 —— 配置解析和模型路由正常吗？

```powershell
(Invoke-RestMethod http://127.0.0.1:4142/v1/models).data.id
```

期望看到你配置的模型，例如 `gpt-5.6-sol[1m]` 和 `claude-opus-5`。结果直接来自配置，
**同样不访问上游**。一个 Copilot 令牌一小时前就过期的 relay，前两层照样通过。

### 第三层 —— 端到端

```powershell
$body = @{
  model      = "gpt-5.6-sol"
  max_tokens = 16
  messages   = @(@{ role = "user"; content = "Reply with the single word: ok" })
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post http://127.0.0.1:4142/v1/messages `
  -ContentType "application/json" `
  -Headers @{ "anthropic-version" = "2023-06-01" } `
  -Body $body
```

返回内容加上非零 `usage`，说明整条链路都是通的：配置、令牌刷新、Copilot 调用，以及转换
回 Claude 格式。**只有这一层能证明 relay 真的可以为 Claude Code 服务。** 它会消耗少量
token。

如果前两层通过而第三层失败，问题在鉴权或上游，不在任务本身 —— 执行
`copilot-relay auth` 并查看当天日志。

### 查看日志

```powershell
$today = Get-Date -Format "yyyy-MM-dd"
Get-Content "$env:USERPROFILE\.copilot-relay\logs\copilot-relay.$today.log" -Tail 80 -Wait
```

日志按天轮转，文件名带本地日期。要搜索所有保留的日期：

```powershell
Select-String -Path "$env:USERPROFILE\.copilot-relay\logs\copilot-relay.*.log" `
  -Pattern "Startup preflight failed"
```

## 停止

现在停止，下次登录时再启动：

```powershell
Stop-ScheduledTask -TaskName "copilot-relay"
```

现在停止，并且登录时也不再启动：

```powershell
Stop-ScheduledTask -TaskName "copilot-relay"
Disable-ScheduledTask -TaskName "copilot-relay"
```

重新启用：

```powershell
Enable-ScheduledTask -TaskName "copilot-relay"
Start-ScheduledTask -TaskName "copilot-relay"
```

### `copilot-relay stop` 与任务计划程序的关系

`copilot-relay stop` 会直接找到并终止 relay 进程。它以 `0` 退出，任务计划程序视为正常
结束而非失败，所以重启策略不会触发，它会一直保持停止，直到下次登录。

不论用哪种守护方式，确认 relay 确实没了：

```powershell
copilot-relay stop
Get-NetTCPConnection -LocalPort 4142 -State Listen -ErrorAction SilentlyContinue
```

第二条命令应该没有任何输出。

### 彻底删除

```powershell
Stop-ScheduledTask -TaskName "copilot-relay"
Unregister-ScheduledTask -TaskName "copilot-relay" -Confirm:$false
```

## 排查

**relay 大约每 3 天死一次。** `-ExecutionTimeLimit` 没生效。特征是 `LastTaskResult` =
**`267014`**（`SCHED_S_TASK_TERMINATED`）且运行时长接近 72 小时 —— 这个码表示任务被终止，
而不是崩溃。检查并修复：

```powershell
(Get-ScheduledTask -TaskName "copilot-relay").Settings.ExecutionTimeLimit
```

`PT72H` 是默认值，也正是问题所在；你要的是 `PT0S`。参见
[务必确认执行时间上限真的生效了](#务必确认执行时间上限真的生效了)。

**拔电源就停，或者用电池时根本起不来。** 两个电池相关的默认值都跟你作对 ——
`StopIfGoingOnBatteries` 和 `DisallowStartIfOnBatteries` 默认都是 `true`。需要同时加
`-DontStopIfGoingOnBatteries` 和 `-AllowStartIfOnBatteries`。

**`Stop-ScheduledTask` 之后 relay 还在跑。** 任务套了垫片或 `powershell.exe`。用上面的
`node.exe` 方式重新注册。

**`LastTaskResult` 是 `1`。** 启动前校验失败：鉴权过期或没有网络。看当天日志，然后执行
`copilot-relay auth`。

**`LastTaskResult` 是 `267009`。** 不是错误 —— `SCHED_S_TASK_RUNNING`，任务正在运行。

**`LastTaskResult` 是 `267011`。** `SCHED_S_TASK_NOT_SCHEDULED` —— 按计划运行所需的某个
属性缺失，重新注册任务即可。

**任务注册了但从来不启动。** `-AtLogOn` 在登录时触发；如果你是在已经登录的会话里注册的，
先手动执行一次 `Start-ScheduledTask`。

**relay 在跑但 Claude Code 不走它。** 服务注册没问题；检查
`%USERPROFILE%\.claude\settings.json` 里的 `ANTHROPIC_BASE_URL`。当 `claudeSetup: true`
时，relay 启动时会自己管理这个值。

## 最佳实践

使用「当前用户」的计划任务。除非你明确管理独立的 home 目录和 token 缓存，否则不要用
`SYSTEM` 运行 —— `SYSTEM` 有自己的用户配置目录，看不到你以自己身份执行的
`copilot-relay auth`。
