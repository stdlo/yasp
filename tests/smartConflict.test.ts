import { strict as assert } from 'assert'
import type {
  Entity,
  MixedEntity,
  RemotelySavePluginSettings,
} from '../src/baseTypes'
import { FakeFs } from '../src/fsAll'
import type { FakeFsEncrypt } from '../src/fsEncrypt'
import type { InternalDBs } from '../src/localdb'
import {
  SMART_CONFLICT_MERGE_LIMIT,
  conflictCopyKey,
  doActualSync,
  getSyncPlanInplace,
} from '../src/sync'

// Smart Conflict, run through the engine's conflict path on in-memory files
// and an in-memory database: what ends up on each side, as the base, and as
// a conflict copy.

const VAULT = 'vault'
const PROFILE = 'profile'
const BASE_KEY = `${VAULT}\t${PROFILE}\t`

const encode = (text: string) => {
  const bytes = new TextEncoder().encode(text)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
}
const decode = (content: ArrayBuffer) => new TextDecoder().decode(content)

class MemFs extends FakeFs {
  kind = 'mem'
  files = new Map<string, { content: ArrayBuffer; mtime: number }>()

  put(key: string, content: string | ArrayBuffer, mtime: number) {
    this.files.set(key, {
      content: typeof content === 'string' ? encode(content) : content,
      mtime,
    })
  }

  text(key: string) {
    const file = this.files.get(key)
    return file === undefined ? undefined : decode(file.content)
  }

  async walk(): Promise<Entity[]> {
    return await Promise.all([...this.files.keys()].map((k) => this.stat(k)))
  }

  async walkPartial(): Promise<Entity[]> {
    return await this.walk()
  }

  async stat(key: string): Promise<Entity> {
    const file = this.files.get(key)
    if (file === undefined) {
      throw Error(`${key} does not exist`)
    }
    const size = file.content.byteLength
    return {
      key,
      keyRaw: key,
      keyEnc: key,
      mtimeCli: file.mtime,
      mtimeSvr: file.mtime,
      ctimeCli: file.mtime,
      size,
      sizeRaw: size,
      sizeEnc: size,
    }
  }

  async mkdir(key: string): Promise<Entity> {
    return { key, keyRaw: key, keyEnc: key, size: 0, sizeRaw: 0, sizeEnc: 0 }
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
  ): Promise<Entity> {
    this.put(key, content.slice(0), mtime)
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
    throw Error('not used')
  }

  async rm(key: string): Promise<void> {
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

// The few localforage calls the engine makes, on a Map.
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
  async removeItems(keys: string[]) {
    for (const key of keys) {
      this.items.delete(key)
    }
  }
}

const memDb = () => ({
  prevSyncRecordsTbl: new MemTable(),
  syncBasesTbl: new MemTable(),
})

const SETTINGS = {
  serviceType: 'dropbox',
  concurrency: 1,
  password: '',
  syncConfigDir: false,
  syncUnderscoreItems: false,
  skipSizeLargerThan: -1,
  protectModifyPercentage: 50,
} as unknown as RemotelySavePluginSettings

// Times: the previous sync, then an edit on each side after it.
const PREV_LOCAL_MTIME = 1_000_000
const PREV_REMOTE_MTIME = 2_000_000
const LOCAL_MTIME = 5_000_000
const REMOTE_MTIME = 6_000_000

interface Case {
  key: string
  base?: string
  // the file on each side; missing when undefined
  local: string | ArrayBuffer | undefined
  remote: string | ArrayBuffer | undefined
  // whether a previous sync record exists (modified on both sides) or not
  // (created on both sides)
  synced?: boolean
  otherLocalFiles?: Record<string, string>
  // whether the plan must be a smart conflict (the default)
  conflict?: boolean
}

const run = async (c: Case) => {
  const fsLocal = new MemFs()
  const fsRemote = new MemFs()
  const db = memDb()
  if (c.local !== undefined) {
    fsLocal.put(c.key, c.local, LOCAL_MTIME)
  }
  if (c.remote !== undefined) {
    fsRemote.put(c.key, c.remote, REMOTE_MTIME)
  }
  for (const [key, text] of Object.entries(c.otherLocalFiles ?? {})) {
    fsLocal.put(key, text, 1)
  }
  if (c.base !== undefined) {
    db.syncBasesTbl.items.set(`${BASE_KEY}${c.key}`, c.base)
  }
  const prevSync: Entity | undefined =
    c.synced === false
      ? undefined
      : {
          key: c.key,
          keyRaw: c.key,
          keyEnc: c.key,
          mtimeCli: PREV_LOCAL_MTIME,
          mtimeSvr: PREV_REMOTE_MTIME,
          size: 1,
          sizeRaw: 1,
          sizeEnc: 1,
        }

  const mappings: Record<string, MixedEntity> = {
    [c.key]: {
      key: c.key,
      local: c.local === undefined ? undefined : await fsLocal.stat(c.key),
      prevSync,
      remote: c.remote === undefined ? undefined : await fsRemote.stat(c.key),
    },
  }
  const plan = await getSyncPlanInplace(
    mappings,
    'skip',
    -1,
    'smart',
    'bidirectional',
    undefined,
    SETTINGS,
    'manual',
  )
  if (c.conflict !== false) {
    assert.match(plan[c.key].decision ?? '', /_then_smart_conflict$/)
  }

  const copies: [string, string][] = []
  await doActualSync(
    plan,
    fsLocal,
    fsRemote as unknown as FakeFsEncrypt,
    VAULT,
    PROFILE,
    1,
    -1,
    () => '',
    db as unknown as InternalDBs,
    undefined,
    undefined,
    (key: string, copyKey: string) => {
      copies.push([key, copyKey])
    },
  )

  return {
    entry: plan[c.key],
    fsLocal,
    fsRemote,
    copies,
    base: db.syncBasesTbl.items.get(`${BASE_KEY}${c.key}`),
    prevSync: db.prevSyncRecordsTbl.items.get(`${BASE_KEY}${c.key}`) as
      | Entity
      | undefined,
  }
}

// Asserts the conflict was settled by a copy: the remote version beside the
// file, the local version kept on both sides, and a notice for the copy.
const assertCopied = (
  result: Awaited<ReturnType<typeof run>>,
  key: string,
  local: string | ArrayBuffer,
  remote: string | ArrayBuffer,
) => {
  const copyKey = conflictCopyKey(key, REMOTE_MTIME)
  const text = (x: string | ArrayBuffer) =>
    typeof x === 'string' ? x : decode(x)
  assert.deepEqual(result.copies, [[key, copyKey]])
  assert.equal(result.fsLocal.text(copyKey), text(remote))
  assert.equal(result.fsLocal.text(key), text(local))
  assert.equal(result.fsRemote.text(key), text(local))
  assert.deepEqual(
    [...result.fsLocal.files.keys()].sort(),
    [key, copyKey].sort(),
  )
}

const useFakeMoment = () => {
  ;(global as any).window = {
    moment: (time: number) => ({
      format: () => new Date(time).toISOString(),
      toISOString: () => new Date(time).toISOString(),
    }),
  }
}

describe('Smart conflict: running it', () => {
  beforeEach(useFakeMoment)

  it('merges a Markdown file edited on different lines', async () => {
    const result = await run({
      key: 'today.md',
      base: 'one\ntwo\nthree\n',
      local: 'ONE\ntwo\nthree\n',
      remote: 'one\ntwo\nTHREE\n',
    })
    const merged = 'ONE\ntwo\nTHREE\n'
    assert.equal(result.fsLocal.text('today.md'), merged)
    assert.equal(result.fsRemote.text('today.md'), merged)
    assert.equal(result.base, merged)
    assert.deepEqual(result.copies, [])
    assert.deepEqual([...result.fsLocal.files.keys()], ['today.md'])
    // the merged file is recorded as synced, at its new local time
    assert.equal(result.prevSync?.sizeEnc, merged.length)
    assert.ok((result.prevSync?.mtimeCli ?? 0) > REMOTE_MTIME)
  })

  it('makes a copy when the merge fails', async () => {
    const local = 'one\nmine\nthree\n'
    const remote = 'one\ntheirs\nthree\n'
    const result = await run({
      key: 'note.md',
      base: 'one\ntwo\nthree\n',
      local,
      remote,
    })
    assertCopied(result, 'note.md', local, remote)
    assert.equal(result.base, local)
  })

  it('makes a copy of a binary file', async () => {
    const local = new Uint8Array([0, 1, 2, 255]).buffer
    const remote = new Uint8Array([0, 1, 3, 254]).buffer
    const result = await run({ key: 'image.png', local, remote })
    const copyKey = conflictCopyKey('image.png', REMOTE_MTIME)
    assert.match(copyKey, /^image\.conflict-remote-\d{8}-\d{6}\.png$/)
    assert.deepEqual(result.copies, [['image.png', copyKey]])
    assert.deepEqual(
      new Uint8Array(await result.fsLocal.readFile(copyKey)),
      new Uint8Array(remote),
    )
    assert.deepEqual(
      new Uint8Array(await result.fsRemote.readFile('image.png')),
      new Uint8Array(local),
    )
    assert.equal(result.base, undefined)
  })

  it('makes a copy of a text file that is not Markdown', async () => {
    const local = 'ONE\ntwo\nthree\n'
    const remote = 'one\ntwo\nTHREE\n'
    const result = await run({
      key: 'list.txt',
      base: 'one\ntwo\nthree\n',
      local,
      remote,
    })
    assertCopied(result, 'list.txt', local, remote)
  })

  it('makes a copy of a Markdown file over the limit', async () => {
    const filler = 'x'.repeat(SMART_CONFLICT_MERGE_LIMIT)
    const base = `one\n${filler}\nthree\n`
    const local = `ONE\n${filler}\nthree\n`
    const remote = `one\n${filler}\nTHREE\n`
    const result = await run({ key: 'big.md', base, local, remote })
    assertCopied(result, 'big.md', local, remote)
    // a file over the limit keeps no base
    assert.equal(result.base, undefined)
  })

  it('makes a copy when no base is stored', async () => {
    const local = 'ONE\ntwo\nthree\n'
    const remote = 'one\ntwo\nTHREE\n'
    const result = await run({ key: 'note.md', local, remote })
    assertCopied(result, 'note.md', local, remote)
    assert.equal(result.base, local)
    // merged from an empty base instead, the remote's text would win here
    const emptied = await run({ key: 'note.md', local: '', remote })
    assertCopied(emptied, 'note.md', '', remote)
  })

  it('makes a copy of a file created on both sides', async () => {
    const result = await run({
      key: 'note.md',
      local: 'mine\n',
      remote: 'theirs\n',
      synced: false,
    })
    assertCopied(result, 'note.md', 'mine\n', 'theirs\n')
  })

  it('makes no copy when both sides hold the same content', async () => {
    const result = await run({
      key: 'note.md',
      local: 'same\n',
      remote: 'same\n',
      synced: false,
    })
    assert.deepEqual(result.copies, [])
    assert.deepEqual([...result.fsLocal.files.keys()], ['note.md'])
    assert.equal(result.fsRemote.text('note.md'), 'same\n')
    assert.equal(result.base, 'same\n')
    assert.equal(result.prevSync?.mtimeCli, LOCAL_MTIME)
  })

  it('never overwrites an earlier copy', async () => {
    const first = conflictCopyKey('note.md', REMOTE_MTIME)
    const second = conflictCopyKey('note.md', REMOTE_MTIME, 2)
    assert.match(second, /^note\.conflict-remote-\d{8}-\d{6}-2\.md$/)
    const result = await run({
      key: 'note.md',
      local: 'mine\n',
      remote: 'theirs\n',
      otherLocalFiles: { [first]: 'earlier copy\n' },
    })
    assert.deepEqual(result.copies, [['note.md', second]])
    assert.equal(result.fsLocal.text(first), 'earlier copy\n')
    assert.equal(result.fsLocal.text(second), 'theirs\n')
    assert.equal(result.fsRemote.text('note.md'), 'mine\n')
  })
})

describe('Smart conflict: the base', () => {
  beforeEach(useFakeMoment)

  const created = { synced: false, conflict: false }

  it('stores a pulled Markdown file as its base', async () => {
    const result = await run({
      key: 'note.md',
      local: undefined,
      remote: 'from remote\n',
      ...created,
    })
    assert.equal(result.entry.decision, 'remote_is_created_then_pull')
    assert.equal(result.fsLocal.text('note.md'), 'from remote\n')
    assert.equal(result.base, 'from remote\n')
  })

  it('stores a pushed Markdown file as its base', async () => {
    const result = await run({
      key: 'note.md',
      local: 'from local\n',
      remote: undefined,
      ...created,
    })
    assert.equal(result.entry.decision, 'local_is_created_then_push')
    assert.equal(result.base, 'from local\n')
  })

  it('drops the base of a Markdown file synced over the limit', async () => {
    const result = await run({
      key: 'note.md',
      base: 'old\n',
      local: 'x'.repeat(SMART_CONFLICT_MERGE_LIMIT + 1),
      remote: undefined,
      ...created,
    })
    assert.equal(result.entry.decision, 'local_is_created_then_push')
    assert.equal(result.base, undefined)
  })

  it('stores no base for a file that is not Markdown', async () => {
    const result = await run({
      key: 'list.txt',
      local: undefined,
      remote: 'from remote\n',
      ...created,
    })
    assert.equal(result.fsLocal.text('list.txt'), 'from remote\n')
    assert.equal(result.base, undefined)
  })

  it('drops the base of a file deleted on both sides', async () => {
    const result = await run({
      key: 'note.md',
      base: 'old\n',
      local: undefined,
      remote: undefined,
      conflict: false,
    })
    assert.equal(result.entry.decision, 'only_history')
    assert.equal(result.base, undefined)
  })
})

describe('Smart conflict: copy names', () => {
  it('puts the copy beside the file, before its extension', () => {
    const time = new Date(2026, 9, 17, 4, 5, 6).getTime()
    assert.equal(
      conflictCopyKey('folder/note.md', time),
      'folder/note.conflict-remote-20261017-040506.md',
    )
    assert.equal(
      conflictCopyKey('folder.v2/README', time),
      'folder.v2/README.conflict-remote-20261017-040506',
    )
    assert.equal(
      conflictCopyKey('a.tar.gz', time, 3),
      'a.tar.conflict-remote-20261017-040506-3.gz',
    )
  })
})
