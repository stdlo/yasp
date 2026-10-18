import { strict as assert } from 'assert'
import type {
  Entity,
  RemoteConfig,
  RemotelySavePluginSettings,
} from '../src/baseTypes'
import { FakeFs } from '../src/fsAll'
import type { FakeFsEncrypt } from '../src/fsEncrypt'
import {
  type InternalDBs,
  getAllPrevSyncRecordsByVaultAndProfile,
} from '../src/localdb'
import {
  type MultiSyncDeps,
  defaultChange,
  deleteRemoteFolder,
  deleteRemoteUnrouted,
  forgetFolder,
  forgetRemote,
  forgetUnrouted,
  hasRecords,
  recordFolderRename,
  routeChanges,
  syncAllRemotes,
} from '../src/multiSync'
import { profileIdOf } from '../src/remotes'
import { remoteMarks } from '../src/statusBar'
import { LOCAL_ONLY, OWNERSHIP_FILE_KEY } from '../src/routes'

// The orchestrator over the real engine: two in-memory remotes, an in-memory
// vault and database, and the routing rules of `docs/design.md`.

const VAULT = 'vault'

const encode = (text: string) => {
  const bytes = new TextEncoder().encode(text)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
}
const decode = (content: ArrayBuffer) => new TextDecoder().decode(content)

const parentsOf = (key: string) => {
  const parts = key.split('/')
  const res: string[] = []
  for (let i = 1; i < parts.length; ++i) {
    res.push(`${parts.slice(0, i).join('/')}/`)
  }
  return res
}

class MemFs extends FakeFs {
  kind = 'mem'
  files = new Map<string, { content: ArrayBuffer; mtime: number }>()
  writes = 0
  removes = 0
  renames: string[] = []
  failWalk = false
  /** runs as a rename starts, before anything moves */
  onRename?: () => Promise<void>
  /** runs once a rename has moved everything */
  afterRename?: () => Promise<void>
  /** folders kept with nothing in them, as a vault keeps them */
  emptyFolders = new Set<string>()

  put(key: string, text: string, mtime = 1_000_000) {
    this.files.set(key, { content: encode(text), mtime })
  }

  text(key: string) {
    const file = this.files.get(key)
    return file === undefined ? undefined : decode(file.content)
  }

  keys() {
    return [...this.files.keys()].sort()
  }

  async walk(): Promise<Entity[]> {
    if (this.failWalk) {
      throw Error('offline')
    }
    const folders = new Set<string>()
    for (const key of [...this.files.keys(), ...this.emptyFolders]) {
      for (const p of parentsOf(key)) {
        folders.add(p)
      }
    }
    for (const key of this.emptyFolders) {
      folders.add(key)
    }
    const res: Entity[] = [...folders].map((key) => ({
      key,
      keyRaw: key,
      size: 0,
      sizeRaw: 0,
    }))
    for (const key of this.files.keys()) {
      res.push(await this.stat(key))
    }
    return res
  }

  async walkPartial(): Promise<Entity[]> {
    return await this.walk()
  }

  async stat(key: string): Promise<Entity> {
    if (key.endsWith('/')) {
      return { key, keyRaw: key, size: 0, sizeRaw: 0 }
    }
    const file = this.files.get(key)
    if (file === undefined) {
      throw Error(`${key} does not exist`)
    }
    const size = file.content.byteLength
    return {
      key,
      keyRaw: key,
      mtimeCli: file.mtime,
      mtimeSvr: file.mtime,
      ctimeCli: file.mtime,
      size,
      sizeRaw: size,
    }
  }

  async mkdir(key: string): Promise<Entity> {
    return { key, keyRaw: key, size: 0, sizeRaw: 0 }
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
  ): Promise<Entity> {
    this.writes += 1
    this.files.set(key, { content: content.slice(0), mtime })
    return await this.stat(key)
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    const file = this.files.get(key)
    if (file === undefined) {
      throw Error(`${key} does not exist`)
    }
    return file.content.slice(0)
  }

  async rename(key1: string, key2: string): Promise<void> {
    await this.onRename?.()
    this.renames.push(`${key1}=>${key2}`)
    for (const [key, file] of [...this.files]) {
      if (key.startsWith(key1)) {
        this.files.delete(key)
        this.files.set(`${key2}${key.slice(key1.length)}`, file)
      }
    }
    await this.afterRename?.()
  }

  async rm(key: string): Promise<void> {
    if (!key.endsWith('/')) {
      this.removes += 1
      this.files.delete(key)
      return
    }
    // removing a folder takes everything under it, as a real file system does
    for (const k of [...this.files.keys(), ...this.emptyFolders]) {
      if (k.startsWith(key)) {
        this.files.delete(k)
        this.emptyFolders.delete(k)
      }
    }
  }

  async checkConnect(): Promise<boolean> {
    return true
  }

  async getUserDisplayName(): Promise<string> {
    return 'mem'
  }

  async revokeAuth(): Promise<any> {}

  allowEmptyFile(): boolean {
    return true
  }
}

/** A remote that refuses to rename a folder it doesn't hold, as Dropbox does. */
class StrictRenameFs extends MemFs {
  async rename(key1: string, key2: string): Promise<void> {
    if (!this.keys().some((k) => k.startsWith(key1))) {
      throw Error(`${key1} not found`)
    }
    await super.rename(key1, key2)
  }
}

/** A remote that stages its writes and fails to commit them. */
class FailingCommitFs extends MemFs {
  staged: string[] = []
  committed = new Map<string, { content: ArrayBuffer; mtime: number }>()
  async writeFile(key: string, content: ArrayBuffer, mtime: number) {
    this.staged.push(key)
    return await super.writeFile(key, content, mtime)
  }
  async finishSync() {
    // the commit fails: nothing staged reached the remote
    for (const key of this.staged) {
      this.files.delete(key)
    }
    throw Error('commit failed')
  }
  uncommittedKeys() {
    return this.staged
  }
}

/** A remote whose commit can be made to fail, with nothing staged. */
class FlakyCommitFs extends MemFs {
  failCommit = false
  async finishSync() {
    if (this.failCommit) {
      throw Error('commit failed')
    }
  }
}

/** A remote that stages its writes and drops some keys from the commit. */
class DroppingFs extends MemFs {
  drop = new Set<string>()
  dropped: string[] = []
  private before = new Map<string, { content: ArrayBuffer; mtime: number }>()
  async writeFile(key: string, content: ArrayBuffer, mtime: number) {
    const file = this.files.get(key)
    if (file !== undefined && !this.before.has(key)) {
      this.before.set(key, file)
    }
    return await super.writeFile(key, content, mtime)
  }
  async finishSync() {
    this.dropped = [...this.drop]
    for (const key of this.dropped) {
      const prev = this.before.get(key)
      if (prev === undefined) {
        this.files.delete(key)
      } else {
        this.files.set(key, prev)
      }
    }
    this.before.clear()
  }
  uncommittedKeys() {
    return this.dropped
  }
}

/** The encryption layer with no password: each call goes to the remote. */
const plainEncrypt = (inner: FakeFs) =>
  ({
    innerFs: inner,
    isPasswordOk: async () => ({ ok: true, reason: 'ok' }),
    encryptEntity: async (e: Entity) => ({
      ...e,
      keyEnc: e.key,
      sizeEnc: e.size,
    }),
    walk: async () =>
      (await inner.walk()).map((e) => ({
        ...e,
        keyEnc: e.key,
        sizeEnc: e.size,
      })),
    stat: async (key: string) => await inner.stat(key),
    mkdir: async (key: string) => await inner.mkdir(key),
    writeFile: async (key: string, c: ArrayBuffer, m: number, ct: number) =>
      await inner.writeFile(key, c, m, ct),
    readFile: async (key: string) => await inner.readFile(key),
    rm: async (key: string) => await inner.rm(key),
    closeResources: () => {},
  }) as unknown as FakeFsEncrypt

/**
 * A stand-in for encryption with a password: every name on the remote sits
 * under `enc/`, so a file that skipped the layer is plain to see.
 */
const prefixEncrypt = (inner: FakeFs) => {
  const P = 'enc/'
  return {
    innerFs: inner,
    isPasswordOk: async () => ({ ok: true, reason: 'ok' }),
    encryptEntity: async (e: Entity) => ({
      ...e,
      keyEnc: `${P}${e.key}`,
      sizeEnc: e.size,
    }),
    walk: async () =>
      (await inner.walk())
        .filter((e) => e.key!.startsWith(P) && e.key !== P)
        .map((e) => {
          const key = e.key!.slice(P.length)
          return { ...e, key, keyRaw: key, keyEnc: e.key, sizeEnc: e.size }
        }),
    mkdir: async (key: string) => await inner.mkdir(`${P}${key}`),
    writeFile: async (key: string, c: ArrayBuffer, m: number, ct: number) => {
      const e = await inner.writeFile(`${P}${key}`, c, m, ct)
      return { ...e, key, keyRaw: key }
    },
    readFile: async (key: string) => await inner.readFile(`${P}${key}`),
    rm: async (key: string) => await inner.rm(`${P}${key}`),
    closeResources: () => {},
  } as unknown as FakeFsEncrypt
}

class MemTable {
  items = new Map<string, unknown>()
  async getItem(key: string) {
    return this.items.has(key) ? this.items.get(key) : null
  }
  async getItems() {
    return Object.fromEntries(this.items)
  }
  async setItem(key: string, value: unknown) {
    this.items.set(key, value)
    return value
  }
  async removeItem(key: string) {
    this.items.delete(key)
  }
  async removeItems(keys: string[]) {
    for (const key of keys) {
      this.items.delete(key)
    }
  }
  async keys() {
    return [...this.items.keys()]
  }
}

const memDb = () =>
  ({
    prevSyncRecordsTbl: new MemTable(),
    syncBasesTbl: new MemTable(),
    syncPlansTbl: new MemTable(),
  }) as unknown as InternalDBs

const remote = (id: string, extra: Partial<RemoteConfig> = {}) =>
  ({
    id,
    name: id,
    type: 'dropbox',
    enabled: true,
    password: '',
    ...extra,
  }) as RemoteConfig

const settingsWith = (
  remotes: RemoteConfig[],
  routes: { folder: string; target: string }[],
  defaultTarget = 'a',
) =>
  ({
    serviceType: 'dropbox',
    password: '',
    concurrency: 1,
    syncConfigDir: false,
    syncUnderscoreItems: false,
    skipSizeLargerThan: -1,
    protectModifyPercentage: 50,
    conflictAction: 'keep_newer',
    syncDirection: 'bidirectional',
    howToCleanEmptyFolder: 'skip',
    remotes,
    routes: { routes, defaultTarget },
    routesUpdatedAt: 1,
  }) as unknown as RemotelySavePluginSettings

const useFakeMoment = () => {
  ;(global as any).window = {
    moment: (time: number) => ({
      format: () => new Date(time).toISOString(),
      toISOString: () => new Date(time).toISOString(),
    }),
  }
}

interface World {
  local: MemFs
  fs: Record<string, MemFs>
  db: InternalDBs
  settings: RemotelySavePluginSettings
  answers: (string | undefined)[]
  asked: number
  notices: string[]
}

const world = (
  settings: RemotelySavePluginSettings,
  fs: Record<string, MemFs> = { a: new MemFs(), b: new MemFs() },
): World => ({
  local: new MemFs(),
  fs,
  db: memDb(),
  settings,
  answers: [],
  asked: 0,
  notices: [],
})

const sync = async (
  w: World,
  triggerSource: MultiSyncDeps['triggerSource'] = 'manual',
) => {
  const deps: MultiSyncDeps = {
    fsLocal: w.local,
    db: w.db,
    vaultRandomID: VAULT,
    configDir: '.obsidian',
    triggerSource,
    makeFs: (r) => w.fs[r.id],
    makeEncrypt: (fs, s) =>
      (s.password ?? '') === '' ? plainEncrypt(fs) : prefixEncrypt(fs),
    getProtectError: () => 'too many changes',
    saveSettings: async () => {},
    notice: (msg) => {
      w.notices.push(msg)
    },
    askHeld: async () => {
      w.asked += 1
      return w.answers.shift() as any
    },
  }
  const res = await syncAllRemotes(w.settings, deps)
  return Object.fromEntries(
    [...res].map(([id, r]) => [
      id,
      `${r.status}${r.error ? `: ${r.error}` : ''}`,
    ]),
  )
}

const userKeys = (fs: MemFs) =>
  fs.keys().filter((k) => !k.startsWith('.remotely-save-lite/'))

describe('Several remotes: the orchestrator', () => {
  before(useFakeMoment)

  it('syncs a migrated single remote exactly as one run', async () => {
    const w = world(settingsWith([remote('a')], []), { a: new MemFs() })
    w.local.put('n.md', 'n')
    w.local.put('work/w.md', 'w')
    assert.deepEqual(await sync(w), { a: 'ok' })
    assert.deepEqual(w.fs.a.keys(), ['n.md', 'work/w.md'])
    // no routes file: one remote and no routes writes nothing of its own
    assert.equal(w.fs.a.text(OWNERSHIP_FILE_KEY), undefined)
  })

  it('routes each folder to its one remote, two levels deep', async () => {
    const w = world(
      settingsWith(
        [remote('a'), remote('b')],
        [
          { folder: 'areas', target: 'a' },
          { folder: 'areas/job', target: 'b' },
        ],
      ),
    )
    w.local.put('n.md', 'n')
    w.local.put('areas/x.md', 'x')
    w.local.put('areas/job/j.md', 'j')
    assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
    assert.deepEqual(userKeys(w.fs.a), ['areas/x.md', 'n.md'])
    assert.deepEqual(userKeys(w.fs.b), ['areas/job/j.md'])
    // and a second run finds everything equal
    w.fs.a.writes = 0
    w.fs.b.writes = 0
    assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
    assert.equal(w.fs.a.writes + w.fs.b.writes, 0)
  })

  describe('empty-folder cleanup across a two-level route', () => {
    const twoLevels = () => {
      const w = world(
        settingsWith(
          [remote('a'), remote('b')],
          [
            { folder: 'areas', target: 'a' },
            { folder: 'areas/job', target: 'b' },
          ],
        ),
      )
      w.settings.howToCleanEmptyFolder = 'clean_both'
      // each remote holds few files: let a last file go past the guard
      w.settings.protectModifyPercentage = 100
      w.local.put('n.md', 'n')
      w.local.put('n2.md', 'n')
      w.local.put('areas/x.md', 'x')
      w.local.put('areas/job/j.md', 'j')
      return w
    }

    it("doesn't trash the child's notes when the parent's last file goes", async () => {
      const w = twoLevels()
      assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
      w.local.files.delete('areas/x.md')
      assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
      assert.deepEqual(w.local.keys(), ['areas/job/j.md', 'n.md', 'n2.md'])
      assert.deepEqual(userKeys(w.fs.b), ['areas/job/j.md'])
    })

    it("doesn't trash the parent's notes when the child's last file goes", async () => {
      const w = twoLevels()
      assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
      // the emptied folder stays in the vault, so its route isn't "gone"
      w.local.files.delete('areas/job/j.md')
      w.local.emptyFolders.add('areas/job/')
      assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
      assert.deepEqual(w.local.keys(), ['areas/x.md', 'n.md', 'n2.md'])
      assert.deepEqual(userKeys(w.fs.a), ['areas/x.md', 'n.md', 'n2.md'])
    })
  })

  describe('a route below a folder some runs never see', () => {
    const belowFolder = () => {
      const w = world(
        settingsWith(
          [remote('a'), remote('b')],
          [
            { folder: 'work', target: 'b' },
            { folder: 'journal/private', target: LOCAL_ONLY },
          ],
        ),
      )
      w.settings.howToCleanEmptyFolder = 'clean_both'
      w.local.put('n.md', 'n')
      w.local.put('work/w.md', 'w')
      return w
    }

    it('syncs both remotes when the parent folder is in one run only', async () => {
      const w = belowFolder()
      w.local.put('journal/j.md', 'j')
      w.local.put('journal/private/p.md', 'p')
      assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
      assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
      assert.deepEqual(userKeys(w.fs.a), ['journal/j.md', 'n.md'])
      assert.deepEqual(userKeys(w.fs.b), ['work/w.md'])
    })

    it('syncs when the parent folder exists nowhere', async () => {
      const w = belowFolder()
      assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
      assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
      assert.deepEqual(userKeys(w.fs.a), ['n.md'])
      assert.deepEqual(w.local.keys(), ['n.md', 'work/w.md'])
    })
  })

  it('moves a note across a boundary', async () => {
    const w = world(
      settingsWith(
        [remote('a'), remote('b')],
        [{ folder: 'work', target: 'b' }],
      ),
    )
    w.local.put('personal/n.md', 'n')
    // enough other files that one deletion stays under the percentage guard
    w.local.put('personal/keep.md', 'k')
    w.local.put('personal/keep2.md', 'k')
    w.local.put('work/w.md', 'w')
    await sync(w)
    const moved = w.local.files.get('personal/n.md')!
    w.local.files.delete('personal/n.md')
    w.local.files.set('work/n.md', moved)
    assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
    assert.deepEqual(userKeys(w.fs.a), [
      'personal/keep.md',
      'personal/keep2.md',
    ])
    assert.deepEqual(userKeys(w.fs.b), ['work/n.md', 'work/w.md'])
  })

  it('renames a routed folder with no deletions or uploads', async () => {
    const w = world(
      settingsWith(
        [remote('a'), remote('b')],
        [{ folder: 'work', target: 'b' }],
      ),
    )
    w.local.put('n.md', 'n')
    w.local.put('work/w1.md', '1')
    w.local.put('work/w2.md', '2')
    await sync(w)
    for (const key of ['work/w1.md', 'work/w2.md']) {
      w.local.files.set(key.replace('work/', 'job/'), w.local.files.get(key)!)
      w.local.files.delete(key)
    }
    assert.equal(recordFolderRename(w.settings, 'work', 'job', 2), true)
    w.fs.b.writes = 0
    w.fs.b.removes = 0
    assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
    assert.deepEqual(w.fs.b.renames, ['work/=>job/'])
    assert.deepEqual(userKeys(w.fs.b), ['job/w1.md', 'job/w2.md'])
    assert.equal(w.fs.b.removes, 0)
    // the routes file is the only write
    assert.equal(w.fs.b.writes, 1)
    assert.deepEqual(userKeys(w.fs.a), ['n.md'])
    assert.deepEqual(w.settings.pendingRenames, [])
  })

  it('keeps a rename pending for a remote that is switched off', async () => {
    const w = world(
      settingsWith(
        [remote('a'), remote('b'), remote('c', { enabled: false })],
        [{ folder: 'work', target: 'b' }],
      ),
      { a: new MemFs(), b: new MemFs(), c: new MemFs() },
    )
    w.local.put('work/w1.md', '1')
    w.local.put('work/w2.md', '2')
    await sync(w)
    for (const key of ['work/w1.md', 'work/w2.md']) {
      w.local.files.set(key.replace('work/', 'job/'), w.local.files.get(key)!)
      w.local.files.delete(key)
    }
    recordFolderRename(w.settings, 'work', 'job', 2)
    await sync(w)
    assert.deepEqual(w.settings.pendingRenames, [
      { from: 'work', to: 'job', done: ['a', 'b'] },
    ])
    // switched on, it gets the rename too, and the rename is finished
    w.settings.remotes![2].enabled = true
    await sync(w)
    assert.deepEqual(w.settings.pendingRenames, [])
  })

  it('keeps a rename pending, and the records, when the remote move fails', async () => {
    const w = world(
      settingsWith(
        [remote('a'), remote('b')],
        [{ folder: 'work', target: 'b' }],
      ),
    )
    w.local.put('n.md', 'n')
    w.local.put('work/w1.md', '1')
    w.local.put('work/w2.md', '2')
    await sync(w)
    const recordKeys = async () =>
      (
        await getAllPrevSyncRecordsByVaultAndProfile(
          w.db,
          VAULT,
          profileIdOf(w.settings.remotes![1]),
        )
      )
        .map((r) => r.key)
        .sort()
    const before = await recordKeys()
    for (const key of ['work/w1.md', 'work/w2.md']) {
      w.local.files.set(key.replace('work/', 'job/'), w.local.files.get(key)!)
      w.local.files.delete(key)
    }
    recordFolderRename(w.settings, 'work', 'job', 2)
    w.fs.b.onRename = async () => {
      w.fs.b.onRename = undefined
      throw Error('the destination exists')
    }
    const res = await sync(w)
    assert.equal(res.a, 'ok')
    assert.match(res.b, /^failed: rename work: the destination exists/)
    // still pending for b, its records where they were, its folder unmoved
    assert.deepEqual(w.settings.pendingRenames, [
      { from: 'work', to: 'job', done: ['a'] },
    ])
    assert.deepEqual(await recordKeys(), before)
    assert.deepEqual(userKeys(w.fs.b), ['work/w1.md', 'work/w2.md'])
    // the next sync finishes it
    assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
    assert.deepEqual(userKeys(w.fs.b), ['job/w1.md', 'job/w2.md'])
    assert.deepEqual(w.settings.pendingRenames, [])
  })

  it('keeps a rename recorded while a sync runs', async () => {
    const w = world(
      settingsWith(
        [remote('a'), remote('b')],
        [
          { folder: 'work', target: 'b' },
          { folder: 'docs', target: 'b' },
        ],
      ),
    )
    w.local.put('work/w.md', 'w')
    w.local.put('docs/d.md', 'd')
    await sync(w)
    w.local.files.set('job/w.md', w.local.files.get('work/w.md')!)
    w.local.files.delete('work/w.md')
    recordFolderRename(w.settings, 'work', 'job', 2)
    // the vault's `docs` is renamed while b's folder is being moved
    w.fs.b.onRename = async () => {
      w.fs.b.onRename = undefined
      recordFolderRename(w.settings, 'docs', 'notes', 3)
    }
    await sync(w)
    // not lost: it waits for the next sync
    assert.deepEqual(w.settings.pendingRenames, [
      { from: 'docs', to: 'notes', done: [] },
    ])
  })

  it('lets a second device sync between the routes file and the folder move', async () => {
    const make = () => {
      const s = settingsWith(
        [remote('a'), remote('b')],
        [{ folder: 'work', target: 'b' }],
      )
      // a few files: let a deletion go past the guard, so one would show
      s.protectModifyPercentage = 100
      return s
    }
    const w1 = world(make())
    w1.local.put('n.md', 'n')
    for (const name of ['w1', 'w2', 'w3']) {
      w1.local.put(`work/${name}.md`, name)
    }
    await sync(w1)
    // a second device: the same remotes, its own vault and records
    const w2 = world(make(), w1.fs)
    for (const [key, file] of w1.local.files) {
      w2.local.files.set(key, { ...file })
    }
    assert.deepEqual(await sync(w2), { a: 'ok', b: 'ok' })
    // the first renames `work` to `job`
    for (const name of ['w1', 'w2', 'w3']) {
      w1.local.files.set(
        `job/${name}.md`,
        w1.local.files.get(`work/${name}.md`)!,
      )
      w1.local.files.delete(`work/${name}.md`)
    }
    recordFolderRename(w1.settings, 'work', 'job', 2)
    // the second syncs just before the remote's folder moves, and just after
    const between: Record<string, string>[] = []
    const second = async () => {
      between.push(await sync(w2))
    }
    w1.fs.b.onRename = async () => {
      w1.fs.b.onRename = undefined
      await second()
    }
    w1.fs.b.afterRename = async () => {
      w1.fs.b.afterRename = undefined
      await second()
    }
    assert.deepEqual(await sync(w1), { a: 'ok', b: 'ok' })
    assert.equal(between.length, 2)
    // nothing of the second device's was deleted
    for (const name of ['w1', 'w2', 'w3']) {
      assert.ok(w2.local.files.has(`work/${name}.md`), name)
    }
  })

  it('finishes a rename the remote already made before a crash', async () => {
    const w = world(
      settingsWith(
        [remote('a'), remote('b')],
        [{ folder: 'work', target: 'b' }],
      ),
      { a: new MemFs(), b: new StrictRenameFs() },
    )
    w.local.put('n.md', 'n')
    w.local.put('work/w1.md', '1')
    w.local.put('work/w2.md', '2')
    await sync(w)
    for (const key of ['work/w1.md', 'work/w2.md']) {
      w.local.files.set(key.replace('work/', 'job/'), w.local.files.get(key)!)
      w.local.files.delete(key)
    }
    recordFolderRename(w.settings, 'work', 'job', 2)
    // the remote rename went through, then the plugin stopped before the
    // records moved
    await w.fs.b.rename('work/', 'job/')
    w.fs.b.writes = 0
    w.fs.b.removes = 0
    assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
    assert.deepEqual(userKeys(w.fs.b), ['job/w1.md', 'job/w2.md'])
    assert.equal(w.fs.b.removes, 0)
    // the routes file is the only write
    assert.equal(w.fs.b.writes, 1)
    assert.deepEqual(w.settings.pendingRenames, [])
  })

  it('writes nothing on a dry run', async () => {
    const w = world(
      settingsWith(
        [remote('a'), remote('b')],
        [
          { folder: 'work', target: 'b' },
          { folder: 'docs', target: 'b' },
        ],
      ),
    )
    w.local.put('n.md', 'n')
    w.local.put('work/w.md', 'w')
    w.local.put('docs/d.md', 'd')
    await sync(w)
    // a rename waiting for the next sync, a new note, and a routed folder
    // gone while unwatched, which a real sync would ask about
    w.local.files.set('job/w.md', w.local.files.get('work/w.md')!)
    w.local.files.delete('work/w.md')
    recordFolderRename(w.settings, 'work', 'job', 2)
    w.local.put('m.md', 'm')
    w.local.files.delete('docs/d.md')
    const snapshot = () =>
      JSON.stringify({
        a: [...w.fs.a.files].map(([k, f]) => [k, decode(f.content)]),
        b: [...w.fs.b.files].map(([k, f]) => [k, decode(f.content)]),
        records: [...(w.db as any).prevSyncRecordsTbl.items],
        bases: [...(w.db as any).syncBasesTbl.items],
        settings: w.settings,
      })
    const before = snapshot()
    const res = await sync(w, 'dry')
    assert.equal(snapshot(), before)
    // held, unasked
    assert.equal(res.b, 'held')
    assert.equal(w.asked, 0)
    assert.equal(w.fs.b.renames.length, 0)
  })

  it('holds both runs when a routed folder is gone while unwatched', async () => {
    const w = world(
      settingsWith(
        [remote('a'), remote('b')],
        [{ folder: 'work', target: 'b' }],
      ),
    )
    w.local.put('n.md', 'n')
    w.local.put('work/w.md', 'w')
    await sync(w)
    w.local.files.set('job/w.md', w.local.files.get('work/w.md')!)
    w.local.files.delete('work/w.md')
    w.answers = [undefined]
    assert.deepEqual(await sync(w), { a: 'held', b: 'held' })
    assert.equal(w.asked, 1)
    // nothing uploaded to the default, nothing deleted on the work remote
    assert.deepEqual(userKeys(w.fs.a), ['n.md'])
    assert.deepEqual(userKeys(w.fs.b), ['work/w.md'])
    // answered "renamed": the route follows and both find everything equal
    w.answers = ['rename']
    assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
    assert.deepEqual(userKeys(w.fs.a), ['n.md'])
    assert.deepEqual(userKeys(w.fs.b), ['job/w.md'])
    assert.equal(w.settings.routes?.routes[0].folder, 'job')
  })

  it("keeps a disabled remote's folders from every other remote", async () => {
    const w = world(
      settingsWith(
        [remote('a'), remote('b', { enabled: false })],
        [{ folder: 'work', target: 'b' }],
      ),
    )
    w.local.put('n.md', 'n')
    w.local.put('work/w.md', 'w')
    assert.deepEqual(await sync(w), { a: 'ok', b: 'disabled' })
    assert.deepEqual(userKeys(w.fs.a), ['n.md'])
    assert.deepEqual(userKeys(w.fs.b), [])
  })

  it('goes on to the next remote when one fails', async () => {
    const w = world(
      settingsWith(
        [remote('a'), remote('b')],
        [{ folder: 'work', target: 'b' }],
      ),
    )
    w.fs.a.failWalk = true
    w.local.put('n.md', 'n')
    w.local.put('work/w.md', 'w')
    const res = await sync(w)
    assert.equal(res.a, 'failed: offline')
    assert.equal(res.b, 'ok')
    assert.deepEqual(userKeys(w.fs.b), ['work/w.md'])
  })

  it('stops every run on a contradicting ownership file', async () => {
    const w = world(
      settingsWith(
        [remote('a'), remote('b')],
        [{ folder: 'work', target: 'b' }],
      ),
    )
    const claim = (name: string) =>
      JSON.stringify({ remote: name, folders: ['work'], updatedAt: 5 })
    w.fs.a.put(OWNERSHIP_FILE_KEY, claim('a'))
    w.fs.b.put(OWNERSHIP_FILE_KEY, claim('b'))
    w.local.put('work/w.md', 'w')
    const res = await sync(w)
    assert.match(res.a, /^stopped/)
    assert.match(res.b, /^stopped/)
    assert.deepEqual(userKeys(w.fs.b), [])
    assert.equal(w.notices.length, 1)
  })

  it('says a refused setup and a failed start in a notice, once', async () => {
    // two remotes with one name are refused, with one remote left in view
    const refused = world(
      settingsWith(
        [remote('a', { name: 'X' }), remote('b', { name: 'X' })],
        [],
      ),
    )
    const res = await sync(refused)
    assert.match(res.a, /^stopped/)
    assert.equal(refused.notices.length, 1)

    const w = world(settingsWith([remote('a'), remote('b')], []))
    const bFs = w.fs.b
    w.fs = {
      get a(): MemFs {
        throw new Error('no token')
      },
      b: bFs,
    } as any
    const after = await sync(w)
    assert.equal(after.a, 'failed: no token')
    assert.equal(after.b, 'ok')
    assert.deepEqual(w.notices, ['a: no token'])
  })

  it('adopts a newer ownership file before the runs', async () => {
    const w = world(
      settingsWith(
        [remote('a'), remote('b')],
        [{ folder: 'work', target: 'b' }],
      ),
    )
    w.fs.b.put(
      OWNERSHIP_FILE_KEY,
      JSON.stringify({ remote: 'b', folders: ['work', 'notes'], updatedAt: 5 }),
    )
    w.local.put('notes/x.md', 'x')
    assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
    assert.deepEqual(userKeys(w.fs.b), ['notes/x.md'])
    assert.deepEqual(userKeys(w.fs.a), [])
  })

  it("keeps an encrypted remote's routes file through its encryption", async () => {
    const w = world(
      settingsWith(
        [remote('a', { password: 'pw' }), remote('b')],
        [{ folder: 'work', target: 'b' }],
      ),
    )
    w.local.put('n.md', 'n')
    w.local.put('work/w.md', 'w')
    assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
    // written under the encrypted names, never in the clear
    assert.equal(w.fs.a.text(OWNERSHIP_FILE_KEY), undefined)
    assert.ok(w.fs.a.text(`enc/${OWNERSHIP_FILE_KEY}`) !== undefined)
    assert.deepEqual(userKeys(w.fs.a), [
      'enc/.remotely-save-lite/routes.json',
      'enc/n.md',
    ])
    // and read back: a newer one from another device is adopted
    w.fs.a.put(
      `enc/${OWNERSHIP_FILE_KEY}`,
      JSON.stringify({ remote: 'a', folders: ['work'], updatedAt: 9 }),
    )
    w.fs.b.put(
      OWNERSHIP_FILE_KEY,
      JSON.stringify({ remote: 'b', folders: [], updatedAt: 9 }),
    )
    await sync(w)
    assert.equal(w.settings.routes?.routes[0].target, 'a')
  })

  it('rolls back the records of a failed commit', async () => {
    const failing = new FailingCommitFs()
    const w = world(
      settingsWith(
        [remote('a'), remote('b')],
        [{ folder: 'work', target: 'b' }],
      ),
      { a: new MemFs(), b: failing },
    )
    w.local.put('work/w.md', 'w')
    const res = await sync(w)
    assert.match(res.b, /^failed/)
    // the next run, with a working remote, uploads it again rather than
    // taking it for deleted on the remote and deleting it locally
    const working = new MemFs()
    w.fs.b = working
    assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
    assert.deepEqual(userKeys(working), ['work/w.md'])
    assert.deepEqual(w.local.keys(), ['work/w.md'])
  })

  it("reports the plan's error when the commit fails too", async () => {
    const flaky = new FlakyCommitFs()
    const w = world(
      settingsWith(
        [remote('a'), remote('b')],
        [{ folder: 'work', target: 'b' }],
      ),
      { a: new MemFs(), b: flaky },
    )
    for (const name of ['w1', 'w2', 'w3', 'w4']) {
      w.local.put(`work/${name}.md`, name)
    }
    assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
    // every note deleted at once: the guard stops the plan, then the commit
    // fails as well
    for (const name of ['w1', 'w2', 'w3', 'w4']) {
      w.local.files.delete(`work/${name}.md`)
    }
    w.local.emptyFolders.add('work/')
    flaky.failCommit = true
    const res = await sync(w)
    assert.match(res.b, /too many changes/)
    assert.match(res.b, /commit failed/)
    // and a commit that fails after a clean plan still says so
    w.settings.protectModifyPercentage = 100
    assert.match((await sync(w)).b, /commit failed/)
  })

  it('keeps both versions after a rolled-back commit and a remote edit', async () => {
    const dropping = new DroppingFs()
    const w = world(
      settingsWith(
        [remote('a'), remote('b')],
        [{ folder: 'work', target: 'b' }],
      ),
      { a: new MemFs(), b: dropping },
    )
    w.settings.conflictAction = 'smart'
    // one file on the remote: let a change to it go past the guard
    w.settings.protectModifyPercentage = 100
    w.local.put('work/n.md', 'one\ntwo\nthree\n')
    assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
    // an edit the commit drops: the remote still holds the old text
    w.local.put('work/n.md', 'one\ntwo here\nthree\n', 2_000_000)
    dropping.drop.add('work/n.md')
    assert.match((await sync(w)).b, /^failed: 1 changes/)
    // then the remote's copy changes, from another device
    dropping.drop.clear()
    dropping.put('work/n.md', 'one\ntwo\nthree there\n', 3_000_000)
    assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
    assert.equal(w.local.text('work/n.md'), 'one\ntwo here\nthree\n')
    const copies = w.local.keys().filter((k) => k.includes('.conflict-remote-'))
    assert.equal(copies.length, 1)
    assert.equal(w.local.text(copies[0]), 'one\ntwo\nthree there\n')
  })

  it('keeps the local notes when a remote is pointed somewhere else', async () => {
    const w = world(
      settingsWith(
        [remote('a'), remote('b')],
        [{ folder: 'work', target: 'b' }],
      ),
    )
    // a guard that lets a mass deletion through, as a small vault would
    w.settings.protectModifyPercentage = 100
    w.local.put('n.md', 'n')
    for (const name of ['w1', 'w2', 'w3']) {
      w.local.put(`work/${name}.md`, name)
    }
    await sync(w)
    const b = w.settings.remotes![1]
    assert.equal(await hasRecords(w.db, VAULT, b), true)
    // b points at another place, which holds a note of its own: the settings
    // page forgets b's records, else the three would read as deleted there
    w.fs.b = new MemFs()
    w.fs.b.put('work/other.md', 'o')
    await forgetRemote(w.db, VAULT, b)
    assert.equal(await hasRecords(w.db, VAULT, b), false)
    assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
    assert.deepEqual(w.local.keys(), [
      'n.md',
      'work/other.md',
      'work/w1.md',
      'work/w2.md',
      'work/w3.md',
    ])
    assert.deepEqual(userKeys(w.fs.b), [
      'work/other.md',
      'work/w1.md',
      'work/w2.md',
      'work/w3.md',
    ])
  })

  it('moves a folder to another remote on a route change', async () => {
    const w = world(settingsWith([remote('a'), remote('b')], []))
    w.local.put('n.md', 'n')
    w.local.put('work/w.md', 'w')
    await sync(w)
    assert.deepEqual(userKeys(w.fs.a), ['n.md', 'work/w.md'])
    const before = w.settings.routes!
    const after = { ...before, routes: [{ folder: 'work', target: 'b' }] }
    assert.deepEqual(routeChanges(before, after), [
      { folder: 'work', from: 'a', to: 'b' },
    ])
    w.settings.routes = after
    w.settings.routesUpdatedAt = 2
    await forgetFolder(w.db, VAULT, w.settings.remotes![0], 'work')
    await deleteRemoteFolder(w.fs.a, 'work')
    assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
    assert.deepEqual(userKeys(w.fs.a), ['n.md'])
    assert.deepEqual(userKeys(w.fs.b), ['work/w.md'])
    assert.deepEqual(w.local.keys(), ['n.md', 'work/w.md'])
  })

  it('moves what no route names when the default row changes', async () => {
    const w = world(
      settingsWith(
        [remote('a'), remote('b')],
        [{ folder: 'areas', target: 'a' }],
      ),
    )
    w.local.put('n.md', 'n')
    w.local.put('work/w.md', 'w')
    w.local.put('areas/x.md', 'x')
    await sync(w)
    assert.deepEqual(userKeys(w.fs.a), ['areas/x.md', 'n.md', 'work/w.md'])
    const before = w.settings.routes!
    const after = { ...before, defaultTarget: 'b' }
    assert.deepEqual(routeChanges(before, after), [])
    assert.deepEqual(defaultChange(before, after), { from: 'a', to: 'b' })
    assert.equal(defaultChange(before, before), undefined)
    w.settings.routes = after
    w.settings.routesUpdatedAt = 2
    const a = w.settings.remotes![0]
    await forgetUnrouted(w.db, VAULT, a, before, after)
    await deleteRemoteUnrouted(w.fs.a, before, after)
    // a keeps its records of the folder it still owns, and nothing else
    const keys = (
      await getAllPrevSyncRecordsByVaultAndProfile(w.db, VAULT, profileIdOf(a))
    ).map((r) => r.key)
    assert.deepEqual(keys.sort(), ['areas/', 'areas/x.md'])
    assert.deepEqual(await sync(w), { a: 'ok', b: 'ok' })
    assert.deepEqual(userKeys(w.fs.a), ['areas/x.md'])
    assert.deepEqual(userKeys(w.fs.b), ['n.md', 'work/w.md'])
    assert.deepEqual(w.local.keys(), ['areas/x.md', 'n.md', 'work/w.md'])
  })

  it('marks each remote in the status bar', () => {
    const remotes = [
      remote('a', { name: 'Dropbox' }),
      remote('b', { name: 'GitHub' }),
    ]
    const results = new Map([
      ['a', { status: 'ok' as const, at: 1 }],
      ['b', { status: 'failed' as const, at: 1, error: 'offline' }],
    ])
    assert.deepEqual(remoteMarks(remotes, results), {
      text: ' · Dropbox ✓ · GitHub ✗',
      label: '\nGitHub: offline',
    })
    const well = new Map([['a', { status: 'ok' as const, at: 1 }]])
    assert.deepEqual(remoteMarks(remotes.slice(0, 1), well), {
      text: '',
      label: '',
    })
    // one remote that stopped or failed shows its mark and the reason
    const stopped = new Map([
      ['a', { status: 'stopped' as const, at: 1, error: 'refused' }],
    ])
    assert.deepEqual(remoteMarks(remotes.slice(0, 1), stopped), {
      text: ' · Dropbox ✗',
      label: '\nDropbox: refused',
    })
  })
})
