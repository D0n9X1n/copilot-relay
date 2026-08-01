# CLAUDE.md

Working conventions for `copilot-relay`. Read before opening a PR or cutting a release.

## Workflow

**Milestone → issue → PR → release.** This is the standard for all work.

1. **Milestone first.** Titled exactly like the release tag it ships in (`v0.2.4`). Create it before the issues that target it.
2. **Issue.** Every change gets one, on the milestone. Labels: `bug`, `enhancement`, `documentation`, `question`.
3. **PR.** Branch off `main`, `Closes #N` in the commit body so the issue auto-closes on merge. Put the PR on the milestone too. Fill in `.github/pull_request_template.md`. Merge commit, delete the branch — the remote keeps only `main` plus active branches.
4. **Release.** Bump `package.json`, commit as `Release vX.Y.Z`, tag, push. Close the milestone.

Nothing lands on `main` without an issue and a PR. (Some history predates this — `v0.2.2` shipped by direct push and has no PR — but it is the rule going forward.)

## Releasing

**Pushing a tag is irreversible.** `.github/workflows/publish.yml` fires on any `v*` tag and publishes to **npm** and **GitHub Packages**. npm cannot be meaningfully unpublished. There is no dry run.

The workflow's `test` job gates the three publish jobs, but run the full gate locally on the exact tree being tagged anyway — CI passing on the PR is not the same tree as the release commit.

```sh
gh pr checks <N>                          # all legs green first
gh pr merge <N> --merge --delete-branch
git checkout main && git pull --ff-only
npm version X.Y.Z --no-git-tag-version
npm run typecheck && npm test && npm run build   # on the exact tree to be tagged
git commit -am "Release vX.Y.Z" && git push origin main
git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z   # ← point of no return
```

Then verify it actually shipped — `npm view copilot-relay version` and `gh release view vX.Y.Z` — and close the milestone.

CI runs `ubuntu-latest`, `macos-latest`, **and `windows-latest`**. All three must be green.

## Milestones

- One per release tag, same title.
- **Membership is decided by commit ancestry, not close dates.** Use `git tag --contains <merge-sha>` and take the earliest tag. Close timestamps are misleading: an issue closed minutes after a tag ships in the *next* release, and three issues were assigned wrongly this way before being corrected.
- Items closed `wontfix` / `NOT_PLANNED` get **no milestone** — they shipped nothing, and attaching them misrepresents the release.
- Description links to the release notes for that tag.
- Close the milestone when its release ships.

## Documentation

**`wiki/` is the only in-repo documentation tree and the source for the GitHub Wiki tab.** There is no `docs/`. It was merged into `wiki/` in #49/#50 — two trees meant the same fact was written twice, drifted, and a reader had to know which one was current.

Both audiences live there. High-level architecture *and* precise technical detail belong in `wiki/`, written to be navigable by humans and by coding agents:

- `EN-How-It-Works` / `ZH-How-It-Works` — the short, approachable version.
- `EN-Architecture` / `ZH-Architecture` — the map: modules, request and startup flow, public API, runtime files, boundaries.
- `EN-Internals` / `ZH-Internals` — precise mechanics and the invariants that hold them: translation, streaming, prompt caching, lifecycle, logging, testing. Name source paths and symbols, not line numbers — line numbers go stale, names do not.
- `EN-Development` / `ZH-Development` — setup, tests, CI matrix, workflow, releasing.
- `EN-Configuration` / `ZH-Configuration` — user-facing config reference.
- `EN-Logging-Troubleshooting` / `ZH-Logging-Troubleshooting` — log format and operational recipes.
- Per-platform service pages.

Keep the split clean *within* the wiki: user-facing configuration stays in Configuration, deep mechanics stay in Internals, and pages cross-link rather than restating each other. Duplicated prose is how the two trees drifted in the first place.

**English and 中文 must stay synchronized.** Every `EN-` page has a `ZH-` counterpart with matching structure and technically equivalent content — not a fragmentary machine translation. `tests/unit/wiki-docs.test.ts` fails the build if a pair is missing.

Publishing constraints, all enforced by that same test:

- **Flat only.** `.github/workflows/publish-wiki.yml` copies top-level `wiki/*.md`; a subdirectory is silently not published.
- **Source links keep `.md`** — `](EN-Internals.md)` — so they resolve when browsing the folder. The workflow strips the extension for the tab and renames `README.md` to `Home.md`.
- **No cross-page anchors.** `](EN-Internals.md#section)` is not rewritten by the transform and 404s on the tab. Same-page `#anchor` links are fine.
- Preserve real external links (`https://docs.anthropic.com/...`); they are not internal references.

**One-way.** Edits made in the wiki tab's browser editor are overwritten on the next publish. Change `wiki/`.

**Every `wiki/` update is incomplete until the publish workflow has succeeded and the live tab has been verified.** Merging is not shipping — the workflow can fail, and a broken link only appears after the transform runs:

```sh
gh run list --workflow=publish-wiki.yml --limit 1     # expect success on your merge SHA
gh run view <run-id> --log                            # read it when it is not

git clone https://github.com/D0n9X1n/copilot-relay.wiki.git /tmp/relay-wiki
ls /tmp/relay-wiki                                    # Home.md present, tree flat
grep -rn "](.*\.md)" /tmp/relay-wiki || echo "no unstripped .md links"
```

Then open the tab and click through both the English and 中文 navigation from `Home`, including any page you added or renamed.

The wiki used to be a separate repo, outside the PR surface. #21 changed the log filename in v0.2.3, the wiki was not updated, and 30 stale log paths survived two releases before #29 caught them — every documented `tail` and `grep` silently matching nothing. In-repo, that change and its doc update land in the same review. Treat a user-visible path, flag, or command change as incomplete until `wiki/` reflects it.

## Config

`readAppConfig()` writes the resolved config back to `~/.copilot-relay/config.yaml`, so an existing install has **every key materialized**. A `?? defaultConfig.x` fallback is never consulted again there.

Consequence: **changing a shipped default reaches fresh installs only.** That is intended. A user's config value is theirs; do not add migration machinery to push a new default onto existing installs. A `configVersion` mechanism existed briefly for exactly that and was removed in #26 as unnecessary complexity.

Configuration-first rule: if behavior might reasonably vary per user, add a config key rather than hardcoding. Reflect any new key in `config.default.yaml`, README, and `wiki/` — `EN-Configuration.md` **and** `ZH-Configuration.md`.

## Logging

Two invariants, both learned from a log that reached 9.3 GB:

**One entry, one physical line.** `formatLogValue` needs *both* `compact: true` and `breakLength: Infinity`. The Node docs read as though the default `compact: 3` suffices — it does not. The number counts inner elements united, not a threshold, so it only collapses payloads nesting no deeper than that count. On a real 4-level error payload: `compact: 3` → 10 lines, `compact: 1` → **22**, `compact: true` → 1. `tests/unit/log-format.test.ts` pins this; do not "simplify" it away. Multi-line dumps also break every `grep` recipe in `wiki/EN-Logging-Troubleshooting.md`.

**Retention needs rotation.** The active file is `copilot-relay.<local-date>.log`, resolved per write so it rotates at local midnight with no timer. Retention ages files by the **filename date**, falling back to mtime for undated files. Before rotation existed, retention aged one never-rotated file by mtime, every append refreshed that mtime, and it was never once eligible for deletion. Local date, not UTC — `logRetentionDays` is a human "how many days" setting.

Log volume is bounded by time, not size. Accepted (#25).

## Tests

```sh
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
```

Any suite that touches the log or config path **must redirect the home directory before importing** `src/` — `paths.ts` resolves from `os.homedir()` at import time, so use a dynamic `import()` after setting it.

Set **both `HOME` and `USERPROFILE`**. Node reads `USERPROFILE` on Windows, and CI runs `windows-latest`, so setting only `HOME` leaves the redirect silently ineffective there. Without this the suite writes into the developer's live `~/.copilot-relay/logs` on every run.

Integration tests mock upstream Copilot. They must never call the real service.

## Public API

Claude Code-compatible only: `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models`, `GET /healthz`. Unknown routes return 500 and log the payload for later compatibility work. Do not add routes outside this surface without a deliberate product decision.

**`/healthz` and `/v1/models` prove nothing about upstream.** The first is a static handler; the second maps config and never contacts Copilot. A relay whose token expired an hour ago passes both. Only `POST /v1/messages` exercises token refresh and a real Copilot call — that is why `copilot-relay status --deep` exists and why the cheap checks are not enough on their own.

**`status` and `stop` ask different questions, and must detect differently.** `status` uses `findRelayOnPort` — pid file when its port matches, else the port-listener check, never the global process scan. `stop` uses `findRelayProcessIds`, which does scan globally, because cleaning up strays on any port is the point. Do not "unify" these: giving `status` the global scan makes it report a relay on a port nothing is listening on (#33), and scoping `stop` would leave strays behind.

Whatever `status` reports, pid and address must come from the same record. Pairing a pid found one way with an address taken from another is how #33 printed a live pid next to a dead port.

**Exit codes are a contract.** `0` requires a live process *and* a passing health probe; `1` is no relay; `2` is running but not usable. Printing `FAILED` while exiting `0` makes every scripted caller treat a broken relay as fine (#34).

**`server.close()` alone does not shut down.** It waits for existing connections, and an idle Claude Code keep-alive socket never finishes on its own — so shutdown hangs until `stop` escalates to `SIGKILL`, which skips pid-file cleanup and severs streams anyway (#35). The handler must call `closeIdleConnections()` immediately and `closeAllConnections()` after a grace period shorter than `stopProcess`'s 5s timeout.

Model IDs are Copilot upstream IDs. Verify against the live `/models` endpoint rather than assuming a name exists.

Never log token values.
