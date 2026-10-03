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

// Returned by mapRecord's callback for a key to leave out.
const removed = Symbol("removed")

// Copy-on-write: the record itself is returned until a value changes or a key is left out, and only
// then copied. Object.fromEntries keeps an own "__proto__" key as data, as JSON.parse does.
function mapRecord(
  record: Record<string, unknown>,
  map: (key: string, value: unknown) => unknown,
): Record<string, unknown> {
  const keys = Object.keys(record)
  let entries: Array<[string, unknown]> | undefined
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    const value = record[key]
    const mapped = map(key, value)
    if (!entries && Object.is(mapped, value)) {
      continue
    }

    entries ??= keys.slice(0, index).map((kept): [string, unknown] => [kept, record[kept]])
    if (mapped !== removed) {
      entries.push([key, mapped])
    }
  }

  return entries ? Object.fromEntries(entries) : record
}

// Copy-on-write, like mapRecord. Holes and the length are kept, as Array.prototype.map keeps them.
function mapArray(values: Array<unknown>): Array<unknown> {
  let copy: Array<unknown> | undefined
  for (let index = 0; index < values.length; index++) {
    if (!(index in values)) {
      continue
    }

    const value = values[index]
    const mapped = normalizeSchemaValue(value)
    if (!copy && Object.is(mapped, value)) {
      continue
    }

    copy ??= values.slice(0, index)
    copy[index] = mapped
  }

  if (!copy) {
    return values
  }

  copy.length = values.length

  return copy
}

function normalizeSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return mapArray(value)
  }

  return isRecord(value) ? normalizeResponsesToolSchema(value) : value
}

// Responses rejects these otherwise valid Claude regex constraints. Adapt only what is sent
// upstream; the client keeps its original schema for tool validation. A schema that needs no
// change is returned as is, so a long tool list is not rebuilt on every request.
export function normalizeResponsesToolSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return mapRecord(schema, (key, value) => {
    if (
      key === "pattern"
      && typeof value === "string"
      && hasUnsupportedPatternFeatures(value)
    ) {
      return removed
    }

    if (schemaMapKeywords.has(key) && isRecord(value)) {
      return mapRecord(value, (_name, nested) => normalizeSchemaValue(nested))
    }

    if (nestedSchemaKeywords.has(key)) {
      return normalizeSchemaValue(value)
    }

    return value
  })
}
