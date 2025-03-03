import { assert, describe, it } from 'vitest'

import {
  bytesToNibbles,
  compactBytesToNibbles,
  hexToBytes,
  nibblesToCompactBytes,
} from '../src/index.js'

describe('encoding', () => {
  it('nibblesToCompactBytes and compactBytesToNibbles should encode hex data correctly', () => {
    const tests = [
      { hex: new Uint8Array(), compact: hexToBytes('0x00') },
      { hex: new Uint8Array([16]), compact: hexToBytes('0x20') },
      {
        hex: new Uint8Array([1, 2, 3, 4, 5]),
        compact: hexToBytes('0x112345'),
      },
      {
        hex: new Uint8Array([0, 1, 2, 3, 4, 5]),
        compact: hexToBytes('0x00012345'),
      },
      {
        hex: new Uint8Array([15, 1, 12, 11, 8, 16]),
        compact: hexToBytes('0x3f1cb8'),
      },
      {
        hex: new Uint8Array([0, 15, 1, 12, 11, 8, 16]),
        compact: hexToBytes('0x200f1cb8'),
      },
    ]

    for (let i = 0; i < tests.length; i++) {
      const test = tests[i]
      assert.equal(JSON.stringify(nibblesToCompactBytes(test.hex)), JSON.stringify(test.compact))
      assert.equal(JSON.stringify(compactBytesToNibbles(test.compact)), JSON.stringify(test.hex))
    }
  })

  it('bytesToNibbles should encode data correctly', () => {
    const tests = [
      { key: new Uint8Array(), hexOut: new Uint8Array([16]) },
      { key: new Uint8Array(), hexOut: new Uint8Array([16]) },
      {
        key: hexToBytes('0x123456'),
        hexOut: new Uint8Array([1, 2, 3, 4, 5, 6, 16]),
      },
      {
        key: hexToBytes('0x123405'),
        hexOut: new Uint8Array([1, 2, 3, 4, 0, 5, 16]),
      },
      {
        key: hexToBytes('0x123456'),
        hexOut: new Uint8Array([1, 2, 3, 4, 5, 6, 16]),
      },
    ]

    for (let i = 0; i < tests.length; i++) {
      const test = tests[i]
      assert.equal(JSON.stringify(bytesToNibbles(test.key)), JSON.stringify(test.hexOut))
    }
  })
})
