import type { ModelTokenLimits } from "../../src/lib/models"

export const astraLimits: ModelTokenLimits = {
  max_context_window_tokens: 1_000_000,
  max_prompt_tokens: 872_000,
  max_output_tokens: 128_000,
}

export const opusLimits: ModelTokenLimits = {
  max_context_window_tokens: 1_000_000,
  max_prompt_tokens: 936_000,
  max_output_tokens: 64_000,
  max_non_streaming_output_tokens: 16_000,
}

export const solLimits: ModelTokenLimits = {
  max_context_window_tokens: 1_050_000,
  max_prompt_tokens: 922_000,
  max_output_tokens: 128_000,
}

export const modelCatalogPayload = {
  data: [
    { id: "gpt-6-astra", capabilities: { limits: astraLimits, tokenizer: "o200k_base" } },
    { id: "claude-opus-5", capabilities: { limits: opusLimits, tokenizer: "o200k_base" } },
    { id: "gpt-5.6-sol", capabilities: { limits: solLimits, tokenizer: "o200k_base" } },
  ],
}
