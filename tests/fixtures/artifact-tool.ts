// Modeled on Claude Code's Artifact tool. Copilot's Responses API rejects the Unicode property
// escapes and lookaheads in `field`, `database` and `doc_id`, so the relay drops those patterns
// upstream; every other constraint here is supported and must reach Copilot unchanged.
export const artifactFieldPattern =
  String.raw`^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\./[\]]{1,200}$`

export const artifactToolSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    field: { type: "string", pattern: artifactFieldPattern },
    database: {
      type: "string",
      maxLength: 1000,
      pattern: String.raw`^(?!\.\.?(?:\/|$))[A-Za-z0-9_\-.~:@+]{1,200}(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9_\-.~:@+]{1,200}){0,14}$`,
    },
    doc_id: {
      type: "string",
      pattern: String.raw`^(?!\.\.?(?:\/|$))[A-Za-z0-9_\-.~:@+]{1,200}$`,
    },
    asset_id: { type: "string", pattern: "^[0-9a-f]{32}$" },
    after: { type: "string", pattern: "^[A-Za-z0-9_=-]{1,4096}$" },
    db_op: { type: "string", enum: ["get", "str_replace"] },
  },
  required: ["field"],
  additionalProperties: false,
}
