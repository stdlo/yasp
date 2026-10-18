import { strict as assert } from 'assert'
import {
  FakeFsGithub,
  type GithubRequest,
  type GithubResponse,
} from '../src/fsGithub'

// The GitHub remote against an in-memory repo behind a fake request
// function. The mock answers as the fs's comments say GitHub's REST docs
// do; those premises are unchecked until the click-through list's real-repo
// sync (docs/click-through.md).

const TOKEN = 'test-token-not-real'
const TIMES = '.remotely-save-lite/times.json'

const enc = (text: string) => Buffer.from(text).toString('base64')
const dec = (b64: string) => Buffer.from(b64, 'base64').toString()
const buf = (text: string) => {
  const b = Buffer.from(text)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}
const str = (content: ArrayBuffer) => Buffer.from(content).toString()

interface Commit {
  tree: string
  parents: string[]
  date: string
}

class MockRepo {
  blobs = new Map<string, string>() // sha → base64
  trees = new Map<string, Map<string, string>>() // sha → path → blob sha
  commits = new Map<string, Commit>()
  head = ''
  /** the branch's ref path tail, as the URL spells it */
  branchPath = 'main'
  n = 0
  requests: GithubRequest[] = []
  /** a status to answer the next request matching, once */
  failOn?: { match: RegExp; status: number; headers?: Record<string, string> }
  /** runs once before the next ref update: another device's commit */
  beforePatch?: () => void

  constructor(files: Record<string, string>, date = '2026-01-01T00:00:00Z') {
    const tree = new Map<string, string>()
    for (const [path, text] of Object.entries(files)) {
      tree.set(path, this.blob(enc(text)))
    }
    this.head = this.commit(this.tree(tree), [], date)
  }

  blob(b64: string) {
    const sha = `blob-${Buffer.from(b64).toString('hex').slice(0, 24)}-${b64.length}`
    this.blobs.set(sha, b64)
    return sha
  }
  tree(map: Map<string, string>) {
    const sha = `tree-${++this.n}`
    this.trees.set(sha, map)
    return sha
  }
  commit(tree: string, parents: string[], date: string) {
    const sha = `commit-${++this.n}`
    this.commits.set(sha, { tree, parents, date })
    return sha
  }
  files(sha = this.head) {
    const res: Record<string, string> = {}
    for (const [path, blob] of this.trees.get(this.commits.get(sha)!.tree)!) {
      res[path] = dec(this.blobs.get(blob)!)
    }
    return res
  }
  /** another device's commit, straight onto the branch */
  push(changes: Record<string, string | null>, date: string) {
    const tree = new Map(this.trees.get(this.commits.get(this.head)!.tree)!)
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) tree.delete(path)
      else tree.set(path, this.blob(enc(text)))
    }
    this.head = this.commit(this.tree(tree), [this.head], date)
  }

  request = async (req: GithubRequest): Promise<GithubResponse> => {
    this.requests.push(req)
    const ok = (json: any, status = 200) => ({ status, headers: {}, json })
    if (
      this.failOn !== undefined &&
      this.failOn.match.test(`${req.method} ${req.url}`)
    ) {
      const { status, headers } = this.failOn
      this.failOn = undefined
      return { status, headers: headers ?? {}, json: { message: 'nope' } }
    }
    if (req.headers.Authorization !== `Bearer ${TOKEN}`) {
      return { status: 401, headers: {}, json: { message: 'Bad credentials' } }
    }
    const url = new URL(req.url)
    const path = url.pathname.replace(/^\/repos\/me\/notes/, '')
    const body = req.body === undefined ? undefined : JSON.parse(req.body)
    let m: RegExpMatchArray | null
    if (req.method === 'GET' && path === `/git/ref/heads/${this.branchPath}`) {
      return ok({ object: { sha: this.head } })
    }
    if (req.method === 'GET' && (m = path.match(/^\/git\/commits\/(.+)$/))) {
      return ok({ tree: { sha: this.commits.get(m[1])!.tree } })
    }
    if (req.method === 'GET' && (m = path.match(/^\/git\/trees\/(.+)$/))) {
      const tree = this.trees.get(m[1])!
      const folders = new Set<string>()
      const items: any[] = []
      for (const [p, sha] of tree) {
        const parts = p.split('/')
        for (let i = 1; i < parts.length; ++i)
          folders.add(parts.slice(0, i).join('/'))
        items.push({
          path: p,
          type: 'blob',
          sha,
          size: dec(this.blobs.get(sha)!).length,
        })
      }
      for (const f of folders)
        items.push({ path: f, type: 'tree', sha: `t-${f}` })
      return ok({ tree: items, truncated: false })
    }
    if (req.method === 'GET' && (m = path.match(/^\/git\/blobs\/(.+)$/))) {
      return ok({ content: this.blobs.get(m[1]), encoding: 'base64' })
    }
    if (req.method === 'POST' && path === '/git/blobs') {
      return ok({ sha: this.blob(body.content) }, 201)
    }
    if (req.method === 'POST' && path === '/git/trees') {
      const tree = new Map(this.trees.get(body.base_tree)!)
      for (const e of body.tree) {
        if (e.sha === null) tree.delete(e.path)
        else tree.set(e.path, e.sha)
      }
      return ok({ sha: this.tree(tree) }, 201)
    }
    if (req.method === 'POST' && path === '/git/commits') {
      return ok(
        { sha: this.commit(body.tree, body.parents, '2026-02-01T00:00:00Z') },
        201,
      )
    }
    if (
      req.method === 'PATCH' &&
      path === `/git/refs/heads/${this.branchPath}`
    ) {
      this.beforePatch?.()
      this.beforePatch = undefined
      if (this.commits.get(body.sha)!.parents[0] !== this.head) {
        return {
          status: 422,
          headers: {},
          json: { message: 'Update is not a fast forward' },
        }
      }
      this.head = body.sha
      return ok({ object: { sha: body.sha } })
    }
    if (req.method === 'GET' && path === '/commits') {
      const p = url.searchParams.get('path')!
      // newest first: the first commit whose blob for the path differs from its parent's
      let sha: string | undefined = this.head
      while (sha !== undefined) {
        const c: Commit = this.commits.get(sha)!
        const mine = this.trees.get(c.tree)!.get(p)
        const parent = c.parents[0]
        const theirs =
          parent === undefined
            ? undefined
            : this.trees.get(this.commits.get(parent)!.tree)!.get(p)
        if (mine !== theirs)
          return ok([{ commit: { committer: { date: c.date } } }])
        sha = parent
      }
      return ok([])
    }
    return {
      status: 404,
      headers: {},
      json: { message: `no route ${req.method} ${path}` },
    }
  }
}

const fsFor = (
  repo: MockRepo,
  notices: string[] = [],
  token = TOKEN,
  branch = 'main',
) =>
  new FakeFsGithub(
    { owner: 'me', repo: 'notes', branch, token },
    'laptop',
    repo.request,
    (msg) => notices.push(msg),
  )

const timesFile = (entries: Record<string, [number, string]>, repo: MockRepo) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(entries).map(([path, [mtime, text]]) => [
        path,
        { mtime, size: text.length, sha: repo.blob(enc(text)) },
      ]),
    ),
  )

describe('GitHub remote', () => {
  it('lists the head tree with the times file, in two calls and a blob', async () => {
    const repo = new MockRepo({ 'work/a.md': 'a', 'work/sub/b.md': 'bb' })
    repo.push(
      {
        [TIMES]: timesFile(
          { 'work/a.md': [111_000, 'a'], 'work/sub/b.md': [222_000, 'bb'] },
          repo,
        ),
      },
      '2026-01-02T00:00:00Z',
    )
    repo.requests = []
    const list = await fsFor(repo).walk()
    const byKey = Object.fromEntries(list.map((e) => [e.key, e]))
    assert.deepEqual(Object.keys(byKey).sort(), [
      'work/',
      'work/a.md',
      'work/sub/',
      'work/sub/b.md',
    ])
    assert.equal(byKey['work/a.md'].mtimeCli, 111_000)
    assert.equal(byKey['work/sub/b.md'].size, 2)
    // ref, commit, tree, and the times blob
    assert.equal(repo.requests.length, 4)
  })

  it('keeps the slash of a branch named feature/x in the ref paths', async () => {
    const repo = new MockRepo({ 'work/old.md': 'old' })
    // each segment encoded alone: the slash stays, a space doesn't
    repo.branchPath = 'feature/x%20y'
    const fs = fsFor(repo, [], TOKEN, 'feature/x y')
    await fs.walk()
    await fs.writeFile('work/a.md', buf('A'), 5_000, 5_000)
    await fs.finishSync()
    assert.equal(repo.files()['work/a.md'], 'A')
  })

  it('commits a run in one commit, times file included', async () => {
    const repo = new MockRepo({ 'work/old.md': 'old' })
    const fs = fsFor(repo)
    await fs.walk()
    const before = repo.commits.size
    await fs.writeFile('work/a.md', buf('A'), 5_000, 5_000)
    await fs.writeFile('work/b.md', buf('B'), 6_000, 6_000)
    await fs.rm('work/old.md')
    await fs.finishSync()
    assert.equal(repo.commits.size, before + 1)
    const files = repo.files()
    assert.equal(files['work/a.md'], 'A')
    assert.equal(files['work/b.md'], 'B')
    assert.equal(files['work/old.md'], undefined)
    const times = JSON.parse(files[TIMES])
    assert.equal(times['work/a.md'].mtime, 5_000)
    assert.deepEqual(fs.uncommittedKeys(), [])
    const patch = repo.requests.filter((r) => r.method === 'PATCH')
    assert.equal(patch.length, 1)
    assert.equal(JSON.parse(patch[0].body!).force, false)
  })

  it('rebuilds on a moved branch with no overlap, merging the times', async () => {
    const repo = new MockRepo({ 'work/a.md': 'a' })
    const fs = fsFor(repo)
    await fs.walk()
    await fs.writeFile('work/mine.md', buf('M'), 7_000, 7_000)
    repo.beforePatch = () =>
      repo.push(
        {
          'work/theirs.md': 'T',
          [TIMES]: timesFile({ 'work/theirs.md': [8_000, 'T'] }, repo),
        },
        '2026-01-03T00:00:00Z',
      )
    await fs.finishSync()
    const files = repo.files()
    assert.equal(files['work/mine.md'], 'M')
    assert.equal(files['work/theirs.md'], 'T')
    const times = JSON.parse(files[TIMES])
    assert.equal(times['work/mine.md'].mtime, 7_000)
    assert.equal(times['work/theirs.md'].mtime, 8_000)
    assert.deepEqual(fs.uncommittedKeys(), [])
  })

  it('drops only the overlapping paths on a moved branch', async () => {
    const repo = new MockRepo({ 'work/a.md': 'a', 'work/b.md': 'b' })
    const fs = fsFor(repo)
    await fs.walk()
    await fs.writeFile('work/a.md', buf('mine'), 7_000, 7_000)
    await fs.writeFile('work/b.md', buf('mine b'), 7_000, 7_000)
    repo.beforePatch = () =>
      repo.push({ 'work/a.md': 'theirs' }, '2026-01-03T00:00:00Z')
    await fs.finishSync()
    const files = repo.files()
    assert.equal(files['work/a.md'], 'theirs')
    assert.equal(files['work/b.md'], 'mine b')
    assert.deepEqual(fs.uncommittedKeys(), ['work/a.md'])
  })

  it('reports every key uncommitted when the commit fails', async () => {
    const repo = new MockRepo({ 'work/a.md': 'a' })
    const fs = fsFor(repo)
    await fs.walk()
    await fs.writeFile('work/n.md', buf('N'), 7_000, 7_000)
    await fs.rm('work/a.md')
    repo.failOn = { match: /POST .*\/git\/trees/, status: 500 }
    await assert.rejects(fs.finishSync())
    assert.deepEqual(fs.uncommittedKeys().sort(), ['work/a.md', 'work/n.md'])
    assert.equal(repo.files()['work/a.md'], 'a')
  })

  it('names a refused token (401)', async () => {
    const repo = new MockRepo({})
    await assert.rejects(fsFor(repo, [], 'wrong').walk(), /401/)
  })

  it('names the rate limit (403, none remaining)', async () => {
    const repo = new MockRepo({})
    repo.failOn = {
      match: /GET .*\/git\/ref\//,
      status: 403,
      headers: { 'x-ratelimit-remaining': '0' },
    }
    await assert.rejects(fsFor(repo).walk(), /request limit/)
  })

  it('gives a file edited on github.com its last commit time, with a notice', async () => {
    const repo = new MockRepo({ 'work/a.md': 'a' })
    repo.push(
      { [TIMES]: timesFile({ 'work/a.md': [111_000, 'a'] }, repo) },
      '2026-01-02T00:00:00Z',
    )
    repo.push({ 'work/a.md': 'edited on the web' }, '2026-01-05T00:00:00Z')
    const notices: string[] = []
    const list = await fsFor(repo, notices).walk()
    const a = list.find((e) => e.key === 'work/a.md')!
    assert.equal(a.mtimeCli, Date.parse('2026-01-05T00:00:00Z'))
    assert.equal(notices.length, 1)
  })

  it('looks up a file edited on github.com once, however many walks', async () => {
    const repo = new MockRepo({ 'work/a.md': 'a', 'work/b.md': 'b' })
    repo.push({ [TIMES]: timesFile({}, repo) }, '2026-01-02T00:00:00Z')
    const fs = fsFor(repo)
    const lookups = () =>
      repo.requests.filter((r) => /\/commits\?/.test(r.url)).length
    repo.requests = []
    await fs.walkPartial()
    assert.equal(lookups(), 0, 'a partial listing makes no lookups')
    await fs.walk()
    assert.equal(lookups(), 2)
    // the tree is reused while the head holds: only the ref is read again
    repo.requests = []
    await fs.walk()
    assert.equal(lookups(), 0)
    assert.equal(repo.requests.length, 1)
  })

  it('commits fallback times alone, so the lookup is made once', async () => {
    const repo = new MockRepo({ 'work/a.md': 'a' })
    repo.push({ [TIMES]: timesFile({}, repo) }, '2026-01-02T00:00:00Z')
    const fs = fsFor(repo)
    await fs.walk()
    const before = repo.commits.size
    await fs.finishSync()
    assert.equal(repo.commits.size, before + 1)
    const times = JSON.parse(repo.files()[TIMES])
    assert.equal(times['work/a.md'].mtime, Date.parse('2026-01-01T00:00:00Z'))
    // a new device run finds the time in the file: no lookup, no commit
    repo.requests = []
    const next = fsFor(repo)
    await next.walk()
    await next.finishSync()
    assert.equal(
      repo.requests.filter((r) => /\/commits\?/.test(r.url)).length,
      0,
    )
    assert.equal(repo.commits.size, before + 1)
  })

  it('renames a folder in one commit', async () => {
    const repo = new MockRepo({
      'work/a.md': 'a',
      'work/b.md': 'b',
      'n.md': 'n',
    })
    const fs = fsFor(repo)
    const before = repo.commits.size
    await fs.rename('work/', 'job/')
    assert.equal(repo.commits.size, before + 1)
    assert.deepEqual(
      Object.keys(repo.files())
        .filter((k) => k !== TIMES)
        .sort(),
      ['job/a.md', 'job/b.md', 'n.md'],
    )
  })

  it('keeps the vault under an optional folder in the repo', async () => {
    const repo = new MockRepo({ 'vault/work/a.md': 'a', 'other/x.md': 'x' })
    const fs = new FakeFsGithub(
      {
        owner: 'me',
        repo: 'notes',
        branch: 'main',
        token: TOKEN,
        folder: 'vault',
      },
      'laptop',
      repo.request,
    )
    const keys = (await fs.walk()).map((e) => e.key).sort()
    assert.deepEqual(keys, ['work/', 'work/a.md'])
  })

  it('never logs the token', async () => {
    const logged: string[] = []
    const saved = { ...console }
    for (const k of ['log', 'info', 'debug', 'warn', 'error'] as const) {
      console[k] = (...args: any[]) => logged.push(args.map(String).join(' '))
    }
    try {
      const repo = new MockRepo({ 'work/a.md': 'a' })
      const fs = fsFor(repo)
      await fs.walk()
      await fs.writeFile('work/b.md', buf('b'), 1_000, 1_000)
      repo.failOn = { match: /PATCH/, status: 500 }
      const err = await fs.finishSync().catch((e) => e)
      assert.ok(!String(err?.message).includes(TOKEN))
    } finally {
      Object.assign(console, saved)
    }
    assert.ok(logged.every((l) => !l.includes(TOKEN)))
  })

  it('round-trips a file through a blob', async () => {
    const repo = new MockRepo({ 'work/a.md': 'hello' })
    const fs = fsFor(repo)
    await fs.walk()
    assert.equal(str(await fs.readFile('work/a.md')), 'hello')
  })
})
