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

Relay 内部可调用 Copilot `/chat/completions`、`/responses` 或原生 `/v1/messages`，
不因此新增公开 OpenAI 路由。没有产品决策，不要扩展公开接口。通过接入检查的未知路由
返回 `500` 并记录有界兼容性诊断。Host/Origin/JSON 接入检查不是网络认证，真实监听器
应保持 loopback。见[架构](ZH-Architecture.md)。

## 搭建与检查

```sh
npm ci --no-audit --no-fund
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
```

使用已提交的 `package-lock.json`，CI/发布安装用 `npm ci`，不做无锁依赖解析。
根 package 与 lockfile 版本应保持一致。

`npm test` 会把单元和集成两个套件一起跑。测试通过 `tsx` 使用 Node 内置 runner，先
预载 `scripts/test-bootstrap.mjs`，在**任何源码 import 之前**隔离 `HOME`、`USERPROFILE`
和临时路径。单独测试也须保留该预载，见[内部实现](ZH-Internals.md)。发布说明测试还需要 Git 和 Python 3.12 或更新版本（POSIX 使用 `python3`，Windows 使用
`python`，也可通过 `PYTHON` 指定可执行文件）。测试使用临时 Git 仓库和模拟的 GitHub
元数据，不调用真实 GitHub API。CI 的六条腿都安装 Python 3.12。Python 只是开发和发布
依赖，运行中继本身不需要 Python。

离线 release-pipeline 测试还要求 PATH 中有 Bash、`jq`、`mkdir`、`cp`、`mktemp`、`rm`、
`basename`、`cmp`、`grep`，以及支持从标准输入读取归档的 `tar`。Windows 的 Git Bash
提供 shell 和 Unix 工具；如果缺少 `jq`，需要单独安装。Windows 的 BSD tar 和 Git 的
GNU tar 均受支持：`package-smoke.mjs` 通过 stdin 列出并解压同一份已校验字节，
把解压目录设为子进程工作目录，而不是传入带 Windows 盘符的归档路径参数。

发布来源收集仍受输出大小和超时限制。在 Windows 上，子进程已退出且两个捕获管道
都已读取完毕时，不再调用 `taskkill`；异常或未完成的捕获仍执行尽力而为的进程树清理。
不保证清理已脱离且关闭捕获管道的后代进程。POSIX 仍清理进程组；通过 `setsid`
创建新会话的后代进程可以脱离该进程组。

纯逻辑优先写单元测试 —— 配置校验、模型路由、token 计数启发式、Claude/Copilot 协议
边界情况。只有当 Hono 路由或 mock 上游行为本身属于契约的一部分时，才用集成测试。

集成测试用一个本地 HTTP server 来 mock 上游 GitHub Copilot API。它们绝不可以调用真实
的 Copilot 服务。

## 支持的运行时与 CI

`package.json` 要求 Node `>=22`。CI（`.github/workflows/ci.yml`）跑的是
**Node 22 和 26** 乘以 **`ubuntu-latest`、`macos-latest`、`windows-latest`** 的矩阵
—— 六条腿，全部必须为绿：

- 用 `npm ci` 安装锁定依赖
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

Workflow 先校验 tag 对应提交里的 package/lockfile 版本，构建一份锁定候选产物，再让
六条**源码测试及打包产物冒烟**腿为三个发布 job 把关。仍须在**即将打 tag 的那棵树**上
本地跑完整关卡；PR 上通过的 CI 和 release commit 不是同一棵树。

```sh
gh pr checks <N>                          # 先确认所有腿都是绿的
gh pr merge <N> --merge --delete-branch
git checkout main && git pull --ff-only
npm version X.Y.Z --no-git-tag-version
npm run typecheck && npm test && npm run build   # 在即将打 tag 的那棵树上
git commit -am "Release vX.Y.Z" && git push origin main
git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z   # ← 不可回头的点
```

`npm version ... --no-git-tag-version` 必须同时更新 `package.json` 和
`package-lock.json`，两者都应进入 release commit。关闭 milestone 前，验证全部发布 job
以及实际可用性（`npm view copilot-relay version`、`gh release view vX.Y.Z`）。

### 不可变候选产物关卡

`.github/workflows/publish.yml` 将 release tag 解析为一个提交，检查包版本与已提交
lockfile 一致。`candidates` 只运行一次 `npm ci` 和 build，禁用脚本后打 npm tarball；
仅改作用域包名派生 GitHub Packages tarball，`dist` 保持完全一致。两个 tarball 及各自
`SHA256SUMS` 存入一份 workflow artifact。

全部 **Node 22/26 × Linux/macOS/Windows** 腿执行源码 typecheck/unit/integration/build，
并下载同一候选。`scripts/package-smoke.mjs` 检查校验和及包名/版本，然后在隔离 home
中仅运行打包后的 JavaScript，生产依赖来自该腿的 lockfile 安装。它通过有网络守卫的
本地 mock 验证 help、运行版本、动态 tokenizer 和两条翻译模型路由，不调用真实 Copilot
或已安装 relay，只清理自己创建的子进程、socket 和临时文件。

发布 job 验证并发布已经过关的 tarball 字节，禁用脚本，不在发布时重建或重写版本。
重跑时，只有 registry 版本的 `dist.integrity` 与候选匹配才跳过。完整性不同，或除已
确认版本不存在之外的查询失败，都会终止发布。已存在的 GitHub Release 附件会先下载
并逐字节比较；缺失附件可补充，不同附件绝不覆盖。重跑不授权替换不可变产物，发布说明
仍可单独更新。

### 发布说明生成

`scripts/release-notes.py` 沿用 SonicTerm 的确定性发布说明格式：Downloads、Resolved
issues、可选的 Manually closed issues (unverified release linkage)、Changes since
上一个 tag，以及 Verification。它复用 SonicTerm 的 `scripts/release-issues.py`
归属验证器，上游 MIT 声明保留在 `scripts/LICENSE-SonicTerm`。

基准是从发布提交的父提交可达的上一个 tag，而不是版本号最大的 tag。候选 issue 来自
精确的左开右闭提交范围中的关闭关键词和关联 PR，包括合并提交。只有关闭事件指向范围
内仍有效的提交或已合并 PR，才会进入 Resolved issues；去重和规范的 revert 记录可防止
把已发布或已撤销的修复算作本次交付。手工关闭的 issue 单独披露，不视为归属证明。
展示的变更按新到旧排列，仅包含非合并提交的标题和短哈希。

生成需要完整 Git 历史、具有 issue/PR 读取权限的 GitHub CLI 认证、与该提交中包版本
一致的 tag，以及 npm tarball 和匹配的 `SHA256SUMS`。历史或产物缺失、归属不明确、
API 查询失败时，会在输出任何说明之前失败。`PREVIOUS_TAG` 可指定祖先基准；
`RELEASE_FIRST=1` 显式允许首次发布，不能与 `PREVIOUS_TAG` 同时使用。

发布 workflow 会先生成说明，再创建或更新 GitHub Release。这不会阻止并行的 npm 和
GitHub Packages job，因此必须验证所有发布 job，而不能只看包是否可用。单独运行生成器
不会创建 tag 或发布包。它的离线测试包含在 `npm run test:unit` 中。

### 发布细节

- 曾用 `0.0.x` 版本进行 registry 发布冒烟，但它们仍是真实、不可逆的发布。开发时应使用离线候选冒烟测试。
- 推送 `v*` tag 会创建或更新 GitHub Release，并上传 npm tarball 和 `SHA256SUMS`。
- npm 发布使用 npm Trusted Publishing 加 GitHub Actions OIDC，因此 workflow 里需要
  `id-token: write`，而不是 `NPM_TOKEN`。
- 在 npm 上把可信发布者配置为仓库 `D0n9X1n/copilot-relay`、workflow 文件名
  `publish.yml`；npm 会精确匹配这两个字段。
- GitHub Packages 发布使用 `GITHUB_TOKEN`。
- GitHub 上的包以 `@<owner>/copilot-relay` 发布。

## 文档

`wiki/` 是仓库内**唯一**的文档树，也是 GitHub Wiki 标签页的来源。
`.github/workflows/publish-wiki.yml` 在 `main` 上有相关变更时发布它，调用
`scripts/publish-wiki.py build wiki wiki-repo`，把 `README.md` 重命名为 `Home.md`，
并重写扁平内部 `.md` 链接的目标（包括返回 `README.md` 的链接）。行内代码、围栏代码块、
外部 URL 和同页锚点保持原样。workflow 与测试运行同一个脚本，而不是各自维护一份正则替代品。

保证发布正确的几条规则：

- **只能扁平。** 脚本只接受顶层 `.md` 页面，拒绝子目录和符号链接；保留目标目录中的
  `.git` 元数据与非页面文件，仅删除已过期的顶层 `.md` 文件。
- **源码里的链接保留 `.md`** —— `](ZH-Internals.md)` —— 这样在仓库里浏览目录时能正常
  跳转。workflow 会为标签页去掉扩展名。
- **不要跨页锚点。** 像 `](ZH-Internals.md#某节)` 这样的真实链接会在发布前被拒绝，
  变换不会重写它。同页 `#锚点` 链接与代码中的示例没问题。
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
python3 scripts/publish-wiki.py verify /tmp/relay-wiki
```

在代码仓库的 checkout 中运行校验器。它检查代码之外的链接目标、`Home.md`、目录扁平性
以及目标是否存在；已发布正文若残留内部 `.md` 链接，就以非零状态退出。代码字面示例和
文档里的校验命令本身不会误报。离线预览时，先构建到另一个空的临时目录，再对它运行
`verify`。非空目标必须已经是 wiki checkout 或构建目录；不要把源目录当成目标目录。

评审前先运行离线发布器与结构检查：

```sh
python3 scripts/publish-wiki_tests.py
node --import ./scripts/test-bootstrap.mjs --import tsx --test tests/unit/wiki-docs.test.ts
```

流程图使用 Mermaid，每张图尽量不超过十二个节点。只有已安装渲染器时才做本地渲染，
不要为了预览安装工具或上传私有源码。结构测试不能证明渲染正常。发布后再打开标签页，
从 `Home` 点一遍中英文导航，检查两种语言的 Mermaid 图都能显示。离线检查不代表线上
wiki 已发布或已验证。

## 文档的结构性测试

`tests/unit/wiki-docs.test.ts` 用机器强制上面这些规则：`docs/` 不存在、`wiki/` 扁平、
`EN-`/`ZH-` 成对、每个相对链接都能解析、不存在跨页锚点链接、发布变换不留下坏链接、
没有任何被跟踪的文件还引用已删除的 `docs/` 树。

它对真实 wiki 调用生产发布脚本，还会运行 `scripts/publish-wiki_tests.py`：覆盖导航、
代码 span、反引号/波浪号围栏、外部 URL、校验和安全替换扁平目录的离线 fixture。测试使用
临时目录，并隔离 `HOME` 和 `USERPROFILE`，不导入中继，也不访问 Copilot。

这些测试跑在普通单元测试套件里。一个会破坏发布的文档改动，会让 CI 失败，而不是让 wiki
标签页失败。

## 配置优先原则

优先用配置而不是写死行为。如果某个行为可能因人而异，就把它加进
`config.default.yaml`，并在 README 和**两种语言**的[配置说明](ZH-Configuration.md)
里体现这个新键。

`readAppConfig()` 保留原文档，只追加缺失键，发布默认值变化不会迁移已有值。
快照/原子写入须保留符号链接并检测已观察到的并发编辑。Watcher 只读，拒绝部分文档，
保留上一次有效设置。不要重新引入默认值迁移，见[内部实现](ZH-Internals.md)。

`claudeUpstreamApi` 默认 `chat-completions`。原生协议正确性与签名历史测试不能解释
历史拒答。2026-09-30 的有限缓存/客户端检查不能证明广泛无退化或计费等价，不足以支持
提升为默认。应保留[内部实现](ZH-Internals.md)中的证据及边界。

## 日志规则

| 级别 | 记录内容 |
| --- | --- |
| `error` | 启动、preflight、请求、token 刷新和上游失败 |
| `info` | error 的内容，加上启动/preflight 状态、request ID、模型与 effort 摘要、上游生命周期、HTTP 状态及独立的完成/缓存结果 |
| `debug` | info 的内容，加上耗时/捕获路径日志和私有原始已观察正文捕获；不做常规 payload 对象转储 |

其他任何 `logLevel` 值都是非法的，必须让启动失败。

模型/effort 元数据保留在 `info`，原生请求还须标明 API。完成/拒答/截断和缓存用量应与
HTTP 200 分开报告。不能把有界错误上下文当作逐字节记录。只有独立捕获通道存储原始
已观察正文；常规 debug 日志报告耗时和捕获路径，剩余请求/响应上下文是有界错误日志，
不是第二份完整 payload 转储。示例及隐私规则见[日志与问题排查](ZH-Logging-Troubleshooting.md)。

捕获元数据排除认证 header/token 状态。原始提示词/工具结果仍可能包含密钥，**绝不整份
分享**。捕获过载或失败必须明确为不完整，离线重放不得创建 socket 或触碰凭据/配置。
遵循[内部实现](ZH-Internals.md)及[日志与问题排查](ZH-Logging-Troubleshooting.md)
的安全与诊断契约。单行与轮转不变量不是风格问题，不要简化掉。

## 刻意移除的功能

没有产品决策，不要把这些加回来：

- 公开的 `/v1/chat/completions`
- 公开的 `/v1/embeddings`
- `/usage`
- Codex 支持
- 自动模型选择模式（不是可选的 `claudeUpstreamApi: auto` 协议选择器）
- 限流
- 仅 Bun 可用的脚本
- `configVersion` 迁移机制（在 #26 中移除）

模型 ID 是 Copilot 上游 ID。请对照线上的 `/models` 接口核实，不要假设某个名字存在。
