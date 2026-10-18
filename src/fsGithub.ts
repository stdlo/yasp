/**
 * A FakeFs over GitHub's REST API (the git database), so a vault folder can
 * sync with a private repo on desktop and phone with no native git.
 * `docs/design.md`, "The GitHub remote", is the spec.
 *
 * Every request shape and reply below is written from what GitHub's REST
 * docs say, without fetching them for this build: each is marked with its
 * doc page and `not fetched`, and the click-through list's real-repo check
 * proves them before real use. No Obsidian imports: the request function is
 * passed in (`fsGithubRequest.ts` wraps Obsidian's `requestUrl`).
 */
import type { Entity, GithubConfig } from './baseTypes'
import { FakeFs } from './fsAll'

export interface GithubRequest {
  url: string
  method: 'GET' | 'POST' | 'PATCH'
  headers: Record<string, string>
  body?: string
}

export interface GithubResponse {
  status: number
  headers: Record<string, string>
  json: any
}

// The parts of GitHub's replies this file reads (docs.github.com/en/rest/git,
// not fetched).
interface GithubRef {
  object: { sha: string }
}
interface GithubCommit {
  sha: string
  tree: { sha: string }
}
interface GithubTreeItem {
  path: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
  size?: number
}
interface GithubTree {
  sha: string
  truncated?: boolean
  tree: GithubTreeItem[]
}
interface GithubBlob {
  sha: string
  content: string
}
interface GithubCommitListItem {
  commit?: { committer?: { date?: string } }
}

/** Sends one request and returns its reply, whatever its status. */
export type GithubRequestFunc = (req: GithubRequest) => Promise<GithubResponse>

const API = 'https://api.github.com'
/** this plugin's own files in the repo: never vault files */
const OWN_FOLDER = '.remotely-save-lite/'
const TIMES_KEY = `${OWN_FOLDER}times.json`
/** files over this are skipped with a notice */
export const GITHUB_MAX_FILE_SIZE = 100 * 1024 * 1024

interface TimeEntry {
  mtime: number
  size: number
  sha: string
}

interface Staged {
  /** undefined: a deletion */
  sha?: string
  mtime: number
  size: number
}

const toBase64 = (content: ArrayBuffer) =>
  Buffer.from(new Uint8Array(content)).toString('base64')

const fromBase64 = (text: string) => {
  const buf = Buffer.from(text.replace(/\n/g, ''), 'base64')
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export class FakeFsGithub extends FakeFs {
  kind = 'github'
  private readonly prefix: string
  // the branch head the cached tree belongs to
  private headSha?: string
  private treeSha?: string
  /** repo paths (prefix stripped) of the head's tree: path → blob sha */
  private blobs = new Map<string, { sha: string; size: number }>()
  private folders = new Set<string>()
  private times: Record<string, TimeEntry> = {}
  private staged = new Map<string, Staged>()
  private uncommitted: string[] = []
  /** a walk gave files a fallback time that the times file doesn't hold yet */
  private timesDirty = false

  constructor(
    readonly config: GithubConfig,
    readonly device: string,
    readonly request: GithubRequestFunc,
    readonly notice?: (msg: string) => void,
  ) {
    super()
    const folder = (config.folder ?? '').replace(/^\/+|\/+$/g, '')
    this.prefix = folder === '' ? '' : `${folder}/`
  }

  private repoUrl(path: string) {
    const { owner, repo } = this.config
    return `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`
  }

  /** `T` is the reply's shape, as far as this file reads it. */
  private async call<T = unknown>(
    method: GithubRequest['method'],
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.request({
      url: path.startsWith('https://') ? path : this.repoUrl(path),
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        // the token goes in this header only, and is never logged
        Authorization: `Bearer ${this.config.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status >= 200 && res.status < 300) {
      return res.json as T
    }
    // docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
    // (not fetched): a 403 or 429 with x-ratelimit-remaining 0 is the limit
    const remaining = res.headers['x-ratelimit-remaining']
    if ((res.status === 403 || res.status === 429) && remaining === '0') {
      throw new GithubError(
        'GitHub: the hourly request limit is used up; the next sync after it resets goes on.',
        res.status,
      )
    }
    if (res.status === 401) {
      throw new GithubError(
        'GitHub: the token was refused (401). Check it in the settings.',
        401,
      )
    }
    if (res.status === 403 || res.status === 404) {
      throw new GithubError(
        `GitHub: no access to ${this.config.owner}/${this.config.repo} (${res.status}). Check the repo, the branch, and that the token may read and write its contents.`,
        res.status,
      )
    }
    throw new GithubError(
      `GitHub: ${method} failed with ${res.status}${res.json?.message ? `: ${res.json.message}` : ''}`,
      res.status,
    )
  }

  /**
   * The branch as the tail of a ref path: one segment at a time, so a branch
   * named `feature/x` keeps its slash (a ref path takes `heads/feature/x`;
   * an encoded `%2F` there isn't known to match, and the docs are not
   * fetched).
   */
  private branchPath() {
    return this.config.branch.split('/').map(encodeURIComponent).join('/')
  }

  /** docs.github.com/en/rest/git/refs (not fetched): `object.sha` */
  private async getHead() {
    const ref = await this.call<GithubRef>(
      'GET',
      `/git/ref/heads/${this.branchPath()}`,
    )
    return ref.object.sha
  }

  /**
   * docs.github.com/en/rest/git/commits (not fetched): `tree.sha`;
   * docs.github.com/en/rest/git/trees (not fetched): `?recursive=1` gives
   * `tree[]` of `{ path, type: 'blob' | 'tree', sha, size }` and `truncated`.
   */
  private async readTree(head: string) {
    const commit = await this.call<GithubCommit>('GET', `/git/commits/${head}`)
    const treeSha = commit.tree.sha
    const tree = await this.call<GithubTree>(
      'GET',
      `/git/trees/${treeSha}?recursive=1`,
    )
    if (tree.truncated) {
      throw Error('GitHub: the repo is too large to list in one request.')
    }
    const blobs = new Map<string, { sha: string; size: number }>()
    const folders = new Set<string>()
    for (const item of tree.tree) {
      if (!item.path.startsWith(this.prefix)) {
        continue
      }
      const path = item.path.slice(this.prefix.length)
      if (item.type === 'blob') {
        blobs.set(path, { sha: item.sha, size: item.size ?? 0 })
      } else if (item.type === 'tree' && path !== '') {
        folders.add(`${path}/`)
      }
    }
    return { treeSha, blobs, folders }
  }

  /** docs.github.com/en/rest/git/blobs (not fetched): base64 `content` */
  private async readBlob(sha: string) {
    const blob = await this.call<GithubBlob>('GET', `/git/blobs/${sha}`)
    return fromBase64(blob.content)
  }

  private async readTimes(blobs: Map<string, { sha: string }>) {
    const times = blobs.get(TIMES_KEY)
    if (times === undefined) {
      return {}
    }
    try {
      return JSON.parse(
        new TextDecoder().decode(await this.readBlob(times.sha)),
      ) as Record<string, TimeEntry>
    } catch (e) {
      return {}
    }
  }

  /**
   * Reads the branch head's tree and times file, unless the tree already
   * loaded is of the head the branch still has: one sync lists the repo for
   * the routes file, the password check, and the engine's walk.
   */
  private async load() {
    const head = await this.getHead()
    if (head === this.headSha) {
      return
    }
    const { treeSha, blobs, folders } = await this.readTree(head)
    this.headSha = head
    this.treeSha = treeSha
    this.blobs = blobs
    this.folders = folders
    this.times = await this.readTimes(blobs)
  }

  /**
   * The time of the last commit touching a path, for a file whose blob the
   * times file doesn't know (edited on github.com).
   * docs.github.com/en/rest/commits/commits (not fetched): `GET /commits?
   * path=&sha=&per_page=1` gives `[{ commit: { committer: { date } } }]`.
   */
  private async lastCommitTime(path: string) {
    const list = await this.call<GithubCommitListItem[]>(
      'GET',
      `/commits?sha=${encodeURIComponent(this.config.branch)}&path=${encodeURIComponent(`${this.prefix}${path}`)}&per_page=1`,
    )
    const date = list?.[0]?.commit?.committer?.date
    return date === undefined ? Date.now() : Date.parse(date)
  }

  /**
   * The listing. A file the times file doesn't know takes the time of its
   * last commit (a request each) when `withFallbacks`; the times it gets are
   * kept, and the next commit writes them to the times file, so the lookup
   * is made once. A partial listing (keys only) makes no lookups.
   */
  private async list(withFallbacks: boolean): Promise<Entity[]> {
    await this.load()
    const res: Entity[] = []
    for (const folder of this.folders) {
      if (folder.startsWith(OWN_FOLDER)) {
        continue
      }
      res.push({ key: folder, keyRaw: folder, size: 0, sizeRaw: 0 })
    }
    const fallbacks: string[] = []
    for (const [path, blob] of this.blobs) {
      if (path.startsWith(OWN_FOLDER)) {
        continue
      }
      let time: TimeEntry | undefined = this.times[path]
      if (withFallbacks && (time === undefined || time.sha !== blob.sha)) {
        time = {
          mtime: await this.lastCommitTime(path),
          size: blob.size,
          sha: blob.sha,
        }
        this.times[path] = time
        fallbacks.push(path)
      }
      res.push({
        key: path,
        keyRaw: path,
        mtimeCli: time?.mtime,
        mtimeSvr: time?.mtime,
        size: blob.size,
        sizeRaw: blob.size,
      })
    }
    if (fallbacks.length > 0) {
      this.timesDirty = true
      this.notice?.(
        `GitHub: ${fallbacks.length} files changed outside this plugin (on github.com, say) take the time of their last commit.`,
      )
    }
    return res
  }

  async walk(): Promise<Entity[]> {
    return await this.list(true)
  }

  async walkPartial(): Promise<Entity[]> {
    return await this.list(false)
  }

  private async ensureLoaded() {
    if (this.headSha === undefined) {
      await this.load()
    }
  }

  async stat(key: string): Promise<Entity> {
    await this.ensureLoaded()
    if (key.endsWith('/')) {
      return { key, keyRaw: key, size: 0, sizeRaw: 0 }
    }
    const staged = this.staged.get(key)
    if (staged?.sha !== undefined) {
      return {
        key,
        keyRaw: key,
        mtimeCli: staged.mtime,
        mtimeSvr: staged.mtime,
        size: staged.size,
        sizeRaw: staged.size,
      }
    }
    const blob = this.blobs.get(key)
    if (blob === undefined || staged !== undefined) {
      throw Error(`GitHub: ${key} does not exist`)
    }
    const mtime = this.times[key]?.mtime ?? Date.now()
    return {
      key,
      keyRaw: key,
      mtimeCli: mtime,
      mtimeSvr: mtime,
      size: blob.size,
      sizeRaw: blob.size,
    }
  }

  async mkdir(key: string): Promise<Entity> {
    // git keeps no empty folders: a folder exists through its files
    return { key, keyRaw: key, size: 0, sizeRaw: 0 }
  }

  /** docs.github.com/en/rest/git/blobs (not fetched): `POST` gives `sha` */
  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
  ): Promise<Entity> {
    if (content.byteLength > GITHUB_MAX_FILE_SIZE) {
      this.notice?.(`GitHub: ${key} is over 100 MB and isn't synced.`)
      throw Error(`GitHub: ${key} is over 100 MB`)
    }
    await this.ensureLoaded()
    const blob = await this.call<GithubBlob>('POST', '/git/blobs', {
      content: toBase64(content),
      encoding: 'base64',
    })
    this.staged.set(key, {
      sha: blob.sha,
      mtime,
      size: content.byteLength,
    })
    return await this.stat(key)
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    await this.ensureLoaded()
    const sha = this.staged.get(key)?.sha ?? this.blobs.get(key)?.sha
    if (sha === undefined) {
      throw Error(`GitHub: ${key} does not exist`)
    }
    return await this.readBlob(sha)
  }

  async rm(key: string): Promise<void> {
    if (key.endsWith('/')) {
      // an empty folder is gone from git already
      return
    }
    await this.ensureLoaded()
    this.staged.set(key, { mtime: 0, size: 0 })
  }

  /** A folder renamed in one commit, outside a sync run. */
  async rename(key1: string, key2: string): Promise<void> {
    await this.load()
    const from = key1.endsWith('/') ? key1 : `${key1}/`
    const to = key2.endsWith('/') ? key2 : `${key2}/`
    for (const [path, blob] of this.blobs) {
      if (!path.startsWith(from)) {
        continue
      }
      const moved = `${to}${path.slice(from.length)}`
      const time = this.times[path]
      this.staged.set(moved, {
        sha: blob.sha,
        mtime: time?.mtime ?? Date.now(),
        size: blob.size,
      })
      this.staged.set(path, { mtime: 0, size: 0 })
    }
    await this.finishSync()
    if (this.uncommitted.length > 0) {
      throw Error(`GitHub: the rename of ${from} wasn't committed`)
    }
  }

  uncommittedKeys() {
    return this.uncommitted
  }

  /** The times file for a commit: the head's, with this run's on top. */
  private mergedTimes(head: Record<string, TimeEntry>) {
    const res: Record<string, TimeEntry> = { ...head }
    for (const [key, s] of this.staged) {
      if (key.startsWith(OWN_FOLDER)) {
        continue
      }
      if (s.sha === undefined) {
        delete res[key]
      } else {
        res[key] = { mtime: s.mtime, size: s.size, sha: s.sha }
      }
    }
    return res
  }

  /**
   * docs.github.com/en/rest/git/trees (not fetched): `POST` with
   * `base_tree` and `tree[]` of `{ path, mode: '100644', type: 'blob', sha }`,
   * `sha: null` deleting a path; gives `sha`.
   * docs.github.com/en/rest/git/commits (not fetched): `POST` with
   * `message`, `tree`, `parents`; gives `sha`.
   * docs.github.com/en/rest/git/refs (not fetched): `PATCH` with `sha` and
   * `force: false`; a 422 when the branch moved and it isn't a fast-forward.
   */
  private async commitOnce(
    head: string,
    baseTree: string,
    times: Record<string, TimeEntry>,
  ) {
    const timesBytes = new TextEncoder().encode(JSON.stringify(times))
    const timesBlob = await this.call<GithubBlob>('POST', '/git/blobs', {
      content: toBase64(
        timesBytes.buffer.slice(
          timesBytes.byteOffset,
          timesBytes.byteOffset + timesBytes.byteLength,
        ),
      ),
      encoding: 'base64',
    })
    const entries: {
      path: string
      mode: string
      type: string
      sha: string | null
    }[] = [...this.staged].map(([key, s]) => ({
      path: `${this.prefix}${key}`,
      mode: '100644',
      type: 'blob',
      sha: s.sha ?? null,
    }))
    // the times file last
    entries.push({
      path: `${this.prefix}${TIMES_KEY}`,
      mode: '100644',
      type: 'blob',
      sha: timesBlob.sha,
    })
    const tree = await this.call<GithubTree>('POST', '/git/trees', {
      base_tree: baseTree,
      tree: entries,
    })
    // titled from what is staged: the plugin's own files (the routes file)
    // count, so only fallback times alone read as a record of times
    const changes = this.staged.size
    const commit = await this.call<GithubCommit>('POST', '/git/commits', {
      message:
        changes === 0
          ? `Record file times from ${this.device}`
          : `Sync from ${this.device}, ${changes} changes`,
      tree: tree.sha,
      parents: [head],
    })
    try {
      await this.call('PATCH', `/git/refs/heads/${this.branchPath()}`, {
        sha: commit.sha,
        force: false,
      })
      return true
    } catch (e) {
      if (e instanceof GithubError && e.status === 422) {
        return false
      }
      throw e
    }
  }

  /**
   * One commit of everything staged in the run. When another device moved
   * the branch first, the tree is rebuilt on the new head, and only the
   * paths that changed there are dropped from it: those are the keys the
   * orchestrator rolls back.
   */
  async finishSync(): Promise<void> {
    this.uncommitted = []
    // fallback times alone are worth a commit: it's the one lookup per file
    if (this.staged.size === 0 && !this.timesDirty) {
      return
    }
    this.timesDirty = false
    const all = [...this.staged.keys()]
    try {
      let head = this.headSha!
      let baseTree = this.treeSha!
      let headTimes = this.times
      const dropped: string[] = []
      for (let attempt = 0; attempt < 3; ++attempt) {
        // on a moved branch, nothing left staged means the head's own times
        // stand and a commit would be empty
        if (attempt > 0 && this.staged.size === 0) {
          this.uncommitted = dropped
          this.headSha = undefined
          return
        }
        if (
          await this.commitOnce(head, baseTree, this.mergedTimes(headTimes))
        ) {
          this.uncommitted = dropped
          this.staged.clear()
          // the next walk reads the new head
          this.headSha = undefined
          return
        }
        // the branch moved: what changed there between our base and its head
        const newHead = await this.getHead()
        const next = await this.readTree(newHead)
        const changed = new Set<string>()
        for (const [path, blob] of next.blobs) {
          if (this.blobs.get(path)?.sha !== blob.sha) {
            changed.add(path)
          }
        }
        for (const path of this.blobs.keys()) {
          if (!next.blobs.has(path)) {
            changed.add(path)
          }
        }
        for (const key of [...this.staged.keys()]) {
          if (changed.has(key) && !key.startsWith(OWN_FOLDER)) {
            this.staged.delete(key)
            dropped.push(key)
          }
        }
        head = newHead
        baseTree = next.treeSha
        headTimes = await this.readTimes(next.blobs)
        this.blobs = next.blobs
        this.folders = next.folders
      }
      throw Error('GitHub: the branch kept moving; nothing was committed.')
    } catch (e) {
      this.uncommitted = all
      this.staged.clear()
      this.headSha = undefined
      throw e
    }
  }

  /** docs.github.com/en/rest/git/refs (not fetched): the branch exists */
  async checkConnect(callbackFunc?: any): Promise<boolean> {
    try {
      await this.getHead()
      return true
    } catch (e) {
      callbackFunc?.(e)
      return false
    }
  }

  async getUserDisplayName(): Promise<string> {
    return `${this.config.owner}/${this.config.repo}`
  }

  async revokeAuth(): Promise<any> {
    // a personal access token is revoked on github.com
  }

  allowEmptyFile(): boolean {
    return true
  }
}
