import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"

// Why (#48): the integration suite exercises the real server, which logs, and
// node --test frames its child-to-runner messages over that same stdout, so an
// application write can interleave with those frames and abort the run
// mid-file. consola reads its level once, when src/ first loads, so silencing
// it only takes effect ahead of that import: position is the point, not just
// presence. A URL rather than a path string - fs takes it directly, and it
// round-trips on Windows, where a bare pathname would keep a leading slash.
const integrationSuiteUrl = new URL(
  "../integration/claude-routes.test.ts",
  import.meta.url,
)

const silenceAssignment = "process.env.CONSOLA_LEVEL = \"0\""
const firstSrcImportMarker = "import(\"../../src/"

test("integration suite silences the logger before importing src", async () => {
  const source = await fs.readFile(integrationSuiteUrl, "utf8")

  const silenceIndex = source.indexOf(silenceAssignment)
  const firstSrcImportIndex = source.indexOf(firstSrcImportMarker)

  assert.notEqual(
    silenceIndex,
    -1,
    `claude-routes.test.ts must contain ${silenceAssignment}`,
  )
  assert.notEqual(
    firstSrcImportIndex,
    -1,
    `claude-routes.test.ts must contain ${firstSrcImportMarker}`,
  )
  assert.ok(
    silenceIndex < firstSrcImportIndex,
    "CONSOLA_LEVEL must be set before the first ../../src/ dynamic import",
  )
})
