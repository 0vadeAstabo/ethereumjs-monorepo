import { Chain, Common, Hardfork } from '@ethereumjs/common'
import { DefaultStateManager } from '@ethereumjs/statemanager'
import {
  Account,
  Address,
  AsyncEventEmitter,
  KECCAK256_NULL,
  MAX_INTEGER,
  bigIntToBytes,
  bytesToUnprefixedHex,
  equalsBytes,
  generateAddress,
  generateAddress2,
  short,
  zeros,
} from '@ethereumjs/util'
import debugDefault from 'debug'
import * as mcl from 'mcl-wasm'

import { EOF, getEOFCode } from './eof.js'
import { ERROR, EvmError } from './exceptions.js'
import { Interpreter } from './interpreter.js'
import { Journal } from './journal.js'
import { Message } from './message.js'
import { getOpcodesForHF } from './opcodes/index.js'
import { getActivePrecompiles } from './precompiles/index.js'
import { TransientStorage } from './transientStorage.js'
import { DefaultBlockchain } from './types.js'

import type { InterpreterOpts, RunState } from './interpreter.js'
import type { MessageWithTo } from './message.js'
import type { AsyncDynamicGasHandler, SyncDynamicGasHandler } from './opcodes/gas.js'
import type { OpHandler, OpcodeList } from './opcodes/index.js'
import type { CustomPrecompile, PrecompileFunc } from './precompiles/index.js'
import type {
  Block,
  Blockchain,
  CustomOpcode,
  EVMEvents,
  EVMInterface,
  EVMRunCallOpts,
  EVMRunCodeOpts,
  Log,
} from './types.js'
import type { EVMStateManagerInterface } from '@ethereumjs/common'
const { debug: createDebugLogger } = debugDefault

const debug = createDebugLogger('evm:evm')
const debugGas = createDebugLogger('evm:gas')
const debugPrecompiles = createDebugLogger('evm:precompiles')

// very ugly way to detect if we are running in a browser
const isBrowser = new Function('try {return this===window;}catch(e){ return false;}')
let mclInitPromise: any

if (isBrowser() === false) {
  mclInitPromise = mcl.init(mcl.BLS12_381)
}

/**
 * Options for instantiating a {@link EVM}.
 */
export interface EVMOpts {
  /**
   * Use a {@link Common} instance for EVM instantiation.
   *
   * ### Supported EIPs
   *
   * - [EIP-1153](https://eips.ethereum.org/EIPS/eip-1153) - Transient Storage Opcodes (`experimental`)
   * - [EIP-1559](https://eips.ethereum.org/EIPS/eip-1559) - EIP-1559 Fee Market
   * - [EIP-2315](https://eips.ethereum.org/EIPS/eip-2315) - VM simple subroutines (`experimental`)
   * - [EIP-2537](https://eips.ethereum.org/EIPS/eip-2537) - BLS12-381 precompiles (`experimental`)
   * - [EIP-2565](https://eips.ethereum.org/EIPS/eip-2565) - ModExp Gas Cost
   * - [EIP-2718](https://eips.ethereum.org/EIPS/eip-2718) - Typed Transactions
   * - [EIP-2929](https://eips.ethereum.org/EIPS/eip-2929) - Gas cost increases for state access opcodes
   * - [EIP-2930](https://eips.ethereum.org/EIPS/eip-2930) - Access List Transaction Type
   * - [EIP-3198](https://eips.ethereum.org/EIPS/eip-3198) - BASEFEE opcode
   * - [EIP-3529](https://eips.ethereum.org/EIPS/eip-3529) - Reduction in refunds
   * - [EIP-3540](https://eips.ethereum.org/EIPS/eip-3541) - EVM Object Format (EOF) v1 (`experimental`)
   * - [EIP-3541](https://eips.ethereum.org/EIPS/eip-3541) - Reject new contracts starting with the 0xEF byte
   *   [EIP-3651](https://eips.ethereum.org/EIPS/eip-3651) - Warm COINBASE (`experimental`)
   * - [EIP-3670](https://eips.ethereum.org/EIPS/eip-3670) - EOF - Code Validation (`experimental`)
   * - [EIP-3855](https://eips.ethereum.org/EIPS/eip-3855) - PUSH0 instruction
   * - [EIP-3860](https://eips.ethereum.org/EIPS/eip-3860) - Limit and meter initcode
   * - [EIP-4399](https://eips.ethereum.org/EIPS/eip-4399) - Supplant DIFFICULTY opcode with PREVRANDAO (Merge)
   * - [EIP-4844](https://eips.ethereum.org/EIPS/eip-4844) - Shard Blob Transactions (`experimental`)
   * - [EIP-4895](https://eips.ethereum.org/EIPS/eip-4895) - Beacon chain push withdrawals as operations
   * - [EIP-5133](https://eips.ethereum.org/EIPS/eip-5133) - Delaying Difficulty Bomb to mid-September 2022
   * - [EIP-5656](https://eips.ethereum.org/EIPS/eip-5656) - MCOPY - Memory copying instruction (`experimental`)
   * *Annotations:*
   *
   * - `experimental`: behaviour can change on patch versions
   */
  common?: Common

  /**
   * Allows unlimited contract sizes while debugging. By setting this to `true`, the check for
   * contract size limit of 24KB (see [EIP-170](https://git.io/vxZkK)) is bypassed.
   *
   * Default: `false` [ONLY set to `true` during debugging]
   */
  allowUnlimitedContractSize?: boolean

  /**
   * Allows unlimited contract code-size init while debugging. This (partially) disables EIP-3860.
   * Gas cost for initcode size analysis will still be charged. Use with caution.
   */
  allowUnlimitedInitCodeSize?: boolean

  /**
   * Override or add custom opcodes to the EVM instruction set
   * These custom opcodes are EIP-agnostic and are always statically added
   * To delete an opcode, add an entry of format `{opcode: number}`. This will delete that opcode from the EVM.
   * If this opcode is then used in the EVM, the `INVALID` opcode would instead be used.
   * To add an opcode, add an entry of the following format:
   * {
   *    // The opcode number which will invoke the custom opcode logic
   *    opcode: number
   *    // The name of the opcode (as seen in the `step` event)
   *    opcodeName: string
   *    // The base fee of the opcode
   *    baseFee: number
   *    // If the opcode charges dynamic gas, add this here. To charge the gas, use the `i` methods of the BN, to update the charged gas
   *    gasFunction?: function(runState: RunState, gas: BN, common: Common)
   *    // The logic of the opcode which holds the logic of changing the current state
   *    logicFunction: function(runState: RunState)
   * }
   * Note: gasFunction and logicFunction can both be async or synchronous functions
   */
  customOpcodes?: CustomOpcode[]

  /*
   * Adds custom precompiles. This is hardfork-agnostic: these precompiles are always activated
   * If only an address is given, the precompile is deleted
   * If an address and a `PrecompileFunc` is given, this precompile is inserted or overridden
   * Please ensure `PrecompileFunc` has exactly one parameter `input: PrecompileInput`
   */
  customPrecompiles?: CustomPrecompile[]

  /*
   * The StateManager which is used to update the trie
   */
  stateManager: EVMStateManagerInterface

  /**
   *
   */
  blockchain?: Blockchain
}

/**
 * EVM is responsible for executing an EVM message fully
 * (including any nested calls and creates), processing the results
 * and storing them to state (or discarding changes in case of exceptions).
 * @ignore
 */
export class EVM implements EVMInterface {
  protected static supportedHardforks = [
    Hardfork.Chainstart,
    Hardfork.Homestead,
    Hardfork.Dao,
    Hardfork.TangerineWhistle,
    Hardfork.SpuriousDragon,
    Hardfork.Byzantium,
    Hardfork.Constantinople,
    Hardfork.Petersburg,
    Hardfork.Istanbul,
    Hardfork.MuirGlacier,
    Hardfork.Berlin,
    Hardfork.London,
    Hardfork.ArrowGlacier,
    Hardfork.GrayGlacier,
    Hardfork.MergeForkIdTransition,
    Hardfork.Paris,
    Hardfork.Shanghai,
    Hardfork.Cancun,
  ]
  protected _tx?: {
    gasPrice: bigint
    origin: Address
  }
  protected _block?: Block

  public readonly common: Common
  public readonly events: AsyncEventEmitter<EVMEvents>

  public stateManager: EVMStateManagerInterface
  public blockchain: Blockchain
  public journal: Journal

  public readonly transientStorage: TransientStorage

  protected _opcodes!: OpcodeList

  public readonly allowUnlimitedContractSize: boolean
  public readonly allowUnlimitedInitCodeSize: boolean

  protected readonly _customOpcodes?: CustomOpcode[]
  protected readonly _customPrecompiles?: CustomPrecompile[]

  protected _handlers!: Map<number, OpHandler>

  protected _dynamicGasHandlers!: Map<number, AsyncDynamicGasHandler | SyncDynamicGasHandler>

  protected _precompiles!: Map<string, PrecompileFunc>

  protected readonly _optsCached: EVMOpts

  public get precompiles() {
    return this._precompiles
  }

  public get opcodes() {
    return this._opcodes
  }

  protected _isInitialized: boolean = false

  /**
   * Pointer to the mcl package, not for public usage
   * set to public due to implementation internals
   * @hidden
   */
  public readonly _mcl: any //

  /**
   * EVM is run in DEBUG mode (default: false)
   * Taken from DEBUG environment variable
   *
   * Safeguards on debug() calls are added for
   * performance reasons to avoid string literal evaluation
   * @hidden
   */
  readonly DEBUG: boolean = false

  protected readonly _emit: (topic: string, data: any) => Promise<void>

  /**
   * EVM async constructor. Creates engine instance and initializes it.
   *
   * @param opts EVM engine constructor options
   */
  static async create(opts: EVMOpts): Promise<EVM> {
    const evm = new this(opts)
    await evm.init()
    return evm
  }

  constructor(opts: EVMOpts) {
    this.events = new AsyncEventEmitter()

    this._optsCached = opts

    this.transientStorage = new TransientStorage()

    if (opts.common) {
      this.common = opts.common
    } else {
      const DEFAULT_CHAIN = Chain.Mainnet
      this.common = new Common({ chain: DEFAULT_CHAIN })
    }

    let blockchain: Blockchain

    if (opts.blockchain === undefined) {
      blockchain = new DefaultBlockchain()
    } else {
      blockchain = opts.blockchain
    }

    this.blockchain = blockchain
    this.stateManager = opts.stateManager ?? new DefaultStateManager()

    // Supported EIPs
    const supportedEIPs = [
      1153, 1559, 2315, 2537, 2565, 2718, 2929, 2930, 3074, 3198, 3529, 3540, 3541, 3607, 3651,
      3670, 3855, 3860, 4399, 4895, 4844, 5133, 5656, 6780,
    ]

    for (const eip of this.common.eips()) {
      if (!supportedEIPs.includes(eip)) {
        throw new Error(`EIP-${eip} is not supported by the EVM`)
      }
    }

    if (!EVM.supportedHardforks.includes(this.common.hardfork() as Hardfork)) {
      throw new Error(
        `Hardfork ${this.common.hardfork()} not set as supported in supportedHardforks`
      )
    }

    this.allowUnlimitedContractSize = opts.allowUnlimitedContractSize ?? false
    this.allowUnlimitedInitCodeSize = opts.allowUnlimitedInitCodeSize ?? false
    this._customOpcodes = opts.customOpcodes
    this._customPrecompiles = opts.customPrecompiles

    this.journal = new Journal(this.stateManager, this.common)

    this.common.events.on('hardforkChanged', () => {
      this.getActiveOpcodes()
      this._precompiles = getActivePrecompiles(this.common, this._customPrecompiles)
    })

    // Initialize the opcode data
    this.getActiveOpcodes()
    this._precompiles = getActivePrecompiles(this.common, this._customPrecompiles)

    if (this.common.isActivatedEIP(2537)) {
      if (isBrowser() === true) {
        throw new Error('EIP-2537 is currently not supported in browsers')
      } else {
        this._mcl = mcl
      }
    }

    this._emit = async (topic: string, data: any): Promise<void> => {
      return new Promise((resolve) => this.events.emit(topic as keyof EVMEvents, data, resolve))
    }

    // Skip DEBUG calls unless 'ethjs' included in environmental DEBUG variables
    // Additional window check is to prevent vite browser bundling (and potentially other) to break
    this.DEBUG =
      typeof window === 'undefined' ? process?.env?.DEBUG?.includes('ethjs') ?? false : false
  }

  protected async init(): Promise<void> {
    if (this._isInitialized) {
      return
    }

    if (this.common.isActivatedEIP(2537)) {
      if (isBrowser() === true) {
        throw new Error('EIP-2537 is currently not supported in browsers')
      } else {
        const mcl = this._mcl
        await mclInitPromise // ensure that mcl is initialized.
        mcl.setMapToMode(mcl.IRTF) // set the right map mode; otherwise mapToG2 will return wrong values.
        mcl.verifyOrderG1(1) // subgroup checks for G1
        mcl.verifyOrderG2(1) // subgroup checks for G2
      }
    }

    this._isInitialized = true
  }

  /**
   * Returns a list with the currently activated opcodes
   * available for EVM execution
   */
  getActiveOpcodes(): OpcodeList {
    const data = getOpcodesForHF(this.common, this._customOpcodes)
    this._opcodes = data.opcodes
    this._dynamicGasHandlers = data.dynamicGasHandlers
    this._handlers = data.handlers
    return data.opcodes
  }

  protected async _executeCall(message: MessageWithTo): Promise<EVMResult> {
    let account = await this.stateManager.getAccount(message.authcallOrigin ?? message.caller)
    if (!account) {
      account = new Account()
    }
    let errorMessage
    // Reduce tx value from sender
    if (!message.delegatecall) {
      try {
        await this._reduceSenderBalance(account, message)
      } catch (e) {
        errorMessage = e
      }
    }
    // Load `to` account
    let toAccount = await this.stateManager.getAccount(message.to)
    if (!toAccount) {
      toAccount = new Account()
    }
    // Add tx value to the `to` account
    if (!message.delegatecall) {
      try {
        await this._addToBalance(toAccount, message)
      } catch (e: any) {
        errorMessage = e
      }
    }

    // Load code
    await this._loadCode(message)
    let exit = false
    if (!message.code || message.code.length === 0) {
      exit = true
      if (this.DEBUG) {
        debug(`Exit early on no code (CALL)`)
      }
    }
    if (errorMessage !== undefined) {
      exit = true
      if (this.DEBUG) {
        debug(`Exit early on value transfer overflowed (CALL)`)
      }
    }
    if (exit) {
      return {
        execResult: {
          gasRefund: message.gasRefund,
          executionGasUsed: BigInt(0),
          exceptionError: errorMessage, // Only defined if addToBalance failed
          returnValue: new Uint8Array(0),
        },
      }
    }

    let result: ExecResult
    if (message.isCompiled) {
      result = await this.runPrecompile(
        message.code as PrecompileFunc,
        message.data,
        message.gasLimit
      )
      result.gasRefund = message.gasRefund
    } else {
      if (this.DEBUG) {
        debug(`Start bytecode processing...`)
      }
      result = await this.runInterpreter(message)
    }

    if (message.depth === 0) {
      this.postMessageCleanup()
    }

    return {
      execResult: result,
    }
  }

  protected async _executeCreate(message: Message): Promise<EVMResult> {
    let account = await this.stateManager.getAccount(message.caller)
    if (!account) {
      account = new Account()
    }
    // Reduce tx value from sender
    await this._reduceSenderBalance(account, message)

    if (this.common.isActivatedEIP(3860)) {
      if (
        message.data.length > Number(this.common.param('vm', 'maxInitCodeSize')) &&
        !this.allowUnlimitedInitCodeSize
      ) {
        return {
          createdAddress: message.to,
          execResult: {
            returnValue: new Uint8Array(0),
            exceptionError: new EvmError(ERROR.INITCODE_SIZE_VIOLATION),
            executionGasUsed: message.gasLimit,
          },
        }
      }
    }

    message.code = message.data
    message.data = new Uint8Array(0)
    message.to = await this._generateAddress(message)

    if (this.common.isActivatedEIP(6780)) {
      message.createdAddresses!.add(message.to.toString())
    }

    if (this.DEBUG) {
      debug(`Generated CREATE contract address ${message.to}`)
    }
    let toAccount = await this.stateManager.getAccount(message.to)
    if (!toAccount) {
      toAccount = new Account()
    }

    // Check for collision
    if (
      (toAccount.nonce && toAccount.nonce > BigInt(0)) ||
      !(equalsBytes(toAccount.codeHash, KECCAK256_NULL) === true)
    ) {
      if (this.DEBUG) {
        debug(`Returning on address collision`)
      }
      return {
        createdAddress: message.to,
        execResult: {
          returnValue: new Uint8Array(0),
          exceptionError: new EvmError(ERROR.CREATE_COLLISION),
          executionGasUsed: message.gasLimit,
        },
      }
    }

    await this.journal.putAccount(message.to, toAccount)
    await this.stateManager.clearContractStorage(message.to)

    const newContractEvent = {
      address: message.to,
      code: message.code,
    }

    await this._emit('newContract', newContractEvent)

    toAccount = await this.stateManager.getAccount(message.to)
    if (!toAccount) {
      toAccount = new Account()
    }
    // EIP-161 on account creation and CREATE execution
    if (this.common.gteHardfork(Hardfork.SpuriousDragon)) {
      toAccount.nonce += BigInt(1)
    }

    // Add tx value to the `to` account
    let errorMessage
    try {
      await this._addToBalance(toAccount, message as MessageWithTo)
    } catch (e: any) {
      errorMessage = e
    }

    let exit = false
    if (message.code === undefined || message.code.length === 0) {
      exit = true
      if (this.DEBUG) {
        debug(`Exit early on no code (CREATE)`)
      }
    }
    if (errorMessage !== undefined) {
      exit = true
      if (this.DEBUG) {
        debug(`Exit early on value transfer overflowed (CREATE)`)
      }
    }
    if (exit) {
      return {
        createdAddress: message.to,
        execResult: {
          executionGasUsed: BigInt(0),
          gasRefund: message.gasRefund,
          exceptionError: errorMessage, // only defined if addToBalance failed
          returnValue: new Uint8Array(0),
        },
      }
    }

    if (this.DEBUG) {
      debug(`Start bytecode processing...`)
    }

    let result = await this.runInterpreter(message)
    // fee for size of the return value
    let totalGas = result.executionGasUsed
    let returnFee = BigInt(0)
    if (!result.exceptionError) {
      returnFee =
        BigInt(result.returnValue.length) * BigInt(this.common.param('gasPrices', 'createData'))
      totalGas = totalGas + returnFee
      if (this.DEBUG) {
        debugGas(`Add return value size fee (${returnFee} to gas used (-> ${totalGas}))`)
      }
    }

    // Check for SpuriousDragon EIP-170 code size limit
    let allowedCodeSize = true
    if (
      !result.exceptionError &&
      this.common.gteHardfork(Hardfork.SpuriousDragon) &&
      result.returnValue.length > Number(this.common.param('vm', 'maxCodeSize'))
    ) {
      allowedCodeSize = false
    }

    // If enough gas and allowed code size
    let CodestoreOOG = false
    if (totalGas <= message.gasLimit && (this.allowUnlimitedContractSize || allowedCodeSize)) {
      if (this.common.isActivatedEIP(3541) && result.returnValue[0] === EOF.FORMAT) {
        if (!this.common.isActivatedEIP(3540)) {
          result = { ...result, ...INVALID_BYTECODE_RESULT(message.gasLimit) }
        }
        // Begin EOF1 contract code checks
        // EIP-3540 EOF1 header check
        const eof1CodeAnalysisResults = EOF.codeAnalysis(result.returnValue)
        if (typeof eof1CodeAnalysisResults?.code === 'undefined') {
          result = {
            ...result,
            ...INVALID_EOF_RESULT(message.gasLimit),
          }
        } else if (this.common.isActivatedEIP(3670)) {
          // EIP-3670 EOF1 opcode check
          const codeStart = eof1CodeAnalysisResults.data > 0 ? 10 : 7
          // The start of the code section of an EOF1 compliant contract will either be
          // index 7 (if no data section is present) or index 10 (if a data section is present)
          // in the bytecode of the contract
          if (
            !EOF.validOpcodes(
              result.returnValue.subarray(codeStart, codeStart + eof1CodeAnalysisResults.code)
            )
          ) {
            result = {
              ...result,
              ...INVALID_EOF_RESULT(message.gasLimit),
            }
          } else {
            result.executionGasUsed = totalGas
          }
        }
      } else {
        result.executionGasUsed = totalGas
      }
    } else {
      if (this.common.gteHardfork(Hardfork.Homestead)) {
        if (!allowedCodeSize) {
          if (this.DEBUG) {
            debug(`Code size exceeds maximum code size (>= SpuriousDragon)`)
          }
          result = { ...result, ...CodesizeExceedsMaximumError(message.gasLimit) }
        } else {
          if (this.DEBUG) {
            debug(`Contract creation: out of gas`)
          }
          result = { ...result, ...OOGResult(message.gasLimit) }
        }
      } else {
        // we are in Frontier
        if (totalGas - returnFee <= message.gasLimit) {
          // we cannot pay the code deposit fee (but the deposit code actually did run)
          if (this.DEBUG) {
            debug(`Not enough gas to pay the code deposit fee (Frontier)`)
          }
          result = { ...result, ...COOGResult(totalGas - returnFee) }
          CodestoreOOG = true
        } else {
          if (this.DEBUG) {
            debug(`Contract creation: out of gas`)
          }
          result = { ...result, ...OOGResult(message.gasLimit) }
        }
      }
    }

    // Save code if a new contract was created
    if (
      !result.exceptionError &&
      result.returnValue !== undefined &&
      result.returnValue.length !== 0
    ) {
      await this.stateManager.putContractCode(message.to, result.returnValue)
      if (this.DEBUG) {
        debug(`Code saved on new contract creation`)
      }
    } else if (CodestoreOOG) {
      // This only happens at Frontier. But, let's do a sanity check;
      if (!this.common.gteHardfork(Hardfork.Homestead)) {
        // Pre-Homestead behavior; put an empty contract.
        // This contract would be considered "DEAD" in later hard forks.
        // It is thus an unnecessary default item, which we have to save to disk
        // It does change the state root, but it only wastes storage.
        const account = await this.stateManager.getAccount(message.to)
        await this.journal.putAccount(message.to, account ?? new Account())
      }
    }

    return {
      createdAddress: message.to,
      execResult: result,
    }
  }

  /**
   * Starts the actual bytecode processing for a CALL or CREATE
   */
  protected async runInterpreter(
    message: Message,
    opts: InterpreterOpts = {}
  ): Promise<ExecResult> {
    let contract = await this.stateManager.getAccount(message.to ?? Address.zero())
    if (!contract) {
      contract = new Account()
    }
    const env = {
      address: message.to ?? Address.zero(),
      caller: message.caller ?? Address.zero(),
      callData: message.data ?? Uint8Array.from([0]),
      callValue: message.value ?? BigInt(0),
      code: message.code as Uint8Array,
      isStatic: message.isStatic ?? false,
      depth: message.depth ?? 0,
      gasPrice: this._tx!.gasPrice,
      origin: this._tx!.origin ?? message.caller ?? Address.zero(),
      block: this._block ?? defaultBlock(),
      contract,
      codeAddress: message.codeAddress,
      gasRefund: message.gasRefund,
      containerCode: message.containerCode,
      versionedHashes: message.versionedHashes ?? [],
    }

    const interpreter = new Interpreter(
      this,
      this.stateManager,
      this.blockchain,
      env,
      message.gasLimit,
      this.journal
    )
    if (message.selfdestruct) {
      interpreter._result.selfdestruct = message.selfdestruct
    }
    if (message.createdAddresses) {
      interpreter._result.createdAddresses = message.createdAddresses
    }

    const interpreterRes = await interpreter.run(message.code as Uint8Array, opts)

    let result = interpreter._result
    let gasUsed = message.gasLimit - interpreterRes.runState!.gasLeft
    if (interpreterRes.exceptionError) {
      if (
        interpreterRes.exceptionError.error !== ERROR.REVERT &&
        interpreterRes.exceptionError.error !== ERROR.INVALID_EOF_FORMAT
      ) {
        gasUsed = message.gasLimit
      }

      // Clear the result on error
      result = {
        ...result,
        logs: [],
        selfdestruct: new Set(),
        createdAddresses: new Set(),
      }
    }

    return {
      ...result,
      runState: {
        ...interpreterRes.runState!,
        ...result,
        ...interpreter._env,
      },
      exceptionError: interpreterRes.exceptionError,
      gas: interpreterRes.runState?.gasLeft,
      executionGasUsed: gasUsed,
      gasRefund: interpreterRes.runState!.gasRefund,
      returnValue: result.returnValue ? result.returnValue : new Uint8Array(0),
    }
  }

  /**
   * Executes an EVM message, determining whether it's a call or create
   * based on the `to` address. It checkpoints the state and reverts changes
   * if an exception happens during the message execution.
   */
  async runCall(opts: EVMRunCallOpts): Promise<EVMResult> {
    let message = opts.message
    let callerAccount
    if (!message) {
      this._block = opts.block ?? defaultBlock()
      this._tx = {
        gasPrice: opts.gasPrice ?? BigInt(0),
        origin: opts.origin ?? opts.caller ?? Address.zero(),
      }
      const caller = opts.caller ?? Address.zero()

      const value = opts.value ?? BigInt(0)
      if (opts.skipBalance === true) {
        callerAccount = await this.stateManager.getAccount(caller)
        if (!callerAccount) {
          callerAccount = new Account()
        }
        if (callerAccount.balance < value) {
          // if skipBalance and balance less than value, set caller balance to `value` to ensure sufficient funds
          callerAccount.balance = value
          await this.journal.putAccount(caller, callerAccount)
        }
      }

      message = new Message({
        caller,
        gasLimit: opts.gasLimit ?? BigInt(0xffffff),
        to: opts.to,
        value,
        data: opts.data,
        code: opts.code,
        depth: opts.depth,
        isCompiled: opts.isCompiled,
        isStatic: opts.isStatic,
        salt: opts.salt,
        selfdestruct: opts.selfdestruct ?? new Set(),
        createdAddresses: opts.createdAddresses ?? new Set(),
        delegatecall: opts.delegatecall,
        versionedHashes: opts.versionedHashes,
      })
    }

    if (message.depth === 0) {
      if (!callerAccount) {
        callerAccount = await this.stateManager.getAccount(message.caller)
      }
      if (!callerAccount) {
        callerAccount = new Account()
      }
      callerAccount.nonce++
      await this.journal.putAccount(message.caller, callerAccount)
      if (this.DEBUG) {
        debug(`Update fromAccount (caller) nonce (-> ${callerAccount.nonce}))`)
      }
    }

    await this._emit('beforeMessage', message)

    if (!message.to && this.common.isActivatedEIP(2929) === true) {
      message.code = message.data
      this.journal.addWarmedAddress((await this._generateAddress(message)).bytes)
    }

    await this.journal.checkpoint()
    if (this.common.isActivatedEIP(1153)) this.transientStorage.checkpoint()
    if (this.DEBUG) {
      debug('-'.repeat(100))
      debug(`message checkpoint`)
    }

    let result
    if (this.DEBUG) {
      const { caller, gasLimit, to, value, delegatecall } = message
      debug(
        `New message caller=${caller} gasLimit=${gasLimit} to=${
          to?.toString() ?? 'none'
        } value=${value} delegatecall=${delegatecall ? 'yes' : 'no'}`
      )
    }
    if (message.to) {
      if (this.DEBUG) {
        debug(`Message CALL execution (to: ${message.to})`)
      }
      result = await this._executeCall(message as MessageWithTo)
    } else {
      if (this.DEBUG) {
        debug(`Message CREATE execution (to undefined)`)
      }
      result = await this._executeCreate(message)
    }
    if (this.DEBUG) {
      const { executionGasUsed, exceptionError, returnValue } = result.execResult
      debug(
        `Received message execResult: [ gasUsed=${executionGasUsed} exceptionError=${
          exceptionError ? `'${exceptionError.error}'` : 'none'
        } returnValue=0x${short(returnValue)} gasRefund=${result.execResult.gasRefund ?? 0} ]`
      )
    }
    const err = result.execResult.exceptionError
    // This clause captures any error which happened during execution
    // If that is the case, then all refunds are forfeited
    // There is one exception: if the CODESTORE_OUT_OF_GAS error is thrown
    // (this only happens the Frontier/Chainstart fork)
    // then the error is dismissed
    if (err && err.error !== ERROR.CODESTORE_OUT_OF_GAS) {
      result.execResult.selfdestruct = new Set()
      result.execResult.createdAddresses = new Set()
      result.execResult.gasRefund = BigInt(0)
    }
    if (
      err &&
      !(this.common.hardfork() === Hardfork.Chainstart && err.error === ERROR.CODESTORE_OUT_OF_GAS)
    ) {
      result.execResult.logs = []
      await this.journal.revert()
      if (this.common.isActivatedEIP(1153)) this.transientStorage.revert()
      if (this.DEBUG) {
        debug(`message checkpoint reverted`)
      }
    } else {
      await this.journal.commit()
      if (this.common.isActivatedEIP(1153)) this.transientStorage.commit()
      if (this.DEBUG) {
        debug(`message checkpoint committed`)
      }
    }
    await this._emit('afterMessage', result)

    return result
  }

  /**
   * Bound to the global VM and therefore
   * shouldn't be used directly from the evm class
   */
  async runCode(opts: EVMRunCodeOpts): Promise<ExecResult> {
    this._block = opts.block ?? defaultBlock()

    this._tx = {
      gasPrice: opts.gasPrice ?? BigInt(0),
      origin: opts.origin ?? opts.caller ?? Address.zero(),
    }

    const message = new Message({
      code: opts.code,
      data: opts.data,
      gasLimit: opts.gasLimit,
      to: opts.address ?? Address.zero(),
      caller: opts.caller,
      value: opts.value,
      depth: opts.depth,
      selfdestruct: opts.selfdestruct ?? new Set(),
      isStatic: opts.isStatic,
      versionedHashes: opts.versionedHashes,
    })

    return this.runInterpreter(message, { pc: opts.pc })
  }

  /**
   * Returns code for precompile at the given address, or undefined
   * if no such precompile exists.
   */
  getPrecompile(address: Address): PrecompileFunc | undefined {
    return this.precompiles.get(bytesToUnprefixedHex(address.bytes))
  }

  /**
   * Executes a precompiled contract with given data and gas limit.
   */
  protected runPrecompile(
    code: PrecompileFunc,
    data: Uint8Array,
    gasLimit: bigint
  ): Promise<ExecResult> | ExecResult {
    if (typeof code !== 'function') {
      throw new Error('Invalid precompile')
    }

    const opts = {
      data,
      gasLimit,
      common: this.common,
      _EVM: this,
      _debug: this.DEBUG ? debugPrecompiles : undefined,
    }

    return code(opts)
  }

  protected async _loadCode(message: Message): Promise<void> {
    if (!message.code) {
      const precompile = this.getPrecompile(message.codeAddress)
      if (precompile) {
        message.code = precompile
        message.isCompiled = true
      } else {
        message.containerCode = await this.stateManager.getContractCode(message.codeAddress)
        message.isCompiled = false
        if (this.common.isActivatedEIP(3540)) {
          message.code = getEOFCode(message.containerCode)
        } else {
          message.code = message.containerCode
        }
      }
    }
  }

  protected async _generateAddress(message: Message): Promise<Address> {
    let addr
    if (message.salt) {
      addr = generateAddress2(message.caller.bytes, message.salt, message.code as Uint8Array)
    } else {
      let acc = await this.stateManager.getAccount(message.caller)
      if (!acc) {
        acc = new Account()
      }
      const newNonce = acc.nonce - BigInt(1)
      addr = generateAddress(message.caller.bytes, bigIntToBytes(newNonce))
    }
    return new Address(addr)
  }

  protected async _reduceSenderBalance(account: Account, message: Message): Promise<void> {
    account.balance -= message.value
    if (account.balance < BigInt(0)) {
      throw new EvmError(ERROR.INSUFFICIENT_BALANCE)
    }
    const result = this.journal.putAccount(message.authcallOrigin ?? message.caller, account)
    if (this.DEBUG) {
      debug(`Reduced sender (${message.caller}) balance (-> ${account.balance})`)
    }
    return result
  }

  protected async _addToBalance(toAccount: Account, message: MessageWithTo): Promise<void> {
    const newBalance = toAccount.balance + message.value
    if (newBalance > MAX_INTEGER) {
      throw new EvmError(ERROR.VALUE_OVERFLOW)
    }
    toAccount.balance = newBalance
    // putAccount as the nonce may have changed for contract creation
    const result = this.journal.putAccount(message.to, toAccount)
    if (this.DEBUG) {
      debug(`Added toAccount (${message.to}) balance (-> ${toAccount.balance})`)
    }
    return result
  }

  /**
   * Once the interpreter has finished depth 0, a post-message cleanup should be done
   */
  private postMessageCleanup() {
    if (this.common.isActivatedEIP(1153)) this.transientStorage.clear()
  }

  /**
   * This method copies the EVM, current HF and EIP settings
   * and returns a new EVM instance.
   *
   * Note: this is only a shallow copy and both EVM instances
   * will point to the same underlying state DB.
   *
   * @returns EVMInterface
   */
  public shallowCopy(): EVMInterface {
    const common = this.common.copy()
    common.setHardfork(this.common.hardfork())

    const opts = {
      ...this._optsCached,
      common,
      stateManager: this.stateManager.shallowCopy(),
    }
    ;(opts.stateManager as any).common = common
    return new EVM(opts)
  }
}

/**
 * Result of executing a message via the {@link EVM}.
 */
export interface EVMResult {
  /**
   * Address of created account during transaction, if any
   */
  createdAddress?: Address
  /**
   * Contains the results from running the code, if any, as described in {@link runCode}
   */
  execResult: ExecResult
}

/**
 * Result of executing a call via the {@link EVM}.
 */
export interface ExecResult {
  runState?: RunState
  /**
   * Description of the exception, if any occurred
   */
  exceptionError?: EvmError
  /**
   * Amount of gas left
   */
  gas?: bigint
  /**
   * Amount of gas the code used to run
   */
  executionGasUsed: bigint
  /**
   * Return value from the contract
   */
  returnValue: Uint8Array
  /**
   * Array of logs that the contract emitted
   */
  logs?: Log[]
  /**
   * A set of accounts to selfdestruct
   */
  selfdestruct?: Set<string>
  /**
   * Map of addresses which were created (used in EIP 6780)
   */
  createdAddresses?: Set<string>
  /**
   * The gas refund counter
   */
  gasRefund?: bigint
  /**
   * Amount of data gas consumed by the transaction
   */
  dataGasUsed?: bigint
}

export function OOGResult(gasLimit: bigint): ExecResult {
  return {
    returnValue: new Uint8Array(0),
    executionGasUsed: gasLimit,
    exceptionError: new EvmError(ERROR.OUT_OF_GAS),
  }
}
// CodeDeposit OOG Result
export function COOGResult(gasUsedCreateCode: bigint): ExecResult {
  return {
    returnValue: new Uint8Array(0),
    executionGasUsed: gasUsedCreateCode,
    exceptionError: new EvmError(ERROR.CODESTORE_OUT_OF_GAS),
  }
}

export function INVALID_BYTECODE_RESULT(gasLimit: bigint): ExecResult {
  return {
    returnValue: new Uint8Array(0),
    executionGasUsed: gasLimit,
    exceptionError: new EvmError(ERROR.INVALID_BYTECODE_RESULT),
  }
}

export function INVALID_EOF_RESULT(gasLimit: bigint): ExecResult {
  return {
    returnValue: new Uint8Array(0),
    executionGasUsed: gasLimit,
    exceptionError: new EvmError(ERROR.INVALID_EOF_FORMAT),
  }
}

export function CodesizeExceedsMaximumError(gasUsed: bigint): ExecResult {
  return {
    returnValue: new Uint8Array(0),
    executionGasUsed: gasUsed,
    exceptionError: new EvmError(ERROR.CODESIZE_EXCEEDS_MAXIMUM),
  }
}

export function EvmErrorResult(error: EvmError, gasUsed: bigint): ExecResult {
  return {
    returnValue: new Uint8Array(0),
    executionGasUsed: gasUsed,
    exceptionError: error,
  }
}

function defaultBlock(): Block {
  return {
    header: {
      number: BigInt(0),
      cliqueSigner: () => Address.zero(),
      coinbase: Address.zero(),
      timestamp: BigInt(0),
      difficulty: BigInt(0),
      prevRandao: zeros(32),
      gasLimit: BigInt(0),
      baseFeePerGas: undefined,
    },
  }
}
