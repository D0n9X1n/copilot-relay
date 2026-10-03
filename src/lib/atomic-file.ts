// Snapshot-based publication for user-owned text files. Replacements are atomic;
// observed edits are conflicts, not permission to retry stale derived content.
import fs from "node:fs/promises"
import type { Stats } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

export interface FileIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

export interface FileSnapshot {
  requestedPath: string
  resolvedPath: string
  raw: string | null
  mode: number
  identity: FileIdentity | null
}

export interface WriteFileSnapshotOptions {
  // Publish the file owner-only (0600) whatever mode it had, for content that holds a credential.
  // The snapshot keeps the mode it read, which is what the concurrent-edit checks compare.
  ownerOnly?: boolean
}

export class FileConflictError extends Error {
  constructor() {
    super("File changed since it was read; refusing to overwrite a concurrent edit")
    this.name = "FileConflictError"
  }
}

// The path exists but is a directory or another non-file. Unlike a conflict, a later read
// finds the same thing.
export class NotRegularFileError extends Error {
  constructor(filePath: string) {
    super(`${filePath} is not a regular file`)
    this.name = "NotRegularFileError"
  }
}

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT"

const identityOf = (stat: Stats): FileIdentity => ({
  dev: stat.dev,
  ino: stat.ino,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
})

// A null identity is a missing file: two missing files match, a missing and a present one do not.
const sameIdentity = (left: FileIdentity | null, right: FileIdentity | null): boolean =>
  left === null || right === null ?
      left === right
    : left.dev === right.dev
      && left.ino === right.ino
      && left.size === right.size
      && left.mtimeMs === right.mtimeMs
      && left.ctimeMs === right.ctimeMs

// realpath also canonicalizes parents (notably /var -> /private/var on macOS).
// Missing suffixes are retained without creating them during a read. Resolve a
// dangling final symlink to its intended target instead of replacing the link.
const resolveTarget = async (filePath: string, remainingLinks = 40): Promise<string> => {
  try {
    return await fs.realpath(filePath)
  } catch (error) {
    if (!isMissing(error)) {
      throw error
    }

    const entry = await fs.lstat(filePath).catch((cause: unknown) => {
      if (!isMissing(cause)) {
        throw cause
      }

      return undefined
    })

    if (entry?.isSymbolicLink()) {
      if (remainingLinks === 0) {
        throw new Error("Too many symbolic links")
      }

      return resolveTarget(
        path.resolve(path.dirname(filePath), await fs.readlink(filePath)),
        remainingLinks - 1,
      )
    }

    const parent = path.dirname(filePath)
    if (parent === filePath) {
      throw error
    }

    return path.join(await resolveTarget(parent, remainingLinks), path.basename(filePath))
  }
}

const readStableSnapshot = async (filePath: string): Promise<FileSnapshot> => {
  const requestedPath = path.resolve(filePath)
  const resolvedPath = await resolveTarget(requestedPath)
  const before = await fs.lstat(resolvedPath).catch((error: unknown) => {
    if (!isMissing(error)) {
      throw error
    }

    return undefined
  })

  if (!before) {
    return { requestedPath, resolvedPath, raw: null, mode: 0o600, identity: null }
  }

  if (!before.isFile()) {
    throw new NotRegularFileError(resolvedPath)
  }

  let raw: string
  let after: Stats
  try {
    raw = await fs.readFile(resolvedPath, "utf8")
    after = await fs.lstat(resolvedPath)
  } catch (error) {
    if (isMissing(error)) {
      throw new FileConflictError()
    }

    throw error
  }

  const snapshot = {
    requestedPath,
    resolvedPath,
    raw,
    mode: before.mode & 0o777,
    identity: identityOf(before),
  }

  if (
    !after.isFile()
    || before.mode !== after.mode
    || await resolveTarget(requestedPath) !== resolvedPath
  ) {
    throw new FileConflictError()
  }

  // A change in ctime alone is retried by readFileSnapshot; any other difference means the file
  // was edited while it was being read.
  if (!sameIdentity(snapshot.identity, identityOf(after))) {
    if (sameReadContent(snapshot, { ...snapshot, identity: identityOf(after) })) {
      throw new MetadataReadConflictError(snapshot)
    }

    throw new FileConflictError()
  }

  return snapshot
}

// Only ctime may settle between attempts; bytes and every other identity field
// stay anchored to the first read, so an actual edit cannot become a fresh read.
const sameReadContent = (left: FileSnapshot, right: FileSnapshot): boolean =>
  left.resolvedPath === right.resolvedPath && left.raw === right.raw && left.mode === right.mode
  && left.identity !== null && right.identity !== null
  && sameIdentity(left.identity, { ...right.identity, ctimeMs: left.identity.ctimeMs })

// A read during which only ctime moved. It carries the bytes read, so readFileSnapshot never lets
// it reach a caller.
class MetadataReadConflictError extends FileConflictError {
  readonly snapshot: FileSnapshot

  constructor(snapshot: FileSnapshot) {
    super()
    this.snapshot = snapshot
  }
}

export const readFileSnapshot = async (filePath: string): Promise<FileSnapshot> => {
  let firstRead: FileSnapshot | undefined

  for (let attempt = 1; ; attempt++) {
    try {
      const snapshot = await readStableSnapshot(filePath)
      if (firstRead && !sameReadContent(firstRead, snapshot)) {
        throw new FileConflictError()
      }

      return snapshot
    } catch (error) {
      if (!(error instanceof MetadataReadConflictError)) {
        throw error
      }

      // The internal retry error holds file bytes; never expose it to callers
      // that may log the error object (settings can contain credentials).
      if (attempt >= 3) {
        throw new FileConflictError()
      }

      if (firstRead && !sameReadContent(firstRead, error.snapshot)) {
        throw new FileConflictError()
      }

      firstRead ??= error.snapshot
    }
  }
}

const assertUnchanged = async (expected: FileSnapshot): Promise<void> => {
  const current = await readFileSnapshot(expected.requestedPath)

  if (
    current.resolvedPath !== expected.resolvedPath
    || current.raw !== expected.raw
    || current.mode !== expected.mode
    || !sameIdentity(current.identity, expected.identity)
  ) {
    throw new FileConflictError()
  }
}

// Serializes cooperative writers in this process only. Filesystems do not offer
// portable compare-and-swap rename: a noncooperating external edit between the
// final check and rename remains possible. Never claim an OS-wide CAS guarantee.
const pendingWrites = new Map<string, Promise<void>>()

const publish = async (
  snapshot: FileSnapshot,
  content: string,
  options: WriteFileSnapshotOptions,
): Promise<void> => {
  // Checked first, again after creating the directory, and again once the temporary file is
  // written and closed, so the last check sits directly before the link or rename that publishes.
  await assertUnchanged(snapshot)
  const directory = path.dirname(snapshot.resolvedPath)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await assertUnchanged(snapshot)

  // Same directory as the target, so the rename stays on one filesystem and is atomic.
  const temporaryPath = path.join(
    directory,
    `.${path.basename(snapshot.resolvedPath)}.${randomUUID()}.tmp`,
  )
  const handle = await fs.open(temporaryPath, "wx", 0o600)
  try {
    try {
      await handle.writeFile(content, "utf8")

      // Windows keeps no POSIX mode bits; chmod there only toggles the read-only flag.
      if (process.platform !== "win32") {
        await handle.chmod(options.ownerOnly ? 0o600 : snapshot.mode)
      }

      await handle.sync()
    } finally {
      await handle.close()
    }

    await assertUnchanged(snapshot)
    if (snapshot.raw === null) {
      // link publishes complete bytes exclusively; rename would overwrite a file
      // created by someone else after our last absence check.
      try {
        await fs.link(temporaryPath, snapshot.resolvedPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new FileConflictError()
        }

        throw error
      }
    } else {
      await fs.rename(temporaryPath, snapshot.resolvedPath)
    }
  } finally {
    await fs.rm(temporaryPath, { force: true })
  }
}

export const writeFileSnapshot = async (
  snapshot: FileSnapshot,
  content: string,
  options: WriteFileSnapshotOptions = {},
): Promise<void> => {
  const previous = pendingWrites.get(snapshot.resolvedPath) ?? Promise.resolve()
  // A failed earlier write has already been reported to its own caller; it must not block this one.
  const current = previous.catch(() => undefined).then(() => publish(snapshot, content, options))
  pendingWrites.set(snapshot.resolvedPath, current)

  try {
    await current
  } finally {
    // A later write may already have queued behind this one; only the newest clears the entry.
    if (pendingWrites.get(snapshot.resolvedPath) === current) {
      pendingWrites.delete(snapshot.resolvedPath)
    }
  }
}
