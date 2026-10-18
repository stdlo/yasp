// Changed for Yet Another Sync Plugin (2026): Dropbox and GitHub
import type { GithubConfig, RemotelySavePluginSettings } from './baseTypes'
import type { FakeFs } from './fsAll'
import { FakeFsDropbox } from './fsDropbox'
import { FakeFsGithub } from './fsGithub'
import { obsidianGithubRequest } from './fsGithubRequest'

/**
 * To avoid circular dependency, we need a new file here.
 */
export function getClient(
  settings: RemotelySavePluginSettings,
  vaultName: string,
  saveUpdatedConfigFunc: () => Promise<any>,
  github?: GithubConfig,
  notice?: (msg: string) => void,
): FakeFs {
  switch (settings.serviceType) {
    case 'dropbox':
      return new FakeFsDropbox(
        settings.dropbox,
        vaultName,
        saveUpdatedConfigFunc,
      )
    case 'github':
      if (github === undefined) {
        throw Error('GitHub: this remote has no settings yet')
      }
      return new FakeFsGithub(github, vaultName, obsidianGithubRequest, notice)
    default:
      throw Error(`cannot init client for serviceType=${settings.serviceType}`)
  }
}
