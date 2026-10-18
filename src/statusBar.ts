/**
 * The status bar's marks per remote: `· Dropbox ✓ · GitHub ✗`, with each
 * failure's error and each held question for the hover label. No Obsidian
 * imports.
 */
import type { RemoteConfig } from './baseTypes'
import type { RemoteResult } from './multiSync'

const MARKS: Record<RemoteResult['status'], string> = {
  ok: '✓',
  failed: '✗',
  stopped: '✗',
  held: '⏸',
  disabled: '–',
}

export const remoteMarks = (
  remotes: RemoteConfig[],
  results: Map<string, RemoteResult>,
) => {
  // one remote reads as before while it's well: no marks, unless a run
  // stopped or failed before it ran, which nothing else on the bar says
  const unwell = [...results.values()].some((r) => r.status !== 'ok')
  if (remotes.length < 2 && !unwell) {
    return { text: '', label: '' }
  }
  const text: string[] = []
  const label: string[] = []
  for (const remote of remotes) {
    const result = results.get(remote.id)
    if (result === undefined) {
      continue
    }
    text.push(`${remote.name} ${MARKS[result.status]}`)
    if (result.error !== undefined) {
      label.push(`${remote.name}: ${result.error}`)
    } else if (result.question !== undefined) {
      label.push(`${remote.name}: held, "${result.question.gone}" is gone`)
    }
  }
  return {
    text: text.length === 0 ? '' : ` · ${text.join(' · ')}`,
    label: label.length === 0 ? '' : `\n${label.join('\n')}`,
  }
}

/** The per-remote detail the status bar opens: one line each. */
export const remoteDetail = (
  remotes: RemoteConfig[],
  results: Map<string, RemoteResult>,
) =>
  remotes.map((remote) => {
    const result = results.get(remote.id)
    if (result === undefined) {
      return `${remote.name}: no run yet`
    }
    const when = new Date(result.at).toLocaleString()
    let line = `${remote.name}: ${result.status}, ${when}`
    if (result.error !== undefined) {
      line += `. ${result.error}`
    }
    if (result.question !== undefined) {
      line += `. "${result.question.gone}" is gone`
      if (result.question.appeared !== undefined) {
        line += ` and "${result.question.appeared}" is new`
      }
      line += '; the next sync asks again.'
    }
    return line
  })
