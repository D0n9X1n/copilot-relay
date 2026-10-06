// Whether two stats name the same file, for the checks that a path was not swapped for another
// file between an lstat and an open or a read.
import type { Stats } from "node:fs"

type FileId = Pick<Stats, "dev" | "ino">

/** True when two stats of a path name the same file: the same device and file index. */
export const sameFile = (left: FileId, right: FileId): boolean =>
  left.dev === right.dev && left.ino === right.ino

/**
 * True when a stat of an open handle and a stat of its path name the same file.
 *
 * On Windows the two can disagree on `dev` for the same file: on Node 22.13.1 a path stat
 * reports `dev` 0 while a handle stat reports the volume serial number. There a `dev` of 0 on
 * either side counts as unreported and the file index (`ino`) alone decides, which is weaker
 * evidence than both. Two nonzero `dev` values must still match, and other platforms compare both.
 */
export const sameOpenedFile = (
  left: FileId,
  right: FileId,
  platform: NodeJS.Platform = process.platform,
): boolean => {
  if (left.ino !== right.ino) {
    return false
  }

  if (platform === "win32" && (left.dev === 0 || right.dev === 0)) {
    return true
  }

  return left.dev === right.dev
}
