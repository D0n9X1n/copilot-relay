# macOS: LaunchAgent

Recommended option: a per-user LaunchAgent. It starts at login, restarts the
relay if it dies, and runs as you — so it uses your `~/.copilot-relay` token
cache rather than a separate one.

## One-time setup

```sh
npm install -g copilot-relay@latest
copilot-relay auth
which copilot-relay
```

Note the path `which` prints. Apple Silicon Homebrew installs to
`/opt/homebrew/bin`, Intel to `/usr/local/bin`, and nvm to a versioned path under
`~/.nvm`. The plist needs that absolute path.

## Create the plist

Create `~/Library/LaunchAgents/com.d0n9x1n.copilot-relay.plist`, replacing the
executable path and `YOUR_USER`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.d0n9x1n.copilot-relay</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/copilot-relay</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>WorkingDirectory</key>
  <string>/Users/YOUR_USER</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/YOUR_USER/.copilot-relay/logs/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USER/.copilot-relay/logs/launchd.err.log</string>
</dict>
</plist>
```

`copilot-relay start` runs in the **foreground** and handles `SIGTERM`, which is
what launchd expects. Do not add `&`, `nohup`, or any other backgrounding —
launchd would see the process exit immediately and restart it forever.

### Why `KeepAlive` is a dict, not `true`

Two settings here are load-bearing. Getting them wrong gives you a service that
looks fine until you reboot.

**`SuccessfulExit: false`** restarts the relay only when it exits *non-zero*. With
a bare `KeepAlive: true`, launchd also restarts after a clean shutdown — so
`copilot-relay stop` appears to do nothing, because launchd starts it again a
second later. See [Stopping it](#stopping-it).

**`ThrottleInterval: 30`** bounds the restart rate. The relay validates upstream
Copilot access at startup and exits `1` if that fails. At login Wi-Fi has often
not associated yet, so the first attempt legitimately fails. Without a throttle,
launchd retries as fast as the process can fail. Thirty seconds comfortably
outlasts a network coming up, and the relay starts on its own once it does.

The tradeoff: after a reboot the relay may take a minute or two to come up on a
slow network. That is it retrying, not breaking.

## Load and start

```sh
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.d0n9x1n.copilot-relay.plist
launchctl enable "gui/$(id -u)/com.d0n9x1n.copilot-relay"
launchctl kickstart -k "gui/$(id -u)/com.d0n9x1n.copilot-relay"
```

After editing the plist, `bootout` then `bootstrap` again. `kickstart` restarts
the job but does not reload the file.

## Verifying it actually works

### The quick answer

```sh
copilot-relay status
```

```text
copilot-relay 0.2.5
  process    running (pid 93744, up 1h 16m)
  version    0.2.5
  listening  http://127.0.0.1:4142
  health     ok (9ms)
  models     gpt-5.6-sol[1m], claude-opus-5
  upstream   not checked (use --deep)
  log        ~/.copilot-relay/logs/copilot-relay.2026-07-25.log
  config     ~/.copilot-relay/config.yaml
    host                    127.0.0.1
    port                    4142
    …
    gptModel                gpt-5.6-sol
    opusModel               claude-opus-5
    host, port and claudeSetup take effect on restart; the rest hot-reload.
```

The `config` block is abridged above; `status` prints all eleven resolved keys.
See [Configuration](EN-Configuration.md).

The `version` row is the build the running daemon reports about itself, which is
not the same thing as the first line — that is the CLI you just invoked. After
`npm i -g copilot-relay@latest` the two disagree until the agent is actually
restarted:

```text
  version    0.2.6 — MISMATCH, 0.3.0 is installed
```

This matters more under launchd than anywhere else: with `KeepAlive` set, the
job can be restarted out from under a `copilot-relay restart`, so the upgrade
silently does not take. The `version` row is how you tell the difference. Use
`launchctl kickstart -k "gui/$(id -u)/com.d0n9x1n.copilot-relay"` and check
again. A mismatch does not change the exit code — the relay still works, it is
just not the build you installed.

Add `--deep` to also send a real request through Copilot — the only check that
proves the relay can serve Claude Code. It spends a few tokens, which is why it
is opt-in:

```sh
copilot-relay status --deep
```

```text
  upstream   ok (1191ms) — end-to-end Copilot round trip
```

Exit codes, for scripting: `0` running and reachable, `1` not running, `2`
running but not usable — the health probe failed, or `--deep` failed. `--json` emits machine-readable output.

### The three layers, by hand

`status` runs these for you. They are worth understanding, because **the first
two pass on a relay that cannot serve a single request** — and worth having when
you are debugging from a machine without the CLI.

### Layer 1 — is the process alive?

```sh
launchctl print "gui/$(id -u)/com.d0n9x1n.copilot-relay" | grep -E "state|pid|last exit"
curl -s http://127.0.0.1:4142/healthz
```

Expect `{"ok":true}`. This is a static handler: it proves a socket is listening
and nothing more. It never contacts GitHub Copilot.

### Layer 2 — did config parse and routing resolve?

```sh
curl -s http://127.0.0.1:4142/v1/models
```

Expect your configured models, e.g. `gpt-5.6-sol[1m]` and `claude-opus-5`. This
is served from config and **also never contacts upstream**. A relay whose Copilot
token expired an hour ago passes layers 1 and 2.

### Layer 3 — end to end

```sh
curl -s -X POST http://127.0.0.1:4142/v1/messages \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"gpt-5.6-sol","max_tokens":16,
       "messages":[{"role":"user","content":"Reply with the single word: ok"}]}'
```

A `200` with `content` and non-zero `usage` proves the whole path: config, token
refresh, the Copilot call, and translation back to Claude shape. **This is the
only check that proves the relay can serve Claude Code.** It costs a handful of
tokens.

Layers 1 and 2 passing while layer 3 fails means auth or upstream, not the
service registration — run `copilot-relay auth` and read today's log.

### Watching the log

```sh
tail -f ~/.copilot-relay/logs/copilot-relay.$(date +%F).log
```

The log rotates daily and the filename carries the local date. To search every
retained day, use the glob:

```sh
grep -n "Startup preflight failed" ~/.copilot-relay/logs/copilot-relay.*.log
```

`launchd.err.log` catches anything written before the relay's own logger starts.
Check it when the service will not start at all.

## Stopping it

Which command you want depends on whether you want it to *stay* stopped.

Stop now, let launchd start it again at next login:

```sh
launchctl kill SIGTERM "gui/$(id -u)/com.d0n9x1n.copilot-relay"
```

Stop now and unload the job — it will not come back until you bootstrap it again:

```sh
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.d0n9x1n.copilot-relay.plist
```

Restart:

```sh
launchctl kickstart -k "gui/$(id -u)/com.d0n9x1n.copilot-relay"
```

### `copilot-relay stop` and launchd

`copilot-relay stop` finds and terminates the relay directly. It exits cleanly,
so with `SuccessfulExit: false` launchd leaves it stopped — CLI and supervisor
agree.

With a bare `KeepAlive: true`, launchd restarts it within seconds and the CLI
looks like it did nothing. If you are seeing that, your plist is the old one.

To confirm a relay is gone regardless of supervisor:

```sh
copilot-relay stop
lsof -nP -iTCP:4142 -sTCP:LISTEN   # should print nothing
```

### Removing it permanently

```sh
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.d0n9x1n.copilot-relay.plist
rm ~/Library/LaunchAgents/com.d0n9x1n.copilot-relay.plist
```

## Troubleshooting

**Will not start, `last exit code = 1`.** Preflight failed: expired auth or no
network. Read the tail of today's log, then `copilot-relay auth`.

**Restarts in a loop.** Confirm `ThrottleInterval` is present. A repeating exit
code `1` in `launchctl print` is preflight failing, which is auth or
connectivity — not the plist.

**`Operation not permitted` on bootstrap.** The plist is usually not owned by you
or has wrong permissions. `chmod 644` and check ownership.

**Relay runs but Claude Code ignores it.** Registration is fine; check
`ANTHROPIC_BASE_URL` in `~/.claude/settings.json`. With `claudeSetup: true` the
relay manages that itself at start.
