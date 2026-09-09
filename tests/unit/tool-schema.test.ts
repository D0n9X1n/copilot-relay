import assert from "node:assert/strict"
import test from "node:test"

import { normalizeResponsesToolSchema } from "../../src/copilot/tool-schema"
import {
  artifactFieldPattern,
  artifactToolSchema,
} from "../fixtures/artifact-tool"

test("omits rejected Artifact patterns without changing other constraints or the input", () => {
  const original = structuredClone(artifactToolSchema)
  const normalized = normalizeResponsesToolSchema(artifactToolSchema)

  assert.deepEqual(normalized, {
    ...artifactToolSchema,
    properties: {
      ...artifactToolSchema.properties,
      field: { type: "string" },
      database: { type: "string", maxLength: 1000 },
      doc_id: { type: "string" },
    },
  })
  assert.deepEqual(artifactToolSchema, original)
  assert.deepEqual(normalizeResponsesToolSchema(normalized), normalized)
})

test("recognizes Unicode property escapes with odd backslash counts", () => {
  for (const pattern of [
    artifactFieldPattern,
    String.raw`^\p{L}+$`,
    String.raw`^[\P{N}]+$`,
    String.raw`^\p{Script=Greek}+$`,
    String.raw`^\\\p{L}$`,
    String.raw`^\\\\\P{N}$`,
  ]) {
    assert.deepEqual(
      normalizeResponsesToolSchema({ type: "string", pattern }),
      { type: "string" },
      pattern,
    )
  }
})

test("omits lookahead and lookbehind patterns rejected by Responses", () => {
  for (const pattern of [
    "^(?!__.*__$)[a-z]+$",
    "^(?=[a-z])[a-z0-9]+$",
    "(?<=prefix)[a-z]+",
    "(?<!prefix)[a-z]+",
    String.raw`^\\(?!_)[a-z]+$`,
    "[a-z](?!_)",
  ]) {
    assert.deepEqual(
      normalizeResponsesToolSchema({ type: "string", pattern }),
      { type: "string" },
      pattern,
    )
  }
})

test("preserves portable patterns, escaped literals, and unrelated invalid input", () => {
  for (const pattern of [
    "",
    "^[a-z0-9_-]+$",
    String.raw`^\d{1,3}\.\d+$`,
    String.raw`^\\p{L}$`,
    String.raw`^\\\\P{N}$`,
    "^(?:[a-z]+|[0-9]+)$",
    "^[()?!<=>]+$",
    "^[(?=!]+$",
    "^[()](?:[a-z]+)$",
    String.raw`^\(\?=foo\)$`,
    String.raw`^\(\?!foo\)$`,
    String.raw`^\(\?<=foo\)$`,
    String.raw`^\(\?<!foo\)$`,
    "[",
    null,
    12,
  ]) {
    const schema = { type: "string", pattern }
    assert.deepEqual(normalizeResponsesToolSchema(schema), schema)
  }
})

for (const keyword of [
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties",
]) {
  test(`normalizes schema values under ${keyword} without rewriting map keys`, () => {
    const schema = {
      [keyword]: {
        pattern: { type: "string", pattern: artifactFieldPattern },
        optional: true,
        forbidden: false,
      },
    }
    assert.deepEqual(normalizeResponsesToolSchema(schema), {
      [keyword]: {
        pattern: { type: "string" },
        optional: true,
        forbidden: false,
      },
    })
  })
}

for (const keyword of [
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]) {
  test(`normalizes nested schemas under ${keyword}`, () => {
    assert.deepEqual(
      normalizeResponsesToolSchema({
        [keyword]: { type: "string", pattern: artifactFieldPattern },
      }),
      { [keyword]: { type: "string" } },
    )
    for (const value of [true, false]) {
      assert.deepEqual(
        normalizeResponsesToolSchema({ [keyword]: value }),
        { [keyword]: value },
      )
    }
  })
}

for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems", "items"]) {
  test(`normalizes schema arrays under ${keyword}`, () => {
    assert.deepEqual(
      normalizeResponsesToolSchema({
        [keyword]: [
          { type: "array", items: { type: "string", pattern: artifactFieldPattern } },
          false,
        ],
      }),
      { [keyword]: [{ type: "array", items: { type: "string" } }, false] },
    )
  })
}

test("does not treat literal data or property names as schema keywords", () => {
  const data = {
    pattern: artifactFieldPattern,
    properties: { field: { pattern: artifactFieldPattern } },
  }
  const schema = {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        pattern: "^[a-z]+$",
        description: artifactFieldPattern,
        default: artifactFieldPattern,
      },
    },
    default: data,
    const: data,
    enum: [data],
    examples: [data],
    "x-metadata": data,
    dependencies: { pattern: ["field"] },
    required: ["pattern"],
    $ref: "#/$defs/pattern",
  }
  assert.deepEqual(normalizeResponsesToolSchema(schema), schema)
})
