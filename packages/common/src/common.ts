import {
  TypeOutput,
  bytesToHex,
  concatBytes,
  hexToBytes,
  intToBytes,
  toType,
} from '@ethereumjs/util'
import crc from 'crc/crc32'
import { EventEmitter } from 'events'

import * as goerli from './chains/goerli.json'
import * as mainnet from './chains/mainnet.json'
import * as sepolia from './chains/sepolia.json'
import { EIPs } from './eips/index.js'
import { Chain, CustomChain, Hardfork } from './enums.js'
import { hardforks as HARDFORK_SPECS } from './hardforks/index.js'
import { parseGethGenesis } from './utils.js'

import type { ConsensusAlgorithm, ConsensusType } from './enums.js'
import type {
  BootstrapNodeConfig,
  CasperConfig,
  ChainConfig,
  ChainName,
  ChainsConfig,
  CliqueConfig,
  CommonOpts,
  CustomCommonOpts,
  EthashConfig,
  GenesisBlockConfig,
  GethConfigOpts,
  HardforkByOpts,
  HardforkConfig,
} from './types.js'
import type { BigIntLike, PrefixedHexString } from '@ethereumjs/util'

type HardforkSpecKeys = keyof typeof HARDFORK_SPECS
type HardforkSpecValues = typeof HARDFORK_SPECS[HardforkSpecKeys]
/**
 * Common class to access chain and hardfork parameters and to provide
 * a unified and shared view on the network and hardfork state.
 *
 * Use the {@link Common.custom} static constructor for creating simple
 * custom chain {@link Common} objects (more complete custom chain setups
 * can be created via the main constructor and the {@link CommonOpts.customChains} parameter).
 */
export class Common {
  readonly DEFAULT_HARDFORK: string | Hardfork

  private _chainParams: ChainConfig
  private _hardfork: string | Hardfork
  private _eips: number[] = []
  private _customChains: ChainConfig[]

  private HARDFORK_CHANGES: [HardforkSpecKeys, HardforkSpecValues][]

  public events: EventEmitter

  /**
   * Creates a {@link Common} object for a custom chain, based on a standard one.
   *
   * It uses all the {@link Chain} parameters from the {@link baseChain} option except the ones overridden
   * in a provided {@link chainParamsOrName} dictionary. Some usage example:
   *
   * ```javascript
   * Common.custom({chainId: 123})
   * ```
   *
   * There are also selected supported custom chains which can be initialized by using one of the
   * {@link CustomChains} for {@link chainParamsOrName}, e.g.:
   *
   * ```javascript
   * Common.custom(CustomChains.MaticMumbai)
   * ```
   *
   * Note that these supported custom chains only provide some base parameters (usually the chain and
   * network ID and a name) and can only be used for selected use cases (e.g. sending a tx with
   * the `@ethereumjs/tx` library to a Layer-2 chain).
   *
   * @param chainParamsOrName Custom parameter dict (`name` will default to `custom-chain`) or string with name of a supported custom chain
   * @param opts Custom chain options to set the {@link CustomCommonOpts.baseChain}, selected {@link CustomCommonOpts.hardfork} and others
   */
  static custom(
    chainParamsOrName: Partial<ChainConfig> | CustomChain,
    opts: CustomCommonOpts = {}
  ): Common {
    const baseChain = opts.baseChain ?? 'mainnet'
    const standardChainParams = { ...Common._getChainParams(baseChain) }
    standardChainParams['name'] = 'custom-chain'

    if (typeof chainParamsOrName !== 'string') {
      return new Common({
        chain: {
          ...standardChainParams,
          ...chainParamsOrName,
        },
        ...opts,
      })
    } else {
      if (chainParamsOrName === CustomChain.PolygonMainnet) {
        return Common.custom(
          {
            name: CustomChain.PolygonMainnet,
            chainId: 137,
            networkId: 137,
          },
          opts
        )
      }
      if (chainParamsOrName === CustomChain.PolygonMumbai) {
        return Common.custom(
          {
            name: CustomChain.PolygonMumbai,
            chainId: 80001,
            networkId: 80001,
          },
          opts
        )
      }
      if (chainParamsOrName === CustomChain.ArbitrumOne) {
        return Common.custom(
          {
            name: CustomChain.ArbitrumOne,
            chainId: 42161,
            networkId: 42161,
          },
          opts
        )
      }
      if (chainParamsOrName === CustomChain.xDaiChain) {
        return Common.custom(
          {
            name: CustomChain.xDaiChain,
            chainId: 100,
            networkId: 100,
          },
          opts
        )
      }

      if (chainParamsOrName === CustomChain.OptimisticKovan) {
        return Common.custom(
          {
            name: CustomChain.OptimisticKovan,
            chainId: 69,
            networkId: 69,
          },
          // Optimism has not implemented the London hardfork yet (targeting Q1.22)
          { hardfork: Hardfork.Berlin, ...opts }
        )
      }

      if (chainParamsOrName === CustomChain.OptimisticEthereum) {
        return Common.custom(
          {
            name: CustomChain.OptimisticEthereum,
            chainId: 10,
            networkId: 10,
          },
          // Optimism has not implemented the London hardfork yet (targeting Q1.22)
          { hardfork: Hardfork.Berlin, ...opts }
        )
      }
      throw new Error(`Custom chain ${chainParamsOrName} not supported`)
    }
  }

  /**
   * Static method to load and set common from a geth genesis json
   * @param genesisJson json of geth configuration
   * @param { chain, eips, genesisHash, hardfork, mergeForkIdPostMerge } to further configure the common instance
   * @returns Common
   */
  static fromGethGenesis(
    genesisJson: any,
    { chain, eips, genesisHash, hardfork, mergeForkIdPostMerge }: GethConfigOpts
  ): Common {
    const genesisParams = parseGethGenesis(genesisJson, chain, mergeForkIdPostMerge)
    const common = new Common({
      chain: genesisParams.name ?? 'custom',
      customChains: [genesisParams],
      eips,
      hardfork: hardfork ?? genesisParams.hardfork,
    })
    if (genesisHash !== undefined) {
      common.setForkHashes(genesisHash)
    }
    return common
  }

  /**
   * Static method to determine if a {@link chainId} is supported as a standard chain
   * @param chainId bigint id (`1`) of a standard chain
   * @returns boolean
   */
  static isSupportedChainId(chainId: bigint): boolean {
    const initializedChains = this.getInitializedChains()
    return Boolean((initializedChains['names'] as ChainName)[chainId.toString()])
  }

  private static _getChainParams(
    chain: string | number | Chain | bigint,
    customChains?: ChainConfig[]
  ): ChainConfig {
    const initializedChains = this.getInitializedChains(customChains)
    if (typeof chain === 'number' || typeof chain === 'bigint') {
      chain = chain.toString()

      if ((initializedChains['names'] as ChainName)[chain]) {
        const name: string = (initializedChains['names'] as ChainName)[chain]
        return initializedChains[name] as ChainConfig
      }

      throw new Error(`Chain with ID ${chain} not supported`)
    }

    if (initializedChains[chain] !== undefined) {
      return initializedChains[chain] as ChainConfig
    }

    throw new Error(`Chain with name ${chain} not supported`)
  }

  constructor(opts: CommonOpts) {
    this.events = new EventEmitter()

    this._customChains = opts.customChains ?? []
    this._chainParams = this.setChain(opts.chain)
    this.DEFAULT_HARDFORK = this._chainParams.defaultHardfork ?? Hardfork.Shanghai
    // Assign hardfork changes in the sequence of the applied hardforks
    this.HARDFORK_CHANGES = this.hardforks().map((hf) => [
      hf.name as HardforkSpecKeys,
      HARDFORK_SPECS[hf.name as HardforkSpecKeys],
    ])
    this._hardfork = this.DEFAULT_HARDFORK
    if (opts.hardfork !== undefined) {
      this.setHardfork(opts.hardfork)
    }
    if (opts.eips) {
      this.setEIPs(opts.eips)
    }
  }

  /**
   * Sets the chain
   * @param chain String ('mainnet') or Number (1) chain representation.
   *              Or, a Dictionary of chain parameters for a private network.
   * @returns The dictionary with parameters set as chain
   */
  setChain(chain: string | number | Chain | bigint | object): ChainConfig {
    if (typeof chain === 'number' || typeof chain === 'bigint' || typeof chain === 'string') {
      this._chainParams = Common._getChainParams(chain, this._customChains)
    } else if (typeof chain === 'object') {
      if (this._customChains.length > 0) {
        throw new Error(
          'Chain must be a string, number, or bigint when initialized with customChains passed in'
        )
      }
      const required = ['networkId', 'genesis', 'hardforks', 'bootstrapNodes']
      for (const param of required) {
        if (!(param in chain)) {
          throw new Error(`Missing required chain parameter: ${param}`)
        }
      }
      this._chainParams = chain as ChainConfig
    } else {
      throw new Error('Wrong input format')
    }
    for (const hf of this.hardforks()) {
      if (hf.block === undefined) {
        throw new Error(`Hardfork cannot have undefined block number`)
      }
    }
    return this._chainParams
  }

  /**
   * Sets the hardfork to get params for
   * @param hardfork String identifier (e.g. 'byzantium') or {@link Hardfork} enum
   */
  setHardfork(hardfork: string | Hardfork): void {
    let existing = false
    for (const hfChanges of this.HARDFORK_CHANGES) {
      if (hfChanges[0] === hardfork) {
        if (this._hardfork !== hardfork) {
          this._hardfork = hardfork
          this.events.emit('hardforkChanged', hardfork)
        }
        existing = true
      }
    }
    if (!existing) {
      throw new Error(`Hardfork with name ${hardfork} not supported`)
    }
  }

  /**
   * Returns the hardfork either based on block numer (older HFs) or
   * timestamp (Shanghai upwards).
   *
   * An optional TD takes precedence in case the corresponding HF block
   * is set to `null` or otherwise needs to match (if not an error
   * will be thrown).
   *
   * @param Opts Block number, timestamp or TD (all optional)
   * @returns The name of the HF
   */
  getHardforkBy(opts: HardforkByOpts): string {
    let { blockNumber, timestamp, td } = opts

    blockNumber = toType(blockNumber, TypeOutput.BigInt)
    td = toType(td, TypeOutput.BigInt)
    timestamp = toType(timestamp, TypeOutput.BigInt)

    // Filter out hardforks with no block number, no ttd or no timestamp (i.e. unapplied hardforks)
    const hfs = this.hardforks().filter(
      (hf) =>
        hf.block !== null || (hf.ttd !== null && hf.ttd !== undefined) || hf.timestamp !== undefined
    )
    const mergeIndex = hfs.findIndex((hf) => hf.ttd !== null && hf.ttd !== undefined)
    const doubleTTDHF = hfs
      .slice(mergeIndex + 1)
      .findIndex((hf) => hf.ttd !== null && hf.ttd !== undefined)
    if (doubleTTDHF >= 0) {
      throw Error(`More than one merge hardforks found with ttd specified`)
    }

    // Find the first hardfork that has a block number greater than `blockNumber`
    // (skips the merge hardfork since it cannot have a block number specified).
    // If timestamp is not provided, it also skips timestamps hardforks to continue
    // discovering/checking number hardforks.
    let hfIndex = hfs.findIndex(
      (hf) =>
        (blockNumber !== undefined &&
          hf.block !== null &&
          BigInt(hf.block) > (blockNumber as bigint)) ||
        (timestamp !== undefined && hf.timestamp !== undefined && hf.timestamp > timestamp)
    )

    if (hfIndex === -1) {
      // all hardforks apply, set hfIndex to the last one as that's the candidate
      hfIndex = hfs.length
    } else if (hfIndex === 0) {
      // cannot have a case where a block number is before all applied hardforks
      // since the chain has to start with a hardfork
      throw Error('Must have at least one hardfork at block 0')
    }

    // If timestamp is not provided, we need to rollback to the last hf with block or ttd
    if (timestamp === undefined) {
      const stepBack = hfs
        .slice(0, hfIndex)
        .reverse()
        .findIndex((hf) => hf.block !== null || hf.ttd !== undefined)
      hfIndex = hfIndex - stepBack
    }
    // Move hfIndex one back to arrive at candidate hardfork
    hfIndex = hfIndex - 1

    // If the timestamp was not provided, we could have skipped timestamp hardforks to look for number
    // hardforks. so it will now be needed to rollback
    if (hfs[hfIndex].block === null && hfs[hfIndex].timestamp === undefined) {
      // We're on the merge hardfork.  Let's check the TTD
      if (td === undefined || td === null || BigInt(hfs[hfIndex].ttd!) > td) {
        // Merge ttd greater than current td so we're on hardfork before merge
        hfIndex -= 1
      }
    } else {
      if (mergeIndex >= 0 && td !== undefined && td !== null) {
        if (hfIndex >= mergeIndex && BigInt(hfs[mergeIndex].ttd!) > td) {
          throw Error('Maximum HF determined by total difficulty is lower than the block number HF')
        } else if (hfIndex < mergeIndex && BigInt(hfs[mergeIndex].ttd!) <= td) {
          throw Error('HF determined by block number is lower than the minimum total difficulty HF')
        }
      }
    }

    const hfStartIndex = hfIndex
    // Move the hfIndex to the end of the hardforks that might be scheduled on the same block/timestamp
    // This won't anyway be the case with Merge hfs
    for (; hfIndex < hfs.length - 1; hfIndex++) {
      // break out if hfIndex + 1 is not scheduled at hfIndex
      if (
        hfs[hfIndex].block !== hfs[hfIndex + 1].block ||
        hfs[hfIndex].timestamp !== hfs[hfIndex + 1].timestamp
      ) {
        break
      }
    }

    if (timestamp !== undefined) {
      const minTimeStamp = hfs
        .slice(0, hfStartIndex)
        .reduce((acc: number, hf: HardforkConfig) => Math.max(Number(hf.timestamp ?? '0'), acc), 0)
      if (minTimeStamp > timestamp) {
        throw Error(`Maximum HF determined by timestamp is lower than the block number/ttd HF`)
      }

      const maxTimeStamp = hfs
        .slice(hfIndex + 1)
        .reduce(
          (acc: number, hf: HardforkConfig) => Math.min(Number(hf.timestamp ?? timestamp), acc),
          Number(timestamp)
        )
      if (maxTimeStamp < timestamp) {
        throw Error(`Maximum HF determined by block number/ttd is lower than timestamp HF`)
      }
    }
    const hardfork = hfs[hfIndex]
    return hardfork.name
  }

  /**
   * Sets a new hardfork either based on block numer (older HFs) or
   * timestamp (Shanghai upwards).
   *
   * An optional TD takes precedence in case the corresponding HF block
   * is set to `null` or otherwise needs to match (if not an error
   * will be thrown).
   *
   * @param Opts Block number, timestamp or TD (all optional)
   * @returns The name of the HF set
   */
  setHardforkBy(opts: HardforkByOpts): string {
    const hardfork = this.getHardforkBy(opts)
    this.setHardfork(hardfork)
    return hardfork
  }

  /**
   * Internal helper function, returns the params for the given hardfork for the chain set
   * @param hardfork Hardfork name
   * @returns Dictionary with hardfork params or null if hardfork not on chain
   */
  private _getHardfork(hardfork: string | Hardfork): HardforkConfig | null {
    const hfs = this.hardforks()
    for (const hf of hfs) {
      if (hf['name'] === hardfork) return hf
    }
    return null
  }

  /**
   * Sets the active EIPs
   * @param eips
   */
  setEIPs(eips: number[] = []) {
    for (const eip of eips) {
      if (!(eip in EIPs)) {
        throw new Error(`${eip} not supported`)
      }
      const minHF = this.gteHardfork(EIPs[eip]['minimumHardfork'])
      if (!minHF) {
        throw new Error(
          `${eip} cannot be activated on hardfork ${this.hardfork()}, minimumHardfork: ${minHF}`
        )
      }
      if (EIPs[eip].requiredEIPs !== undefined) {
        for (const elem of EIPs[eip].requiredEIPs) {
          if (!(eips.includes(elem) || this.isActivatedEIP(elem))) {
            throw new Error(`${eip} requires EIP ${elem}, but is not included in the EIP list`)
          }
        }
      }
    }
    this._eips = eips
  }

  /**
   * Returns a parameter for the current chain setup
   *
   * If the parameter is present in an EIP, the EIP always takes precedence.
   * Otherwise the parameter if taken from the latest applied HF with
   * a change on the respective parameter.
   *
   * @param topic Parameter topic ('gasConfig', 'gasPrices', 'vm', 'pow')
   * @param name Parameter name (e.g. 'minGasLimit' for 'gasConfig' topic)
   * @returns The value requested or `BigInt(0)` if not found
   */
  param(topic: string, name: string): bigint {
    // TODO: consider the case that different active EIPs
    // can change the same parameter
    let value
    for (const eip of this._eips) {
      value = this.paramByEIP(topic, name, eip)
      if (value !== undefined) return value
    }
    return this.paramByHardfork(topic, name, this._hardfork)
  }

  /**
   * Returns the parameter corresponding to a hardfork
   * @param topic Parameter topic ('gasConfig', 'gasPrices', 'vm', 'pow')
   * @param name Parameter name (e.g. 'minGasLimit' for 'gasConfig' topic)
   * @param hardfork Hardfork name
   * @returns The value requested or `BigInt(0)` if not found
   */
  paramByHardfork(topic: string, name: string, hardfork: string | Hardfork): bigint {
    let value = null
    for (const hfChanges of this.HARDFORK_CHANGES) {
      // EIP-referencing HF file (e.g. berlin.json)
      if ('eips' in hfChanges[1]) {
        const hfEIPs = hfChanges[1]['eips']
        for (const eip of hfEIPs) {
          const valueEIP = this.paramByEIP(topic, name, eip)
          value = typeof valueEIP === 'bigint' ? valueEIP : value
        }
        // Parameter-inlining HF file (e.g. istanbul.json)
      } else {
        if ((hfChanges[1] as any)[topic] === undefined) {
          throw new Error(`Topic ${topic} not defined`)
        }
        if ((hfChanges[1] as any)[topic][name] !== undefined) {
          value = (hfChanges[1] as any)[topic][name].v
        }
      }
      if (hfChanges[0] === hardfork) break
    }
    return BigInt(value ?? 0)
  }

  /**
   * Returns a parameter corresponding to an EIP
   * @param topic Parameter topic ('gasConfig', 'gasPrices', 'vm', 'pow')
   * @param name Parameter name (e.g. 'minGasLimit' for 'gasConfig' topic)
   * @param eip Number of the EIP
   * @returns The value requested or `undefined` if not found
   */
  paramByEIP(topic: string, name: string, eip: number): bigint | undefined {
    if (!(eip in EIPs)) {
      throw new Error(`${eip} not supported`)
    }

    const eipParams = EIPs[eip]
    if (!(topic in eipParams)) {
      throw new Error(`Topic ${topic} not defined`)
    }
    if (eipParams[topic][name] === undefined) {
      return undefined
    }
    const value = eipParams[topic][name].v
    return BigInt(value)
  }

  /**
   * Returns a parameter for the hardfork active on block number or
   * optional provided total difficulty (Merge HF)
   * @param topic Parameter topic
   * @param name Parameter name
   * @param blockNumber Block number
   * @param td Total difficulty
   *    * @returns The value requested or `BigInt(0)` if not found
   */
  paramByBlock(
    topic: string,
    name: string,
    blockNumber: BigIntLike,
    td?: BigIntLike,
    timestamp?: BigIntLike
  ): bigint {
    const hardfork = this.getHardforkBy({ blockNumber, td, timestamp })
    return this.paramByHardfork(topic, name, hardfork)
  }

  /**
   * Checks if an EIP is activated by either being included in the EIPs
   * manually passed in with the {@link CommonOpts.eips} or in a
   * hardfork currently being active
   *
   * Note: this method only works for EIPs being supported
   * by the {@link CommonOpts.eips} constructor option
   * @param eip
   */
  isActivatedEIP(eip: number): boolean {
    if (this.eips().includes(eip)) {
      return true
    }
    for (const hfChanges of this.HARDFORK_CHANGES) {
      const hf = hfChanges[1]
      if (this.gteHardfork(hf['name']) && 'eips' in hf) {
        if ((hf['eips'] as number[]).includes(eip)) {
          return true
        }
      }
    }
    return false
  }

  /**
   * Checks if set or provided hardfork is active on block number
   * @param hardfork Hardfork name or null (for HF set)
   * @param blockNumber
   * @returns True if HF is active on block number
   */
  hardforkIsActiveOnBlock(hardfork: string | Hardfork | null, blockNumber: BigIntLike): boolean {
    blockNumber = toType(blockNumber, TypeOutput.BigInt)
    hardfork = hardfork ?? this._hardfork
    const hfBlock = this.hardforkBlock(hardfork)
    if (typeof hfBlock === 'bigint' && hfBlock !== BigInt(0) && blockNumber >= hfBlock) {
      return true
    }
    return false
  }

  /**
   * Alias to hardforkIsActiveOnBlock when hardfork is set
   * @param blockNumber
   * @returns True if HF is active on block number
   */
  activeOnBlock(blockNumber: BigIntLike): boolean {
    return this.hardforkIsActiveOnBlock(null, blockNumber)
  }

  /**
   * Sequence based check if given or set HF1 is greater than or equal HF2
   * @param hardfork1 Hardfork name or null (if set)
   * @param hardfork2 Hardfork name
   * @param opts Hardfork options
   * @returns True if HF1 gte HF2
   */
  hardforkGteHardfork(hardfork1: string | Hardfork | null, hardfork2: string | Hardfork): boolean {
    hardfork1 = hardfork1 ?? this._hardfork
    const hardforks = this.hardforks()

    let posHf1 = -1,
      posHf2 = -1
    let index = 0
    for (const hf of hardforks) {
      if (hf['name'] === hardfork1) posHf1 = index
      if (hf['name'] === hardfork2) posHf2 = index
      index += 1
    }
    return posHf1 >= posHf2 && posHf2 !== -1
  }

  /**
   * Alias to hardforkGteHardfork when hardfork is set
   * @param hardfork Hardfork name
   * @returns True if hardfork set is greater than hardfork provided
   */
  gteHardfork(hardfork: string | Hardfork): boolean {
    return this.hardforkGteHardfork(null, hardfork)
  }

  /**
   * Returns the hardfork change block for hardfork provided or set
   * @param hardfork Hardfork name, optional if HF set
   * @returns Block number or null if unscheduled
   */
  hardforkBlock(hardfork?: string | Hardfork): bigint | null {
    hardfork = hardfork ?? this._hardfork
    const block = this._getHardfork(hardfork)?.['block']
    if (block === undefined || block === null) {
      return null
    }
    return BigInt(block)
  }

  hardforkTimestamp(hardfork?: string | Hardfork): bigint | null {
    hardfork = hardfork ?? this._hardfork
    const timestamp = this._getHardfork(hardfork)?.['timestamp']
    if (timestamp === undefined || timestamp === null) {
      return null
    }
    return BigInt(timestamp)
  }

  /**
   * Returns the hardfork change block for eip
   * @param eip EIP number
   * @returns Block number or null if unscheduled
   */
  eipBlock(eip: number): bigint | null {
    for (const hfChanges of this.HARDFORK_CHANGES) {
      const hf = hfChanges[1]
      if ('eips' in hf) {
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
        if ((hf['eips'] as any).includes(eip)) {
          return this.hardforkBlock(hfChanges[0])
        }
      }
    }
    return null
  }

  /**
   * Returns the hardfork change total difficulty (Merge HF) for hardfork provided or set
   * @param hardfork Hardfork name, optional if HF set
   * @returns Total difficulty or null if no set
   */
  hardforkTTD(hardfork?: string | Hardfork): bigint | null {
    hardfork = hardfork ?? this._hardfork
    const ttd = this._getHardfork(hardfork)?.['ttd']
    if (ttd === undefined || ttd === null) {
      return null
    }
    return BigInt(ttd)
  }

  /**
   * Returns the change block for the next hardfork after the hardfork provided or set
   * @param hardfork Hardfork name, optional if HF set
   * @returns Block timestamp, number or null if not available
   */
  nextHardforkBlockOrTimestamp(hardfork?: string | Hardfork): bigint | null {
    hardfork = hardfork ?? this._hardfork
    const hfs = this.hardforks()
    let hfIndex = hfs.findIndex((hf) => hf.name === hardfork)
    // If the current hardfork is merge, go one behind as merge hf is not part of these
    // calcs even if the merge hf block is set
    if (hardfork === Hardfork.Paris) {
      hfIndex -= 1
    }
    // Hardfork not found
    if (hfIndex < 0) {
      return null
    }

    let currHfTimeOrBlock = hfs[hfIndex].timestamp ?? hfs[hfIndex].block
    currHfTimeOrBlock =
      currHfTimeOrBlock !== null && currHfTimeOrBlock !== undefined
        ? Number(currHfTimeOrBlock)
        : null

    const nextHf = hfs.slice(hfIndex + 1).find((hf) => {
      let hfTimeOrBlock = hf.timestamp ?? hf.block
      hfTimeOrBlock =
        hfTimeOrBlock !== null && hfTimeOrBlock !== undefined ? Number(hfTimeOrBlock) : null
      return (
        hf.name !== Hardfork.Paris &&
        hfTimeOrBlock !== null &&
        hfTimeOrBlock !== undefined &&
        hfTimeOrBlock !== currHfTimeOrBlock
      )
    })
    // If no next hf found with valid block or timestamp return null
    if (nextHf === undefined) {
      return null
    }

    const nextHfBlock = nextHf.timestamp ?? nextHf.block
    if (nextHfBlock === null || nextHfBlock === undefined) {
      return null
    }

    return BigInt(nextHfBlock)
  }

  /**
   * Internal helper function to calculate a fork hash
   * @param hardfork Hardfork name
   * @param genesisHash Genesis block hash of the chain
   * @returns Fork hash as hex string
   */
  private _calcForkHash(hardfork: string | Hardfork, genesisHash: Uint8Array): PrefixedHexString {
    let hfBytes = new Uint8Array(0)
    let prevBlockOrTime = 0
    for (const hf of this.hardforks()) {
      const { block, timestamp, name } = hf
      // Timestamp to be used for timestamp based hfs even if we may bundle
      // block number with them retrospectively
      let blockOrTime = timestamp ?? block
      blockOrTime = blockOrTime !== null ? Number(blockOrTime) : null

      // Skip for chainstart (0), not applied HFs (null) and
      // when already applied on same blockOrTime HFs
      // and on the merge since forkhash doesn't change on merge hf
      if (
        typeof blockOrTime === 'number' &&
        blockOrTime !== 0 &&
        blockOrTime !== prevBlockOrTime &&
        name !== Hardfork.Paris
      ) {
        const hfBlockBytes = hexToBytes('0x' + blockOrTime.toString(16).padStart(16, '0'))
        hfBytes = concatBytes(hfBytes, hfBlockBytes)
        prevBlockOrTime = blockOrTime
      }

      if (hf.name === hardfork) break
    }
    const inputBytes = concatBytes(genesisHash, hfBytes)

    // CRC32 delivers result as signed (negative) 32-bit integer,
    // convert to hex string
    const forkhash = bytesToHex(intToBytes(crc(inputBytes) >>> 0))
    return forkhash
  }

  /**
   * Returns an eth/64 compliant fork hash (EIP-2124)
   * @param hardfork Hardfork name, optional if HF set
   * @param genesisHash Genesis block hash of the chain, optional if already defined and not needed to be calculated
   */
  forkHash(hardfork?: string | Hardfork, genesisHash?: Uint8Array): PrefixedHexString {
    hardfork = hardfork ?? this._hardfork
    const data = this._getHardfork(hardfork)
    if (
      data === null ||
      (data?.block === null && data?.timestamp === undefined && data?.ttd === undefined)
    ) {
      const msg = 'No fork hash calculation possible for future hardfork'
      throw new Error(msg)
    }
    if (data?.forkHash !== null && data?.forkHash !== undefined) {
      return data.forkHash
    }
    if (!genesisHash) throw new Error('genesisHash required for forkHash calculation')
    return this._calcForkHash(hardfork, genesisHash)
  }

  /**
   *
   * @param forkHash Fork hash as a hex string
   * @returns Array with hardfork data (name, block, forkHash)
   */
  hardforkForForkHash(forkHash: string): HardforkConfig | null {
    const resArray = this.hardforks().filter((hf: HardforkConfig) => {
      return hf.forkHash === forkHash
    })
    return resArray.length >= 1 ? resArray[resArray.length - 1] : null
  }

  /**
   * Sets any missing forkHashes on the passed-in {@link Common} instance
   * @param common The {@link Common} to set the forkHashes for
   * @param genesisHash The genesis block hash
   */
  setForkHashes(genesisHash: Uint8Array) {
    for (const hf of this.hardforks()) {
      const blockOrTime = hf.timestamp ?? hf.block
      if (
        (hf.forkHash === null || hf.forkHash === undefined) &&
        ((blockOrTime !== null && blockOrTime !== undefined) || typeof hf.ttd !== 'undefined')
      ) {
        hf.forkHash = this.forkHash(hf.name, genesisHash)
      }
    }
  }

  /**
   * Returns the Genesis parameters of the current chain
   * @returns Genesis dictionary
   */
  genesis(): GenesisBlockConfig {
    return this._chainParams.genesis
  }

  /**
   * Returns the hardforks for current chain
   * @returns {Array} Array with arrays of hardforks
   */
  hardforks(): HardforkConfig[] {
    return this._chainParams.hardforks
  }

  /**
   * Returns bootstrap nodes for the current chain
   * @returns {Dictionary} Dict with bootstrap nodes
   */
  bootstrapNodes(): BootstrapNodeConfig[] {
    return this._chainParams.bootstrapNodes
  }

  /**
   * Returns DNS networks for the current chain
   * @returns {String[]} Array of DNS ENR urls
   */
  dnsNetworks(): string[] {
    return this._chainParams.dnsNetworks!
  }

  /**
   * Returns the hardfork set
   * @returns Hardfork name
   */
  hardfork(): string | Hardfork {
    return this._hardfork
  }

  /**
   * Returns the Id of current chain
   * @returns chain Id
   */
  chainId(): bigint {
    return BigInt(this._chainParams.chainId)
  }

  /**
   * Returns the name of current chain
   * @returns chain name (lower case)
   */
  chainName(): string {
    return this._chainParams.name
  }

  /**
   * Returns the Id of current network
   * @returns network Id
   */
  networkId(): bigint {
    return BigInt(this._chainParams.networkId)
  }

  /**
   * Returns the active EIPs
   * @returns List of EIPs
   */
  eips(): number[] {
    return this._eips
  }

  /**
   * Returns the consensus type of the network
   * Possible values: "pow"|"poa"|"pos"
   *
   * Note: This value can update along a Hardfork.
   */
  consensusType(): string | ConsensusType {
    const hardfork = this.hardfork()

    let value
    for (const hfChanges of this.HARDFORK_CHANGES) {
      if ('consensus' in hfChanges[1]) {
        value = hfChanges[1]['consensus']['type']
      }
      if (hfChanges[0] === hardfork) break
    }
    return value ?? this._chainParams['consensus']['type']
  }

  /**
   * Returns the concrete consensus implementation
   * algorithm or protocol for the network
   * e.g. "ethash" for "pow" consensus type,
   * "clique" for "poa" consensus type or
   * "casper" for "pos" consensus type.
   *
   * Note: This value can update along a Hardfork.
   */
  consensusAlgorithm(): string | ConsensusAlgorithm {
    const hardfork = this.hardfork()

    let value
    for (const hfChanges of this.HARDFORK_CHANGES) {
      if ('consensus' in hfChanges[1]) {
        value = hfChanges[1]['consensus']['algorithm']
      }
      if (hfChanges[0] === hardfork) break
    }
    return value ?? (this._chainParams['consensus']['algorithm'] as ConsensusAlgorithm)
  }

  /**
   * Returns a dictionary with consensus configuration
   * parameters based on the consensus algorithm
   *
   * Expected returns (parameters must be present in
   * the respective chain json files):
   *
   * ethash: empty object
   * clique: period, epoch
   * casper: empty object
   *
   * Note: This value can update along a Hardfork.
   */
  consensusConfig(): { [key: string]: CliqueConfig | EthashConfig | CasperConfig } {
    const hardfork = this.hardfork()

    let value
    for (const hfChanges of this.HARDFORK_CHANGES) {
      if ('consensus' in hfChanges[1]) {
        // The config parameter is named after the respective consensus algorithm
        value = (hfChanges[1] as any)['consensus'][hfChanges[1]['consensus']['algorithm']]
      }
      if (hfChanges[0] === hardfork) break
    }
    return (
      value ?? this._chainParams['consensus'][this.consensusAlgorithm() as ConsensusAlgorithm] ?? {}
    )
  }

  /**
   * Returns a deep copy of this {@link Common} instance.
   */
  copy(): Common {
    const copy = Object.assign(Object.create(Object.getPrototypeOf(this)), this)
    copy.events = new EventEmitter()
    return copy
  }

  static getInitializedChains(customChains?: ChainConfig[]): ChainsConfig {
    const names: ChainName = {}
    for (const [name, id] of Object.entries(Chain)) {
      names[id] = name.toLowerCase()
    }
    const chains = { mainnet, goerli, sepolia } as ChainsConfig
    if (customChains) {
      for (const chain of customChains) {
        const { name } = chain
        names[chain.chainId.toString()] = name
        chains[name] = chain
      }
    }
    chains.names = names
    return chains
  }
}
