# Commands

`copilot-relay` is one executable with several commands. This page lists what
each command does, its options, what it reads, writes and contacts, and how it
exits. Settings live in `~/.copilot-relay/config.yaml`; see
[Configuration](EN-Configuration.md).

`--help` or `-h` prints the usage of the CLI, or of one command, and exits `0`:

```sh
copilot-relay --help
copilot-relay models --help
```

There is no `--version` option: `copilot-relay --version` prints
`No version specified` and exits `1`. `copilot-relay status` prints the version of
the CLI that ran it and, when a relay is running, the version that relay reports,
or `unknown` for a relay that does not report one.

## Summary

| Command | What it does | Contacts |
| --- | --- | --- |
| `start` | Runs the relay in the foreground | GitHub, Copilot |
| `stop` | Stops every relay it finds, on any port | Nothing |
| `restart` | Runs `stop`, then `start` | GitHub, Copilot |
| `status` | Shows whether the relay on the configured port is running and usable | The relay; with `--deep`, Copilot through it |
| `auth` | Signs in to GitHub with a device code | GitHub |
| `models` | Lists, searches or tests Copilot's models | GitHub, Copilot |
| `usage` | Shows the Copilot plan and quota | GitHub |
| `cache` | Reports prompt-cache hit rates from local logs | Nothing |
| `replay` | Replays a debug capture offline | Nothing |

`start`, `restart`, `stop`, `status`, `auth` and `models` load `config.yaml` the
way the relay does: they create it when it is missing and add any missing key with
its default, leaving existing keys as they are. A file that cannot be parsed, or
that holds a value the relay rejects, is not rewritten. `usage` reads the file and
never writes it. `cache` and `replay` do not read it.

## `start`

```sh
copilot-relay start
```

Runs the relay's HTTP server in the foreground until it receives `SIGINT` or
`SIGTERM`. It has no options. In order, it:

1. Loads `config.yaml`. If the file cannot be loaded, it stops here, before it
   signs in.
2. Reads the GitHub token stored in `~/.copilot-relay/github_token`. With no
   stored token, it starts a device-code sign-in: it logs a URL and a code, waits
   until the code is entered, and stores the new token.
3. Gets a Copilot token. It reuses the one stored in
   `~/.copilot-relay/copilot_token.json` while more than 60 seconds of it remain,
   and otherwise exchanges the GitHub token for a new one. If GitHub refuses to
   issue a Copilot token, it runs the device-code sign-in again and retries the
   exchange once.
4. Runs the startup preflight: Copilot's model catalog must list `gptModel` and
   `opusModel`, and each must answer a short request. Otherwise it logs
   `Startup preflight failed:` with the reason and exits `1`.
5. Listens on `host` and `port`, writes its pid to
   `~/.copilot-relay/copilot-relay.pid`, and logs
   `copilot-relay listening on <url>`.
6. With `claudeSetup: true`, the default, updates `~/.claude/settings.json` with
   the local relay endpoint. A failure here is logged; the relay keeps running.

While it runs, it applies changes to `config.yaml`, except for the keys listed as
requiring a restart under "Hot reload vs restart" in
[Configuration](EN-Configuration.md). With `upstreamProxy` set, its GitHub and
Copilot requests go through that proxy. It writes its log to
`~/.copilot-relay/logs/` and applies `logRetentionDays` to its logs and debug
captures.

On `SIGINT` or `SIGTERM` it stops accepting connections, closes idle connections at
once and the rest after two seconds, then removes the pid file.

It exits `1` when startup fails, for example when the port is already in use. After
a signal it exits `0`, or `1` if closing the server failed.

To keep the relay running after you log out or restart, register it as a service:
[Windows Task Scheduler](EN-Windows-Service.md),
[macOS LaunchAgent](EN-macOS-LaunchAgent.md) or
[Linux systemd user service](EN-Linux-systemd.md).

## `stop`

```sh
copilot-relay stop
```

Stops every copilot-relay server on the machine, on any port. It has no options.

It collects candidates from the pid file, the processes listening on the configured
port and the process list, and signals only a process it has verified to be a
copilot-relay server: `SIGTERM`, then `SIGKILL` if the process is still running
five seconds later. With none found, it logs
`No existing copilot-relay instance found`. It removes the pid file unless the
process it names is still running.

It does not need a valid `config.yaml`. When the file cannot be loaded, it logs
that and still stops the relays it can verify, without the configured port as a
hint. When the file loads, it also applies `logRetentionDays` to the logs.

It exits `0` when it stopped every relay it found, or found none, and `1` when it
could not inspect the processes or could not stop a relay it found.

A service manager may start the relay again after `stop`; each service page
describes how `stop` interacts with its manager. Why `stop` searches every port
while `status` checks only the configured one is under "Lifecycle: status and stop
ask different questions" in [Internals](EN-Internals.md).

## `restart`

```sh
copilot-relay restart
```

Stops every relay it finds, as `stop` does, then starts one, as `start` does, in
the same process: the new relay runs in the foreground of the terminal that ran
`restart`. It has no options.

Unlike `stop`, it needs a valid `config.yaml`: when the file cannot be loaded, it
exits `1` before it stops anything. It also exits `1` when it cannot stop a running
relay. From then on it exits as `start` does.

Run it after an upgrade, so the relay serves the version you installed. A relay
run by a service manager is restarted through that manager instead; see "A new
version did not take effect" in
[Logs and troubleshooting](EN-Logging-Troubleshooting.md).

## `status`

```sh
copilot-relay status
copilot-relay status --deep --json
```

| Option | Description |
| --- | --- |
| `--deep` | Also send a real request through Copilot. Proves the relay works end to end; spends a few tokens. |
| `--json` | Emit machine-readable JSON. |

Shows whether the relay on the configured port is running and usable. It finds that
relay from the pid file when the file's port matches, and otherwise from the process
listening on the port; it never reports a relay on another port. For a running
relay it requests `/healthz` and, when that passes, `/v1/models`; with `--deep` it
also sends a short `POST /v1/messages`, which goes through the relay to Copilot.
`/healthz` and `/v1/models` never contact Copilot.

The first line shows the version of the CLI that ran `status`. For a running relay,
the `version` row shows the version the relay reports, `unknown` for a relay that
does not report one, or a mismatch with the installed version together with the
command to restart it.

| Exit | Meaning |
| --- | --- |
| `0` | A relay is running and passed `/healthz`, and `--deep` if given. A version mismatch still exits `0`. |
| `1` | No relay is running on the configured port. |
| `2` | `/healthz` or `--deep` failed, `config.yaml` could not be loaded, or the process state could not be verified. |

Scripts can rely on these codes; see "Exit codes are a contract" in
[Internals](EN-Internals.md), and "What the cheap endpoints do and do not prove" in
[Architecture](EN-Architecture.md).

## `auth`

```sh
copilot-relay auth
```

Signs in to GitHub with a device code, even when a GitHub token is already stored.
It has no options. It logs a URL and a code, waits until the code is entered, and
writes the new token to `~/.copilot-relay/github_token`. It then gets a Copilot
token: it reuses the one stored in `~/.copilot-relay/copilot_token.json` while more
than 60 seconds of it remain, and otherwise exchanges the new GitHub token for a
new one. It logs the GitHub account it signed in to when GitHub returns it. It
starts no relay.

Its requests go through `upstreamProxy`, so when GitHub is reachable only through a
proxy, set `upstreamProxy` in `config.yaml` first. It exits `1` when loading
`config.yaml`, the sign-in or getting the Copilot token fails, and `0` otherwise.
Looking up the account name is best effort: when it fails, the command logs that
and still exits `0`.

`start` and `models` run the same device-code sign-in when no GitHub token is
stored, so `auth` is for signing in ahead of time or replacing a stored token.
`usage` never signs in. Both token files are described under "Token cache
problems" in [Logs and troubleshooting](EN-Logging-Troubleshooting.md).

## `models`

```sh
copilot-relay models                                   # list
copilot-relay models opus                              # search by ID or display name
copilot-relay models --deep --model claude-opus-5.5    # test one model
```

| Argument or option | Description |
| --- | --- |
| `[SEARCH]` | Find models by ID or display name and print the config line to use. |
| `--deep` | Send real inference probes through an isolated relay pipeline; consumes Copilot usage. |
| `--details` | Show safe request, route and replay evidence for each probe (requires --deep). |
| `--model` | Test only this exact upstream ID (requires --deep). |
| `--effort` | Probe effort override; otherwise use the lowest advertised effort, or unverified low. |
| `--max-tokens` | Output budget per probe (default 4096; bounded by catalog limits). |
| `--timeout` | Positive per-probe timeout in seconds (default 30; bounded by configured timeout). |
| `--total-timeout` | Positive timeout in seconds for all probes (default 300). |

Lists the model IDs Copilot's catalog advertises, marking the ones the relay cannot
use; the listing does not verify that a model works. Unquoted words form one search,
and a search prints the matching models and the `config.yaml` line that selects one.
`--deep` checks the `--model` ID, or every entry in the catalog. It sends a real
request only to an entry it can probe before the total timeout; the other entries
get a status without a request. The requests go through a relay pipeline built
inside the command's own process rather than a running relay, and consume Copilot
usage. Every other option requires `--deep`, and a search cannot be combined with
it: find the ID first, then test it with `--deep --model <id>`. It loads
`config.yaml` and signs in as `start` does; with `--deep`, the device-code prompt
goes to stderr.

| Exit | Meaning |
| --- | --- |
| `0` | The list was printed, a search matched, or every entry `--deep` checked passed. |
| `1` | A search matched nothing (the closest IDs are printed, if any), an option was unusable, the `--model` ID is not in the catalog, or loading the config, signing in, loading the catalog or running the checks failed. |
| `2` | An entry `--deep` checked did not pass, including one it could not probe, or there was no entry to check. |
| `130` | `SIGINT` or `SIGTERM` interrupted `--deep`. |

How to choose models, and how to read the `--deep` output, are under "Choose models
and thinking effort" in [Configuration](EN-Configuration.md).

## `usage`

```sh
copilot-relay usage
copilot-relay usage --json
```

| Option | Description |
| --- | --- |
| `--json` | Print the plan and quota fields as a JSON object. |

Shows the Copilot plan of the account behind the stored GitHub token, and how much
of each quota is left. It sends the token from `~/.copilot-relay/github_token` to
GitHub, through `upstreamProxy` when `config.yaml` sets it, so no relay needs to
run. It never signs in, exchanges no Copilot token and writes nothing, the log
included. It exits `0` with the report, or `1` with a one-line reason on stderr,
such as no stored token. The fields and messages are under "Copilot plan and quota"
in [Logs and troubleshooting](EN-Logging-Troubleshooting.md).

## `cache`

```sh
copilot-relay cache
copilot-relay cache --hourly --since 2d
```

| Option | Description |
| --- | --- |
| `--hourly` | Show the trend by local hour. Covers the last 24 hours unless --since is given. |
| `--daily` | Show the trend by local day. Covers every retained day unless --since is given. |
| `--since` | Start of the window: a duration such as 6h or 2d, or an ISO date or time. Without it, the summary covers the last 24 hours. |
| `--model` | Only count models whose name contains this text, ignoring case. |
| `--json` | Print the rows as a JSON array. |
| `--goal` | Hit-rate goal in percent, with at most two decimals. A hit rate below it is shown in red. |

Reports how much of each model's input the prompt cache served, per upstream route,
from the `completion` entries in the relay's log files under
`~/.copilot-relay/logs/`. `--goal` defaults to `95`, and `--hourly` and `--daily`
cannot be combined. It contacts neither the relay nor Copilot, does not read
`config.yaml`, and writes nothing. Any report, an empty one included, exits `0`; an
unusable option, or a logs directory that cannot be read, prints the reason on
stderr and exits `1`. The report itself is under "Measure the hit rate" in
[Prompt caching](EN-Prompt-Caching.md).

## `replay`

```sh
copilot-relay replay <request-id>
copilot-relay replay /absolute/path/to/capture-directory
```

| Argument | Description |
| --- | --- |
| `<TARGET>` | Request ID or capture directory |

Replays a debug capture through the relay's current request handling and compares
the result with the recording, offline. Captures exist only for requests a relay
handled with `logLevel: debug`, under
`~/.copilot-relay/captures/<local-date>/<request-id>/`. An ID is searched for in
those date directories, and an ID found under two dates is refused; an explicit
directory can be outside `~/.copilot-relay`. Replay opens no socket, uses no real
credentials, writes no token, config or new capture, and does not read
`config.yaml`.

It exits `0` for `MATCH`, `2` for `DIFF` or `INCOMPLETE`, and `1` for `MISSING` or
`MALFORMED`. What each verdict means, and why a capture must not be shared whole,
are under "Debug captures and offline replay" in
[Logs and troubleshooting](EN-Logging-Troubleshooting.md).
