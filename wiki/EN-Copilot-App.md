# GitHub Copilot app and Copilot CLI

The GitHub Copilot app and Copilot CLI can use a custom model provider, a preview
feature GitHub calls bring your own key. Pointed at the relay, they reach the same
two models Claude Code and Codex use, `gptModel` and `opusModel`, and their usage
shows up in the relay's logs and in `copilot-relay cache`.

The app already talks to GitHub Copilot directly, with the same models. Route it
through the relay when you want one place to see logs and the prompt-cache hit
rate across all your clients; otherwise the built-in provider does the same job
with one hop fewer. Usage through the relay still runs on your own Copilot seat:
see "Personal use only" in [Configuration](EN-Configuration.md).

This was checked with Copilot CLI 1.0.103, which runs the same provider engine as
the app, against a live relay: a plain reply and a five-step tool-call session
each completed on GPT-6 Astra and on Claude Opus 5.5.

## Choose the provider settings

The relay serves two of the wire formats these clients speak. Pick one row:

| Provider type | Base URL | Relay route | Result |
| --- | --- | --- | --- |
| OpenAI-compatible, wire API **Responses** | `http://127.0.0.1:4142/v1` | `POST /v1/responses` | Works for both models. Recommended. |
| **Anthropic** | `http://127.0.0.1:4142` | `POST /v1/messages` | Works for both models. Copilot CLI warns that it knows no token multiplier for an Anthropic `gpt-6-astra`, so its token estimates for that model are approximate. |
| OpenAI-compatible, wire API **Chat completions** (the default) | `http://127.0.0.1:4142/v1` | `POST /v1/chat/completions` | Fails. The relay does not serve this route and answers `500 Unsupported Claude API route`. |

Use the port from your `config.yaml` if it is not `4142`. The Responses base URL
ends in `/v1` because the client appends `/responses`; the Anthropic one does not,
because the client appends `/v1/messages`.

With the Responses wire API, the relay passes GPT requests through to Copilot
`/responses` and translates Claude requests to native Messages, as it does for
Codex; see [Codex](EN-Codex.md).

## Set up the Copilot app

Open **Settings → Model providers**, add a provider, and fill it in:

| Field | Value |
| --- | --- |
| Name | `Copilot Relay (local)` |
| Type | OpenAI-compatible |
| Base URL | `http://127.0.0.1:4142/v1` |
| Wire API | Responses |
| API key | your relay `apiKey` |

Then add the two models:

| Model ID | Display name |
| --- | --- |
| `gpt-6-astra` | `GPT-6 Astra · Relay` |
| `claude-opus-5.5` | `Claude Opus 5.5 · Relay` |

The display names keep Copilot's own model names, so they sort beside the
built-in ones, and add `· Relay` so the picker does not show two entries with the
same label. Use the model IDs from your `gptModel` and `opusModel`.

If the form offers no Responses choice, use the Anthropic type with base URL
`http://127.0.0.1:4142` and the same key and models instead.

The API key is the `apiKey` value in `~/.copilot-relay/config.yaml`. The app
stores it in the operating system's secure storage. With `apiKey` empty the relay
accepts any key, so any placeholder works when the form insists on one.

If the form asks for token limits, use 1,000,000 prompt and 128,000 output tokens
for Claude Opus 5.5, and 1,050,000 and 128,000 for GPT-6 Astra. The relay logs the
limits Copilot advertises at startup, on its `Model token limits` lines.

`copilot-relay setup` has no target for the app. The app keeps providers in its
own database and keys in the operating system's secure storage, neither of which
is a documented interface, so the relay does not write them.

## Set up Copilot CLI

Copilot CLI reads the provider from environment variables. In zsh or bash:

```sh
export COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:4142/v1
export COPILOT_PROVIDER_TYPE=openai
export COPILOT_PROVIDER_WIRE_API=responses
export COPILOT_PROVIDER_API_KEY="<your relay apiKey>"
export COPILOT_MODEL=gpt-6-astra
```

In PowerShell:

```powershell
$env:COPILOT_PROVIDER_BASE_URL = "http://127.0.0.1:4142/v1"
$env:COPILOT_PROVIDER_TYPE = "openai"
$env:COPILOT_PROVIDER_WIRE_API = "responses"
$env:COPILOT_PROVIDER_API_KEY = "<your relay apiKey>"
$env:COPILOT_MODEL = "gpt-6-astra"
```

Set `COPILOT_MODEL` to `claude-opus-5.5` for Opus, or switch with `/model` in a
session. For the Anthropic type, set `COPILOT_PROVIDER_TYPE=anthropic`, use base
URL `http://127.0.0.1:4142`, and leave `COPILOT_PROVIDER_WIRE_API` unset.

## Check it works

1. Pick `GPT-6 Astra · Relay` and send a message, then do the same with
   `Claude Opus 5.5 · Relay`.
2. Watch the relay log while you do:

   ```sh
   tail -f ~/.copilot-relay/logs/copilot-relay.$(date +%F).log | grep -E 'POST /v1/(responses|messages)'
   ```

   Each message logs `POST /v1/responses -> 200`, or `POST /v1/messages -> 200`
   with the Anthropic type. The relay labels Responses traffic `client=codex`,
   since it is the same route Codex uses.
3. After a few turns, run `copilot-relay cache` to see the hit rate per model and
   upstream route. The first request of a session writes the cache rather than
   reading it, so a short session reads lower than a long one; see
   [Prompt caching](EN-Prompt-Caching.md).

## Limitations

- Custom model providers are a preview in the Copilot app and Copilot CLI, and
  their settings can change between releases.
- The relay serves no `/v1/chat/completions` route, so the OpenAI-compatible
  default wire API does not work.
- The app still requires a GitHub sign-in. It does not require a Copilot plan
  with a custom provider, which is why the relay must only be used by the account
  that ran `copilot-relay auth`.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `500 Unsupported Claude API route`, and the log shows `POST /v1/chat/completions` | The wire API is chat completions. Choose Responses, or the Anthropic type. |
| `500 Unsupported Claude API route` on another path, such as `/v1/v1/messages` or `/responses` | The base URL has the wrong ending: `/v1` for Responses, none for Anthropic. |
| `401` with `authentication_error` | The key does not match `apiKey`. Copy it again from `config.yaml`. |
| Connection refused | The relay is not running, or listens on another port. Run `copilot-relay status`. |
| A model is missing from the picker | Add it to the provider by hand; model IDs must match `gptModel` and `opusModel`. |
