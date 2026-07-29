# Windows: run in the background

Recommended built-in option: Task Scheduler, as a per-user task.

## One-time setup

Run PowerShell as your normal user:

```powershell
npm install -g copilot-relay@latest
copilot-relay auth
```

## Create the scheduled task

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

### Verify the execution time limit actually took

Do this once, immediately after registering. It is the difference between a relay
that runs indefinitely and one that dies silently in three days:

```powershell
(Get-ScheduledTask -TaskName "copilot-relay").Settings.ExecutionTimeLimit
```

**You want `PT0S`.** If it shows `PT72H`, the setting did not take — PowerShell's
`[TimeSpan]::Zero` does not always serialize to `PT0S`, and it fails silently.
Force it through the XML in that case:

```powershell
$task = Get-ScheduledTask -TaskName "copilot-relay"
$task.Settings.ExecutionTimeLimit = "PT0S"
Set-ScheduledTask -InputObject $task
(Get-ScheduledTask -TaskName "copilot-relay").Settings.ExecutionTimeLimit  # PT0S
```

### Why these settings

Four of these are load-bearing. The Task Scheduler defaults are actively wrong
for a long-lived service.

**`-ExecutionTimeLimit ([TimeSpan]::Zero)`** is the one that bites hardest. The
default is **`PT72H` — 3 days** — and Task Scheduler *terminates* the task when it
is reached. A perfectly healthy relay dies after 72 hours, and because it looks
like an ordinary stop you get no error anywhere. Zero means no limit. Verify it
took, as above.

**`-DontStopIfGoingOnBatteries`** and **`-AllowStartIfOnBatteries`** are both
required on a laptop, because both underlying defaults work against you:
`StopIfGoingOnBatteries` defaults to `true` (Windows stops the task the moment you
unplug) and `DisallowStartIfOnBatteries` also defaults to `true` (it will not
start while on battery at all).

Note that `-DisallowStartIfOnBatteries` is **not** a cmdlet parameter — it is the
name of the underlying XML property. Passing it to `New-ScheduledTaskSettingsSet`
does nothing useful; use `-AllowStartIfOnBatteries`.

**Executing `node.exe` directly** rather than making the task's program
`powershell.exe`. Microsoft documents that stopping a task "stops only the
instances of a program started by a scheduled task. To stop other processes, you
must use the TaskKill command." So the task's program is what a stop reliably
covers — anything that program launched is one of the "other processes."

If the task's program is `powershell.exe`, the relay is a child of it, and
stopping the task is not documented to reach the relay. Calling
`node dist\main.js start` makes the relay the task's own program, so a stop
covers exactly the thing you want stopped.

(npm's global install on Windows creates extensionless, `.cmd`, and `.ps1` shims,
and `(Get-Command copilot-relay).Source` resolves to one of those. The `.ps1`
shim is a script rather than a separate process — it runs in the calling host and
launches node from there — so the extra layer comes from choosing `powershell.exe`
as the task's program, not from the shim itself.)

**`-RestartCount 10` at 1-minute intervals** bounds retries. These settings live
under `RestartOnFailure` and apply **only when the task fails** — a process
exiting `0` is a successful completion, so a clean `copilot-relay stop` is never
undone by them. The relay validates upstream Copilot access at startup and exits
`1` if that fails; at logon the network is often not up yet, so the first attempt
legitimately fails. Ten retries over ten minutes covers a slow network without
retrying forever against a real misconfiguration.

`-MultipleInstances IgnoreNew` is already the Task Scheduler default; it is
specified here to document the intent that a second instance must never start
alongside the first.

`copilot-relay start` runs in the foreground, which is what Task Scheduler
expects — it treats the running process as the running task.

## Verifying it actually works

### The quick answer

```powershell
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
  log        C:\Users\you\.copilot-relay\logs\copilot-relay.2026-07-25.log
  config     C:\Users\you\.copilot-relay\config.yaml
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

Restart the service and check again. A mismatch does not change the exit code —
the relay still works, it is just not the build you installed.

Add `--deep` to also send a real request through Copilot — the only check that
proves the relay can serve Claude Code. It spends a few tokens, which is why it
is opt-in:

```powershell
copilot-relay status --deep
```

Exit codes, for scripting: `0` running and reachable, `1` not running, `2`
running but not usable — the health probe failed, or `--deep` failed. `--json` emits machine-readable output.

This is worth preferring on Windows in particular — the manual layer 3 below is
a multi-line `Invoke-RestMethod` with a hand-built JSON body, and `status --deep`
is one command.

### The three layers, by hand

`status` runs these for you. They are worth understanding, because **the first
two pass on a relay that cannot serve a single request** — and worth having when
you are debugging from a machine without the CLI.

### Layer 1 — is the process alive?

```powershell
Get-ScheduledTask -TaskName "copilot-relay" | Select-Object State
Get-ScheduledTaskInfo -TaskName "copilot-relay" |
  Select-Object LastRunTime, LastTaskResult, NumberOfMissedRuns

Invoke-RestMethod http://127.0.0.1:4142/healthz
```

Expect `State: Running`, `LastTaskResult: 267009` (means *currently running* —
not an error), and `ok : True`. That endpoint is a static handler: it proves a
socket is listening and nothing more. It never contacts GitHub Copilot.

### Layer 2 — did config parse and routing resolve?

```powershell
(Invoke-RestMethod http://127.0.0.1:4142/v1/models).data.id
```

Expect your configured models, e.g. `gpt-5.6-sol[1m]` and `claude-opus-5`. Served
from config; **also never contacts upstream**. A relay whose Copilot token expired
an hour ago passes layers 1 and 2.

### Layer 3 — end to end

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

Content plus non-zero `usage` proves the whole path: config, token refresh, the
Copilot call, and translation back to Claude shape. **This is the only check that
proves the relay can serve Claude Code.** It costs a handful of tokens.

Layers 1 and 2 passing while layer 3 fails means auth or upstream, not the task —
run `copilot-relay auth` and read today's log.

### Reading logs

```powershell
$today = Get-Date -Format "yyyy-MM-dd"
Get-Content "$env:USERPROFILE\.copilot-relay\logs\copilot-relay.$today.log" -Tail 80 -Wait
```

The log rotates daily and the filename carries the local date. To search every
retained day:

```powershell
Select-String -Path "$env:USERPROFILE\.copilot-relay\logs\copilot-relay.*.log" `
  -Pattern "Startup preflight failed"
```

## Stopping it

Stop now, let it start again at next logon:

```powershell
Stop-ScheduledTask -TaskName "copilot-relay"
```

Stop now and do not start at logon:

```powershell
Stop-ScheduledTask -TaskName "copilot-relay"
Disable-ScheduledTask -TaskName "copilot-relay"
```

Re-enable:

```powershell
Enable-ScheduledTask -TaskName "copilot-relay"
Start-ScheduledTask -TaskName "copilot-relay"
```

### `copilot-relay stop` and Task Scheduler

`copilot-relay stop` finds and terminates the relay directly. It exits `0`, which
Task Scheduler reads as normal completion — not a failure — so the restart policy
does not fire and it stays stopped until next logon.

To confirm a relay is gone regardless of supervisor:

```powershell
copilot-relay stop
Get-NetTCPConnection -LocalPort 4142 -State Listen -ErrorAction SilentlyContinue
```

The second command should return nothing.

### Removing it permanently

```powershell
Stop-ScheduledTask -TaskName "copilot-relay"
Unregister-ScheduledTask -TaskName "copilot-relay" -Confirm:$false
```

## Troubleshooting

**Relay dies every ~3 days.** `-ExecutionTimeLimit` did not take. The fingerprint
is `LastTaskResult` = **`267014`** (`SCHED_S_TASK_TERMINATED`) with an uptime near
72 hours — that code means the task was terminated rather than that it crashed.
Check and fix:

```powershell
(Get-ScheduledTask -TaskName "copilot-relay").Settings.ExecutionTimeLimit
```

`PT72H` is the default and is the bug; you want `PT0S`. See
[Verify the execution time limit actually took](#verify-the-execution-time-limit-actually-took).

**Relay stops when unplugged, or will not start on battery.** Both battery
defaults work against you — `StopIfGoingOnBatteries` and
`DisallowStartIfOnBatteries` are both `true` by default. You need
`-DontStopIfGoingOnBatteries` *and* `-AllowStartIfOnBatteries`.

**`Stop-ScheduledTask` leaves the relay running.** The task is wrapped in a shim
or `powershell.exe`. Re-register with the `node.exe` action above.

**`LastTaskResult` is `1`.** Preflight failed: expired auth or no network. Read
today's log, then `copilot-relay auth`.

**`LastTaskResult` is `267009`.** Not an error — `SCHED_S_TASK_RUNNING`, the task
is currently running.

**`LastTaskResult` is `267011`.** `SCHED_S_TASK_NOT_SCHEDULED` — a property needed
to run on a schedule is missing. Re-register the task.

**Task registered but never starts.** `-AtLogOn` fires at logon; if you registered
it in an already-open session, start it once by hand with `Start-ScheduledTask`.

**Relay runs but Claude Code ignores it.** Registration is fine; check
`ANTHROPIC_BASE_URL` in `%USERPROFILE%\.claude\settings.json`. With
`claudeSetup: true` the relay manages that itself at start.

## Best practice

Use a per-user task. Do not run as `SYSTEM` unless you deliberately manage a
separate home directory and token cache — `SYSTEM` has its own profile, so it
will not see the `copilot-relay auth` you ran as yourself.
