import { strict as assert } from 'assert'
import type {
  Entity,
  RemoteConfig,
  RemotelySavePluginSettings,
} from '../src/baseTypes'
import { FakeFs } from '../src/fsAll'
import type { FakeFsEncrypt } from '../src/fsEncrypt'
import type { InternalDBs } from '../src/localdb'
import {
  type MultiSyncDeps,
  recordFolderRename,
  syncAllRemotes,
} from '../src/multiSync'
import { OWNERSHIP_FILE_KEY } from '../src/routes'

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
    for (const key of this.files.keys()) {
      for (const p of parentsOf(key)) {
        folders.add(p)
      }
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
    this.renames.push(`${key1}=>${key2}`)
    for (const [key, file] of [...this.files]) {
      if (key.startsWith(key1)) {
        this.files.delete(key)
        this.files.set(`${key2}${key.slice(key1.length)}`, file)
      }
    }
  }

  async rm(key: string): Promise<void> {
    if (!key.endsWith('/')) {
      this.removes += 1
    }
    this.files.delete(key)
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
})

const sync = async (w: World) => {
  const deps: MultiSyncDeps = {
    fsLocal: w.local,
    db: w.db,
    vaultRandomID: VAULT,
    configDir: '.obsidian',
    triggerSource: 'manual',
    makeFs: (r) => w.fs[r.id],
    makeEncrypt: (fs) => plainEncrypt(fs),
    getProtectError: () => 'too many changes',
    saveSettings: async () => {},
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
})
