/**
 * The settings page's part for several remotes: the remotes, each read
 * from the table ("everything except …", "only …"), a GitHub remote's own
 * settings, and the route table's rows. A refused setup shows its reason
 * and isn't saved.
 */
import cloneDeep from 'lodash/cloneDeep'
import { nanoid } from 'nanoid'
import { type App, Notice, Setting } from 'obsidian'
import type { RemoteConfig, RemotelySavePluginSettings } from './baseTypes'
import { getClient } from './fsGetter'
import type RemotelySavePlugin from './main' // unavoidable
import {
  deleteRemoteFolder,
  forgetFolder,
  forgetRemote,
  hasRecords,
  routeChanges,
} from './multiSync'
import { refusedSettings, settingsForRemote } from './remotes'
import {
  LOCAL_ONLY,
  type RouteTable,
  describeTarget,
  normalizeFolder,
} from './routes'
import { askChangeLocation, askDeleteOldCopies } from './routesModals'
import { wrapTextWithPasswordHide } from './settings'

const remoteFs = (plugin: RemotelySavePlugin, remote: RemoteConfig) =>
  getClient(
    settingsForRemote(plugin.settings, remote),
    plugin.app.vault.getName(),
    async () => await plugin.saveSettings(),
    remote.github,
  )

const newGithubRemote = (remotes: RemoteConfig[]): RemoteConfig => {
  let n = 1
  while (remotes.some((r) => r.name === (n === 1 ? 'GitHub' : `GitHub ${n}`))) {
    n += 1
  }
  return {
    // never reused: a removed remote's id may still be on another device's
    // remote or in a records key, and would hand its records to the new one
    id: `github-${nanoid()}`,
    name: n === 1 ? 'GitHub' : `GitHub ${n}`,
    type: 'github',
    // off until its settings are filled in
    enabled: false,
    password: '',
    syncConfigDir: false,
    github: { owner: '', repo: '', branch: 'main', token: '', folder: '' },
  }
}

/** Saves a table change: refused setups shown, route changes followed up. */
const saveTable = async (
  app: App,
  plugin: RemotelySavePlugin,
  draft: RouteTable,
  reasonsEl: HTMLElement,
) => {
  reasonsEl.empty()
  const next: RemotelySavePluginSettings = { ...plugin.settings, routes: draft }
  const reasons = refusedSettings(next)
  if (reasons.length > 0) {
    for (const reason of reasons) {
      reasonsEl.createEl('p', { text: reason, cls: 'mod-warning' })
    }
    return false
  }
  if (plugin.isSyncing) {
    reasonsEl.createEl('p', {
      text: 'A sync is running: save the routes once it finishes.',
      cls: 'mod-warning',
    })
    return false
  }
  const changes = routeChanges(plugin.settings.routes!, draft)
  plugin.settings.routes = draft
  plugin.settings.routesUpdatedAt = Date.now()
  await plugin.saveSettings()
  const remotes = plugin.settings.remotes ?? []
  for (const change of changes) {
    const old = remotes.find((r) => r.id === change.from)
    if (old === undefined) {
      continue
    }
    await forgetFolder(plugin.db, plugin.vaultRandomID, old, change.folder)
    if (await askDeleteOldCopies(app, change.folder, old.name)) {
      if ((settingsForRemote(plugin.settings, old).password ?? '') !== '') {
        new Notice(
          `${old.name} is encrypted: delete "${change.folder}" there yourself.`,
        )
        continue
      }
      try {
        await deleteRemoteFolder(remoteFs(plugin, old), change.folder)
        new Notice(`Deleted "${change.folder}" from ${old.name}.`)
      } catch (e: any) {
        new Notice(`${old.name}: ${e?.message ?? e}`)
      }
    }
  }
  return true
}

export const renderRemotesSettings = (
  containerEl: HTMLElement,
  app: App,
  plugin: RemotelySavePlugin,
  refresh: () => void,
) => {
  const div = containerEl.createDiv()
  div.createEl('h2', { text: 'Remotes and routes' })
  div.createEl('p', {
    text: 'Each folder syncs with one remote. The longest matching route wins; everything else follows the default row.',
  })
  const settings = plugin.settings
  const remotes = settings.remotes ?? []
  const table = settings.routes ?? { routes: [] }

  for (const remote of remotes) {
    const s = new Setting(div)
      .setName(remote.name)
      .setDesc(`${remote.type}: ${describeTarget(table, remote.id)}`)
      .addToggle((toggle) =>
        toggle.setValue(remote.enabled).onChange(async (val) => {
          remote.enabled = val
          await plugin.saveSettings()
        }),
      )
    if (remote.type === 'github') {
      s.addButton((b) =>
        b.setButtonText('Remove').onClick(async () => {
          const owned = table.routes.filter((r) => r.target === remote.id)
          if (owned.length > 0 || table.defaultTarget === remote.id) {
            new Notice(
              `Route its folders elsewhere first: ${owned.map((r) => r.folder).join(', ') || 'the default row'}.`,
            )
            return
          }
          settings.remotes = remotes.filter((r) => r !== remote)
          await plugin.saveSettings()
          // its records and sync bases go with it
          await forgetRemote(plugin.db, plugin.vaultRandomID, remote)
          refresh()
        }),
      )
      renderGithubSettings(div, app, plugin, remote)
    }
  }
  new Setting(div).addButton((b) =>
    b.setButtonText('Add a GitHub remote').onClick(async () => {
      settings.remotes = [...remotes, newGithubRemote(remotes)]
      await plugin.saveSettings()
      refresh()
    }),
  )

  div.createEl('h3', { text: 'Routes' })
  const draft = cloneDeep(table)
  const targets: [string, string][] = [
    ...remotes.map((r): [string, string] => [r.id, r.name]),
    [LOCAL_ONLY, 'Local only'],
  ]
  const addTargets = (dropdown: any) => {
    for (const [id, name] of targets) {
      dropdown.addOption(id, name)
    }
  }
  // the rows are a draft until "Save routes", redrawn in place
  const routesDiv = div.createDiv()
  const reasonsEl = div.createDiv()
  const drawRoutes = () => {
    routesDiv.empty()
    draft.routes.forEach((route, i) => {
      new Setting(routesDiv)
        .addText((text) =>
          text
            .setPlaceholder('folder/in/the/vault')
            .setValue(route.folder)
            .onChange((val) => {
              route.folder = normalizeFolder(val)
            }),
        )
        .addDropdown((dropdown) => {
          addTargets(dropdown)
          dropdown.setValue(route.target).onChange((val) => {
            route.target = val
          })
        })
        .addButton((b) =>
          b.setButtonText('Remove').onClick(() => {
            draft.routes.splice(i, 1)
            drawRoutes()
          }),
        )
    })
    new Setting(routesDiv)
      .setName('Default')
      .setDesc('Everything no route names, root files included.')
      .addDropdown((dropdown) => {
        addTargets(dropdown)
        dropdown.setValue(draft.defaultTarget ?? '').onChange((val) => {
          draft.defaultTarget = val
        })
      })
    new Setting(routesDiv)
      .addButton((b) =>
        b.setButtonText('Add a route').onClick(() => {
          draft.routes.push({
            folder: '',
            target: remotes[0]?.id ?? LOCAL_ONLY,
          })
          drawRoutes()
        }),
      )
      .addButton((b) =>
        b
          .setButtonText('Save routes')
          .setCta()
          .onClick(async () => {
            if (await saveTable(app, plugin, draft, reasonsEl)) {
              new Notice('Routes saved.')
              refresh()
            }
          }),
      )
  }
  drawRoutes()
}

const renderGithubSettings = (
  div: HTMLElement,
  app: App,
  plugin: RemotelySavePlugin,
  remote: RemoteConfig,
) => {
  const gh = remote.github!
  // where the remote points is a draft until "Save", since a half-typed
  // name would be a different place; the saved place is what syncs
  const draft = { ...gh }
  const text = (
    name: string,
    desc: string,
    key: 'owner' | 'repo' | 'branch' | 'folder',
  ) =>
    new Setting(div)
      .setName(`${remote.name}: ${name}`)
      .setDesc(desc)
      .addText((t) =>
        t.setValue(draft[key] ?? '').onChange((val) => {
          draft[key] = val.trim()
        }),
      )
  text('owner', 'The account or organization the repo belongs to.', 'owner')
  text('repo', 'A private repo, with at least one commit.', 'repo')
  text('branch', 'The branch to sync with.', 'branch')
  text(
    'folder',
    'Optional: a folder in the repo to keep the vault under.',
    'folder',
  )
  new Setting(div)
    .setName(`${remote.name}: save the place`)
    .setDesc(
      'Saves the owner, repo, branch, and folder. If this remote has synced before, you are asked first: its old records are forgotten.',
    )
    .addButton((b) =>
      b
        .setButtonText('Save')
        .setCta()
        .onClick(async () => {
          if (plugin.isSyncing) {
            new Notice('A sync is running: save once it finishes.')
            return
          }
          const keys = ['owner', 'repo', 'branch', 'folder'] as const
          if (keys.every((k) => (draft[k] ?? '') === (gh[k] ?? ''))) {
            new Notice(`${remote.name}: nothing changed.`)
            return
          }
          if (
            (await hasRecords(plugin.db, plugin.vaultRandomID, remote)) &&
            !(await askChangeLocation(app, remote.name))
          ) {
            return
          }
          for (const k of keys) {
            gh[k] = draft[k] ?? ''
          }
          await plugin.saveSettings()
          await forgetRemote(plugin.db, plugin.vaultRandomID, remote)
          new Notice(`${remote.name}: saved.`)
        }),
    )
  new Setting(div)
    .setName(`${remote.name}: token`)
    .setDesc(
      'A fine-grained personal access token for this one repo, with contents read and write.',
    )
    .addText((t) => {
      wrapTextWithPasswordHide(t)
      t.setValue(gh.token).onChange(async (val) => {
        gh.token = val.trim()
        await plugin.saveSettings()
      })
    })
  new Setting(div).setName(`${remote.name}: check connection`).addButton((b) =>
    b.setButtonText('Check').onClick(async () => {
      let message = ''
      const ok = await remoteFs(plugin, remote).checkConnect((e: any) => {
        message = e?.message ?? `${e}`
      })
      new Notice(ok ? `${remote.name}: connected.` : message)
    }),
  )
}
