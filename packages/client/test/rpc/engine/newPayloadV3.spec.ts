import { BlockHeader } from '@ethereumjs/block'
import { FeeMarketEIP1559Transaction } from '@ethereumjs/tx'
import { Address, bytesToHex, hexToBytes, zeros } from '@ethereumjs/util'
import * as tape from 'tape'
import * as td from 'testdouble'

import { INVALID_PARAMS } from '../../../src/rpc/error-code'
import * as blocks from '../../testdata/blocks/beacon.json'
import * as genesisJSON from '../../testdata/geth-genesis/post-merge.json'
import { baseRequest, baseSetup, params, setupChain } from '../helpers'
import { checkError } from '../util'

import type { HttpServer } from 'jayson'
type Test = tape.Test

const method = 'engine_newPayloadV3'

const [blockData] = blocks

const originalValidate = (BlockHeader as any).prototype._consensusFormatValidation

export const batchBlocks = async (t: Test, server: HttpServer) => {
  for (let i = 0; i < 3; i++) {
    const req = params(method, [blocks[i]])
    const expectRes = (res: any) => {
      t.equal(res.body.result.status, 'VALID')
    }
    await baseRequest(t, server, req, 200, expectRes, false)
  }
}

tape(`${method}: call with executionPayloadV1`, (v1) => {
  v1.test(`${method}: call with invalid block hash without 0x`, async (t) => {
    const { server } = baseSetup({ engine: true, includeVM: true })

    const blockDataWithInvalidParentHash = [
      {
        ...blockData,
        parentHash: blockData.parentHash.slice(2),
      },
    ]

    const req = params(method, blockDataWithInvalidParentHash)
    const expectRes = checkError(
      t,
      INVALID_PARAMS,
      "invalid argument 0 for key 'parentHash': hex string without 0x prefix"
    )
    await baseRequest(t, server, req, 200, expectRes)
  })

  v1.test(`${method}: call with invalid hex string as block hash`, async (t) => {
    const { server } = baseSetup({ engine: true, includeVM: true })

    const blockDataWithInvalidBlockHash = [{ ...blockData, blockHash: '0x-invalid-block-hash' }]
    const req = params(method, blockDataWithInvalidBlockHash)
    const expectRes = checkError(
      t,
      INVALID_PARAMS,
      "invalid argument 0 for key 'blockHash': invalid block hash"
    )
    await baseRequest(t, server, req, 200, expectRes)
  })

  v1.test(`${method}: call with non existent block hash`, async (t) => {
    const { server } = await setupChain(genesisJSON, 'merge', { engine: true })

    const blockDataNonExistentBlockHash = [
      {
        ...blockData,
        blockHash: '0x2559e851470f6e7bbed1db474980683e8c315bfce99b2a6ef47c057c04de7858',
      },
    ]
    const req = params(method, blockDataNonExistentBlockHash)
    const expectRes = (res: any) => {
      t.equal(res.body.result.status, 'INVALID')
    }

    await baseRequest(t, server, req, 200, expectRes)
  })

  v1.test(`${method}: call with non existent parent hash`, async (t) => {
    const { server } = await setupChain(genesisJSON, 'post-merge', { engine: true })

    const blockDataNonExistentParentHash = [
      {
        ...blockData,
        parentHash: '0x2559e851470f6e7bbed1db474980683e8c315bfce99b2a6ef47c057c04de7858',
        blockHash: '0xf31969a769bfcdbcc1c05f2542fdc7aa9336fc1ea9a82c4925320c035095d649',
      },
    ]
    const req = params(method, blockDataNonExistentParentHash)
    const expectRes = (res: any) => {
      t.equal(res.body.result.status, 'ACCEPTED')
    }

    await baseRequest(t, server, req, 200, expectRes)
  })

  v1.test(
    `${method}: call with unknown parent hash to store in remoteBlocks, then call valid ancestor in fcU`,
    async (t) => {
      const { server } = await setupChain(genesisJSON, 'post-merge', { engine: true })

      let req = params(method, [blocks[1]])
      let expectRes = (res: any) => {
        t.equal(res.body.result.status, 'ACCEPTED')
      }
      await baseRequest(t, server, req, 200, expectRes, false)

      req = params(method, [blocks[0]])
      expectRes = (res: any) => {
        t.equal(res.body.result.status, 'VALID')
      }
      await baseRequest(t, server, req, 200, expectRes, false)

      const state = {
        headBlockHash: blocks[1].blockHash,
        safeBlockHash: blocks[1].blockHash,
        finalizedBlockHash: blocks[0].blockHash,
      }
      req = params('engine_forkchoiceUpdatedV1', [state])
      expectRes = (res: any) => {
        t.equal(res.body.result.payloadStatus.status, 'VALID')
      }

      await baseRequest(t, server, req, 200, expectRes)
    }
  )

  v1.test(`${method}: invalid terminal block`, async (t) => {
    const genesisWithHigherTtd = {
      ...genesisJSON,
      config: {
        ...genesisJSON.config,
        terminalTotalDifficulty: 17179869185,
      },
    }

    ;(BlockHeader as any).prototype._consensusFormatValidation = td.func<any>()
    td.replace<any>('@ethereumjs/block', { BlockHeader })

    const { server } = await setupChain(genesisWithHigherTtd, 'post-merge', {
      engine: true,
    })

    const req = params(method, [blockData, null])
    const expectRes = (res: any) => {
      t.equal(res.body.result.status, 'INVALID')
      t.equal(res.body.result.latestValidHash, bytesToHex(zeros(32)))
    }
    await baseRequest(t, server, req, 200, expectRes)
  })

  v1.test(`${method}: call with valid data`, async (t) => {
    const { server } = await setupChain(genesisJSON, 'post-merge', { engine: true })

    const req = params(method, [blockData])
    const expectRes = (res: any) => {
      t.equal(res.body.result.status, 'VALID')
      t.equal(res.body.result.latestValidHash, blockData.blockHash)
    }
    await baseRequest(t, server, req, 200, expectRes)
  })

  v1.test(`${method}: call with valid data but invalid transactions`, async (t) => {
    const { chain, server } = await setupChain(genesisJSON, 'post-merge', { engine: true })
    chain.config.logger.silent = true
    const blockDataWithInvalidTransaction = {
      ...blockData,
      transactions: ['0x1'],
    }
    const expectRes = (res: any) => {
      t.equal(res.body.result.status, 'INVALID')
      t.equal(res.body.result.latestValidHash, blockData.parentHash)
      const expectedError =
        'Invalid tx at index 0: Error: Invalid serialized tx input: must be array'
      t.ok(
        res.body.result.validationError.includes(expectedError),
        `should error with - ${expectedError}`
      )
    }

    const req = params(method, [blockDataWithInvalidTransaction])
    await baseRequest(t, server, req, 200, expectRes)
  })

  v1.test(`${method}: call with valid data & valid transaction but not signed`, async (t) => {
    const { server, common, chain } = await setupChain(genesisJSON, 'post-merge', { engine: true })
    chain.config.logger.silent = true

    // Let's mock a non-signed transaction so execution fails
    const tx = FeeMarketEIP1559Transaction.fromTxData(
      {
        gasLimit: 21_000,
        maxFeePerGas: 10,
        value: 1,
        to: Address.fromString('0x61FfE691821291D02E9Ba5D33098ADcee71a3a17'),
      },
      { common }
    )

    const transactions = [bytesToHex(tx.serialize())]
    const blockDataWithValidTransaction = {
      ...blockData,
      transactions,
      blockHash: '0x308f490332a31fade8b2b46a8e1132cd15adeaffbb651cb523c067b3f007dd9e',
    }
    const expectRes = (res: any) => {
      t.equal(res.body.result.status, 'INVALID')
      t.true(res.body.result.validationError.includes('Error verifying block while running:'))
    }

    const req = params(method, [blockDataWithValidTransaction])
    await baseRequest(t, server, req, 200, expectRes)
  })

  v1.test(`${method}: call with valid data & valid transaction`, async (t) => {
    const accountPk = hexToBytes(
      '0xe331b6d69882b4cb4ea581d88e0b604039a3de5967688d3dcffdd2270c0fd109'
    )
    const accountAddress = Address.fromPrivateKey(accountPk)
    const newGenesisJSON = {
      ...genesisJSON,
      alloc: {
        ...genesisJSON.alloc,
        [accountAddress.toString()]: {
          balance: '0x1000000',
        },
      },
    }

    const { server, common } = await setupChain(newGenesisJSON, 'post-merge', { engine: true })

    const tx = FeeMarketEIP1559Transaction.fromTxData(
      {
        maxFeePerGas: '0x7',
        value: 6,
        gasLimit: 53_000,
      },
      { common }
    ).sign(accountPk)
    const transactions = [bytesToHex(tx.serialize())]
    const blockDataWithValidTransaction = {
      ...blockData,
      transactions,
      parentHash: '0xefc1993f08864165c42195966b3f12794a1a42afa84b1047a46ab6b105828c5c',
      receiptsRoot: '0xc508745f9f8b6847a127bbc58b7c6b2c0f073c7ca778b6f020138f0d6d782adf',
      gasUsed: '0xcf08',
      stateRoot: '0x5a7123ab8bdd4f172438671a2a3de143f2105aa1ac3338c97e5f433e8e380d8d',
      blockHash: '0x625f2fd36bf278f92211376cbfe5acd7ac5da694e28f3d94d59488b7dbe213a4',
    }
    const expectRes = (res: any) => {
      t.equal(res.body.result.status, 'VALID')
    }
    const req = params(method, [blockDataWithValidTransaction])
    await baseRequest(t, server, req, 200, expectRes)
  })

  v1.test(`${method}: re-execute payload and verify that no errors occur`, async (t) => {
    const { server } = await setupChain(genesisJSON, 'post-merge', { engine: true })

    await batchBlocks(t, server)

    let req = params('engine_forkchoiceUpdatedV1', [
      {
        headBlockHash: blocks[2].blockHash,
        finalizedBlockHash: blocks[2].blockHash,
        safeBlockHash: blocks[2].blockHash,
      },
    ])

    // Let's set new head hash
    const expectResFcu = (res: any) => {
      t.equal(res.body.result.payloadStatus.status, 'VALID')
    }
    await baseRequest(t, server, req, 200, expectResFcu, false)

    // Now let's try to re-execute payload
    req = params(method, [blockData])

    const expectRes = (res: any) => {
      t.equal(res.body.result.status, 'VALID')
    }
    await baseRequest(t, server, req, 200, expectRes)
  })

  v1.test(`${method}: parent hash equals to block hash`, async (t) => {
    const { server } = await setupChain(genesisJSON, 'post-merge', { engine: true })
    const blockDataHasBlockHashSameAsParentHash = [
      {
        ...blockData,
        blockHash: blockData.parentHash,
      },
    ]
    const req = params(method, blockDataHasBlockHashSameAsParentHash)
    const expectRes = (res: any) => {
      t.equal(res.body.result.status, 'INVALID')
    }

    await baseRequest(t, server, req, 200, expectRes)
  })

  v1.test(`reset TD`, (t) => {
    ;(BlockHeader as any).prototype._consensusFormatValidation = originalValidate
    td.reset()
    t.end()
  })
  v1.end()
})

tape(`${method}: call with executionPayloadV2`, (v2) => {
  v2.pass('TODO: add tests for executionPayloadV2')
  v2.end()
  // TODO: add tests for executionPayloadV2
})
tape(`${method}: call with executionPayloadV3`, (v2) => {
  v2.pass('TODO: add tests for executionPayloadV2')
  v2.end()
  // TODO: add tests for executionPayloadV3
})
