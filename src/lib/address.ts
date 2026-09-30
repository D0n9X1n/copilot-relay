// A bind address is not always a usable client address (wildcards and IPv6).
export const getRelayBaseUrl = (host: string, port: number): string => {
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  const hostname = new URL(`http://${authority}`).hostname
  const connectHost = hostname === "0.0.0.0" ? "127.0.0.1"
    : hostname === "[::]" ? "[::1]" : hostname
  return `http://${connectHost}:${port}`
}
