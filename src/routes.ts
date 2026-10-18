/**
 * The route table: which remote each folder of the vault syncs with.
 * Plain functions with no Obsidian imports, so they test on their own.
 * `docs/design.md`, "How folders route", is the spec.
 */

/** The target of a row that syncs nowhere: the files stay on this device. */
export const LOCAL_ONLY = 'local-only'

export interface Route {
  /** a folder relative to the vault root, without slashes at either end */
  folder: string
  /** a remote's id, or `LOCAL_ONLY` */
  target: string
}

export interface RouteTable {
  routes: Route[]
  /** the default row: where everything no route names goes */
  defaultTarget?: string
}

/** What the table needs to know of each remote. */
export interface RemoteRef {
  id: string
  name: string
  enabled: boolean
  syncConfigDir?: boolean
}

/** `a/b/` and `/a/b` both become `a/b`. */
export const normalizeFolder = (folder: string) =>
  folder.trim().replace(/^\/+/, '').replace(/\/+$/, '')

/** Whether `folder` holds `path` (or is it), on whole segments. */
export const isUnder = (path: string, folder: string) =>
  path === folder || path.startsWith(`${folder}/`)

/**
 * The target for a vault path (a file `a/b.md` or a folder `a/b/`): the
 * longest route holding it, else the default. Undefined when the table has
 * no default row and no route holds it.
 */
export const routeOf = (table: RouteTable, key: string) => {
  const path = key.replace(/\/+$/, '')
  let best: Route | undefined = undefined
  for (const route of table.routes) {
    if (
      isUnder(path, route.folder) &&
      (best === undefined || route.folder.length > best.folder.length)
    ) {
      best = route
    }
  }
  return best === undefined ? table.defaultTarget : best.target
}

/**
 * The folder keys (`areas/`, with the engine's trailing slash) above each
 * route to `target`, which its run needs as parents of what it syncs.
 */
export const ancestorFolders = (table: RouteTable, target: string) => {
  const res = new Set<string>()
  for (const route of table.routes) {
    if (route.target !== target) {
      continue
    }
    const parts = route.folder.split('/')
    for (let i = 1; i < parts.length; ++i) {
      res.add(`${parts.slice(0, i).join('/')}/`)
    }
  }
  return res
}

/**
 * The folder keys a remote's run must never delete as empty: those above one
 * of its own routes (in its run only as parents) and those above a route to
 * another target (their subtree holds notes the run can't see). The engine
 * seeds its kept-folder set with them.
 */
export const sharedFoldersFor = (table: RouteTable, target: string) => {
  const res = ancestorFolders(table, target)
  for (const route of table.routes) {
    if (route.target === target) {
      continue
    }
    const parts = route.folder.split('/')
    for (let i = 1; i < parts.length; ++i) {
      res.add(`${parts.slice(0, i).join('/')}/`)
    }
  }
  return res
}

/**
 * The route filter for one remote's run: whether a key is in it. A key is
 * when the table routes it to this remote, and a folder key also when it
 * sits above one of this remote's routes.
 */
export const routeFilterFor = (table: RouteTable, target: string) => {
  const ancestors = ancestorFolders(table, target)
  return (key: string) =>
    routeOf(table, key) === target || (key.endsWith('/') && ancestors.has(key))
}

/**
 * Why the settings page won't save this setup, one reason each; empty when
 * it's fine.
 */
export const refusedSetup = (table: RouteTable, remotes: RemoteRef[]) => {
  const reasons: string[] = []
  const ids = new Set(remotes.map((r) => r.id))
  const known = (target: string) => target === LOCAL_ONLY || ids.has(target)
  const seen = new Set<string>()
  for (const route of table.routes) {
    const folder = normalizeFolder(route.folder)
    if (folder === '') {
      reasons.push('A route has no folder.')
      continue
    }
    if (seen.has(folder)) {
      reasons.push(`The folder "${folder}" is routed twice.`)
    }
    seen.add(folder)
    if (!known(route.target)) {
      reasons.push(
        `The folder "${folder}" is routed to a remote that doesn't exist.`,
      )
    }
  }
  if (table.defaultTarget === undefined || table.defaultTarget === '') {
    reasons.push('There is no default row.')
  } else if (!known(table.defaultTarget)) {
    reasons.push("The default row names a remote that doesn't exist.")
  }
  if (remotes.filter((r) => r.syncConfigDir ?? false).length > 1) {
    reasons.push('The config folder may sync with one remote only.')
  }
  return reasons
}

const quoted = (folders: string[]) => folders.map((f) => `"${f}"`).join(', ')

/**
 * The table read for one remote: "everything except "work"", "only
 * "work"", "nothing".
 */
export const describeTarget = (table: RouteTable, target: string) => {
  // a route's area starts where its parent goes somewhere else
  const parentGoesHere = (r: Route) =>
    routeOf(table, parentOf(r.folder)) === target
  const also = table.routes
    .filter((r) => r.target === target && !parentGoesHere(r))
    .map((r) => r.folder)
  const except = table.routes
    .filter((r) => r.target !== target && parentGoesHere(r))
    .map((r) => r.folder)
  let res: string
  if (table.defaultTarget === target) {
    res =
      except.length === 0 ? 'everything' : `everything except ${quoted(except)}`
    if (also.length > 0) {
      res += `, but still ${quoted(also)}`
    }
  } else if (also.length === 0) {
    res = 'nothing'
  } else {
    res = `only ${quoted(also)}`
    if (except.length > 0) {
      res += `, except ${quoted(except)}`
    }
  }
  return res
}

const parentOf = (folder: string) => {
  const i = folder.lastIndexOf('/')
  return i < 0 ? '' : folder.slice(0, i)
}

/**
 * The ownership file each remote keeps (`.remotely-save-lite/routes.json`):
 * the folders it owns, by its name, and when the table that wrote it changed.
 */
export interface OwnershipFile {
  remote: string
  folders: string[]
  updatedAt: number
}

export const OWNERSHIP_FILE_KEY = '.remotely-save-lite/routes.json'

/** The file this device writes to a remote, from its table. */
export const ownershipFor = (
  table: RouteTable,
  remote: RemoteRef,
  updatedAt: number,
): OwnershipFile => ({
  remote: remote.name,
  folders: table.routes
    .filter((r) => r.target === remote.id)
    .map((r) => r.folder)
    .sort(),
  updatedAt,
})

export type OwnershipMerge =
  | { kind: 'same' }
  | {
      kind: 'adopt'
      table: RouteTable
      updatedAt: number
      /** each change made, for the notice */
      changes: string[]
    }
  | { kind: 'contradiction'; folder: string; owners: string[] }

/**
 * Compares this device's table with the ownership files read from its
 * remotes. A newer file is adopted: its folders route to its remote, and a
 * folder it no longer lists, which no newer file claims, becomes local only
 * (never the default, which would upload it elsewhere). One folder claimed
 * by two remotes at the same time is a contradiction, and the runs stop.
 */
export const mergeOwnership = (
  table: RouteTable,
  updatedAt: number,
  remotes: RemoteRef[],
  files: OwnershipFile[],
): OwnershipMerge => {
  const idByName = new Map(remotes.map((r) => [r.name, r.id]))
  // the newest claim on each folder
  const claims = new Map<string, { remote: string; updatedAt: number }>()
  for (const file of files) {
    for (const folder of file.folders) {
      const claim = claims.get(folder)
      if (claim === undefined || file.updatedAt > claim.updatedAt) {
        claims.set(folder, { remote: file.remote, updatedAt: file.updatedAt })
      } else if (
        file.updatedAt === claim.updatedAt &&
        file.remote !== claim.remote
      ) {
        return {
          kind: 'contradiction',
          folder,
          owners: [claim.remote, file.remote],
        }
      }
    }
  }
  const newer = files.filter((f) => f.updatedAt > updatedAt)
  if (newer.length === 0) {
    return { kind: 'same' }
  }
  const routes = table.routes.map((r) => ({ ...r }))
  const changes: string[] = []
  for (const [folder, claim] of claims) {
    const id = idByName.get(claim.remote)
    if (claim.updatedAt <= updatedAt || id === undefined) {
      continue
    }
    const route = routes.find((r) => r.folder === folder)
    if (route === undefined) {
      routes.push({ folder, target: id })
      changes.push(`"${folder}" now syncs with ${claim.remote}`)
    } else if (route.target !== id) {
      route.target = id
      changes.push(`"${folder}" now syncs with ${claim.remote}`)
    }
  }
  for (const file of newer) {
    const id = idByName.get(file.remote)
    for (const route of routes) {
      if (
        route.target === id &&
        !file.folders.includes(route.folder) &&
        (claims.get(route.folder)?.remote ?? file.remote) === file.remote
      ) {
        route.target = LOCAL_ONLY
        changes.push(`"${route.folder}" is now local only`)
      }
    }
  }
  if (changes.length === 0) {
    return { kind: 'same' }
  }
  return {
    kind: 'adopt',
    table: { ...table, routes },
    updatedAt: Math.max(...newer.map((f) => f.updatedAt)),
    changes,
  }
}

/** A run held before it starts, and the one question it asks. */
export interface HeldQuestion {
  /** the routed folder missing locally */
  gone: string
  /** the remote it routes to */
  goneTarget: string
  /** a new, never-synced top-level folder, when one appeared */
  appeared?: string
  /** the remotes held: the gone folder's, and the default's when `appeared` */
  held: string[]
}

/**
 * The hold rule: a routed folder missing locally whose remote holds files
 * there (it has previous-sync records under it) holds that remote's run;
 * when a new, never-synced top-level folder has appeared too, the default's
 * run is held with it, since that may be the same folder renamed.
 */
export const heldQuestions = (
  table: RouteTable,
  localFolders: Set<string>,
  recordsByTarget: Map<string, string[]>,
): HeldQuestion[] => {
  const synced = [...recordsByTarget.values()].flat()
  const appeared = [...localFolders].filter(
    (f) =>
      !f.includes('/') &&
      routeOf(table, `${f}/`) === table.defaultTarget &&
      !table.routes.some((r) => isUnder(r.folder, f)) &&
      !synced.some((k) => isUnder(k.replace(/\/+$/, ''), f)),
  )
  const res: HeldQuestion[] = []
  for (const route of table.routes) {
    if (localFolders.has(route.folder)) {
      continue
    }
    const records = recordsByTarget.get(route.target) ?? []
    if (!records.some((k) => isUnder(k.replace(/\/+$/, ''), route.folder))) {
      continue
    }
    const held = [route.target]
    const q: HeldQuestion = {
      gone: route.folder,
      goneTarget: route.target,
      held,
    }
    // offered to the first question only: one new folder can't be the
    // rename of two gone ones, and the default stays held through the first
    if (appeared.length > 0 && res.length === 0) {
      q.appeared = appeared[0]
      if (
        table.defaultTarget !== undefined &&
        !held.includes(table.defaultTarget)
      ) {
        held.push(table.defaultTarget)
      }
    }
    res.push(q)
  }
  return res
}

/** A routed folder renamed in the vault, applied before the next runs. */
export interface PendingRename {
  from: string
  to: string
  /** the remotes whose folder and records are renamed already */
  done: string[]
}

/** The table after a routed folder (and the routes under it) is renamed. */
export const renameRoute = (
  table: RouteTable,
  from: string,
  to: string,
): RouteTable => ({
  ...table,
  routes: table.routes.map((r) =>
    isUnder(r.folder, from)
      ? { ...r, folder: `${to}${r.folder.slice(from.length)}` }
      : r,
  ),
})
