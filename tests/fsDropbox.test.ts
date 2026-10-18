import { strict as assert } from 'assert'
import { DEFAULT_DROPBOX_CONFIG, FakeFsDropbox } from '../src/fsDropbox'

// Dropbox's file system with its client replaced: no request leaves the test.

class StubbedDropbox extends FakeFsDropbox {
  moves: { from_path: string; to_path: string }[] = []
  moveError: Error | undefined

  constructor() {
    super({ ...DEFAULT_DROPBOX_CONFIG }, 'vault', async () => {})
    this.dropbox = {
      filesMoveV2: async (arg: { from_path: string; to_path: string }) => {
        this.moves.push(arg)
        if (this.moveError !== undefined) {
          throw this.moveError
        }
        return { result: {} }
      },
    } as unknown as FakeFsDropbox['dropbox']
  }

  async _init() {
    return this
  }
}

describe('Dropbox: the folder move', () => {
  it('moves a folder', async () => {
    const fs = new StubbedDropbox()
    await fs.rename('work/', 'job/')
    assert.equal(fs.moves.length, 1)
  })

  it('rethrows a move that fails, so a caller keeps its rename pending', async () => {
    const fs = new StubbedDropbox()
    fs.moveError = new Error('to_path/conflict')
    await assert.rejects(fs.rename('work/', 'job/'), /to_path\/conflict/)
    assert.equal(fs.moves.length, 1)
  })
})
