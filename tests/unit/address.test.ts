import assert from "node:assert/strict"
import test from "node:test"

test("relay base URLs replace wildcard binds and bracket concrete IPv6", async () => {
  const { getRelayBaseUrl } = await import("../../src/lib/address")
  for (const [host, expected] of [
    ["0.0.0.0", "http://127.0.0.1:4142"],
    ["::", "http://[::1]:4142"],
    ["[::]", "http://[::1]:4142"],
    ["0:0:0:0:0:0:0:0", "http://[::1]:4142"],
    ["::1", "http://[::1]:4142"],
    ["[::1]", "http://[::1]:4142"],
    ["2001:db8::2", "http://[2001:db8::2]:4142"],
    ["[2001:db8::2]", "http://[2001:db8::2]:4142"],
    ["127.0.0.1", "http://127.0.0.1:4142"],
    ["localhost", "http://localhost:4142"],
    ["relay.example", "http://relay.example:4142"],
    ["192.0.2.8", "http://192.0.2.8:4142"],
  ]) {
    assert.equal(getRelayBaseUrl(host, 4142), expected, host)
  }
})
