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

// Why: the startup warning is for a bind host that other machines may
// reach. Only literal loopback addresses and the name localhost count as local;
// a wildcard, another address or any other name does not.
test("only loopback literals and localhost are loopback bind hosts", async () => {
  const { isLoopbackHost } = await import("../../src/lib/address")

  for (const host of [
    "127.0.0.1",
    "127.42.0.2",
    "localhost",
    "LOCALHOST",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isLoopbackHost(host), true, host)
  }

  for (const host of [
    "0.0.0.0",
    "::",
    "[::]",
    "192.0.2.8",
    "10.0.0.1",
    "2001:db8::2",
    "fe80::1%eth0",
    "relay.example",
    "localhost.example",
    "",
  ]) {
    assert.equal(isLoopbackHost(host), false, host)
  }
})
