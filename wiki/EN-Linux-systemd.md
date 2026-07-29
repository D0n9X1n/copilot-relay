# Linux: systemd user service

Recommended option: `systemd --user`. It starts at login, restarts the relay if
it dies, and runs as you — so it uses your `~/.copilot-relay` token cache rather
than a separate one.

## One-time setup

```sh
npm install -g copilot-relay@latest
copilot-relay auth
command -v copilot-relay
```

## Create the user service

```sh
mkdir -p ~/.config/systemd/user
RELAY_BIN="$(command -v copilot-relay)"

cat > ~/.config/systemd/user/copilot-relay.service <<EOF
[Unit]
Description=copilot-relay for Claude Code
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${RELAY_BIN} start
WorkingDirectory=%h
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
EOF
```

`copilot-relay start` runs in the **foreground** and handles `SIGTERM`, so
`Type=simple` is correct. Do not add `&` or `nohup` — systemd would treat the
immediate exit as a failure and restart it forever.

### Why `on-failure` and not `always`

Three settings here are load-bearing, and the defaults most guides use are wrong
for this service.

**`Restart=on-failure`** restarts only on a non-zero exit. With `Restart=always`,
systemd also restarts after a clean shutdown — so `copilot-relay stop` appears to
do nothing, because systemd starts it again immediately. See
[Stopping it](#stopping-it).

**`RestartSec=30`** bounds the retry rate. The relay validates upstream Copilot
access at startup and exits `1` if that fails. At boot the network is often not
up yet, so the first attempt legitimately fails. `RestartSec=5` retries twelve
times a minute against a network that is not there.

**`StartLimitIntervalSec=300` + `StartLimitBurst=5`** stop the loop entirely: more
than 5 failures in 5 minutes puts the unit in `failed` and systemd stops trying.
That converts an invisible loop into a visible, diagnosable state.

`After=network-online.target` orders startup but does not guarantee reachability,
so the retry policy still matters.

## Enable and start

```sh
systemctl --user daemon-reload
systemctl --user enable --now copilot-relay.service
```

After editing the unit file, `daemon-reload` before `restart` or systemd keeps
using the old definition.

## Start before login

A `--user` service normally starts at login and stops at logout. To keep the
relay running on a headless box or across logout:

```sh
sudo loginctl enable-linger "$USER"
```

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
`npm i -g copilot-relay@latest` the two disagree until the service is actually
restarted:

```text
  version    0.2.6 — MISMATCH, 0.3.0 is installed
```

Under systemd that usually means the unit was never reloaded. `systemctl --user
restart copilot-relay` and check again. A mismatch does not change the exit
code — the relay still works, it is just not the build you installed.

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
running but not usable — the health probe failed, or `--deep` failed. `--json` emits machine-readable output. That makes it usable
directly in a unit:

```ini
ExecStartPost=/usr/bin/env copilot-relay status
```

### The three layers, by hand

`status` runs these for you. They are worth understanding, because **the first
two pass on a relay that cannot serve a single request** — and worth having when
you are debugging from a machine without the CLI.

### Layer 1 — is the process alive?

```sh
systemctl --user status copilot-relay.service
curl -s http://127.0.0.1:4142/healthz
```

Expect `active (running)` and `{"ok":true}`. That endpoint is a static handler:
it proves a socket is listening and nothing more. It never contacts GitHub
Copilot.

### Layer 2 — did config parse and routing resolve?

```sh
curl -s http://127.0.0.1:4142/v1/models
```

Expect your configured models, e.g. `gpt-5.6-sol[1m]` and `claude-opus-5`. Served
from config; **also never contacts upstream**. A relay whose Copilot token expired
an hour ago passes layers 1 and 2.

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

Layers 1 and 2 passing while layer 3 fails means auth or upstream, not the unit
file — run `copilot-relay auth` and read today's log.

### Reading logs

systemd captures stdout in the journal; the relay also writes its own rotating
file. The journal is better for startup failures, the file for request history.

```sh
journalctl --user -u copilot-relay.service -n 100 --no-pager
journalctl --user -u copilot-relay.service -f

tail -f ~/.copilot-relay/logs/copilot-relay.$(date +%F).log
```

The log rotates daily and the filename carries the local date. To search every
retained day, use the glob:

```sh
grep -n "Startup preflight failed" ~/.copilot-relay/logs/copilot-relay.*.log
```

## Stopping it

Stop now, let systemd start it again at next login:

```sh
systemctl --user stop copilot-relay.service
```

Stop now and do not start at login again:

```sh
systemctl --user disable --now copilot-relay.service
```

Restart:

```sh
systemctl --user restart copilot-relay.service
```

### `copilot-relay stop` and systemd

`copilot-relay stop` finds and terminates the relay directly. It exits cleanly,
so with `Restart=on-failure` systemd leaves it stopped — CLI and supervisor
agree.

With `Restart=always`, systemd restarts it after `RestartSec` and the CLI looks
like it did nothing. If you are seeing that, your unit is the old one.

To confirm a relay is gone regardless of supervisor:

```sh
copilot-relay stop
ss -ltnp 'sport = :4142'   # should print no LISTEN row
```

### Removing it permanently

```sh
systemctl --user disable --now copilot-relay.service
rm ~/.config/systemd/user/copilot-relay.service
systemctl --user daemon-reload
```

## Troubleshooting

**`failed` with `start-limit-hit`.** More than 5 failures in 5 minutes, so systemd
gave up — by design. Fix the cause, then clear the latch:

```sh
systemctl --user reset-failed copilot-relay.service
systemctl --user start copilot-relay.service
```

It will not retry on its own until you do this.

**Repeating `status=1`.** Preflight failing: expired auth or no network. Check
`journalctl` and today's log, then `copilot-relay auth`.

**Service dies at logout.** You need lingering: `sudo loginctl enable-linger "$USER"`.

**`command -v copilot-relay` empty inside the unit.** A `--user` unit does not get
your interactive shell PATH. `ExecStart` above bakes in the absolute path at
creation time, which avoids this — if you edited it to a bare command, put the
full path back.

**Relay runs but Claude Code ignores it.** Registration is fine; check
`ANTHROPIC_BASE_URL` in `~/.claude/settings.json`. With `claudeSetup: true` the
relay manages that itself at start.
