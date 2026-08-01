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

The proxy may call Copilot `/chat/completions` and `/responses` internally, but
those routes are not public. Do not add routes outside this surface without a
deliberate product decision. Unknown routes return `500` and log the payload for
later compatibility work.

## Setup and checks

```sh
npm install
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
```

`npm test` runs the unit and integration suites together. Tests use Node's
built-in test runner via `tsx`.

Prefer unit tests for pure logic — config validation, model routing, token-count
heuristics, Claude/Copilot protocol edge cases. Use integration tests only when
Hono routing or mocked upstream behavior is part of the contract.

Integration tests mock the upstream GitHub Copilot API with a local HTTP server.
They must never call real Copilot services.

## Supported runtimes and CI

`package.json` requires Node `>=22`. CI (`.github/workflows/ci.yml`) runs a
matrix of **Node 22 and 26** across **`ubuntu-latest`, `macos-latest`, and
`windows-latest`** — six legs, all of which must be green:

- install dependencies
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

The workflow's `test` job gates the three publish jobs, but run the full gate
locally on the exact tree being tagged anyway — CI passing on the PR is not the
same tree as the release commit.

```sh
gh pr checks <N>                          # all legs green first
gh pr merge <N> --merge --delete-branch
git checkout main && git pull --ff-only
npm version X.Y.Z --no-git-tag-version
npm run typecheck && npm test && npm run build   # on the exact tree to be tagged
git commit -am "Release vX.Y.Z" && git push origin main
git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z   # ← point of no return
```

Then verify it actually shipped — `npm view copilot-relay version` and
`gh release view vX.Y.Z` — and close the milestone.

### Publishing details

- `0.0.x` versions are for package publishing smoke tests.
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
Wiki tab. `.github/workflows/publish-wiki.yml` publishes it on every merge to
`main`, renaming `README.md` to `Home.md` and stripping `.md` from simple
internal links.

Rules that keep publishing correct:

- **Flat only.** The workflow copies `wiki/*.md` at the top level; a
  subdirectory is silently not published.
- **Source links keep `.md`** — `](EN-Internals.md)` — so they resolve when
  browsing the folder in the repo. The workflow strips the extension for the tab.
- **No cross-page anchors.** `](EN-Internals.md#section)` is not rewritten by the
  transform and 404s on the tab. Same-page `#anchor` links are fine.
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
grep -rn "](.*\.md)" /tmp/relay-wiki || echo "no unstripped .md links"
```

Then open the tab and click through the EN and ZH navigation from `Home`.

## Structural tests for documentation

`tests/unit/wiki-docs.test.ts` enforces the rules above mechanically: `docs/` is
absent, `wiki/` is flat, `EN-`/`ZH-` pairs match, every relative link resolves,
no cross-page anchor link exists, the publish transform leaves no broken link,
and no tracked file references the removed `docs/` tree.

It runs in the normal unit suite. A documentation change that breaks publishing
fails CI rather than the wiki tab.

## Configuration-first rule

Prefer config over hardcoded behavior. If a behavior can reasonably vary per
user, add it to `config.default.yaml` and reflect the new key in the README and
in [Configuration](EN-Configuration.md) in **both** languages.

Shipped defaults apply to fresh installs only, because `readAppConfig()` persists
the resolved config. Do not add migration machinery to force a new default onto
an existing install — a user's config value is theirs. See
[Internals](EN-Internals.md).

## Logging rules

| Level | Logs |
| --- | --- |
| `error` | Startup, preflight, request, token refresh, and upstream failures |
| `info` | Errors plus startup status, preflight status, request IDs, upstream lifecycle, and local HTTP status codes |
| `debug` | Info plus model routing summaries, Copilot upstream timings, and request payloads |

Any other `logLevel` value is invalid and must fail startup.

At `debug`, every model request must log client type, requested model, upstream
model, requested think effort, requested thinking budget, and effective think
effort. At `error`, log upstream failures with full request and response context
in the same log file.

Never log token values. The one-line and rotation invariants in
[Internals](EN-Internals.md) are not stylistic — do not simplify them away.

## Things intentionally removed

Do not reintroduce these without a product decision:

- public `/v1/chat/completions`
- public `/v1/embeddings`
- `/usage`
- Codex support
- Auto mode
- rate limiting
- Bun-only scripts
- `configVersion` migration machinery (removed in #26)

Model IDs are Copilot upstream IDs. Verify against the live `/models` endpoint
rather than assuming a name exists.
