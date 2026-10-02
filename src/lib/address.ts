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
