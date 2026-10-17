// Changed for Remotely Save Lite (2026): Dropbox only
import type { RemotelySavePluginSettings } from './baseTypes'
import type { FakeFs } from './fsAll'
import { FakeFsDropbox } from './fsDropbox'

/**
 * To avoid circular dependency, we need a new file here.
 */
export function getClient(
  settings: RemotelySavePluginSettings,
  vaultName: string,
  saveUpdatedConfigFunc: () => Promise<any>,
): FakeFs {
  switch (settings.serviceType) {
    case 'dropbox':
      return new FakeFsDropbox(
        settings.dropbox,
        vaultName,
        saveUpdatedConfigFunc,
      )
    default:
      throw Error(`cannot init client for serviceType=${settings.serviceType}`)
  }
}
