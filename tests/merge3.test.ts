import { strict as assert } from 'assert'
import { diffHunks, merge3, splitLines } from '../src/merge3'

describe('merge3: lines', () => {
  it('keeps each line ending with its line', () => {
    assert.deepEqual(splitLines('a\nb\r\nc'), ['a\n', 'b\r\n', 'c'])
    assert.deepEqual(splitLines(''), [])
    assert.deepEqual(splitLines('\n\n'), ['\n', '\n'])
  })

  it('finds the changed run of lines', () => {
    assert.deepEqual(
      diffHunks(splitLines('a\nb\nc\nd\n'), splitLines('a\nB\nX\nc\nd\n')),
      [{ baseStart: 1, baseEnd: 2, start: 1, end: 3 }],
    )
  })
})

describe('merge3: clean merges', () => {
  const base = 'one\ntwo\nthree\nfour\nfive\n'

  it('keeps edits to different lines from both sides', () => {
    assert.equal(
      merge3(
        base,
        'ONE\ntwo\nthree\nfour\nfive\n',
        'one\ntwo\nthree\nfour\nFIVE\n',
      ),
      'ONE\ntwo\nthree\nfour\nFIVE\n',
    )
  })

  it('keeps edits to adjacent lines from both sides', () => {
    assert.equal(
      merge3(
        base,
        'one\nTWO\nthree\nfour\nfive\n',
        'one\ntwo\nTHREE\nfour\nfive\n',
      ),
      'one\nTWO\nTHREE\nfour\nfive\n',
    )
  })

  it('takes the one side that changed', () => {
    const local = 'one\ntwo\n2.5\nthree\nfour\nfive\n'
    assert.equal(merge3(base, local, base), local)
    assert.equal(merge3(base, base, local), local)
  })

  it('keeps a deletion on one side and an edit on the other', () => {
    assert.equal(
      merge3(base, 'one\nthree\nfour\nfive\n', 'one\ntwo\nthree\nFOUR\nfive\n'),
      'one\nthree\nFOUR\nfive\n',
    )
  })

  it('takes the same edit made on both sides once', () => {
    const both = 'one\ntwo\nTHREE\nfour\nfive\n'
    assert.equal(merge3(base, both, both), both)
  })

  it('keeps additions at both ends', () => {
    assert.equal(
      merge3(base, `zero\n${base}`, `${base}six\n`),
      `zero\n${base}six\n`,
    )
    assert.equal(
      merge3(base, `${base}six\n`, `zero\n${base}`),
      `zero\n${base}six\n`,
    )
  })
})

describe('merge3: overlapping edits fail', () => {
  const base = 'one\ntwo\nthree\n'

  it('fails when both sides changed the same line differently', () => {
    assert.equal(
      merge3(base, 'one\nTWO\nthree\n', 'one\nDeux\nthree\n'),
      undefined,
    )
  })

  it('fails when one side deleted a line the other changed', () => {
    assert.equal(merge3(base, 'one\nthree\n', 'one\nTWO\nthree\n'), undefined)
  })

  it('fails when both sides added different lines at the same place', () => {
    assert.equal(merge3(base, `${base}four\n`, `${base}FOUR\n`), undefined)
  })

  it('fails when the changed runs overlap', () => {
    assert.equal(
      merge3('a\nb\nc\nd\n', 'A\nB\nc\nd\n', 'a\nB2\nC\nd\n'),
      undefined,
    )
  })
})

describe('merge3: line endings', () => {
  it('keeps \\r\\n as found', () => {
    assert.equal(
      merge3('a\r\nb\r\nc\r\n', 'A\r\nb\r\nc\r\n', 'a\r\nb\r\nC\r\n'),
      'A\r\nb\r\nC\r\n',
    )
  })

  it('keeps each side its own endings on the lines it changed', () => {
    assert.equal(merge3('a\nb\nc\n', 'A\r\nb\nc\n', 'a\nb\nC\n'), 'A\r\nb\nC\n')
  })

  it('treats a last line without an ending as its own line', () => {
    assert.equal(merge3('a\nb', 'A\nb', 'a\nb\nc'), 'A\nb\nc')
  })
})

describe('merge3: an empty base', () => {
  it('takes the one side that added text', () => {
    assert.equal(merge3('', 'new\nnote\n', ''), 'new\nnote\n')
    assert.equal(merge3('', '', 'new\nnote\n'), 'new\nnote\n')
  })

  it('takes the same text added on both sides once', () => {
    assert.equal(merge3('', 'same\n', 'same\n'), 'same\n')
  })

  it('fails when both sides added different text', () => {
    assert.equal(merge3('', 'mine\n', 'theirs\n'), undefined)
  })
})
