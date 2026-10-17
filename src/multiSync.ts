/**
 * The orchestrator: one sync over several remotes, each a normal `syncer()`
 * run with its own settings slice, profile, and route filter, under the one
 * sync lock the caller holds. `docs/design.md`, "How a sync runs", is the
 * spec. No Obsidian imports: the plugin passes in what it needs.
 */
import type {
  Entity,
  RemoteConfig,
  RemotelySavePluginSettings,
  SyncTriggerSourceType,
} from './baseTypes'
import type { FakeFs } from './fsAll'
import type { FakeFsEncrypt } from './fsEncrypt'
import {
  type InternalDBs,
  clearPrevSyncRecordByVaultAndProfile,
  clearProfileRecords,
  getAllPrevSyncRecordsByVaultAndProfile,
  moveProfileRecords,
  upsertPrevSyncRecordByVaultAndProfile,
} from './localdb'
import {
  profileIdOf,
  refusedSettings,
  remoteRefs,
  settingsForRemote,
} from './remotes'
import {
  type HeldQuestion,
  OWNERSHIP_FILE_KEY,
  type OwnershipFile,
  type RouteTable,
  heldQuestions,
  isUnder,
  mergeOwnership,
  ownershipFor,
  renameRoute,
  routeFilterFor,
  routeOf,
} from './routes'
import type { Profiler } from './profiler'
import { syncer } from './sync'

/** A remote that stages its writes and can say which it didn't commit. */
export interface StagingFs {
  /** the keys written or removed in the run and not committed */
  uncommittedKeys(): string[]
}

const isStaging = (fs: FakeFs): fs is FakeFs & StagingFs =>
  typeof (fs as any).uncommittedKeys === 'function'

export type RemoteStatus = 'ok' | 'failed' | 'held' | 'stopped' | 'disabled'

export interface RemoteResult {
  status: RemoteStatus
  at: number
  error?: string
  /** the held question, when held */
  question?: HeldQuestion
}

/**
 * `rename`: the gone folder was renamed to the appeared one. `new`: the
 * appeared folder is new; the gone folder's remote stays held. `delete`: the
 * gone folder was deleted; its run deletes it on the remote too.
 */
export type HeldAnswer = 'rename' | 'new' | 'delete'

export interface MultiSyncDeps {
  fsLocal: FakeFs
  db: InternalDBs
  vaultRandomID: string
  configDir: string
  triggerSource: SyncTriggerSourceType
  /** a remote's FakeFs, from its settings slice */
  makeFs: (remote: RemoteConfig, settings: RemotelySavePluginSettings) => FakeFs
  /** the encryption layer over it (passed in: its workers need a browser) */
  makeEncrypt: (
    fs: FakeFs,
    settings: RemotelySavePluginSettings,
  ) => FakeFsEncrypt
  getProtectError: any
  profiler?: Profiler
  saveSettings: () => Promise<void>
  notice?: (msg: string) => void
  askHeld?: (q: HeldQuestion) => Promise<HeldAnswer | undefined>
  onRemoteStart?: (remote: RemoteConfig) => void
  onRemoteResult?: (remote: RemoteConfig, result: RemoteResult) => void
  /** passed through to each run */
  runCallbacks?: {
    notifyFunc?: (s: SyncTriggerSourceType, step: number) => Promise<any>
    errNotifyFunc?: (s: SyncTriggerSourceType, error: Error) => Promise<any>
    ribboonFunc?: (s: SyncTriggerSourceType, step: number) => Promise<any>
    statusBarFunc?: (
      s: SyncTriggerSourceType,
      step: number,
      everythingOk: boolean,
    ) => any
    callbackSyncProcess?: any
    callbackConflictCopy?: (key: string, copyKey: string) => void
  }
  now?: () => number
}

/**
 * Whether the routing is in use at all: with one remote and no routes the
 * runs write nothing of their own, so a migrated setup syncs as before.
 */
const isRouted = (settings: RemotelySavePluginSettings) =>
  (settings.remotes ?? []).length > 1 ||
  (settings.routes?.routes ?? []).length > 0

const hasPassword = (settings: RemotelySavePluginSettings) =>
  (settings.password ?? '') !== ''

const readOwnership = async (fs: FakeFs) => {
  try {
    const content = await fs.readFile(OWNERSHIP_FILE_KEY)
    const parsed = JSON.parse(new TextDecoder().decode(content))
    if (
      typeof parsed?.remote === 'string' &&
      Array.isArray(parsed?.folders) &&
      typeof parsed?.updatedAt === 'number'
    ) {
      return parsed as OwnershipFile
    }
  } catch (e) {
    // no file yet, or unreadable: this device's table stands
  }
  return undefined
}

const writeOwnership = async (fs: FakeFs, file: OwnershipFile) => {
  const bytes = new TextEncoder().encode(JSON.stringify(file, null, 2))
  const now = Date.now()
  await fs.writeFile(
    OWNERSHIP_FILE_KEY,
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    now,
    now,
  )
}

/** Each enabled remote's FakeFs and settings slice, made once per sync. */
interface Run {
  remote: RemoteConfig
  settings: RemotelySavePluginSettings
  fs: FakeFs
  profileID: string
}

/**
 * Applies the routed-folder renames recorded since the last sync: per
 * remote, the folder renamed on the remote, then that profile's records.
 * A remote whose rename fails keeps it pending and doesn't run, since its
 * records and its folder would disagree.
 */
const applyPendingRenames = async (
  settings: RemotelySavePluginSettings,
  runs: Run[],
  deps: MultiSyncDeps,
  failed: Map<string, string>,
) => {
  const pending = settings.pendingRenames ?? []
  for (const rename of pending) {
    for (const run of runs) {
      if (rename.done.includes(run.remote.id)) {
        continue
      }
      const records = await getAllPrevSyncRecordsByVaultAndProfile(
        deps.db,
        deps.vaultRandomID,
        run.profileID,
      )
      const under = records.filter((r) =>
        isUnder(r.key!.replace(/\/+$/, ''), rename.from),
      )
      // an encrypted remote names each path on its own, so a folder move
      // there isn't one call: its run deletes and uploads instead
      if (under.length > 0 && !hasPassword(run.settings)) {
        try {
          await run.fs.rename(`${rename.from}/`, `${rename.to}/`)
        } catch (e: any) {
          failed.set(run.remote.id, `rename ${rename.from}: ${e?.message ?? e}`)
          continue
        }
        await moveProfileRecords(
          deps.db,
          deps.vaultRandomID,
          run.profileID,
          run.profileID,
          (key) =>
            isUnder(key.replace(/\/+$/, ''), rename.from)
              ? `${rename.to}${key.slice(rename.from.length)}`
              : undefined,
        )
      }
      rename.done.push(run.remote.id)
    }
  }
  const enabled = runs.map((r) => r.remote.id)
  settings.pendingRenames = pending.filter(
    (p) => !enabled.every((id) => p.done.includes(id)),
  )
  await deps.saveSettings()
}

/**
 * Records a routed folder renamed in the vault: the route follows now, and
 * the remotes' folders and records follow before the next run. A rename of
 * a folder no route sits in or under changes nothing here.
 */
export const recordFolderRename = (
  settings: RemotelySavePluginSettings,
  from: string,
  to: string,
  now: number,
) => {
  const table = settings.routes
  if (
    table === undefined ||
    !table.routes.some((r) => isUnder(r.folder, from))
  ) {
    return false
  }
  settings.routes = renameRoute(table, from, to)
  settings.routesUpdatedAt = now
  settings.pendingRenames = [
    ...(settings.pendingRenames ?? []),
    { from, to, done: [] },
  ]
  return true
}

/** The folders whose target a table change moves, old target and new. */
export const routeChanges = (before: RouteTable, after: RouteTable) => {
  const folders = new Set([
    ...before.routes.map((r) => r.folder),
    ...after.routes.map((r) => r.folder),
  ])
  const res: { folder: string; from?: string; to?: string }[] = []
  for (const folder of folders) {
    const from = routeOf(before, `${folder}/`)
    const to = routeOf(after, `${folder}/`)
    if (from !== to) {
      res.push({ folder, from, to })
    }
  }
  return res
}

/**
 * After a route change, the old remote's records under the folder go, so
 * its copies are neither deleted nor pulled back by a later run.
 */
export const forgetFolder = async (
  db: InternalDBs,
  vaultRandomID: string,
  remote: RemoteConfig,
  folder: string,
) =>
  await clearProfileRecords(db, vaultRandomID, profileIdOf(remote), (key) =>
    isUnder(key.replace(/\/+$/, ''), folder),
  )

/** Deletes a folder's copies on a remote, after a route change. */
export const deleteRemoteFolder = async (fs: FakeFs, folder: string) => {
  const keys = (await fs.walk())
    .map((e) => e.key!)
    .filter((k) => isUnder(k.replace(/\/+$/, ''), folder))
    // files first, then folders, deepest first
    .sort(
      (a, b) =>
        Number(a.endsWith('/')) - Number(b.endsWith('/')) ||
        b.length - a.length,
    )
  for (const key of keys) {
    await fs.rm(key)
  }
  await fs.finishSync?.()
}

/**
 * The ownership check: reads each remote's routes file, adopts a newer
 * table, and writes this device's ownership where a remote's differs.
 * Returns the reason to stop every run, when there is one.
 */
const checkOwnership = async (
  settings: RemotelySavePluginSettings,
  runs: Run[],
  deps: MultiSyncDeps,
) => {
  // an encrypted remote's routes file goes through its encryption, which
  // needs a listing first to know the remote's names
  const owning: { run: Run; io: FakeFs; close?: () => void }[] = []
  for (const run of runs) {
    if (!hasPassword(run.settings)) {
      owning.push({ run, io: run.fs })
      continue
    }
    const enc = deps.makeEncrypt(run.fs, run.settings)
    try {
      await enc.walk()
      owning.push({ run, io: enc, close: () => enc.closeResources() })
    } catch (e) {
      // unreachable: its run reports the failure
      enc.closeResources()
    }
  }
  const files: OwnershipFile[] = []
  for (const { io } of owning) {
    const file = await readOwnership(io)
    if (file !== undefined) {
      files.push(file)
    }
  }
  const refs = remoteRefs(settings)
  const merged = mergeOwnership(
    settings.routes!,
    settings.routesUpdatedAt ?? 0,
    refs,
    files,
  )
  const closeAll = () => {
    for (const o of owning) {
      o.close?.()
    }
  }
  if (merged.kind === 'contradiction') {
    closeAll()
    return `The folder "${merged.folder}" is owned by ${merged.owners.join(' and ')}. Fix the routes in the settings.`
  }
  if (merged.kind === 'adopt') {
    settings.routes = merged.table
    settings.routesUpdatedAt = merged.updatedAt
    await deps.saveSettings()
    deps.notice?.(
      `Routes updated from another device: ${merged.changes.join('; ')}.`,
    )
  }
  for (const { run, io } of owning) {
    const mine = ownershipFor(
      settings.routes!,
      refs.find((r) => r.id === run.remote.id)!,
      settings.routesUpdatedAt ?? 0,
    )
    const theirs = files.find((f) => f.remote === run.remote.name)
    if (JSON.stringify(theirs) !== JSON.stringify(mine)) {
      try {
        await writeOwnership(io, mine)
      } catch (e) {
        // that remote's run reports the failure; the next sync writes again
      }
    }
  }
  closeAll()
  return undefined
}

/** The vault's folders (no trailing slash), from the local walk. */
const localFoldersOf = (entities: Entity[]) => {
  const res = new Set<string>()
  for (const e of entities) {
    const key = e.key ?? ''
    const parts = key.replace(/\/+$/, '').split('/')
    const depth = key.endsWith('/') ? parts.length : parts.length - 1
    for (let i = 1; i <= depth; ++i) {
      res.add(parts.slice(0, i).join('/'))
    }
  }
  return res
}

/**
 * The hold rule before the runs. Returns the remotes held, each with its
 * question; an answer may rename a route or release a hold.
 */
const applyHoldRule = async (
  settings: RemotelySavePluginSettings,
  runs: Run[],
  deps: MultiSyncDeps,
) => {
  const recordsByTarget = new Map<string, string[]>()
  for (const run of runs) {
    const records = await getAllPrevSyncRecordsByVaultAndProfile(
      deps.db,
      deps.vaultRandomID,
      run.profileID,
    )
    recordsByTarget.set(
      run.remote.id,
      records.map((r) => r.key!),
    )
  }
  const local = localFoldersOf(await deps.fsLocal.walk())
  const held = new Map<string, HeldQuestion>()
  for (const q of heldQuestions(settings.routes!, local, recordsByTarget)) {
    const answer = await deps.askHeld?.(q)
    if (answer === 'rename' && q.appeared !== undefined) {
      recordFolderRename(settings, q.gone, q.appeared, (deps.now ?? Date.now)())
      await deps.saveSettings()
      continue
    }
    if (answer === 'delete') {
      continue
    }
    const stillHeld = answer === 'new' ? [q.goneTarget] : q.held
    for (const id of stillHeld) {
      held.set(id, q)
    }
  }
  return held
}

/**
 * Restores the records of the keys a staging remote didn't commit to what
 * they were before the run, so the next run sees an upload as still to do
 * and a deletion as still to make, never as a change on the remote.
 */
const rollBack = async (
  run: Run,
  before: Map<string, Entity>,
  deps: MultiSyncDeps,
) => {
  if (!isStaging(run.fs)) {
    return 0
  }
  const keys = run.fs.uncommittedKeys()
  for (const key of keys) {
    const prev = before.get(key)
    if (prev === undefined) {
      await clearPrevSyncRecordByVaultAndProfile(
        deps.db,
        deps.vaultRandomID,
        run.profileID,
        key,
      )
    } else {
      await upsertPrevSyncRecordByVaultAndProfile(
        deps.db,
        deps.vaultRandomID,
        run.profileID,
        prev,
      )
    }
  }
  return keys.length
}

/**
 * One sync over every enabled remote, in the list's order. The caller holds
 * the sync lock for the whole of it. One remote failing doesn't stop the
 * next; each gets its own result.
 */
export const syncAllRemotes = async (
  settings: RemotelySavePluginSettings,
  deps: MultiSyncDeps,
) => {
  const now = deps.now ?? Date.now
  const results = new Map<string, RemoteResult>()
  const remotes = settings.remotes ?? []
  const report = (remote: RemoteConfig, result: RemoteResult) => {
    results.set(remote.id, result)
    deps.onRemoteResult?.(remote, result)
  }

  const refused = refusedSettings(settings)
  if (refused.length > 0) {
    for (const remote of remotes) {
      report(remote, { status: 'stopped', at: now(), error: refused.join(' ') })
    }
    return results
  }

  const runs: Run[] = []
  for (const remote of remotes) {
    if (!remote.enabled) {
      report(remote, { status: 'disabled', at: now() })
      continue
    }
    const slice = settingsForRemote(settings, remote)
    try {
      runs.push({
        remote,
        settings: slice,
        fs: deps.makeFs(remote, slice),
        profileID: profileIdOf(remote),
      })
    } catch (e: any) {
      report(remote, {
        status: 'failed',
        at: now(),
        error: e?.message ?? `${e}`,
      })
    }
  }

  let held = new Map<string, HeldQuestion>()
  const failed = new Map<string, string>()
  if (isRouted(settings)) {
    await applyPendingRenames(settings, runs, deps, failed)
    const stop = await checkOwnership(settings, runs, deps)
    if (stop !== undefined) {
      for (const run of runs) {
        report(run.remote, { status: 'stopped', at: now(), error: stop })
      }
      return results
    }
    held = await applyHoldRule(settings, runs, deps)
    // an answer "renamed" records a rename: finish it before the runs
    if ((settings.pendingRenames ?? []).length > 0) {
      await applyPendingRenames(settings, runs, deps, failed)
    }
  }

  for (const run of runs) {
    const { remote } = run
    if (failed.has(remote.id)) {
      report(remote, {
        status: 'failed',
        at: now(),
        error: failed.get(remote.id),
      })
      continue
    }
    if (held.has(remote.id)) {
      report(remote, {
        status: 'held',
        at: now(),
        question: held.get(remote.id),
      })
      continue
    }
    deps.onRemoteStart?.(remote)
    const before = new Map(
      (
        await getAllPrevSyncRecordsByVaultAndProfile(
          deps.db,
          deps.vaultRandomID,
          run.profileID,
        )
      ).map((r) => [r.key!, r]),
    )
    const fsEncrypt = deps.makeEncrypt(run.fs, run.settings)
    let error: string | undefined = undefined
    const cb = deps.runCallbacks ?? {}
    await syncer(
      deps.fsLocal,
      run.fs,
      fsEncrypt,
      deps.profiler,
      deps.db,
      deps.triggerSource,
      run.profileID,
      deps.vaultRandomID,
      deps.configDir,
      run.settings,
      deps.getProtectError,
      // the caller holds the one lock for every run
      () => {},
      cb.notifyFunc,
      async (s, e) => {
        error = e?.message ?? 'error while sync'
        await cb.errNotifyFunc?.(s, e)
      },
      cb.ribboonFunc,
      cb.statusBarFunc,
      cb.callbackSyncProcess,
      cb.callbackConflictCopy,
      isRouted(settings)
        ? routeFilterFor(settings.routes as RouteTable, remote.id)
        : undefined,
    )
    fsEncrypt.closeResources()
    const rolledBack = await rollBack(run, before, deps)
    if (error === undefined && rolledBack > 0) {
      error = `${rolledBack} changes weren't committed; the next sync tries them again.`
    }
    report(remote, {
      status: error === undefined ? 'ok' : 'failed',
      at: now(),
      error,
    })
  }
  return results
}
