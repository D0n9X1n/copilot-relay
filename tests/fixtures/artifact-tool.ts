export const artifactFieldPattern =
  String.raw`^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\./[\]]{1,200}$`

export const artifactToolSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    field: { type: "string", pattern: artifactFieldPattern },
    doc_id: {
      type: "string",
      pattern: String.raw`^(?!\.\.?(?:\/|$))[A-Za-z0-9_\-.~:@+]{1,200}$`,
    },
    db_op: { type: "string", enum: ["get", "str_replace"] },
  },
  required: ["field"],
  additionalProperties: false,
}
