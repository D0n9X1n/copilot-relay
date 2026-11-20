// One upstream deadline per operation: a relay request, a CLI command's catalog load, preflight or a
// model probe. The operation owns the timer and disposes it when it settles, so a finished request
// holds no timer and nothing that timer would keep alive.
export interface UpstreamDeadline {
  // Aborts with a TimeoutError when the time runs out; never aborts for a deadline of 0.
  signal: AbortSignal
  // Clears the timer. Safe to call more than once.
  dispose: () => void
}

const counts = { created: 0, disposed: 0 }

// How many deadline timers were created and disposed, so a test can check none is left behind.
export const upstreamDeadlineCounts = (): { created: number; disposed: number } => ({ ...counts })

const never = new AbortController().signal

export const createUpstreamDeadline = (timeoutMs: number): UpstreamDeadline => {
  if (!(timeoutMs > 0)) {
    return { signal: never, dispose: () => {} }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DOMException("The operation timed out.", "TimeoutError"))
  }, timeoutMs)
  counts.created++

  let disposed = false
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) {
        return
      }

      disposed = true
      clearTimeout(timer)
      counts.disposed++
    },
  }
}

// Creates a deadline, gives `run` its signal, and disposes it however `run` ends. `run` must have
// read or cancelled every body it fetched by then: the deadline no longer bounds what is left.
export const withUpstreamDeadline = async <T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const deadline = createUpstreamDeadline(timeoutMs)
  try {
    return await run(deadline.signal)
  } finally {
    deadline.dispose()
  }
}
