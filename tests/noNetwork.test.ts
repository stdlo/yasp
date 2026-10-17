import { strict as assert } from 'assert'

// No test may reach the network. Mocha loads every test file before it runs
// any test, so these stubs are in place for the whole suite: each attempt is
// recorded and throws, and the hook at the bottom fails the run if any
// attempt was made, even one the code under test caught.

const attempts: string[] = []

const blockedFetch = async (input: unknown) => {
  attempts.push(`fetch ${String(input)}`)
  throw new Error(`tests must not use the network: fetch ${String(input)}`)
}

class BlockedXMLHttpRequest {
  open(method: string, url: string) {
    attempts.push(`XMLHttpRequest ${method} ${url}`)
    throw new Error(`tests must not use the network: XMLHttpRequest ${url}`)
  }

  send() {
    attempts.push('XMLHttpRequest send')
    throw new Error('tests must not use the network: XMLHttpRequest send')
  }
}

globalThis.fetch = blockedFetch as typeof fetch
;(globalThis as any).XMLHttpRequest = BlockedXMLHttpRequest

describe('No network', () => {
  it('blocks fetch and XMLHttpRequest for the whole suite', () => {
    assert.equal(globalThis.fetch, blockedFetch)
    assert.equal((globalThis as any).XMLHttpRequest, BlockedXMLHttpRequest)
  })
})

// A root hook: it runs once, after every test in every file.
after('no test used the network', () => {
  assert.deepEqual(attempts, [])
})
