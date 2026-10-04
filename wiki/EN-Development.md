# Development

Setup, checks, and the workflow every change goes through. For the design map see
[Architecture](EN-Architecture.md); for the mechanics and invariants see
[Internals](EN-Internals.md).

## Goal and scope

`copilot-relay` is just another relay for Claude Code to use a GitHub Copilot
subscription. The public API is Claude Code-compatible only:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`
- `GET /healthz`
- `GET|HEAD /api/hello`

The relay may call Copilot `/chat/completions`, `/responses` or native `/v1/messages`
internally; this does not add public OpenAI routes. Do not expand the public surface
without a product decision. Unknown admitted routes return `500` with bounded
compatibility diagnostics. Host/Origin/JSON admission is not network authentication;
keep real listeners on loopback. See [Architecture](EN-Architecture.md).

## Setup and checks

```sh
npm ci --no-audit --no-fund
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
```

Use the committed `package-lock.json`; CI/release installs use `npm ci`, not an
unlocked dependency resolution. Keep root package and lockfile versions aligned.

`npm test` runs the unit and integration suites together. Tests use Node's
built-in runner via `tsx`, with `scripts/test-bootstrap.mjs` preloaded first to
isolate `HOME`, `USERPROFILE` and temporary paths **before any source import**.
Focused tests must retain that preload; see [Internals](EN-Internals.md).
Release-note tests also require Git and Python
3.12 or newer (`python3` on POSIX, `python` on Windows, or the executable named by
`PYTHON`). They use temporary Git repositories and mocked GitHub metadata, never
live GitHub API calls. CI provisions Python 3.12 on all six legs. Python is a
development/release dependency only, not a requirement for running the relay.

Offline release-pipeline tests also need Bash, `jq`, `mkdir`, `cp`, `mktemp`, `rm`,
`basename`, `cmp`, `grep`, and a `tar` that reads archives from standard input on
PATH. Git Bash supplies the shell and Unix utilities on Windows; install `jq`
separately if absent. Both Windows' BSD tar and Git's GNU tar are supported:
`package-smoke.mjs` lists and extracts the same checksummed bytes through stdin,
with the extraction directory set as the child working directory rather than a
Windows drive-qualified archive argument.

Release provenance capture retains output caps and timeouts. On Windows, a child
that has exited with both captured pipes fully drained does not invoke `taskkill`;
exceptions and unfinished captures still perform best-effort tree cleanup.
Detached descendants that close the captured pipes are not guaranteed to be
reaped. POSIX still cleans up the process group; descendants that create a new
session with `setsid` can escape that group.

Prefer unit tests for pure logic — config validation, model routing, token-count
heuristics, Claude/Copilot protocol edge cases. Use integration tests only when
Hono routing or mocked upstream behavior is part of the contract.

Integration tests mock the upstream GitHub Copilot API with a local HTTP server.
They must never call real Copilot services.

## Supported runtimes and CI

`package.json` requires Node `>=22`. CI (`.github/workflows/ci.yml`) runs a
matrix of **Node 22 and 26** across **`ubuntu-latest`, `macos-latest`, and
`windows-latest`** — six legs, all of which must be green:

- install locked dependencies with `npm ci`
- typecheck
- unit tests
- integration tests
- build

Windows is not decorative. It is why any suite touching the config or log path
must set both `HOME` and `USERPROFILE`; see the testing section of
[Internals](EN-Internals.md).

## CLI lifecycle

```sh
copilot-relay auth
copilot-relay start
copilot-relay status
copilot-relay restart
copilot-relay stop
```

`status` and `stop` detect a running relay differently and deliberately so —
`status` is scoped to a port, `stop` scans globally. The reasoning, and the exit
code contract, are in [Internals](EN-Internals.md).

## Workflow: milestone → issue → PR → release

This is the standard for all work. Nothing lands on `main` without an issue and a
PR.

1. **Milestone first.** Titled exactly like the release tag it ships in
   (`v0.2.4`). Create it before the issues that target it.
2. **Issue.** Every change gets one, on the milestone. Labels: `bug`,
   `enhancement`, `documentation`, `question`.
3. **PR.** Branch off `main`, `Closes #N` in the commit body so the issue
   auto-closes on merge. Put the PR on the milestone too. Fill in
   `.github/pull_request_template.md`. Merge commit, delete the branch — the
   remote keeps only `main` plus active branches.
4. **Release.** Bump `package.json`, commit as `Release vX.Y.Z`, tag, push. Close
   the milestone.

Some history predates this — `v0.2.2` shipped by direct push and has no PR — but
it is the rule going forward.

### Required post-merge cleanup

A merged PR is not complete until its inactive feature branches and temporary
worktrees are cleaned up, or preserved exceptions are explicitly reported.

1. Confirm the PR is merged and fetch the current base branch. Check
   `git status --short`, `git worktree list --porcelain`, and branch ancestry;
   a branch's age or name does not prove its work was merged.
2. Check which sessions own the worktrees and locks. Never remove an active
   worktree or clear another session's lock merely to make cleanup succeed.
3. Switch away from the merged feature branch only in a checkout you own.
   Remove clean, inactive worktrees before deleting their local branches with
   `git branch -d`. Use ordinary `git worktree remove`, not forced removal.
4. Delete the confirmed merged remote branch if it remains, then run
   `git fetch --prune origin`. Keep `main` and genuinely active branches.
5. Report the final working-tree status, remaining branches/worktrees, and any
   preserved exceptions. Remove only disposable build outputs, never credentials,
   runtime state, or another session's files.

Uncommitted changes or unique commits block ordinary deletion. Preserve them in
place, or create and verify a private recovery archive before an explicitly
agreed stale-work cleanup. Do not use forced deletion to bypass these checks.

`git branch -d` relies on ancestry and can refuse a squash/rebase-merged branch.
For that case only, `git branch -D` is permitted after confirming all of these:

- The PR is merged and its merge result is reachable from the current base.
- The local branch tip exactly matches the PR's head commit recorded at merge,
  not the resulting squash/rebase commit. Extra or rewritten local commits mean
  preserve the branch, even when the original PR diff landed.
- All changes from that recorded PR head landed. `git cherry -v main <branch>`
  with no `+` entries confirms per-commit patch equivalence; a multi-commit squash
  may still show `+`, so compare the complete PR diff with its squash commit.

Recheck each branch tip immediately before deletion, including the remote tip;
if it changed or the recorded PR head/equivalence cannot be verified, preserve it.
Never infer safety from a PR being closed, or use this exception to force-remove
a dirty or active worktree.

### Milestone membership

Membership is decided by **commit ancestry, not close dates**. Use
`git tag --contains <merge-sha>` and take the earliest tag. Close timestamps are
misleading: an issue closed minutes after a tag ships in the *next* release, and
three issues were assigned wrongly this way before being corrected.

Items closed `wontfix` / `NOT_PLANNED` get **no milestone** — they shipped
nothing, and attaching them misrepresents the release.

## Releasing

**Pushing a tag is irreversible.** `.github/workflows/publish.yml` fires on any
`v*` tag and publishes to **npm** and **GitHub Packages**. npm cannot be
meaningfully unpublished. There is no dry run.

The workflow validates the tag's committed package/lockfile versions, builds one
locked candidate artifact, then gates all three publishing jobs on six source-test
**and packed-artifact smoke** legs. Run the full local gate on the exact tree being
tagged anyway: CI passing on the PR is not the same tree as the release commit.

```sh
gh pr checks <N>                          # all legs green first
gh pr merge <N> --merge --delete-branch
git checkout main && git pull --ff-only
npm version X.Y.Z --no-git-tag-version
npm run typecheck && npm test && npm run build   # on the exact tree to be tagged
git commit -am "Release vX.Y.Z" && git push origin main
git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z   # ← point of no return
```

`npm version ... --no-git-tag-version` must update both `package.json` and
`package-lock.json`; include both in the release commit. Then verify all publish
jobs and actual availability (`npm view copilot-relay version` and
`gh release view vX.Y.Z`) before closing the milestone.

### Immutable candidate gate

`.github/workflows/publish.yml` resolves the release tag to one commit and checks
its package version against the committed lockfile. `candidates` performs one
`npm ci` and build, packs the npm tarball with scripts disabled, and derives the
GitHub Packages tarball by changing only the scoped package name while keeping
`dist` identical. Both tarballs and their `SHA256SUMS` enter one workflow artifact.

All **Node 22/26 × Linux/macOS/Windows** legs run source typecheck/unit/integration/
build and download those exact candidates. `scripts/package-smoke.mjs` checks
checksums, package name/version, then runs only packed JavaScript in an isolated
home with production dependencies from that leg's lockfile install. It exercises
help, the running version, the dynamically loaded tokenizer (which `start` loads
before its server listens) and both translated model routes against a guarded
local mock. It cannot call real Copilot or the installed relay, and it cleans up
only its own child, sockets and temporary files.

Publish jobs verify and publish the already-gated tarball bytes with scripts
disabled: no publish-time rebuild or version rewrite. On rerun, a registry version
is skipped only if its `dist.integrity` matches the candidate. Different integrity
or a lookup failure other than a confirmed missing version aborts publication.
Existing GitHub Release assets are downloaded and byte-compared; missing assets
may be added, differing assets are never clobbered. A rerun is not permission to
replace immutable artifacts. Release notes may still be updated separately.

### Release-note generation

`scripts/release-notes.py` follows SonicTerm's deterministic release-message
format: Downloads, Resolved issues, optional Manually closed issues (unverified
release linkage), Changes since the previous tag, and Verification. It reuses
SonicTerm's `scripts/release-issues.py` provenance collector; the upstream MIT
notice is preserved in `scripts/LICENSE-SonicTerm`.

The base is the previous reachable tag from the release commit's parent, not the
highest version number. Issue candidates come from closing keywords and associated
PRs across the exact base-exclusive/head-inclusive range, including merge commits.
Only closure events tied to active, in-range commits or merged PRs enter Resolved
issues; deduplication and canonical reverts prevent claiming previously shipped or
reverted fixes. Manual closures are disclosed separately, not treated as proof.
Displayed changes are newest-first non-merge commit subjects with short hashes.

Generation requires complete Git history, GitHub CLI authentication with issue/PR
read access, a tag matching that commit's package version, and the npm tarball plus
matching `SHA256SUMS`. Missing history/assets, ambiguous provenance, or failed API
lookups fail before any notes are emitted. `PREVIOUS_TAG` may select an explicit
ancestor base; `RELEASE_FIRST=1` is the explicit first-release opt-in and cannot be
combined with `PREVIOUS_TAG`.

The publish workflow generates notes before creating or updating the GitHub
Release. This does not gate the parallel npm/GitHub Packages jobs: verify all
publish jobs, not just package availability. Running the generator alone never
creates a tag or publishes a package. Its offline tests run under `npm run test:unit`.

### Publishing details

- `0.0.x` versions were used for registry publishing smoke tests; they are still real, irreversible publications. Use offline candidate smoke tests for development.
- Pushing a `v*` tag creates or updates the GitHub Release and uploads the npm
  tarball plus `SHA256SUMS`.
- npm publish uses npm Trusted Publishing with GitHub Actions OIDC, so it
  requires `id-token: write` in the workflow instead of `NPM_TOKEN`.
- Configure npm's trusted publisher for repository `D0n9X1n/copilot-relay` and
  workflow filename `publish.yml`; npm matches these fields exactly.
- GitHub Packages publish uses `GITHUB_TOKEN`.
- The GitHub package is published as `@<owner>/copilot-relay`.

## Documentation

`wiki/` is the **only** in-repo documentation tree and the source for the GitHub
Wiki tab. `.github/workflows/publish-wiki.yml` publishes relevant changes on
`main`. It runs `scripts/publish-wiki.py build wiki wiki-repo`, renaming
`README.md` to `Home.md` and rewriting flat internal `.md` link destinations
(including links back to `README.md`). Inline code, fenced code, external URLs,
and same-page anchors are preserved. The workflow and tests run this same script,
not independent regular-expression copies.

Rules that keep publishing correct:

- **Flat only.** The script accepts only top-level `.md` pages and rejects
  subdirectories and symlinks; it preserves the destination's `.git` metadata
  and non-page files, and removes only stale top-level `.md` files.
- **Source links keep `.md`** — `](EN-Internals.md)` — so they resolve when
  browsing the folder in the repo. The workflow strips the extension for the tab.
- **No cross-page anchors.** An actual link like `](EN-Internals.md#section)`
  is rejected before publishing; the transform does not rewrite it. Same-page
  `#anchor` links and examples inside code are fine.
- **English and 中文 stay synchronized.** Every `EN-` page has a `ZH-`
  counterpart with matching structure.

**One-way.** Edits made in the wiki tab's browser editor are overwritten on the
next publish. Change `wiki/`.

The wiki used to be a separate repo, outside the PR surface. #21 changed the log
filename in v0.2.3, the wiki was not updated, and 30 stale log paths survived two
releases before #29 caught them — every documented `tail` and `grep` silently
matching nothing. In-repo, that change and its doc update land in the same
review. Treat a user-visible path, flag, or command change as incomplete until
`wiki/` reflects it.

### Verifying a wiki change

A merged doc change is not done until the publish workflow succeeded **and** the
live tab shows it:

```sh
gh run list --workflow=publish-wiki.yml --limit 1
gh run view <run-id> --log

git clone https://github.com/D0n9X1n/copilot-relay.wiki.git /tmp/relay-wiki
ls /tmp/relay-wiki                       # Home.md present, tree flat
python3 scripts/publish-wiki.py verify /tmp/relay-wiki
```

Run the verifier from the code checkout. It examines link destinations outside
code, checks `Home.md`, flatness, and target existence, and exits nonzero for an
internal `.md` link left in published prose. It does not flag literal examples
or its own documented command. For an offline preview, build into a separate,
empty temporary folder, then run `verify` on that folder. A nonempty destination
must already be a wiki checkout or build; never use the source folder as the
destination.

Run the offline publisher and structural checks before review:

```sh
python3 scripts/publish-wiki_tests.py
node --import ./scripts/test-bootstrap.mjs --import tsx --test tests/unit/wiki-docs.test.ts
```

Keep flow diagrams in Mermaid, with roughly twelve nodes or fewer per diagram.
Render locally only if a renderer is already installed; do not install one or
upload private source just for a preview. Structural tests do not prove rendering.
After publication, open the tab and click through EN and ZH navigation from `Home`,
and check that Mermaid diagrams render in both languages. An offline check is
not a claim the live wiki was published or verified.

## Structural tests for documentation

`tests/unit/wiki-docs.test.ts` enforces the rules above mechanically: `docs/` is
absent, `wiki/` is flat, `EN-`/`ZH-` pairs match, every relative link resolves,
no cross-page anchor link exists, the publish transform leaves no broken link,
and no tracked file references the removed `docs/` tree.

It invokes the production publisher on the real wiki and also runs
`scripts/publish-wiki_tests.py`: offline fixtures for navigation, code spans,
backtick/tilde fences, external URLs, verification, and safe flat-directory
replacement. These tests use temporary folders and isolated `HOME` and
`USERPROFILE`, without importing the relay or contacting Copilot.

They run in the normal unit suite. A documentation change that breaks publishing
fails CI rather than the wiki tab.

## Code style

Write for the next human reader. `tests/unit/code-style.test.ts` enforces the
mechanical rules below on every script under `src/`, `tests/` and `scripts/`, plus
root config files. It runs in the normal unit suite, so a violation fails CI with
its `file:line`. The check parses source with the TypeScript compiler API the
project already uses, so it adds no linter dependency.

| Enforced rule | Closest ESLint rule |
| --- | --- |
| Every `if`, `else`, `for`, `while` and `do` body is a braced block; only `else if` is exempt | `curly: "all"` |
| Contents never share a line with the `{` or `}` of a non-empty block or a `switch`, class, interface or enum body — no `if (x) { return }` | `@stylistic/brace-style: "1tbs"` |
| `else`, `catch` and `finally` continue the line that closes the previous block | `@stylistic/brace-style: "1tbs"` |
| One statement per line — no `a(); b()` | `@stylistic/max-statements-per-line` |
| A blank line follows each multi-line block statement (`if`, loop, `try`, `switch`, function) | `@stylistic/padding-line-between-statements` (`multiline-block-like`) |
| No blank line directly after `{` or before `}` of a non-empty block or body | `@stylistic/padded-blocks: "never"` |
| At most one blank line in a row outside string and template literals; Python keeps PEP 8's two around top-level definitions | `@stylistic/no-multiple-empty-lines` with `max: 1` |
| No ternary inside a ternary's branch — use `if`/`else`, an early return or a lookup | `no-nested-ternary` |
| `===` and `!==`; `== null` only to match both `null` and `undefined` | `eqeqeq` with `null: "ignore"` |
| `const` or `let` with one variable per declaration; loop headers excepted | `no-var`, `one-var: "never"` |
| Python: no compound one-line statements, `case` clauses included, and no `;` separators | PEP 8 (pycodestyle E701–E704) |

This brace rule is deliberately stricter than the Google, Airbnb and Microsoft
guides, which each allow some brace-less one-line bodies. It matches ESLint's
`curly` default and [CERT C EXP19-C](https://wiki.sei.cmu.edu/confluence/display/c/EXP19-C.+Use+braces+for+the+body+of+an+if%2C+for%2C+or+while+statement):
without braces, a line added under a one-statement body looks conditional but
always runs. That is the shape of Apple's 2014 `goto fail` TLS bug, which CERT
blames "in large part" on not following this recommendation. Adam Langley's
[write-up](https://www.imperialviolet.org/2014/02/22/applebug.html) is more
cautious, because indentation can mislead with braces too: braces remove one easy
mistake, not every misleading layout.

Reviewed rather than enforced:

- Blank lines separate the logical steps of a function, not only blocks.
- Names say what a value is or does; booleans read as predicates; no unexplained
  abbreviations. Renames never change public API, config keys, error codes or
  wire fields.
- Comments state how the code works and why — an invariant, ordering constraint or
  non-obvious reason — not what the next line already says. Fix stale comments
  instead of adding more.
- Code states how it works today, never its history. Comments, test names and
  strings never cite an issue or PR number or tell how a bug was found; that
  history belongs in commit messages, PR descriptions and the wiki.
- Prefer guard clauses to deep nesting.
- Tests separate arrange, act and assert with blank lines; fixtures do not hide
  the behavior under test.

Keep formatting-only commits apart from renames and logic changes, so a reviewer
can confirm the formatting commit compiles to the same program.

## Configuration-first rule

Prefer config over hardcoded behavior. If a behavior can reasonably vary per
user, add it to `config.default.yaml` and reflect the new key in the README and
in [Configuration](EN-Configuration.md) in **both** languages.

`readAppConfig()` preserves the original document and appends only absent keys;
shipped default changes do not migrate saved values. Snapshot/atomic writes must
preserve symlinks and detect observed concurrent edits. The watcher is read-only
and rejects partial documents, retaining the last valid settings. Do not reintroduce
default migrations; see [Internals](EN-Internals.md).

`claudeUpstreamApi` defaults to `chat-completions`. Native protocol correctness and
signed-history tests do not explain historical refusals. The bounded 2026-09-30
cache/client checks do not establish broad non-regression or billing equivalence,
so they do not justify default promotion. Preserve the evidence and limitations in
[Internals](EN-Internals.md).

## Logging rules

| Level | Logs |
| --- | --- |
| `error` | Startup, preflight, request, token refresh, and upstream failures |
| `info` | Errors plus startup/preflight status, request IDs, model/effort summaries, upstream lifecycle, HTTP codes and separate completion/cache outcomes |
| `debug` | Info plus timing/capture-path logs and private raw observed-body captures; no routine payload-object dumps |

Any other `logLevel` value is invalid and must fail startup.

Keep model/effort metadata at `info`; native requests also identify their API.
Report completion/refusal/truncation and cache usage separately from HTTP 200.
Do not promote bounded error-context logs into purported byte-exact recordings.
Only the separate capture channel stores raw observed bodies. Routine debug logs
report timing and capture paths; remaining request/response context is bounded
error logging, not a second full-payload dump. Examples and privacy rules are in
[Logs and troubleshooting](EN-Logging-Troubleshooting.md).

Exclude auth headers/token state from capture metadata. Raw prompts/tool results
can still contain secrets and **must never be shared wholesale**. Capture overload
or failure must be explicitly incomplete; offline replay must not open a socket
or touch credentials/config. Keep the safety and diagnostic contracts in
[Internals](EN-Internals.md) and [Logs and troubleshooting](EN-Logging-Troubleshooting.md).
The one-line and rotation invariants are not stylistic — do not simplify them away.

## Things intentionally removed

Do not reintroduce these without a product decision:

- public `/v1/chat/completions`
- public `/v1/embeddings`
- `/usage`
- Codex support
- Automatic model-selection mode (not the opt-in `claudeUpstreamApi: auto` protocol selector)
- rate limiting
- Bun-only scripts
- `configVersion` migration machinery (removed in #26)

Model IDs are Copilot upstream IDs. Verify against the live `/models` endpoint
rather than assuming a name exists.
