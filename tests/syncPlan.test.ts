import { strict as assert } from 'assert'
import type {
  ConflictActionType,
  EmptyFolderCleanType,
  Entity,
  MixedEntity,
  RemotelySavePluginSettings,
  SyncDirectionType,
} from '../src/baseTypes'
import type { FakeFsEncrypt } from '../src/fsEncrypt'
import { ensembleMixedEnties, getSyncPlanInplace } from '../src/sync'

// The sync plan's decision for each file, pinned by its decision and branch,
// so any change to what the engine decides fails a test here.

const KEY = 'note.md'

const file = (
  key: string,
  mtimeCli: number,
  mtimeSvr: number,
  size: number,
): Entity => ({
  key,
  keyRaw: key,
  keyEnc: key,
  mtimeCli,
  mtimeSvr,
  size,
  sizeRaw: size,
  sizeEnc: size,
})

const folder = (key: string): Entity => ({
  key,
  keyRaw: key,
  keyEnc: key,
  size: 0,
  sizeRaw: 0,
  sizeEnc: 0,
})

// The previous sync record: the local mtime the file was synced at, the
// server's mtime, and the size.
const prev = file(KEY, 1_000_000, 2_000_000, 10)
// Unchanged since the previous sync.
const localSame = file(KEY, 1_000_000, 1_000_000, 10)
const remoteSame = file(KEY, 1_000_000, 2_000_000, 10)
// Created or modified since the previous sync; the remote one is newer.
const localNew = file(KEY, 5_000_000, 5_000_000, 12)
const remoteNew = file(KEY, 6_000_000, 7_000_000, 14)
// Newer than remoteNew, and larger than it.
const localNewest = file(KEY, 8_000_000, 8_000_000, 12)
const localLarger = file(KEY, 5_000_000, 5_000_000, 20)

// The engine formats times with Obsidian's window.moment.
const useFakeMoment = () => {
  ;(global as any).window = {
    moment: (time: number) => ({
      format: () => new Date(time).toISOString(),
      toISOString: () => new Date(time).toISOString(),
    }),
  }
}

const SETTINGS = {
  serviceType: 'dropbox',
  concurrency: 5,
  password: '',
  syncConfigDir: false,
  syncUnderscoreItems: false,
  skipSizeLargerThan: -1,
  protectModifyPercentage: 50,
} as unknown as RemotelySavePluginSettings

interface PlanOptions {
  direction?: SyncDirectionType
  conflict?: ConflictActionType
  limit?: number
  folders?: EmptyFolderCleanType
}

const plan = async (
  mappings: Record<string, MixedEntity>,
  opts: PlanOptions = {},
) =>
  await getSyncPlanInplace(
    mappings,
    opts.folders ?? 'skip',
    opts.limit ?? -1,
    opts.conflict ?? 'keep_newer',
    opts.direction ?? 'bidirectional',
    undefined,
    SETTINGS,
    'manual',
  )

const planOf = async (entries: MixedEntity[], opts: PlanOptions = {}) => {
  const mappings: Record<string, MixedEntity> = {}
  for (const entry of entries) {
    mappings[entry.key] = entry
  }
  return await plan(mappings, opts)
}

const decisionOf = (entry: MixedEntity) => ({
  decision: entry.decision,
  branch: entry.decisionBranch,
})

const decide = async (
  local: Entity | undefined,
  prevSync: Entity | undefined,
  remote: Entity | undefined,
  opts: PlanOptions = {},
) =>
  decisionOf((await planOf([{ key: KEY, local, prevSync, remote }], opts))[KEY])

// Builds the plan's entries the way a sync does: from the local, previous
// sync, and remote lists, with no password.
const noPassword = {
  encryptEntity: async (entity: Entity) => ({
    ...entity,
    keyEnc: entity.keyRaw,
    sizeEnc: entity.sizeRaw,
  }),
} as unknown as FakeFsEncrypt

const ensemble = async (
  locals: Entity[],
  prevSyncs: Entity[],
  remotes: Entity[],
  syncUnderscoreItems = false,
) =>
  await ensembleMixedEnties(
    locals,
    prevSyncs,
    remotes,
    false,
    '.obsidian',
    syncUnderscoreItems,
    [],
    noPassword,
    'dropbox',
    undefined,
  )

describe('Sync plan: one file, both ways', () => {
  beforeEach(useFakeMoment)

  it('does nothing when the file is unchanged on both sides', async () => {
    assert.deepEqual(await decide(localSame, prev, remoteSame), {
      decision: 'equal',
      branch: 2,
    })
  })

  it('does nothing when both sides still match the previous sync record', async () => {
    const remoteOtherClientTime = file(KEY, 3_000_000, 2_000_000, 10)
    assert.deepEqual(await decide(localSame, prev, remoteOtherClientTime), {
      decision: 'equal',
      branch: 21,
    })
  })

  it('pushes a file created on local', async () => {
    assert.deepEqual(await decide(localNew, undefined, undefined), {
      decision: 'local_is_created_then_push',
      branch: 6,
    })
  })

  it('pulls a file created on remote', async () => {
    assert.deepEqual(await decide(undefined, undefined, remoteNew), {
      decision: 'remote_is_created_then_pull',
      branch: 3,
    })
  })

  it('pushes a file modified on local', async () => {
    assert.deepEqual(await decide(localNew, prev, remoteSame), {
      decision: 'local_is_modified_then_push',
      branch: 10,
    })
  })

  it('pulls a file modified on remote', async () => {
    assert.deepEqual(await decide(localSame, prev, remoteNew), {
      decision: 'remote_is_modified_then_pull',
      branch: 9,
    })
  })

  it('deletes on remote a file deleted on local', async () => {
    assert.deepEqual(await decide(undefined, prev, remoteSame), {
      decision: 'local_is_deleted_thus_also_delete_remote',
      branch: 4,
    })
  })

  it('deletes on local a file deleted on remote', async () => {
    assert.deepEqual(await decide(localSame, prev, undefined), {
      decision: 'remote_is_deleted_thus_also_delete_local',
      branch: 7,
    })
  })

  it('pulls a file deleted on local but modified on remote', async () => {
    assert.deepEqual(await decide(undefined, prev, remoteNew), {
      decision: 'remote_is_modified_then_pull',
      branch: 5,
    })
  })

  it('pushes a file deleted on remote but modified on local', async () => {
    assert.deepEqual(await decide(localNew, prev, undefined), {
      decision: 'local_is_modified_then_push',
      branch: 8,
    })
  })

  it('only keeps history for a file deleted on both sides', async () => {
    assert.deepEqual(await decide(undefined, prev, undefined), {
      decision: 'only_history',
      branch: 1,
    })
  })
})

describe('Sync plan: conflicts', () => {
  beforeEach(useFakeMoment)

  it('keeps the newer remote file when both sides created it', async () => {
    assert.deepEqual(await decide(localNew, undefined, remoteNew), {
      decision: 'conflict_created_then_keep_remote',
      branch: 12,
    })
  })

  it('keeps the newer local file when both sides created it', async () => {
    assert.deepEqual(await decide(localNewest, undefined, remoteNew), {
      decision: 'conflict_created_then_keep_local',
      branch: 11,
    })
  })

  it('keeps the newer remote file when both sides modified it', async () => {
    assert.deepEqual(await decide(localNew, prev, remoteNew), {
      decision: 'conflict_modified_then_keep_remote',
      branch: 17,
    })
  })

  it('keeps the newer local file when both sides modified it', async () => {
    assert.deepEqual(await decide(localNewest, prev, remoteNew), {
      decision: 'conflict_modified_then_keep_local',
      branch: 16,
    })
  })

  it('keeps the larger remote file when both sides created it', async () => {
    assert.deepEqual(
      await decide(localNew, undefined, remoteNew, { conflict: 'keep_larger' }),
      { decision: 'conflict_created_then_keep_remote', branch: 14 },
    )
  })

  it('keeps the larger local file when both sides created it', async () => {
    assert.deepEqual(
      await decide(localLarger, undefined, remoteNew, {
        conflict: 'keep_larger',
      }),
      { decision: 'conflict_created_then_keep_local', branch: 13 },
    )
  })

  it('keeps the larger remote file when both sides modified it', async () => {
    assert.deepEqual(
      await decide(localNew, prev, remoteNew, { conflict: 'keep_larger' }),
      { decision: 'conflict_modified_then_keep_remote', branch: 19 },
    )
  })

  it('keeps the larger local file when both sides modified it', async () => {
    assert.deepEqual(
      await decide(localLarger, prev, remoteNew, { conflict: 'keep_larger' }),
      { decision: 'conflict_modified_then_keep_local', branch: 18 },
    )
  })

  it('leaves a smart conflict to run time when both sides created it', async () => {
    assert.deepEqual(
      await decide(localNew, undefined, remoteNew, { conflict: 'smart' }),
      { decision: 'conflict_created_then_smart_conflict', branch: 15 },
    )
  })

  it('leaves a smart conflict to run time when both sides modified it', async () => {
    assert.deepEqual(
      await decide(localNew, prev, remoteNew, { conflict: 'smart' }),
      { decision: 'conflict_modified_then_smart_conflict', branch: 20 },
    )
  })

  it('keeps one side in a one-way sync whatever the conflict choice', async () => {
    assert.deepEqual(
      await decide(localNew, prev, remoteNew, {
        conflict: 'smart',
        direction: 'incremental_pull_only',
      }),
      { decision: 'conflict_modified_then_keep_remote', branch: 24 },
    )
    assert.deepEqual(
      await decide(localNew, prev, remoteNew, {
        conflict: 'smart',
        direction: 'incremental_push_only',
      }),
      { decision: 'conflict_modified_then_keep_local', branch: 25 },
    )
  })
})

describe('Sync plan: the size limit', () => {
  beforeEach(useFakeMoment)

  // localSame and remoteSame are 10 bytes, localNew 12, remoteNew 14.
  const limit = 11

  it('skips a file created on local over the limit', async () => {
    assert.deepEqual(await decide(localNew, undefined, undefined, { limit }), {
      decision: 'local_is_created_too_large_then_do_nothing',
      branch: 37,
    })
  })

  it('skips a file created on remote over the limit', async () => {
    assert.deepEqual(await decide(undefined, undefined, remoteNew, { limit }), {
      decision: 'remote_is_created_too_large_then_do_nothing',
      branch: 36,
    })
  })

  it('stops the sync on a file modified on local over the limit', async () => {
    await assert.rejects(decide(localNew, prev, remoteSame, { limit }), {
      message: /branch 10/,
    })
  })

  it('stops the sync on a file modified on remote over the limit', async () => {
    await assert.rejects(decide(localSame, prev, remoteNew, { limit }), {
      message: /branch 9/,
    })
  })

  it('stops the sync on a file deleted on remote and modified on local over the limit', async () => {
    await assert.rejects(decide(localNew, prev, undefined, { limit }), {
      message: /branch 8/,
    })
  })

  it('stops the sync on a file deleted on local and modified on remote over the limit', async () => {
    await assert.rejects(decide(undefined, prev, remoteNew, { limit }), {
      message: /branch 5/,
    })
  })

  it('still resolves a conflict over the limit by the conflict setting', async () => {
    assert.deepEqual(await decide(localNew, prev, remoteNew, { limit }), {
      decision: 'conflict_modified_then_keep_remote',
      branch: 17,
    })
  })

  it('still deletes a file over the limit deleted on the other side', async () => {
    assert.deepEqual(await decide(undefined, prev, remoteSame, { limit: 5 }), {
      decision: 'local_is_deleted_thus_also_delete_remote',
      branch: 4,
    })
  })

  it('leaves an unchanged file over the limit alone', async () => {
    assert.deepEqual(await decide(localSame, prev, remoteSame, { limit: 5 }), {
      decision: 'equal',
      branch: 2,
    })
  })
})

describe('Sync plan: push only', () => {
  beforeEach(useFakeMoment)

  const opts: PlanOptions = { direction: 'incremental_push_only' }

  it('pushes a file created on local', async () => {
    assert.deepEqual(await decide(localNew, undefined, undefined, opts), {
      decision: 'local_is_created_then_push',
      branch: 6,
    })
  })

  it('pushes a file modified on local', async () => {
    assert.deepEqual(await decide(localNew, prev, remoteSame, opts), {
      decision: 'local_is_modified_then_push',
      branch: 10,
    })
  })

  it('does not pull a file created on remote', async () => {
    assert.deepEqual(await decide(undefined, undefined, remoteNew, opts), {
      decision: 'conflict_created_then_do_nothing',
      branch: 28,
    })
  })

  it('overwrites a file modified on remote with the local one', async () => {
    assert.deepEqual(await decide(localSame, prev, remoteNew, opts), {
      decision: 'conflict_modified_then_keep_local',
      branch: 26,
    })
  })

  it('does not delete on remote a file deleted on local', async () => {
    assert.deepEqual(await decide(undefined, prev, remoteSame, opts), {
      decision: 'conflict_created_then_do_nothing',
      branch: 29,
    })
  })

  it('does not pull a file deleted on local but modified on remote', async () => {
    assert.deepEqual(await decide(undefined, prev, remoteNew, opts), {
      decision: 'conflict_created_then_do_nothing',
      branch: 30,
    })
  })

  it('pushes again a file deleted on remote', async () => {
    assert.deepEqual(await decide(localSame, prev, undefined, opts), {
      decision: 'conflict_created_then_keep_local',
      branch: 32,
    })
  })

  it('keeps the local file when both sides created it', async () => {
    assert.deepEqual(await decide(localNew, undefined, remoteNew, opts), {
      decision: 'conflict_created_then_keep_local',
      branch: 23,
    })
  })

  it('keeps the local file when both sides modified it', async () => {
    assert.deepEqual(await decide(localNew, prev, remoteNew, opts), {
      decision: 'conflict_modified_then_keep_local',
      branch: 25,
    })
  })
})

describe('Sync plan: pull only', () => {
  beforeEach(useFakeMoment)

  const opts: PlanOptions = { direction: 'incremental_pull_only' }

  it('pulls a file created on remote', async () => {
    assert.deepEqual(await decide(undefined, undefined, remoteNew, opts), {
      decision: 'remote_is_created_then_pull',
      branch: 3,
    })
  })

  it('pulls a file modified on remote', async () => {
    assert.deepEqual(await decide(localSame, prev, remoteNew, opts), {
      decision: 'remote_is_modified_then_pull',
      branch: 9,
    })
  })

  it('does not push a file created on local', async () => {
    assert.deepEqual(await decide(localNew, undefined, undefined, opts), {
      decision: 'conflict_created_then_do_nothing',
      branch: 31,
    })
  })

  it('overwrites a file modified on local with the remote one', async () => {
    assert.deepEqual(await decide(localNew, prev, remoteSame, opts), {
      decision: 'conflict_modified_then_keep_remote',
      branch: 27,
    })
  })

  it('does not delete on local a file deleted on remote', async () => {
    assert.deepEqual(await decide(localSame, prev, undefined, opts), {
      decision: 'conflict_created_then_do_nothing',
      branch: 33,
    })
  })

  it('does not push a file deleted on remote but modified on local', async () => {
    assert.deepEqual(await decide(localNew, prev, undefined, opts), {
      decision: 'conflict_created_then_do_nothing',
      branch: 34,
    })
  })

  it('pulls again a file deleted on local', async () => {
    assert.deepEqual(await decide(undefined, prev, remoteSame, opts), {
      decision: 'conflict_created_then_keep_remote',
      branch: 35,
    })
  })

  it('keeps the remote file when both sides created it', async () => {
    assert.deepEqual(await decide(localNew, undefined, remoteNew, opts), {
      decision: 'conflict_created_then_keep_remote',
      branch: 22,
    })
  })

  it('keeps the remote file when both sides modified it', async () => {
    assert.deepEqual(await decide(localNew, prev, remoteNew, opts), {
      decision: 'conflict_modified_then_keep_remote',
      branch: 24,
    })
  })
})

describe('Sync plan: folders', () => {
  beforeEach(useFakeMoment)

  const DIR = 'dir/'
  const NOTE = 'dir/note.md'
  const inDir = (entity: Entity | undefined) =>
    entity === undefined
      ? undefined
      : { ...entity, key: NOTE, keyRaw: NOTE, keyEnc: NOTE }

  const planFolder = async (
    folderLocal: boolean,
    folderRemote: boolean,
    note: [Entity | undefined, Entity | undefined, Entity | undefined] | null,
    opts: PlanOptions = {},
  ) => {
    const entries: MixedEntity[] = [
      {
        key: DIR,
        local: folderLocal ? folder(DIR) : undefined,
        remote: folderRemote ? folder(DIR) : undefined,
      },
    ]
    if (note !== null) {
      entries.push({
        key: NOTE,
        local: inDir(note[0]),
        prevSync: inDir(note[1]),
        remote: inDir(note[2]),
      })
    }
    const result = await planOf(entries, opts)
    return {
      folder: decisionOf(result[DIR]),
      note: note === null ? undefined : decisionOf(result[NOTE]),
    }
  }

  it('skips an empty folder', async () => {
    assert.deepEqual((await planFolder(true, false, null)).folder, {
      decision: 'folder_to_skip',
      branch: 105,
    })
  })

  it('leaves a folder on both sides that holds a file', async () => {
    assert.deepEqual(
      (await planFolder(true, true, [localSame, prev, remoteSame])).folder,
      { decision: 'folder_existed_both_then_do_nothing', branch: 101 },
    )
  })

  it('creates on remote the folder of a file created on local', async () => {
    assert.deepEqual(
      await planFolder(true, false, [localNew, undefined, undefined]),
      {
        folder: {
          decision: 'folder_existed_local_then_also_create_remote',
          branch: 102,
        },
        note: { decision: 'local_is_created_then_push', branch: 6 },
      },
    )
  })

  it('creates on local the folder of a file created on remote', async () => {
    assert.deepEqual(
      await planFolder(false, true, [undefined, undefined, remoteNew]),
      {
        folder: {
          decision: 'folder_existed_remote_then_also_create_local',
          branch: 103,
        },
        note: { decision: 'remote_is_created_then_pull', branch: 3 },
      },
    )
  })

  it('does not create on local a remote folder when pushing only', async () => {
    assert.deepEqual(
      (
        await planFolder(false, true, [undefined, undefined, remoteNew], {
          direction: 'incremental_push_only',
        })
      ).folder,
      { decision: 'folder_to_skip', branch: 108 },
    )
  })

  it('does not create on remote a local folder when pulling only', async () => {
    assert.deepEqual(
      (
        await planFolder(true, false, [localNew, undefined, undefined], {
          direction: 'incremental_pull_only',
        })
      ).folder,
      { decision: 'folder_to_skip', branch: 107 },
    )
  })

  it('keeps a folder emptied by a deletion when empty folders are skipped', async () => {
    assert.deepEqual(
      await planFolder(true, true, [undefined, prev, remoteSame]),
      {
        folder: { decision: 'folder_to_skip', branch: 105 },
        note: {
          decision: 'local_is_deleted_thus_also_delete_remote',
          branch: 4,
        },
      },
    )
  })

  it('deletes on both sides a folder emptied by a deletion when cleaning', async () => {
    assert.deepEqual(
      (
        await planFolder(true, true, [undefined, prev, remoteSame], {
          folders: 'clean_both',
        })
      ).folder,
      { decision: 'folder_to_be_deleted_on_both', branch: 106 },
    )
  })

  it('deletes on local a folder emptied by a remote deletion when cleaning', async () => {
    assert.deepEqual(
      (
        await planFolder(true, false, [localSame, prev, undefined], {
          folders: 'clean_both',
        })
      ).folder,
      { decision: 'folder_to_be_deleted_on_local', branch: 110 },
    )
  })

  it('leaves an empty folder no deletion emptied when cleaning', async () => {
    assert.deepEqual(
      (await planFolder(true, true, null, { folders: 'clean_both' })).folder,
      { decision: 'folder_existed_both_then_do_nothing', branch: 115 },
    )
  })
})

describe('Sync plan: building the entries', () => {
  beforeEach(useFakeMoment)

  const other = file('other.md', 1_000_000, 1_000_000, 3)

  it('deletes on remote a file deleted on local when both sides hold files', async () => {
    const mappings = await ensemble([other], [prev], [remoteSame])
    assert.deepEqual(decisionOf((await plan(mappings))[KEY]), {
      decision: 'local_is_deleted_thus_also_delete_remote',
      branch: 4,
    })
  })

  it('ignores the previous sync records when local is empty, so nothing is deleted', async () => {
    const mappings = await ensemble([], [prev], [remoteSame])
    assert.equal(mappings[KEY].prevSync, undefined)
    assert.deepEqual(decisionOf((await plan(mappings))[KEY]), {
      decision: 'remote_is_created_then_pull',
      branch: 3,
    })
  })

  it('ignores the previous sync records when remote is empty, so nothing is deleted', async () => {
    const mappings = await ensemble([localSame], [prev], [])
    assert.equal(mappings[KEY].prevSync, undefined)
    assert.deepEqual(decisionOf((await plan(mappings))[KEY]), {
      decision: 'local_is_created_then_push',
      branch: 6,
    })
  })

  it('rounds times to the second for Dropbox before comparing', async () => {
    const localWithMillis = file(KEY, 1_000_400, 1_000_400, 10)
    const mappings = await ensemble([localWithMillis], [prev], [remoteSame])
    assert.deepEqual(decisionOf((await plan(mappings))[KEY]), {
      decision: 'equal',
      branch: 2,
    })
  })

  it('leaves hidden and underscore files out of the plan', async () => {
    const skipped = [
      file('.obsidian/app.json', 1_000_000, 1_000_000, 3),
      file('_private.md', 1_000_000, 1_000_000, 3),
    ]
    const mappings = await ensemble([other, ...skipped], [], skipped)
    assert.deepEqual(Object.keys(mappings), ['other.md'])
  })

  it("leaves upstream's metadata files out even when syncing underscore files", async () => {
    const underscored = file('_private.md', 1_000_000, 1_000_000, 3)
    const metadata = [
      file('_remotely-save-metadata-on-remote.json', 1_000_000, 1_000_000, 3),
      file('_remotely-save-metadata-on-remote.bin', 1_000_000, 1_000_000, 3),
    ]
    const mappings = await ensemble(
      [other, underscored],
      [],
      [underscored, ...metadata],
      true,
    )
    assert.deepEqual(Object.keys(mappings).sort(), ['_private.md', 'other.md'])
  })
})
