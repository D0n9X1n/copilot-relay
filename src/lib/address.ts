import { BlockList, isIP } from "node:net"

const loopbackForWildcard = new Map([
  ["0.0.0.0", "127.0.0.1"],
  ["[::]", "[::1]"],
])

// A bind address is not always a usable client address (wildcards and IPv6).
export const getRelayBaseUrl = (host: string, port: number): string => {
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  const hostname = new URL(`http://${authority}`).hostname
  const connectHost = loopbackForWildcard.get(hostname) ?? hostname
  return `http://${connectHost}:${port}`
}

// 127.0.0.0/8 and ::1. BlockList also matches the IPv4-mapped form, ::ffff:127.0.0.1.
const loopbackAddresses = new BlockList()
loopbackAddresses.addSubnet("127.0.0.0", 8, "ipv4")
loopbackAddresses.addAddress("::1", "ipv6")

/**
 * True when a bind host accepts connections from this machine only.
 *
 * Literal loopback addresses and the name localhost qualify. Wildcards, other addresses and other
 * names do not: a name can resolve to any address, so it is treated as reachable from the network.
 */
export const isLoopbackHost = (host: string): boolean => {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  if (bare.toLowerCase() === "localhost") {
    return true
  }

  const family = isIP(bare)
  if (family === 0) {
    return false
  }

  return loopbackAddresses.check(bare, family === 4 ? "ipv4" : "ipv6")
}
