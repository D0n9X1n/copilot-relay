# Vendored from OpenAI Codex

These files are copied unchanged from [openai/codex](https://github.com/openai/codex)
at tag `rust-v0.164.0` (commit `6aaac694803004a63c6f393d153c96d22521a6b9`), under the Apache License 2.0 in
`LICENSE`, with the project's `NOTICE`.

| File | Source path |
| --- | --- |
| `models.json` | `codex-rs/models-manager/models.json` |
| `prompt.md` | `codex-rs/models-manager/prompt.md` |

`copilot-relay start` reads them to write the model catalog it gives Codex
(`src/codex/catalog.ts`). A model Codex ships in `models.json` keeps its own
entry; any other model gets an entry built around `prompt.md`, the instructions
Codex itself uses for a model it does not know.
