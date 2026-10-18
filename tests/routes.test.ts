import { strict as assert } from 'assert'
import {
  LOCAL_ONLY,
  type RouteTable,
  describeTarget,
  heldQuestions,
  mergeOwnership,
  ownershipFor,
  refusedSetup,
  renameRoute,
  routeFilterFor,
  routeOf,
  sharedFoldersFor,
} from '../src/routes'

// The route table's rules, as `docs/design.md` gives them.

const REMOTES = [
  { id: 'dropbox', name: 'Dropbox', enabled: true },
  { id: 'github', name: 'GitHub', enabled: true },
]

const TABLE: RouteTable = {
  routes: [
    { folder: 'areas', target: 'dropbox' },
    { folder: 'areas/job', target: 'github' },
    { folder: 'work', target: 'github' },
  ],
  defaultTarget: 'dropbox',
}

describe('Routes: the table', () => {
  it('takes the longest match', () => {
    assert.equal(routeOf(TABLE, 'areas/a.md'), 'dropbox')
    assert.equal(routeOf(TABLE, 'areas/job/a.md'), 'github')
    assert.equal(routeOf(TABLE, 'areas/job/'), 'github')
  })

  it('matches whole segments only', () => {
    assert.equal(routeOf(TABLE, 'work/a.md'), 'github')
    assert.equal(routeOf(TABLE, 'work/'), 'github')
    assert.equal(routeOf(TABLE, 'workshop/a.md'), 'dropbox')
    assert.equal(routeOf(TABLE, 'areas/jobs/a.md'), 'dropbox')
  })

  it('sends root files to the default', () => {
    assert.equal(routeOf(TABLE, 'a.md'), 'dropbox')
    assert.equal(
      routeOf({ routes: TABLE.routes, defaultTarget: LOCAL_ONLY }, 'a.md'),
      LOCAL_ONLY,
    )
  })

  it("admits a route's ancestor folders, and only folders", () => {
    const github = routeFilterFor(TABLE, 'github')
    assert.equal(github('areas/'), true)
    assert.equal(github('areas/a.md'), false)
    assert.equal(github('areas/job/a.md'), true)
    assert.equal(github('a.md'), false)
    const dropbox = routeFilterFor(TABLE, 'dropbox')
    assert.equal(dropbox('areas/job/a.md'), false)
    assert.equal(dropbox('work/'), false)
    assert.equal(dropbox('a.md'), true)
  })

  it("shares the folders above any other target's route, and its own", () => {
    // Dropbox's run holds `areas` but not what GitHub owns below it
    assert.deepEqual([...sharedFoldersFor(TABLE, 'dropbox')], ['areas/'])
    // GitHub's run holds `areas` only as an ancestor
    assert.deepEqual([...sharedFoldersFor(TABLE, 'github')], ['areas/'])
    assert.deepEqual(
      [
        ...sharedFoldersFor(
          {
            routes: [{ folder: 'a/b', target: LOCAL_ONLY }],
            defaultTarget: 'x',
          },
          'x',
        ),
      ],
      ['a/'],
    )
  })

  it("keeps a disabled remote's folders from every other remote", () => {
    // the table never looks at enabled: the route still owns the folder
    const dropbox = routeFilterFor(TABLE, 'dropbox')
    assert.equal(dropbox('work/a.md'), false)
    assert.equal(routeOf(TABLE, 'work/a.md'), 'github')
  })

  it('reads per remote', () => {
    assert.equal(
      describeTarget(TABLE, 'dropbox'),
      'everything except "areas/job", "work"',
    )
    assert.equal(describeTarget(TABLE, 'github'), 'only "areas/job", "work"')
    assert.equal(
      describeTarget(
        {
          routes: [
            { folder: 'work', target: 'github' },
            { folder: 'work/private', target: LOCAL_ONLY },
          ],
          defaultTarget: 'dropbox',
        },
        'github',
      ),
      'only "work", except "work/private"',
    )
    assert.equal(
      describeTarget({ routes: [], defaultTarget: 'dropbox' }, 'github'),
      'nothing',
    )
  })

  it('renames a route and the routes under it', () => {
    const t = renameRoute(TABLE, 'areas', 'zones')
    assert.deepEqual(
      t.routes.map((r) => r.folder),
      ['zones', 'zones/job', 'work'],
    )
  })
})

describe('Routes: refused setups', () => {
  it('accepts the table above', () => {
    assert.deepEqual(refusedSetup(TABLE, REMOTES), [])
  })

  it('refuses the same folder twice', () => {
    const t = {
      routes: [
        { folder: 'work', target: 'github' },
        { folder: 'work/', target: 'dropbox' },
      ],
      defaultTarget: 'dropbox',
    }
    assert.equal(refusedSetup(t, REMOTES).length, 1)
  })

  it("refuses a route to a remote that doesn't exist", () => {
    const t = {
      routes: [{ folder: 'work', target: 'onedrive' }],
      defaultTarget: 'dropbox',
    }
    assert.equal(refusedSetup(t, REMOTES).length, 1)
  })

  it('refuses config-folder sync on two remotes', () => {
    const remotes = REMOTES.map((r) => ({ ...r, syncConfigDir: true }))
    assert.equal(refusedSetup(TABLE, remotes).length, 1)
  })

  it('refuses a table with no default row', () => {
    assert.equal(refusedSetup({ routes: TABLE.routes }, REMOTES).length, 1)
  })
})

describe('Routes: the ownership file', () => {
  it('writes the folders a remote owns', () => {
    assert.deepEqual(ownershipFor(TABLE, REMOTES[1], 7), {
      remote: 'GitHub',
      folders: ['areas/job', 'work'],
      updatedAt: 7,
    })
  })

  it('leaves the table alone when no file is newer', () => {
    const files = [ownershipFor(TABLE, REMOTES[1], 5)]
    assert.deepEqual(mergeOwnership(TABLE, 5, REMOTES, files), {
      kind: 'same',
    })
  })

  it('adopts a newer file', () => {
    const files = [
      { remote: 'GitHub', folders: ['areas/job', 'job'], updatedAt: 9 },
    ]
    const res = mergeOwnership(TABLE, 5, REMOTES, files)
    assert.equal(res.kind, 'adopt')
    if (res.kind !== 'adopt') return
    assert.equal(res.updatedAt, 9)
    assert.equal(routeOf(res.table, 'job/a.md'), 'github')
    // released, and claimed by no one: local only, never the default
    assert.equal(routeOf(res.table, 'work/a.md'), LOCAL_ONLY)
  })

  it('moves a folder another remote now claims', () => {
    const files = [
      { remote: 'GitHub', folders: ['areas/job'], updatedAt: 9 },
      { remote: 'Dropbox', folders: ['areas', 'work'], updatedAt: 9 },
    ]
    const res = mergeOwnership(TABLE, 5, REMOTES, files)
    assert.equal(res.kind, 'adopt')
    if (res.kind !== 'adopt') return
    assert.equal(routeOf(res.table, 'work/a.md'), 'dropbox')
  })

  it('stops on a folder two remotes claim', () => {
    const files = [
      { remote: 'GitHub', folders: ['work'], updatedAt: 9 },
      { remote: 'Dropbox', folders: ['work'], updatedAt: 9 },
    ]
    const res = mergeOwnership(TABLE, 5, REMOTES, files)
    assert.equal(res.kind, 'contradiction')
  })
})

describe('Routes: the hold rule', () => {
  const records = new Map([
    ['github', ['work/', 'work/a.md', 'areas/job/b.md']],
    ['dropbox', ['a.md', 'areas/', 'areas/c.md']],
  ])

  it('holds nothing when every routed folder is there', () => {
    const local = new Set(['areas', 'areas/job', 'work'])
    assert.deepEqual(heldQuestions(TABLE, local, records), [])
  })

  it('holds both runs when a routed folder is gone and a new one appeared', () => {
    const local = new Set(['areas', 'areas/job', 'job'])
    assert.deepEqual(heldQuestions(TABLE, local, records), [
      {
        gone: 'work',
        goneTarget: 'github',
        appeared: 'job',
        held: ['github', 'dropbox'],
      },
    ])
  })

  it('offers the new folder to the first question only', () => {
    // both github folders are gone, and one new folder appeared
    const local = new Set(['areas', 'new'])
    const res = heldQuestions(TABLE, local, records)
    assert.equal(res.length, 2)
    assert.equal(res[0].appeared, 'new')
    assert.deepEqual(res[0].held, ['github', 'dropbox'])
    assert.equal(res[1].appeared, undefined)
    assert.deepEqual(res[1].held, ['github'])
  })

  it("holds only the gone folder's run when nothing new appeared", () => {
    const local = new Set(['areas', 'areas/job'])
    assert.deepEqual(heldQuestions(TABLE, local, records), [
      { gone: 'work', goneTarget: 'github', held: ['github'] },
    ])
  })
})
