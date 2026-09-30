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

export class FileConflictError extends Error {
  constructor() {
    super("File changed since it was read; refusing to overwrite a concurrent edit")
    this.name = "FileConflictError"
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

const sameIdentity = (left: FileIdentity | null, right: FileIdentity | null): boolean =>
  left === null || right === null ? left === right
    : left.dev === right.dev && left.ino === right.ino && left.size === right.size
      && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs

// realpath also canonicalizes parents (notably /var -> /private/var on macOS).
// Missing suffixes are retained without creating them during a read. Resolve a
// dangling final symlink to its intended target instead of replacing the link.
const resolveTarget = async (filePath: string, remainingLinks = 40): Promise<string> => {
  try {
    return await fs.realpath(filePath)
  } catch (error) {
    if (!isMissing(error)) throw error
    const entry = await fs.lstat(filePath).catch((cause: unknown) => {
      if (!isMissing(cause)) throw cause
      return undefined
    })
    if (entry?.isSymbolicLink()) {
      if (remainingLinks === 0) throw new Error("Too many symbolic links")
      return resolveTarget(path.resolve(path.dirname(filePath), await fs.readlink(filePath)), remainingLinks - 1)
    }
    const parent = path.dirname(filePath)
    if (parent === filePath) throw error
    return path.join(await resolveTarget(parent, remainingLinks), path.basename(filePath))
  }
}

export const readFileSnapshot = async (filePath: string): Promise<FileSnapshot> => {
  const requestedPath = path.resolve(filePath)
  const resolvedPath = await resolveTarget(requestedPath)
  const before = await fs.lstat(resolvedPath).catch((error: unknown) => {
    if (!isMissing(error)) throw error
    return undefined
  })
  if (!before) {
    return { requestedPath, resolvedPath, raw: null, mode: 0o600, identity: null }
  }
  if (!before.isFile()) throw new FileConflictError()

  let raw: string
  let after: Stats
  try {
    raw = await fs.readFile(resolvedPath, "utf8")
    after = await fs.lstat(resolvedPath)
  } catch (error) {
    if (isMissing(error)) throw new FileConflictError()
    throw error
  }
  if (!after.isFile() || !sameIdentity(identityOf(before), identityOf(after))
    || await resolveTarget(requestedPath) !== resolvedPath) {
    throw new FileConflictError()
  }
  return { requestedPath, resolvedPath, raw, mode: before.mode & 0o777, identity: identityOf(before) }
}

const assertUnchanged = async (expected: FileSnapshot): Promise<void> => {
  const current = await readFileSnapshot(expected.requestedPath)
  if (current.resolvedPath !== expected.resolvedPath || current.raw !== expected.raw
    || current.mode !== expected.mode || !sameIdentity(current.identity, expected.identity)) {
    throw new FileConflictError()
  }
}

// Serializes cooperative writers in this process only. Filesystems do not offer
// portable compare-and-swap rename: a noncooperating external edit between the
// final check and rename remains possible. Never claim an OS-wide CAS guarantee.
const pendingWrites = new Map<string, Promise<void>>()

const publish = async (snapshot: FileSnapshot, content: string): Promise<void> => {
  await assertUnchanged(snapshot)
  const directory = path.dirname(snapshot.resolvedPath)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await assertUnchanged(snapshot)

  const temporaryPath = path.join(directory, `.${path.basename(snapshot.resolvedPath)}.${randomUUID()}.tmp`)
  const handle = await fs.open(temporaryPath, "wx", 0o600)
  try {
    try {
      await handle.writeFile(content, "utf8")
      if (process.platform !== "win32") await handle.chmod(snapshot.mode)
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
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new FileConflictError()
        throw error
      }
    } else {
      await fs.rename(temporaryPath, snapshot.resolvedPath)
    }
  } finally {
    await fs.rm(temporaryPath, { force: true })
  }
}

export const writeFileSnapshot = async (snapshot: FileSnapshot, content: string): Promise<void> => {
  const previous = pendingWrites.get(snapshot.resolvedPath) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(() => publish(snapshot, content))
  pendingWrites.set(snapshot.resolvedPath, current)
  try {
    await current
  } finally {
    if (pendingWrites.get(snapshot.resolvedPath) === current) pendingWrites.delete(snapshot.resolvedPath)
  }
}
