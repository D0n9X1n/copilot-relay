# 开发指南

搭建环境、检查项，以及每个改动都要走的流程。设计地图见
[架构](ZH-Architecture.md)；机制与不变量见[内部实现](ZH-Internals.md)。

## 目标与边界

`copilot-relay` 只是又一个让 Claude Code 使用 GitHub Copilot 订阅的中继。公开 API
只兼容 Claude Code：

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`
- `GET /healthz`
- `GET|HEAD /api/hello`

代理内部可以调用 Copilot `/chat/completions` 和 `/responses`，但这些路由不对外公开。
没有明确的产品决策，不要在这个表面之外添加路由。未知路由返回 `500`，并记录 payload
以便日后补兼容性。

## 搭建与检查

```sh
npm install
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
```

`npm test` 会把单元和集成两个套件一起跑。测试通过 `tsx` 使用 Node 内置 test runner。

纯逻辑优先写单元测试 —— 配置校验、模型路由、token 计数启发式、Claude/Copilot 协议
边界情况。只有当 Hono 路由或 mock 上游行为本身属于契约的一部分时，才用集成测试。

集成测试用一个本地 HTTP server 来 mock 上游 GitHub Copilot API。它们绝不可以调用真实
的 Copilot 服务。

## 支持的运行时与 CI

`package.json` 要求 Node `>=22`。CI（`.github/workflows/ci.yml`）跑的是
**Node 22 和 26** 乘以 **`ubuntu-latest`、`macos-latest`、`windows-latest`** 的矩阵
—— 六条腿，全部必须为绿：

- 安装依赖
- typecheck
- 单元测试
- 集成测试
- build

Windows 不是摆设。正因为它，任何触碰配置或日志路径的测试套件都必须同时设置 `HOME`
和 `USERPROFILE`；见[内部实现](ZH-Internals.md)的测试一节。

## CLI 生命周期

```sh
copilot-relay auth
copilot-relay start
copilot-relay status
copilot-relay restart
copilot-relay stop
```

`status` 和 `stop` 检测运行中中继的方式不同，而且是刻意如此 —— `status` 限定在端口
范围内，`stop` 做全局扫描。理由以及退出码契约见[内部实现](ZH-Internals.md)。

## 流程：milestone → issue → PR → release

这是所有工作的标准。没有 issue 和 PR，任何东西都不能进 `main`。

1. **先建 milestone。** 标题与它要发布的 tag 完全一致（`v0.2.4`）。要在指向它的
   issue 之前建好。
2. **Issue。** 每个改动都有一个，挂在 milestone 上。标签：`bug`、`enhancement`、
   `documentation`、`question`。
3. **PR。** 从 `main` 切分支，commit body 里写 `Closes #N`，让 issue 在合并时自动
   关闭。PR 也挂到 milestone 上。填写 `.github/pull_request_template.md`。用 merge
   commit，并删除分支 —— 远端只保留 `main` 和活跃分支。
4. **Release。** 更新 `package.json`，以 `Release vX.Y.Z` 提交，打 tag，推送。关闭
   milestone。

有一部分历史早于这套规则 —— `v0.2.2` 是直接推送发布的，没有 PR —— 但从今往后按此
执行。

### 合并后必须清理

PR 合并后，只有清理了不再活跃的功能分支和临时 worktree，或明确报告了保留的例外，
才算完成。

1. 确认 PR 已合并，并获取最新的基础分支。检查 `git status --short`、
   `git worktree list --porcelain` 和分支祖先关系；分支的名称或年龄不能证明工作已合并。
2. 检查 worktree 和锁由哪个会话持有。不要删除活跃 worktree，也不要为了让清理通过
   就解除其他会话的锁。
3. 只在自己拥有的 checkout 中切离已合并的功能分支。先用普通的
   `git worktree remove` 删除干净、非活跃的 worktree，再用 `git branch -d`
   删除本地分支；不要强制移除。
4. 如果已确认合并的远端分支仍存在，删除它，再运行 `git fetch --prune origin`。
   保留 `main` 和真正活跃的分支。
5. 报告最终工作区状态、剩余分支/worktree 和保留的例外。只清理可再生成的构建产物，
   不要删除凭据、运行状态或其他会话的文件。

未提交改动或独有提交会阻止普通删除。应原地保留，或在明确约定的陈旧工作清理之前，
创建并验证私有恢复归档。不要用强制删除绕过这些检查。

`git branch -d` 依据祖先关系，可能拒绝删除经 squash/rebase 合并的分支。仅在这种情况下，
确认以下全部条件后，才允许使用 `git branch -D`：

- PR 已合并，且合并结果可从当前基础分支到达。
- 本地分支 tip 与 PR 合并时记录的 head commit 完全一致，而不是与生成的 squash/rebase
  commit 比较。如果本地有额外或重写的提交，即使原 PR diff 已进入目标分支，也必须保留。
- 该 PR head 的全部改动均已合并。`git cherry -v main <branch>` 没有 `+` 条目可以确认
  逐提交补丁等价；多个提交合并成一个 squash commit 后仍可能显示 `+`，这时应比较
  完整 PR diff 与对应的 squash commit。

删除前立即重新检查每个分支 tip，包括远端 tip；如果它已变化，或无法验证 PR 合并时的
head 或补丁等价，就保留分支。不要仅凭 PR 已关闭就判断安全，也不要借此强制删除脏的或
活跃的 worktree。

### Milestone 归属

归属由**提交祖先关系决定，而不是关闭时间**。用 `git tag --contains <merge-sha>`，取
最早的那个 tag。关闭时间戳具有误导性：一个在 tag 之后几分钟关闭的 issue，实际上是在
**下一个** release 里发布的；曾有三个 issue 因此被错误归属，后来才更正。

以 `wontfix` / `NOT_PLANNED` 关闭的条目**不挂 milestone** —— 它们什么都没发布，挂上
去会歪曲这次 release 的内容。

## 发布

**推送 tag 是不可逆的。** `.github/workflows/publish.yml` 会在任何 `v*` tag 上触发，
并发布到 **npm** 和 **GitHub Packages**。npm 无法有意义地撤回发布。没有 dry run。

workflow 的 `test` job 会把关那三个发布 job，但仍然要在**即将打 tag 的那棵树**上本地
跑完整关卡 —— PR 上通过的 CI 和 release commit 不是同一棵树。

```sh
gh pr checks <N>                          # 先确认所有腿都是绿的
gh pr merge <N> --merge --delete-branch
git checkout main && git pull --ff-only
npm version X.Y.Z --no-git-tag-version
npm run typecheck && npm test && npm run build   # 在即将打 tag 的那棵树上
git commit -am "Release vX.Y.Z" && git push origin main
git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z   # ← 不可回头的点
```

然后验证它确实发布了 —— `npm view copilot-relay version` 和
`gh release view vX.Y.Z` —— 并关闭 milestone。

### 发布细节

- `0.0.x` 版本用于打包发布的冒烟测试。
- 推送 `v*` tag 会创建或更新 GitHub Release，并上传 npm tarball 和 `SHA256SUMS`。
- npm 发布使用 npm Trusted Publishing 加 GitHub Actions OIDC，因此 workflow 里需要
  `id-token: write`，而不是 `NPM_TOKEN`。
- 在 npm 上把可信发布者配置为仓库 `D0n9X1n/copilot-relay`、workflow 文件名
  `publish.yml`；npm 会精确匹配这两个字段。
- GitHub Packages 发布使用 `GITHUB_TOKEN`。
- GitHub 上的包以 `@<owner>/copilot-relay` 发布。

## 文档

`wiki/` 是仓库内**唯一**的文档树，也是 GitHub Wiki 标签页的来源。
`.github/workflows/publish-wiki.yml` 在每次合并到 `main` 时发布它，把 `README.md`
重命名为 `Home.md`，并从简单的内部链接里去掉 `.md`。

保证发布正确的几条规则：

- **只能扁平。** workflow 只拷贝顶层的 `wiki/*.md`；子目录会被静默地不发布。
- **源码里的链接保留 `.md`** —— `](ZH-Internals.md)` —— 这样在仓库里浏览目录时能正常
  跳转。workflow 会为标签页去掉扩展名。
- **不要跨页锚点。** `](ZH-Internals.md#某节)` 不会被变换重写，在标签页上会 404。
  同页 `#锚点` 链接没问题。
- **English 与中文保持同步。** 每个 `EN-` 页面都有结构对应的 `ZH-` 页面。

**单向发布。** 在 wiki 标签页的浏览器编辑器里做的修改，会在下次发布时被覆盖。请改
`wiki/`。

wiki 曾经是一个独立仓库，在 PR 的视野之外。#21 在 v0.2.3 改了日志文件名，wiki 没有
同步更新，30 处过期的日志路径活过了两个 release，直到 #29 才发现 —— 文档里每一条
`tail` 和 `grep` 都在悄无声息地匹配不到任何东西。放进仓库后，那个改动和它的文档更新
会落在同一次评审里。把用户可见的路径、参数或命令的变更，视作在 `wiki/` 同步之前尚未
完成。

### 验证一次 wiki 变更

一次合并的文档改动，要等到发布 workflow 成功**并且**线上标签页确实显示出来，才算
完成：

```sh
gh run list --workflow=publish-wiki.yml --limit 1
gh run view <run-id> --log

git clone https://github.com/D0n9X1n/copilot-relay.wiki.git /tmp/relay-wiki
ls /tmp/relay-wiki                       # Home.md 存在，目录扁平
grep -rn "](.*\.md)" /tmp/relay-wiki || echo "没有残留的 .md 链接"
```

然后打开标签页，从 `Home` 点一遍中英文导航。

## 文档的结构性测试

`tests/unit/wiki-docs.test.ts` 用机器强制上面这些规则：`docs/` 不存在、`wiki/` 扁平、
`EN-`/`ZH-` 成对、每个相对链接都能解析、不存在跨页锚点链接、发布变换不留下坏链接、
没有任何被跟踪的文件还引用已删除的 `docs/` 树。

它跑在普通单元测试套件里。一个会破坏发布的文档改动，会让 CI 失败，而不是让 wiki
标签页失败。

## 配置优先原则

优先用配置而不是写死行为。如果某个行为可能因人而异，就把它加进
`config.default.yaml`，并在 README 和**两种语言**的[配置说明](ZH-Configuration.md)
里体现这个新键。

发布默认值只对全新安装生效，因为 `readAppConfig()` 会持久化解析后的配置。不要加迁移
机制去把新默认值强推给已有安装 —— 用户配置里的值属于用户。见
[内部实现](ZH-Internals.md)。

## 日志规则

| 级别 | 记录内容 |
| --- | --- |
| `error` | 启动、preflight、请求、token 刷新和上游失败 |
| `info` | error 的内容，加上启动/preflight 状态、request ID、模型与 effort 摘要、上游生命周期和本地 HTTP 状态码 |
| `debug` | info 的内容，加上详细 Copilot 耗时和请求 payload |

其他任何 `logLevel` 值都是非法的，必须让启动失败。

在 `info` 级别，每个模型请求都必须记录 client 类型、请求模型、上游模型、请求 think
effort、请求 thinking budget、生效 think effort。缺失的 effort 用 `unset` 表示，普通
payload 转储保留在 `debug` 级别。在 `error` 级别，上游失败要连同完整
的请求与响应上下文记录在同一个日志文件里。

永远不要记录 token 值。[内部实现](ZH-Internals.md)里的单行与轮转不变量不是风格问题
—— 不要把它们简化掉。

## 刻意移除的功能

没有产品决策，不要把这些加回来：

- 公开的 `/v1/chat/completions`
- 公开的 `/v1/embeddings`
- `/usage`
- Codex 支持
- Auto 模式
- 限流
- 仅 Bun 可用的脚本
- `configVersion` 迁移机制（在 #26 中移除）

模型 ID 是 Copilot 上游 ID。请对照线上的 `/models` 接口核实，不要假设某个名字存在。
