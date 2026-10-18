/**
 * The list of remotes in the settings: the migration from a single-remote
 * setup, and the settings object each remote's run gets. No Obsidian
 * imports.
 */
import type { RemoteConfig, RemotelySavePluginSettings } from './baseTypes'
import { type RemoteRef, refusedSetup } from './routes'

/** The profile the single-remote setup kept its records under. */
export const LEGACY_PROFILE_ID = 'dropbox-default-1'

export const profileIdOf = (remote: RemoteConfig) => `remote-${remote.id}`

/**
 * The settings' route table, an empty one when there is none (what
 * `refusedSettings()` reads too: such a setup is refused before it runs).
 */
export const routeTableOf = (settings: RemotelySavePluginSettings) =>
  settings.routes ?? { routes: [] }

/**
 * Gives a single-remote setup its list: one remote `dropbox`, with every
 * per-remote setting left to fall back to the top-level one, and the table
 * `default → dropbox`, so it syncs exactly as before. Idempotent: a setup
 * that has its list is left alone. It doesn't say whether it changed
 * anything, because the caller moves the records from `LEGACY_PROFILE_ID` to
 * the migrated remote's profile on every load (a load cut short before the
 * move finishes it on the next), and that move is idempotent too.
 */
export const migrateToRemotes = (settings: RemotelySavePluginSettings) => {
  // the Dropbox credentials live in `settings.dropbox` only, where the OAuth
  // flow and the settings page write them: a copy an earlier build kept on
  // the remote goes
  for (const remote of settings.remotes ?? []) {
    delete (remote as { dropbox?: unknown }).dropbox
  }
  if (settings.remotes !== undefined && settings.remotes.length > 0) {
    if (settings.routes === undefined) {
      settings.routes = { routes: [], defaultTarget: settings.remotes[0].id }
    }
    return
  }
  settings.remotes = [
    {
      id: 'dropbox',
      name: 'Dropbox',
      type: 'dropbox',
      enabled: true,
    },
  ]
  settings.routes = { routes: [], defaultTarget: 'dropbox' }
  settings.routesUpdatedAt = 0
}

/**
 * The settings object one remote's run gets. A Dropbox remote's credentials
 * are the top-level `dropbox` (the slice shares that object, so a token
 * refreshed in a run is the one saved).
 */
export const settingsForRemote = (
  settings: RemotelySavePluginSettings,
  remote: RemoteConfig,
): RemotelySavePluginSettings => ({
  ...settings,
  serviceType: remote.type,
  password: remote.password ?? settings.password,
  encryptionMethod: remote.encryptionMethod ?? settings.encryptionMethod,
  concurrency: remote.concurrency ?? settings.concurrency,
  syncDirection: remote.syncDirection ?? settings.syncDirection,
  conflictAction: remote.conflictAction ?? settings.conflictAction,
  protectModifyPercentage:
    remote.protectModifyPercentage ?? settings.protectModifyPercentage,
  syncConfigDir: remote.syncConfigDir ?? settings.syncConfigDir,
})

export const remoteRefs = (settings: RemotelySavePluginSettings): RemoteRef[] =>
  (settings.remotes ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    syncConfigDir: settingsForRemote(settings, r).syncConfigDir,
  }))

/** Why these settings may not be saved; empty when they may. */
export const refusedSettings = (settings: RemotelySavePluginSettings) => {
  const reasons = refusedSetup(
    settings.routes ?? { routes: [] },
    remoteRefs(settings),
  )
  const ids = (settings.remotes ?? []).map((r) => r.id)
  if (new Set(ids).size !== ids.length) {
    reasons.push('Two remotes have the same id.')
  }
  // a batched commit's rollback finds its records by vault path, which an
  // encrypted remote doesn't keep: until it does, GitHub syncs unencrypted
  for (const remote of settings.remotes ?? []) {
    if (
      remote.type === 'github' &&
      (settingsForRemote(settings, remote).password ?? '') !== ''
    ) {
      reasons.push(`${remote.name}: a GitHub remote can't be encrypted yet.`)
    }
  }
  const names = (settings.remotes ?? []).map((r) => r.name)
  if (new Set(names).size !== names.length) {
    reasons.push('Two remotes have the same name.')
  }
  return reasons
}
