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

const lookaroundPrefixes = ["(?=", "(?!", "(?<=", "(?<!"]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function hasUnsupportedPatternFeatures(pattern: string): boolean {
  let inCharacterClass = false
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    if (character === "\\") {
      if (
        (pattern[index + 1] === "p" || pattern[index + 1] === "P")
        && pattern[index + 2] === "{"
      ) {
        return true
      }
      index += 1
      continue
    }
    if (character === "[") {
      inCharacterClass = true
    } else if (character === "]") {
      inCharacterClass = false
    } else if (
      !inCharacterClass
      && character === "("
      && lookaroundPrefixes.some((prefix) => pattern.startsWith(prefix, index))
    ) {
      return true
    }
  }
  return false
}

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
        && hasUnsupportedPatternFeatures(value)
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
