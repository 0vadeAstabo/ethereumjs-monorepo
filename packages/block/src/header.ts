import { Chain, Common, ConsensusAlgorithm, ConsensusType, Hardfork } from '@ethereumjs/common'
import { RLP } from '@ethereumjs/rlp'
import {
  Address,
  KECCAK256_RLP,
  KECCAK256_RLP_ARRAY,
  TypeOutput,
  bigIntToBytes,
  bigIntToHex,
  bigIntToUnpaddedBytes,
  bytesToBigInt,
  bytesToHex,
  concatBytes,
  ecrecover,
  ecsign,
  equalsBytes,
  hexToBytes,
  toType,
  zeros,
} from '@ethereumjs/util'
import { keccak256 } from 'ethereum-cryptography/keccak.js'

import { CLIQUE_EXTRA_SEAL, CLIQUE_EXTRA_VANITY } from './clique.js'
import { fakeExponential, valuesArrayToHeaderData } from './helpers.js'

import type { BlockHeaderBytes, BlockOptions, HeaderData, JsonHeader } from './types.js'
import type { CliqueConfig } from '@ethereumjs/common'
import type { BigIntLike } from '@ethereumjs/util'

interface HeaderCache {
  hash: Uint8Array | undefined
}

const DEFAULT_GAS_LIMIT = BigInt('0xffffffffffffff')

/**
 * An object that represents the block header.
 */
export class BlockHeader {
  public readonly parentHash: Uint8Array
  public readonly uncleHash: Uint8Array
  public readonly coinbase: Address
  public readonly stateRoot: Uint8Array
  public readonly transactionsTrie: Uint8Array
  public readonly receiptTrie: Uint8Array
  public readonly logsBloom: Uint8Array
  public readonly difficulty: bigint
  public readonly number: bigint
  public readonly gasLimit: bigint
  public readonly gasUsed: bigint
  public readonly timestamp: bigint
  public readonly extraData: Uint8Array
  public readonly mixHash: Uint8Array
  public readonly nonce: Uint8Array
  public readonly baseFeePerGas?: bigint
  public readonly withdrawalsRoot?: Uint8Array
  public readonly dataGasUsed?: bigint
  public readonly excessDataGas?: bigint

  public readonly common: Common

  private cache: HeaderCache = {
    hash: undefined,
  }

  /**
   * EIP-4399: After merge to PoS, `mixHash` supplanted as `prevRandao`
   */
  get prevRandao() {
    if (this.common.isActivatedEIP(4399) === false) {
      const msg = this._errorMsg(
        'The prevRandao parameter can only be accessed when EIP-4399 is activated'
      )
      throw new Error(msg)
    }
    return this.mixHash
  }

  /**
   * Static constructor to create a block header from a header data dictionary
   *
   * @param headerData
   * @param opts
   */
  public static fromHeaderData(headerData: HeaderData = {}, opts: BlockOptions = {}) {
    return new BlockHeader(headerData, opts)
  }

  /**
   * Static constructor to create a block header from a RLP-serialized header
   *
   * @param serializedHeaderData
   * @param opts
   */
  public static fromRLPSerializedHeader(serializedHeaderData: Uint8Array, opts: BlockOptions = {}) {
    const values = RLP.decode(serializedHeaderData)
    if (!Array.isArray(values)) {
      throw new Error('Invalid serialized header input. Must be array')
    }
    return BlockHeader.fromValuesArray(values as Uint8Array[], opts)
  }

  /**
   * Static constructor to create a block header from an array of Bytes values
   *
   * @param values
   * @param opts
   */
  public static fromValuesArray(values: BlockHeaderBytes, opts: BlockOptions = {}) {
    const headerData = valuesArrayToHeaderData(values)
    const { number, baseFeePerGas, excessDataGas, dataGasUsed } = headerData
    const header = BlockHeader.fromHeaderData(headerData, opts)
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (header.common.isActivatedEIP(1559) && baseFeePerGas === undefined) {
      const eip1559ActivationBlock = bigIntToBytes(header.common.eipBlock(1559)!)
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
      if (eip1559ActivationBlock && equalsBytes(eip1559ActivationBlock, number as Uint8Array)) {
        throw new Error('invalid header. baseFeePerGas should be provided')
      }
    }
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (header.common.isActivatedEIP(4844)) {
      if (excessDataGas === undefined) {
        throw new Error('invalid header. excessDataGas should be provided')
      } else if (dataGasUsed === undefined) {
        throw new Error('invalid header. dataGasUsed should be provided')
      }
    }
    return header
  }
  /**
   * This constructor takes the values, validates them, assigns them and freezes the object.
   *
   * @deprecated Use the public static factory methods to assist in creating a Header object from
   * varying data types. For a default empty header, use {@link BlockHeader.fromHeaderData}.
   *
   */
  constructor(headerData: HeaderData, options: BlockOptions = {}) {
    if (options.common) {
      this.common = options.common.copy()
    } else {
      this.common = new Common({
        chain: Chain.Mainnet, // default
      })
    }

    const skipValidateConsensusFormat = options.skipConsensusFormatValidation ?? false

    const defaults = {
      parentHash: zeros(32),
      uncleHash: KECCAK256_RLP_ARRAY,
      coinbase: Address.zero(),
      stateRoot: zeros(32),
      transactionsTrie: KECCAK256_RLP,
      receiptTrie: KECCAK256_RLP,
      logsBloom: zeros(256),
      difficulty: BigInt(0),
      number: BigInt(0),
      gasLimit: DEFAULT_GAS_LIMIT,
      gasUsed: BigInt(0),
      timestamp: BigInt(0),
      extraData: new Uint8Array(0),
      mixHash: zeros(32),
      nonce: zeros(8),
    }

    const parentHash = toType(headerData.parentHash, TypeOutput.Uint8Array) ?? defaults.parentHash
    const uncleHash = toType(headerData.uncleHash, TypeOutput.Uint8Array) ?? defaults.uncleHash
    const coinbase = new Address(
      toType(headerData.coinbase ?? defaults.coinbase, TypeOutput.Uint8Array)
    )
    const stateRoot = toType(headerData.stateRoot, TypeOutput.Uint8Array) ?? defaults.stateRoot
    const transactionsTrie =
      toType(headerData.transactionsTrie, TypeOutput.Uint8Array) ?? defaults.transactionsTrie
    const receiptTrie =
      toType(headerData.receiptTrie, TypeOutput.Uint8Array) ?? defaults.receiptTrie
    const logsBloom = toType(headerData.logsBloom, TypeOutput.Uint8Array) ?? defaults.logsBloom
    const difficulty = toType(headerData.difficulty, TypeOutput.BigInt) ?? defaults.difficulty
    const number = toType(headerData.number, TypeOutput.BigInt) ?? defaults.number
    const gasLimit = toType(headerData.gasLimit, TypeOutput.BigInt) ?? defaults.gasLimit
    const gasUsed = toType(headerData.gasUsed, TypeOutput.BigInt) ?? defaults.gasUsed
    const timestamp = toType(headerData.timestamp, TypeOutput.BigInt) ?? defaults.timestamp
    const extraData = toType(headerData.extraData, TypeOutput.Uint8Array) ?? defaults.extraData
    const mixHash = toType(headerData.mixHash, TypeOutput.Uint8Array) ?? defaults.mixHash
    const nonce = toType(headerData.nonce, TypeOutput.Uint8Array) ?? defaults.nonce

    const setHardfork = options.setHardfork ?? false
    if (setHardfork === true) {
      this.common.setHardforkBy({
        blockNumber: number,
        timestamp,
      })
    } else if (typeof setHardfork !== 'boolean') {
      this.common.setHardforkBy({
        blockNumber: number,
        td: setHardfork as BigIntLike,
        timestamp,
      })
    }

    // Hardfork defaults which couldn't be paired with earlier defaults
    const hardforkDefaults = {
      baseFeePerGas: this.common.isActivatedEIP(1559)
        ? number === this.common.hardforkBlock(Hardfork.London)
          ? this.common.param('gasConfig', 'initialBaseFee')
          : BigInt(7)
        : undefined,
      withdrawalsRoot: this.common.isActivatedEIP(4895) ? KECCAK256_RLP : undefined,
      dataGasUsed: this.common.isActivatedEIP(4844) ? BigInt(0) : undefined,
      excessDataGas: this.common.isActivatedEIP(4844) ? BigInt(0) : undefined,
    }

    const baseFeePerGas =
      toType(headerData.baseFeePerGas, TypeOutput.BigInt) ?? hardforkDefaults.baseFeePerGas
    const withdrawalsRoot =
      toType(headerData.withdrawalsRoot, TypeOutput.Uint8Array) ?? hardforkDefaults.withdrawalsRoot
    const dataGasUsed =
      toType(headerData.dataGasUsed, TypeOutput.BigInt) ?? hardforkDefaults.dataGasUsed
    const excessDataGas =
      toType(headerData.excessDataGas, TypeOutput.BigInt) ?? hardforkDefaults.excessDataGas

    if (!this.common.isActivatedEIP(1559) && baseFeePerGas !== undefined) {
      throw new Error('A base fee for a block can only be set with EIP1559 being activated')
    }

    if (!this.common.isActivatedEIP(4895) && withdrawalsRoot !== undefined) {
      throw new Error(
        'A withdrawalsRoot for a header can only be provided with EIP4895 being activated'
      )
    }

    if (!this.common.isActivatedEIP(4844)) {
      if (headerData.dataGasUsed !== undefined) {
        throw new Error('data gas used can only be provided with EIP4844 activated')
      }

      if (headerData.excessDataGas !== undefined) {
        throw new Error('excess data gas can only be provided with EIP4844 activated')
      }
    }

    this.parentHash = parentHash
    this.uncleHash = uncleHash
    this.coinbase = coinbase
    this.stateRoot = stateRoot
    this.transactionsTrie = transactionsTrie
    this.receiptTrie = receiptTrie
    this.logsBloom = logsBloom
    this.difficulty = difficulty
    this.number = number
    this.gasLimit = gasLimit
    this.gasUsed = gasUsed
    this.timestamp = timestamp
    this.extraData = extraData
    this.mixHash = mixHash
    this.nonce = nonce
    this.baseFeePerGas = baseFeePerGas
    this.withdrawalsRoot = withdrawalsRoot
    this.dataGasUsed = dataGasUsed
    this.excessDataGas = excessDataGas
    this._genericFormatValidation()
    this._validateDAOExtraData()

    // Now we have set all the values of this Header, we possibly have set a dummy
    // `difficulty` value (defaults to 0). If we have a `calcDifficultyFromHeader`
    // block option parameter, we instead set difficulty to this value.
    if (
      options.calcDifficultyFromHeader &&
      this.common.consensusAlgorithm() === ConsensusAlgorithm.Ethash
    ) {
      this.difficulty = this.ethashCanonicalDifficulty(options.calcDifficultyFromHeader)
    }

    // If cliqueSigner is provided, seal block with provided privateKey.
    if (options.cliqueSigner) {
      // Ensure extraData is at least length CLIQUE_EXTRA_VANITY + CLIQUE_EXTRA_SEAL
      const minExtraDataLength = CLIQUE_EXTRA_VANITY + CLIQUE_EXTRA_SEAL
      if (this.extraData.length < minExtraDataLength) {
        const remainingLength = minExtraDataLength - this.extraData.length
        this.extraData = concatBytes(this.extraData, new Uint8Array(remainingLength))
      }

      this.extraData = this.cliqueSealBlock(options.cliqueSigner)
    }

    // Validate consensus format after block is sealed (if applicable) so extraData checks will pass
    if (skipValidateConsensusFormat === false) this._consensusFormatValidation()

    const freeze = options?.freeze ?? true
    if (freeze) {
      Object.freeze(this)
    }
  }

  /**
   * Validates correct buffer lengths, throws if invalid.
   */
  protected _genericFormatValidation() {
    const { parentHash, stateRoot, transactionsTrie, receiptTrie, mixHash, nonce } = this

    if (parentHash.length !== 32) {
      const msg = this._errorMsg(`parentHash must be 32 bytes, received ${parentHash.length} bytes`)
      throw new Error(msg)
    }
    if (stateRoot.length !== 32) {
      const msg = this._errorMsg(`stateRoot must be 32 bytes, received ${stateRoot.length} bytes`)
      throw new Error(msg)
    }
    if (transactionsTrie.length !== 32) {
      const msg = this._errorMsg(
        `transactionsTrie must be 32 bytes, received ${transactionsTrie.length} bytes`
      )
      throw new Error(msg)
    }
    if (receiptTrie.length !== 32) {
      const msg = this._errorMsg(
        `receiptTrie must be 32 bytes, received ${receiptTrie.length} bytes`
      )
      throw new Error(msg)
    }
    if (mixHash.length !== 32) {
      const msg = this._errorMsg(`mixHash must be 32 bytes, received ${mixHash.length} bytes`)
      throw new Error(msg)
    }

    if (nonce.length !== 8) {
      const msg = this._errorMsg(`nonce must be 8 bytes, received ${nonce.length} bytes`)
      throw new Error(msg)
    }

    // check if the block used too much gas
    if (this.gasUsed > this.gasLimit) {
      const msg = this._errorMsg('Invalid block: too much gas used')
      throw new Error(msg)
    }

    // Validation for EIP-1559 blocks
    if (this.common.isActivatedEIP(1559) === true) {
      if (typeof this.baseFeePerGas !== 'bigint') {
        const msg = this._errorMsg('EIP1559 block has no base fee field')
        throw new Error(msg)
      }
      const londonHfBlock = this.common.hardforkBlock(Hardfork.London)
      if (
        typeof londonHfBlock === 'bigint' &&
        londonHfBlock !== BigInt(0) &&
        this.number === londonHfBlock
      ) {
        const initialBaseFee = this.common.param('gasConfig', 'initialBaseFee')
        if (this.baseFeePerGas !== initialBaseFee) {
          const msg = this._errorMsg('Initial EIP1559 block does not have initial base fee')
          throw new Error(msg)
        }
      }
    }

    if (this.common.isActivatedEIP(4895) === true) {
      if (this.withdrawalsRoot === undefined) {
        const msg = this._errorMsg('EIP4895 block has no withdrawalsRoot field')
        throw new Error(msg)
      }
      if (this.withdrawalsRoot?.length !== 32) {
        const msg = this._errorMsg(
          `withdrawalsRoot must be 32 bytes, received ${this.withdrawalsRoot!.length} bytes`
        )
        throw new Error(msg)
      }
    }
  }

  /**
   * Checks static parameters related to consensus algorithm
   * @throws if any check fails
   */
  protected _consensusFormatValidation() {
    const { nonce, uncleHash, difficulty, extraData, number } = this
    const hardfork = this.common.hardfork()

    // Consensus type dependent checks
    if (this.common.consensusAlgorithm() === ConsensusAlgorithm.Ethash) {
      // PoW/Ethash
      if (
        number > BigInt(0) &&
        this.extraData.length > this.common.paramByHardfork('vm', 'maxExtraDataSize', hardfork)
      ) {
        // Check length of data on all post-genesis blocks
        const msg = this._errorMsg('invalid amount of extra data')
        throw new Error(msg)
      }
    }
    if (this.common.consensusAlgorithm() === ConsensusAlgorithm.Clique) {
      // PoA/Clique
      const minLength = CLIQUE_EXTRA_VANITY + CLIQUE_EXTRA_SEAL
      if (!this.cliqueIsEpochTransition()) {
        // ExtraData length on epoch transition
        if (this.extraData.length !== minLength) {
          const msg = this._errorMsg(
            `extraData must be ${minLength} bytes on non-epoch transition blocks, received ${this.extraData.length} bytes`
          )
          throw new Error(msg)
        }
      } else {
        const signerLength = this.extraData.length - minLength
        if (signerLength % 20 !== 0) {
          const msg = this._errorMsg(
            `invalid signer list length in extraData, received signer length of ${signerLength} (not divisible by 20)`
          )
          throw new Error(msg)
        }
        // coinbase (beneficiary) on epoch transition
        if (!this.coinbase.isZero()) {
          const msg = this._errorMsg(
            `coinbase must be filled with zeros on epoch transition blocks, received ${this.coinbase}`
          )
          throw new Error(msg)
        }
      }
      // MixHash format
      if (!equalsBytes(this.mixHash, new Uint8Array(32))) {
        const msg = this._errorMsg(`mixHash must be filled with zeros, received ${this.mixHash}`)
        throw new Error(msg)
      }
    }
    // Validation for PoS blocks (EIP-3675)
    if (this.common.consensusType() === ConsensusType.ProofOfStake) {
      let error = false
      let errorMsg = ''

      if (!equalsBytes(uncleHash, KECCAK256_RLP_ARRAY)) {
        errorMsg += `, uncleHash: ${bytesToHex(uncleHash)} (expected: ${bytesToHex(
          KECCAK256_RLP_ARRAY
        )})`
        error = true
      }
      if (number !== BigInt(0)) {
        // Skip difficulty, nonce, and extraData check for PoS genesis block as genesis block may have non-zero difficulty (if TD is > 0)
        if (difficulty !== BigInt(0)) {
          errorMsg += `, difficulty: ${difficulty} (expected: 0)`
          error = true
        }
        if (extraData.length > 32) {
          errorMsg += `, extraData: ${bytesToHex(
            extraData
          )} (cannot exceed 32 bytes length, received ${extraData.length} bytes)`
          error = true
        }
        if (!equalsBytes(nonce, zeros(8))) {
          errorMsg += `, nonce: ${bytesToHex(nonce)} (expected: ${bytesToHex(zeros(8))})`
          error = true
        }
      }
      if (error) {
        const msg = this._errorMsg(`Invalid PoS block: ${errorMsg}`)
        throw new Error(msg)
      }
    }
  }

  /**
   * Validates if the block gasLimit remains in the boundaries set by the protocol.
   * Throws if out of bounds.
   *
   * @param parentBlockHeader - the header from the parent `Block` of this header
   */
  validateGasLimit(parentBlockHeader: BlockHeader) {
    let parentGasLimit = parentBlockHeader.gasLimit
    // EIP-1559: assume double the parent gas limit on fork block
    // to adopt to the new gas target centered logic
    const londonHardforkBlock = this.common.hardforkBlock(Hardfork.London)
    if (
      typeof londonHardforkBlock === 'bigint' &&
      londonHardforkBlock !== BigInt(0) &&
      this.number === londonHardforkBlock
    ) {
      const elasticity = this.common.param('gasConfig', 'elasticityMultiplier')
      parentGasLimit = parentGasLimit * elasticity
    }
    const gasLimit = this.gasLimit
    const hardfork = this.common.hardfork()

    const a =
      parentGasLimit / this.common.paramByHardfork('gasConfig', 'gasLimitBoundDivisor', hardfork)
    const maxGasLimit = parentGasLimit + a
    const minGasLimit = parentGasLimit - a

    if (gasLimit >= maxGasLimit) {
      const msg = this._errorMsg('gas limit increased too much')
      throw new Error(msg)
    }

    if (gasLimit <= minGasLimit) {
      const msg = this._errorMsg('gas limit decreased too much')
      throw new Error(msg)
    }

    if (gasLimit < this.common.paramByHardfork('gasConfig', 'minGasLimit', hardfork)) {
      const msg = this._errorMsg(
        `gas limit decreased below minimum gas limit for hardfork=${hardfork}`
      )
      throw new Error(msg)
    }
  }

  /**
   * Calculates the base fee for a potential next block
   */
  public calcNextBaseFee(): bigint {
    if (this.common.isActivatedEIP(1559) === false) {
      const msg = this._errorMsg(
        'calcNextBaseFee() can only be called with EIP1559 being activated'
      )
      throw new Error(msg)
    }
    let nextBaseFee: bigint
    const elasticity = this.common.param('gasConfig', 'elasticityMultiplier')
    const parentGasTarget = this.gasLimit / elasticity

    if (parentGasTarget === this.gasUsed) {
      nextBaseFee = this.baseFeePerGas!
    } else if (this.gasUsed > parentGasTarget) {
      const gasUsedDelta = this.gasUsed - parentGasTarget
      const baseFeeMaxChangeDenominator = this.common.param(
        'gasConfig',
        'baseFeeMaxChangeDenominator'
      )

      const calculatedDelta =
        (this.baseFeePerGas! * gasUsedDelta) / parentGasTarget / baseFeeMaxChangeDenominator
      nextBaseFee =
        (calculatedDelta > BigInt(1) ? calculatedDelta : BigInt(1)) + this.baseFeePerGas!
    } else {
      const gasUsedDelta = parentGasTarget - this.gasUsed
      const baseFeeMaxChangeDenominator = this.common.param(
        'gasConfig',
        'baseFeeMaxChangeDenominator'
      )

      const calculatedDelta =
        (this.baseFeePerGas! * gasUsedDelta) / parentGasTarget / baseFeeMaxChangeDenominator
      nextBaseFee =
        this.baseFeePerGas! - calculatedDelta > BigInt(0)
          ? this.baseFeePerGas! - calculatedDelta
          : BigInt(0)
    }
    return nextBaseFee
  }

  /**
   * Returns the price per unit of data gas for a blob transaction in the current/pending block
   * @returns the price in gwei per unit of data gas spent
   */
  getDataGasPrice(): bigint {
    if (this.excessDataGas === undefined) {
      throw new Error('header must have excessDataGas field populated')
    }
    return fakeExponential(
      this.common.param('gasPrices', 'minDataGasPrice'),
      this.excessDataGas,
      this.common.param('gasConfig', 'dataGasPriceUpdateFraction')
    )
  }

  /**
   * Returns the total fee for data gas spent for including blobs in block.
   *
   * @param numBlobs number of blobs in the transaction/block
   * @returns the total data gas fee for numBlobs blobs
   */
  calcDataFee(numBlobs: number): bigint {
    const dataGasPerBlob = this.common.param('gasConfig', 'dataGasPerBlob')
    const dataGasUsed = dataGasPerBlob * BigInt(numBlobs)

    const dataGasPrice = this.getDataGasPrice()
    return dataGasUsed * dataGasPrice
  }

  /**
   * Calculates the excess data gas for next (hopefully) post EIP 4844 block.
   */
  public calcNextExcessDataGas(): bigint {
    // The validation of the fields and 4844 activation is already taken care in BlockHeader constructor
    const targetGasConsumed = (this.excessDataGas ?? BigInt(0)) + (this.dataGasUsed ?? BigInt(0))
    const targetDataGasPerBlock = this.common.param('gasConfig', 'targetDataGasPerBlock')

    if (targetGasConsumed <= targetDataGasPerBlock) {
      return BigInt(0)
    } else {
      return targetGasConsumed - targetDataGasPerBlock
    }
  }

  /**
   * Returns a Uint8Array Array of the raw Bytes in this header, in order.
   */
  raw(): BlockHeaderBytes {
    const rawItems = [
      this.parentHash,
      this.uncleHash,
      this.coinbase.bytes,
      this.stateRoot,
      this.transactionsTrie,
      this.receiptTrie,
      this.logsBloom,
      bigIntToUnpaddedBytes(this.difficulty),
      bigIntToUnpaddedBytes(this.number),
      bigIntToUnpaddedBytes(this.gasLimit),
      bigIntToUnpaddedBytes(this.gasUsed),
      bigIntToUnpaddedBytes(this.timestamp ?? BigInt(0)),
      this.extraData,
      this.mixHash,
      this.nonce,
    ]

    if (this.common.isActivatedEIP(1559) === true) {
      rawItems.push(bigIntToUnpaddedBytes(this.baseFeePerGas!))
    }

    if (this.common.isActivatedEIP(4895) === true) {
      rawItems.push(this.withdrawalsRoot!)
    }
    if (this.common.isActivatedEIP(4844) === true) {
      rawItems.push(bigIntToUnpaddedBytes(this.dataGasUsed!))
      rawItems.push(bigIntToUnpaddedBytes(this.excessDataGas!))
    }

    return rawItems
  }

  /**
   * Returns the hash of the block header.
   */
  hash(): Uint8Array {
    if (Object.isFrozen(this)) {
      if (!this.cache.hash) {
        this.cache.hash = keccak256(RLP.encode(this.raw()))
      }
      return this.cache.hash
    }

    return keccak256(RLP.encode(this.raw()))
  }

  /**
   * Checks if the block header is a genesis header.
   */
  isGenesis(): boolean {
    return this.number === BigInt(0)
  }

  protected _requireClique(name: string) {
    if (this.common.consensusAlgorithm() !== ConsensusAlgorithm.Clique) {
      const msg = this._errorMsg(
        `BlockHeader.${name}() call only supported for clique PoA networks`
      )
      throw new Error(msg)
    }
  }

  /**
   * Returns the canonical difficulty for this block.
   *
   * @param parentBlockHeader - the header from the parent `Block` of this header
   */
  ethashCanonicalDifficulty(parentBlockHeader: BlockHeader): bigint {
    if (this.common.consensusType() !== ConsensusType.ProofOfWork) {
      const msg = this._errorMsg('difficulty calculation is only supported on PoW chains')
      throw new Error(msg)
    }
    if (this.common.consensusAlgorithm() !== ConsensusAlgorithm.Ethash) {
      const msg = this._errorMsg(
        'difficulty calculation currently only supports the ethash algorithm'
      )
      throw new Error(msg)
    }
    const hardfork = this.common.hardfork()
    const blockTs = this.timestamp
    const { timestamp: parentTs, difficulty: parentDif } = parentBlockHeader
    const minimumDifficulty = this.common.paramByHardfork('pow', 'minimumDifficulty', hardfork)
    const offset =
      parentDif / this.common.paramByHardfork('pow', 'difficultyBoundDivisor', hardfork)
    let num = this.number

    // We use a ! here as TS cannot follow this hardfork-dependent logic, but it always gets assigned
    let dif!: bigint

    if (this.common.hardforkGteHardfork(hardfork, Hardfork.Byzantium) === true) {
      // max((2 if len(parent.uncles) else 1) - ((timestamp - parent.timestamp) // 9), -99) (EIP100)
      const uncleAddend = equalsBytes(parentBlockHeader.uncleHash, KECCAK256_RLP_ARRAY) ? 1 : 2
      let a = BigInt(uncleAddend) - (blockTs - parentTs) / BigInt(9)
      const cutoff = BigInt(-99)
      // MAX(cutoff, a)
      if (cutoff > a) {
        a = cutoff
      }
      dif = parentDif + offset * a
    }

    if (this.common.hardforkGteHardfork(hardfork, Hardfork.Byzantium) === true) {
      // Get delay as parameter from common
      num = num - this.common.param('pow', 'difficultyBombDelay')
      if (num < BigInt(0)) {
        num = BigInt(0)
      }
    } else if (this.common.hardforkGteHardfork(hardfork, Hardfork.Homestead) === true) {
      // 1 - (block_timestamp - parent_timestamp) // 10
      let a = BigInt(1) - (blockTs - parentTs) / BigInt(10)
      const cutoff = BigInt(-99)
      // MAX(cutoff, a)
      if (cutoff > a) {
        a = cutoff
      }
      dif = parentDif + offset * a
    } else {
      // pre-homestead
      if (parentTs + this.common.paramByHardfork('pow', 'durationLimit', hardfork) > blockTs) {
        dif = offset + parentDif
      } else {
        dif = parentDif - offset
      }
    }

    const exp = num / BigInt(100000) - BigInt(2)
    if (exp >= 0) {
      dif = dif + BigInt(2) ** exp
    }

    if (dif < minimumDifficulty) {
      dif = minimumDifficulty
    }

    return dif
  }

  /**
   * PoA clique signature hash without the seal.
   */
  cliqueSigHash() {
    this._requireClique('cliqueSigHash')
    const raw = this.raw()
    raw[12] = this.extraData.subarray(0, this.extraData.length - CLIQUE_EXTRA_SEAL)
    return keccak256(RLP.encode(raw))
  }

  /**
   * Checks if the block header is an epoch transition
   * header (only clique PoA, throws otherwise)
   */
  cliqueIsEpochTransition(): boolean {
    this._requireClique('cliqueIsEpochTransition')
    const epoch = BigInt((this.common.consensusConfig() as CliqueConfig).epoch)
    // Epoch transition block if the block number has no
    // remainder on the division by the epoch length
    return this.number % epoch === BigInt(0)
  }

  /**
   * Returns extra vanity data
   * (only clique PoA, throws otherwise)
   */
  cliqueExtraVanity(): Uint8Array {
    this._requireClique('cliqueExtraVanity')
    return this.extraData.subarray(0, CLIQUE_EXTRA_VANITY)
  }

  /**
   * Returns extra seal data
   * (only clique PoA, throws otherwise)
   */
  cliqueExtraSeal(): Uint8Array {
    this._requireClique('cliqueExtraSeal')
    return this.extraData.subarray(-CLIQUE_EXTRA_SEAL)
  }

  /**
   * Seal block with the provided signer.
   * Returns the final extraData field to be assigned to `this.extraData`.
   * @hidden
   */
  private cliqueSealBlock(privateKey: Uint8Array) {
    this._requireClique('cliqueSealBlock')

    const signature = ecsign(this.cliqueSigHash(), privateKey)
    const signatureB = concatBytes(
      signature.r,
      signature.s,
      bigIntToBytes(signature.v - BigInt(27))
    )

    const extraDataWithoutSeal = this.extraData.subarray(
      0,
      this.extraData.length - CLIQUE_EXTRA_SEAL
    )
    const extraData = concatBytes(extraDataWithoutSeal, signatureB)
    return extraData
  }

  /**
   * Returns a list of signers
   * (only clique PoA, throws otherwise)
   *
   * This function throws if not called on an epoch
   * transition block and should therefore be used
   * in conjunction with {@link BlockHeader.cliqueIsEpochTransition}
   */
  cliqueEpochTransitionSigners(): Address[] {
    this._requireClique('cliqueEpochTransitionSigners')
    if (!this.cliqueIsEpochTransition()) {
      const msg = this._errorMsg('Signers are only included in epoch transition blocks (clique)')
      throw new Error(msg)
    }

    const start = CLIQUE_EXTRA_VANITY
    const end = this.extraData.length - CLIQUE_EXTRA_SEAL
    const signerBytes = this.extraData.subarray(start, end)

    const signerList: Uint8Array[] = []
    const signerLength = 20
    for (let start = 0; start <= signerBytes.length - signerLength; start += signerLength) {
      signerList.push(signerBytes.subarray(start, start + signerLength))
    }
    return signerList.map((buf) => new Address(buf))
  }

  /**
   * Verifies the signature of the block (last 65 bytes of extraData field)
   * (only clique PoA, throws otherwise)
   *
   *  Method throws if signature is invalid
   */
  cliqueVerifySignature(signerList: Address[]): boolean {
    this._requireClique('cliqueVerifySignature')
    const signerAddress = this.cliqueSigner()
    const signerFound = signerList.find((signer) => {
      return signer.equals(signerAddress)
    })
    return !!signerFound
  }

  /**
   * Returns the signer address
   */
  cliqueSigner(): Address {
    this._requireClique('cliqueSigner')
    const extraSeal = this.cliqueExtraSeal()
    // Reasonable default for default blocks
    if (extraSeal.length === 0 || equalsBytes(extraSeal, new Uint8Array(65))) {
      return Address.zero()
    }
    const r = extraSeal.subarray(0, 32)
    const s = extraSeal.subarray(32, 64)
    const v = bytesToBigInt(extraSeal.subarray(64, 65)) + BigInt(27)
    const pubKey = ecrecover(this.cliqueSigHash(), v, r, s)
    return Address.fromPublicKey(pubKey)
  }

  /**
   * Returns the rlp encoding of the block header.
   */
  serialize(): Uint8Array {
    return RLP.encode(this.raw())
  }

  /**
   * Returns the block header in JSON format.
   */
  toJSON(): JsonHeader {
    const withdrawalAttr = this.withdrawalsRoot
      ? { withdrawalsRoot: bytesToHex(this.withdrawalsRoot) }
      : {}
    const jsonDict: JsonHeader = {
      parentHash: bytesToHex(this.parentHash),
      uncleHash: bytesToHex(this.uncleHash),
      coinbase: this.coinbase.toString(),
      stateRoot: bytesToHex(this.stateRoot),
      transactionsTrie: bytesToHex(this.transactionsTrie),
      ...withdrawalAttr,
      receiptTrie: bytesToHex(this.receiptTrie),
      logsBloom: bytesToHex(this.logsBloom),
      difficulty: bigIntToHex(this.difficulty),
      number: bigIntToHex(this.number),
      gasLimit: bigIntToHex(this.gasLimit),
      gasUsed: bigIntToHex(this.gasUsed),
      timestamp: bigIntToHex(this.timestamp),
      extraData: bytesToHex(this.extraData),
      mixHash: bytesToHex(this.mixHash),
      nonce: bytesToHex(this.nonce),
    }
    if (this.common.isActivatedEIP(1559) === true) {
      jsonDict.baseFeePerGas = bigIntToHex(this.baseFeePerGas!)
    }
    if (this.common.isActivatedEIP(4844) === true) {
      jsonDict.dataGasUsed = bigIntToHex(this.dataGasUsed!)
      jsonDict.excessDataGas = bigIntToHex(this.excessDataGas!)
    }
    return jsonDict
  }

  /**
   * Validates extra data is DAO_ExtraData for DAO_ForceExtraDataRange blocks after DAO
   * activation block (see: https://blog.slock.it/hard-fork-specification-24b889e70703)
   */
  protected _validateDAOExtraData() {
    if (this.common.hardforkIsActiveOnBlock(Hardfork.Dao, this.number) === false) {
      return
    }
    const DAOActivationBlock = this.common.hardforkBlock(Hardfork.Dao)
    if (DAOActivationBlock === null || this.number < DAOActivationBlock) {
      return
    }
    const DAO_ExtraData = hexToBytes('0x64616f2d686172642d666f726b')
    const DAO_ForceExtraDataRange = BigInt(9)
    const drift = this.number - DAOActivationBlock
    if (drift <= DAO_ForceExtraDataRange && !equalsBytes(this.extraData, DAO_ExtraData)) {
      const msg = this._errorMsg("extraData should be 'dao-hard-fork'")
      throw new Error(msg)
    }
  }

  /**
   * Return a compact error string representation of the object
   */
  public errorStr() {
    let hash = ''
    try {
      hash = bytesToHex(this.hash())
    } catch (e: any) {
      hash = 'error'
    }
    let hf = ''
    try {
      hf = this.common.hardfork()
    } catch (e: any) {
      hf = 'error'
    }
    let errorStr = `block header number=${this.number} hash=${hash} `
    errorStr += `hf=${hf} baseFeePerGas=${this.baseFeePerGas ?? 'none'}`
    return errorStr
  }

  /**
   * Helper function to create an annotated error message
   *
   * @param msg Base error message
   * @hidden
   */
  protected _errorMsg(msg: string) {
    return `${msg} (${this.errorStr()})`
  }
}
