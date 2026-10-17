import { strict as assert } from 'assert'
import type { RemotelySavePluginSettings } from '../src/baseTypes'
import { type InternalDBs, moveProfileRecords } from '../src/localdb'
import {
  LEGACY_PROFILE_ID,
  linkDropboxConfig,
  migrateToRemotes,
  profileIdOf,
  refusedSettings,
  settingsForRemote,
} from '../src/remotes'
import { routeOf } from '../src/routes'

// The list of remotes: the migration from one remote, each run's settings,
// and the records' move to the new profile.

const single = () =>
  ({
    serviceType: 'dropbox',
    dropbox: { accessToken: 'a', refreshToken: 'r', remoteBaseDir: '' },
    password: 'pw',
    encryptionMethod: 'rclone-base64',
    concurrency: 3,
    syncDirection: 'bidirectional',
    conflictAction: 'keep_newer',
    protectModifyPercentage: 40,
    syncConfigDir: true,
  }) as unknown as RemotelySavePluginSettings

class MemTable {
  items = new Map<string, unknown>()
  async getItem(key: string) {
    return this.items.has(key) ? this.items.get(key) : null
  }
  async setItem(key: string, value: unknown) {
    this.items.set(key, value)
    return value
  }
  async removeItem(key: string) {
    this.items.delete(key)
  }
  async keys() {
    return [...this.items.keys()]
  }
}

describe('Remotes: the migration from one remote', () => {
  it('makes one remote dropbox and default → dropbox', () => {
    const s = single()
    assert.equal(migrateToRemotes(s), true)
    assert.equal(s.remotes?.length, 1)
    assert.equal(s.remotes?.[0].id, 'dropbox')
    assert.equal(profileIdOf(s.remotes![0]), 'remote-dropbox')
    assert.equal(routeOf(s.routes!, 'any/note.md'), 'dropbox')
    assert.deepEqual(refusedSettings(s), [])
    // a second load changes nothing
    assert.equal(migrateToRemotes(s), false)
  })

  it('gives the migrated remote exactly the settings it had', () => {
    const s = single()
    migrateToRemotes(s)
    linkDropboxConfig(s)
    const run = settingsForRemote(s, s.remotes![0])
    for (const k of [
      'serviceType',
      'password',
      'encryptionMethod',
      'concurrency',
      'syncDirection',
      'conflictAction',
      'protectModifyPercentage',
      'syncConfigDir',
    ] as const) {
      assert.equal(run[k], single()[k], k)
    }
    // one object behind the credentials, so a refreshed token is saved
    assert.equal(run.dropbox, s.dropbox)
  })

  it("gives another remote its own settings, not the first one's", () => {
    const s = single()
    migrateToRemotes(s)
    s.remotes!.push({
      id: 'gh',
      name: 'GitHub',
      type: 'github',
      enabled: true,
      password: '',
      syncConfigDir: false,
    })
    const run = settingsForRemote(s, s.remotes![1])
    assert.equal(run.serviceType, 'github')
    assert.equal(run.password, '')
    assert.equal(run.syncConfigDir, false)
  })

  it('refuses an encrypted GitHub remote', () => {
    const s = single()
    migrateToRemotes(s)
    // no password of its own: it would inherit the top-level one
    s.remotes!.push({
      id: 'gh',
      name: 'GitHub',
      type: 'github',
      enabled: true,
      syncConfigDir: false,
    })
    assert.equal(refusedSettings(s).length, 1)
    s.remotes![1].password = ''
    assert.deepEqual(refusedSettings(s), [])
  })

  it('moves the records to the new profile', async () => {
    const db = {
      prevSyncRecordsTbl: new MemTable(),
      syncBasesTbl: new MemTable(),
    } as unknown as InternalDBs
    const tbl = (db.prevSyncRecordsTbl as unknown as MemTable).items
    tbl.set(`v\t${LEGACY_PROFILE_ID}\ta.md`, { key: 'a.md', keyRaw: 'a.md' })
    tbl.set(`other\t${LEGACY_PROFILE_ID}\tb.md`, { key: 'b.md' })
    const bases = (db.syncBasesTbl as unknown as MemTable).items
    bases.set(`v\t${LEGACY_PROFILE_ID}\ta.md`, 'base')
    await moveProfileRecords(db, 'v', LEGACY_PROFILE_ID, 'remote-dropbox')
    assert.deepEqual(
      [...tbl.keys()].sort(),
      [`other\t${LEGACY_PROFILE_ID}\tb.md`, 'v\tremote-dropbox\ta.md'].sort(),
    )
    assert.equal(bases.get('v\tremote-dropbox\ta.md'), 'base')
    // again: nothing left to move
    assert.equal(
      await moveProfileRecords(db, 'v', LEGACY_PROFILE_ID, 'remote-dropbox'),
      0,
    )
  })
})
