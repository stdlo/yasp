/**
 * A three-way merge of text by lines: the last-synced base, and the local and
 * remote versions edited from it. Edits to different lines both survive;
 * when the same lines changed differently, the merge fails. Plain functions,
 * no Obsidian imports.
 */

/**
 * Above this many cells (base lines times the other side's lines, after the
 * common start and end are trimmed) the diff gives up, and so does the merge.
 */
const MAX_DIFF_CELLS = 4_000_000

/** A run of base lines, `[baseStart, baseEnd)`, replaced by the other side's `[start, end)`. */
export interface Hunk {
  baseStart: number
  baseEnd: number
  start: number
  end: number
}

/** Splits text into lines, each keeping its own ending (`\n` or `\r\n`). */
export const splitLines = (text: string): string[] => {
  const lines: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lines.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start))
  }
  return lines
}

/**
 * The hunks that turn `base` into `other`, from a longest common subsequence
 * of their lines; undefined when the files are too far apart to diff.
 */
export const diffHunks = (
  base: string[],
  other: string[],
): Hunk[] | undefined => {
  let prefix = 0
  while (
    prefix < base.length &&
    prefix < other.length &&
    base[prefix] === other[prefix]
  ) {
    prefix++
  }
  let suffix = 0
  while (
    suffix < base.length - prefix &&
    suffix < other.length - prefix &&
    base[base.length - 1 - suffix] === other[other.length - 1 - suffix]
  ) {
    suffix++
  }
  const n = base.length - prefix - suffix
  const m = other.length - prefix - suffix
  if (n * m > MAX_DIFF_CELLS) {
    return undefined
  }

  // lcs[i * width + j]: the longest common subsequence of the middle parts
  // from base line i and other line j on.
  const width = m + 1
  const lcs = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        base[prefix + i] === other[prefix + j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
    }
  }

  const hunks: Hunk[] = []
  const addHunk = (i0: number, i1: number, j0: number, j1: number) => {
    if (i0 < i1 || j0 < j1) {
      hunks.push({
        baseStart: prefix + i0,
        baseEnd: prefix + i1,
        start: prefix + j0,
        end: prefix + j1,
      })
    }
  }
  let i = 0
  let j = 0
  let hunkI = 0
  let hunkJ = 0
  while (i < n || j < m) {
    if (i < n && j < m && base[prefix + i] === other[prefix + j]) {
      addHunk(hunkI, i, hunkJ, j)
      i++
      j++
      hunkI = i
      hunkJ = j
    } else if (
      j >= m ||
      (i < n && lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])
    ) {
      i++
    } else {
      j++
    }
  }
  addHunk(hunkI, n, hunkJ, m)
  return hunks
}

/**
 * Merges `local` and `remote`, both edited from `base`. Returns the merged
 * text, or undefined when both sides changed the same lines differently (or
 * the files are too far apart to diff). Line endings are kept as found.
 */
export const merge3 = (
  base: string,
  local: string,
  remote: string,
): string | undefined => {
  const baseLines = splitLines(base)
  const sides = [splitLines(local), splitLines(remote)]
  const tagged: { hunk: Hunk; side: number }[] = []
  for (let side = 0; side < sides.length; side++) {
    const hunks = diffHunks(baseLines, sides[side])
    if (hunks === undefined) {
      return undefined
    }
    for (const hunk of hunks) {
      tagged.push({ hunk, side })
    }
  }
  tagged.sort(
    (x, y) =>
      x.hunk.baseStart - y.hunk.baseStart || x.hunk.baseEnd - y.hunk.baseEnd,
  )

  const out: string[] = []
  let baseDone = 0
  let k = 0
  while (k < tagged.length) {
    // A region of the base that one side or both changed: hunks that overlap
    // it, or that start where it starts (two insertions at the same place).
    const regionStart = tagged[k].hunk.baseStart
    let regionEnd = tagged[k].hunk.baseEnd
    const group = [tagged[k]]
    k++
    while (
      k < tagged.length &&
      (tagged[k].hunk.baseStart < regionEnd ||
        tagged[k].hunk.baseStart === regionStart)
    ) {
      regionEnd = Math.max(regionEnd, tagged[k].hunk.baseEnd)
      group.push(tagged[k])
      k++
    }

    // What each side has in place of the region.
    const replacement = sides.map((lines, side) => {
      const hunks = group.filter((x) => x.side === side).map((x) => x.hunk)
      if (hunks.length === 0) {
        return undefined
      }
      const first = hunks[0]
      const last = hunks[hunks.length - 1]
      return lines.slice(
        first.start - (first.baseStart - regionStart),
        last.end + (regionEnd - last.baseEnd),
      )
    })

    for (let i = baseDone; i < regionStart; i++) {
      out.push(baseLines[i])
    }
    const [fromLocal, fromRemote] = replacement
    if (fromLocal !== undefined && fromRemote !== undefined) {
      if (fromLocal.join('') !== fromRemote.join('')) {
        return undefined
      }
      out.push(...fromLocal)
    } else {
      out.push(...(fromLocal ?? fromRemote ?? []))
    }
    baseDone = regionEnd
  }
  for (let i = baseDone; i < baseLines.length; i++) {
    out.push(baseLines[i])
  }
  return out.join('')
}
