import { strict as assert } from 'assert'

import type { RemotelySavePluginSettings } from '../src/baseTypes'
import { exportQrCodeUri, parseUriByHand } from '../src/importExport'

// What the QR code and the URI carry. Placeholder values only.

const settings = () =>
  ({
    serviceType: 'dropbox',
    password: '',
    concurrency: 3,
    dropbox: { accessToken: 'test-dropbox', refreshToken: 'test-refresh' },
    remotes: [
      { id: 'dropbox', name: 'Dropbox', type: 'dropbox', enabled: true },
      {
        id: 'gh',
        name: 'GitHub',
        type: 'github',
        enabled: true,
        github: {
          owner: 'o',
          repo: 'r',
          branch: 'main',
          token: 'test-token',
        },
        password: 'test-password',
      },
    ],
    routes: { routes: [{ folder: 'work', target: 'gh' }], defaultTarget: 'x' },
    routesUpdatedAt: 5,
    pendingRenames: [{ from: 'a', to: 'b', done: [] }],
    vaultRandomID: 'test-vault-id',
  }) as unknown as RemotelySavePluginSettings

const exported = async (kind: 'basic_and_advanced' | 'dropbox') => {
  const { rawUri } = await exportQrCodeUri(settings(), 'v', '0.6.0', kind)
  const data = JSON.parse(parseUriByHand(rawUri).data)
  return { data, text: JSON.stringify(data) }
}

describe('Import and export: the QR code', () => {
  it('leaves every credential and per-device key out of a basic export', async () => {
    const { data, text } = await exported('basic_and_advanced')
    for (const key of [
      'dropbox',
      'remotes',
      'routes',
      'routesUpdatedAt',
      'pendingRenames',
      'vaultRandomID',
    ]) {
      assert.equal(key in data, false, key)
    }
    assert.equal(text.includes('test-'), false)
    // the rest still goes
    assert.equal(data.concurrency, 3)
  })

  it('exports only the Dropbox credentials for a Dropbox export', async () => {
    const { data } = await exported('dropbox')
    assert.deepEqual(Object.keys(data), ['dropbox'])
  })
})
