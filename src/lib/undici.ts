// undici, loaded the first time a command makes an HTTP call rather than when the CLI starts.
// Evaluating it takes about a quarter of a second, and stop, cache, setup, --help and the shell
// completion that runs on every TAB never use it. Its CommonJS entry is the same module object an
// ESM import of "undici" resolves to, so classes from either compare equal.
import { createRequire } from "node:module"

type Undici = typeof import("undici")

let undici: Undici | undefined

export const loadUndici = (): Undici => {
  undici ??= createRequire(import.meta.url)("undici") as Undici
  return undici
}
