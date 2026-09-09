const schemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties",
])

const nestedSchemaKeywords = new Set([
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "oneOf",
  "prefixItems",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
])

// Only odd-length backslash runs introduce a Unicode property escape.
const unicodePropertyEscapePattern = /(?:^|[^\\])(?:\\\\)*\\[pP]\{/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function normalizeSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeSchemaValue)
  }
  return isRecord(value) ? normalizeResponsesToolSchema(value) : value
}

// Responses rejects these otherwise valid Claude regex constraints. Adapt only
// the upstream copy; the client retains its original schema for tool validation.
export function normalizeResponsesToolSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, value]): Array<[string, unknown]> => {
      if (
        key === "pattern"
        && typeof value === "string"
        && unicodePropertyEscapePattern.test(value)
      ) {
        return []
      }
      if (schemaMapKeywords.has(key) && isRecord(value)) {
        return [[key, Object.fromEntries(
          Object.entries(value).map(([name, nested]) => [
            name,
            normalizeSchemaValue(nested),
          ]),
        )]]
      }
      if (nestedSchemaKeywords.has(key)) {
        return [[key, normalizeSchemaValue(value)]]
      }
      return [[key, value]]
    }),
  )
}
