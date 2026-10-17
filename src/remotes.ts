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
 * Gives a single-remote setup its list: one remote `dropbox`, with every
 * per-remote setting left to fall back to the top-level one, and the table
 * `default → dropbox`, so it syncs exactly as before. Returns whether it
 * changed anything; the caller then moves the records from
 * `LEGACY_PROFILE_ID` to the new profile.
 */
export const migrateToRemotes = (settings: RemotelySavePluginSettings) => {
  if (settings.remotes !== undefined && settings.remotes.length > 0) {
    if (settings.routes === undefined) {
      settings.routes = { routes: [], defaultTarget: settings.remotes[0].id }
    }
    return false
  }
  settings.remotes = [
    {
      id: 'dropbox',
      name: 'Dropbox',
      type: 'dropbox',
      enabled: true,
      dropbox: settings.dropbox,
    },
  ]
  settings.routes = { routes: [], defaultTarget: 'dropbox' }
  settings.routesUpdatedAt = 0
  return true
}

/**
 * Keeps one object behind a Dropbox remote's credentials and the top-level
 * `dropbox`, which the OAuth flow and the settings page write, so a token
 * refreshed in a run is the one saved.
 */
export const linkDropboxConfig = (settings: RemotelySavePluginSettings) => {
  const remote = settings.remotes?.find((r) => r.type === 'dropbox')
  if (remote === undefined) {
    return
  }
  if (remote.dropbox === undefined) {
    remote.dropbox = settings.dropbox
  } else {
    settings.dropbox = remote.dropbox
  }
}

/** The settings object one remote's run gets. */
export const settingsForRemote = (
  settings: RemotelySavePluginSettings,
  remote: RemoteConfig,
): RemotelySavePluginSettings => ({
  ...settings,
  serviceType: remote.type,
  dropbox: remote.dropbox ?? settings.dropbox,
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
  const names = (settings.remotes ?? []).map((r) => r.name)
  if (new Set(names).size !== names.length) {
    reasons.push('Two remotes have the same name.')
  }
  return reasons
}
