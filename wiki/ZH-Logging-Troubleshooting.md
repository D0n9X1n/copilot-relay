# 日志与问题排查

当前日志文件名带本地日期，每天本地零点轮转：

```text
~/.copilot-relay/logs/copilot-relay.2026-07-25.log
```

超过 `logRetentionDays`（默认 3 天）的文件会被自动删除。

实时查看当天日志：

```sh
tail -f ~/.copilot-relay/logs/copilot-relay.$(date +%F).log
```

用通配符搜索所有保留的日期：

```sh
grep -n "request_id=" ~/.copilot-relay/logs/copilot-relay.*.log
```

每条日志都是单独一行，包含携带完整请求/响应上下文的错误条目 —— 所以 `grep` 返回的是
完整的一条，而不是某个对象的片段。

如果你是从 v0.2.3 之前升级上来的，目录里可能还留着一个不带日期的
`copilot-relay.log`。那是旧的单一日志文件，它会自己过期删除，现在已经没有任何东西往里
写了。

## 日志级别

只支持三个级别：

| 级别 | 用途 |
| --- | --- |
| `error` | 启动失败、请求失败、token 刷新失败、上游 400/500 详情。 |
| `info` | 启动状态、preflight 成功、token 生命周期、本地 HTTP 状态摘要。 |
| `debug` | 模型路由、上游耗时、完整请求 payload 诊断。 |

`warn`、`trace`、`silent` 等其他值都是非法配置，会导致启动失败。

## 常用搜索

```sh
grep -n "Startup preflight failed" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "Failed to create" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "Failed to refresh Copilot token" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "Model request" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "Copilot POST" ~/.copilot-relay/logs/copilot-relay.*.log
```

## 启动失败

搜索：

```text
Startup preflight failed
Preflight failed
Required Copilot model
Invalid logLevel
```

常见原因：

- `github_token` 过期或失效
- `copilot_token.json` 缺失或过期
- 配置的 `gptModel` / `opusModel` 上游不存在
- `logLevel` 非法
- `thinkEffort` 被上游拒绝

重新登录：

```sh
copilot-relay auth
copilot-relay start
```

## 请求返回 400/500

`info` 里会看到短摘要：

```text
info POST /v1/messages -> 400 123ms error="Invalid request"
```

同一个日志文件里对应的 `error` 会包含完整上下文：

- 上游 route
- model
- request payload
- response status
- response headers
- response body

搜索：

```sh
grep -n "Failed to create" ~/.copilot-relay/logs/copilot-relay.*.log
```

## 模型或 effort 不对

临时设置：

```yaml
logLevel: debug
```

搜索：

```sh
grep -n "Model request" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "effective_think_effort" ~/.copilot-relay/logs/copilot-relay.*.log
```

重点看：

- `requested_model`
- `upstream_model`
- `requested_think_effort`
- `effective_think_effort`

## 响应慢

先看本地请求耗时：

```text
info POST /v1/messages -> 200 8291ms
```

再在 `debug` 下看上游耗时：

```text
debug Copilot POST /chat/completions -> 200 8287ms (attempt 1)
```

如果两个数字接近，瓶颈基本是上游模型响应时间。

## Token 问题

搜索：

```sh
grep -n "Using cached Copilot token\|Next Copilot token refresh\|Failed to refresh Copilot token" ~/.copilot-relay/logs/copilot-relay.*.log
```

如果持续刷新失败，重新登录：

```sh
copilot-relay auth
```

## 安全分享日志

不要直接公开完整 `debug` 日志。debug 可能包含 prompt 和工具 payload。

提 bug 时建议提供：

- 精确时间点
- 相关 `info` 请求摘要
- 对应的 `error` 块
- 是否开启过 `debug`
- 去掉隐私信息后的 `~/.copilot-relay/config.yaml`

