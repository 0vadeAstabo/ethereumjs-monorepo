import type { Account, Address, PrefixedHexString } from '@ethereumjs/util'

export interface StorageDump {
  [key: string]: string
}

export type AccountFields = Partial<Pick<Account, 'nonce' | 'balance' | 'storageRoot' | 'codeHash'>>

export type StorageProof = {
  key: PrefixedHexString
  proof: PrefixedHexString[]
  value: PrefixedHexString
}

export type Proof = {
  address: PrefixedHexString
  balance: PrefixedHexString
  codeHash: PrefixedHexString
  nonce: PrefixedHexString
  storageHash: PrefixedHexString
  accountProof: PrefixedHexString[]
  storageProof: StorageProof[]
}

/*
 * Access List types
 */

export type AccessListItem = {
  address: PrefixedHexString
  storageKeys: PrefixedHexString[]
}

/*
 * An Access List as a tuple of [address: Uint8Array, storageKeys: Uint8Array[]]
 */
export type AccessListBytesItem = [Uint8Array, Uint8Array[]]
export type AccessListBytes = AccessListBytesItem[]
export type AccessList = AccessListItem[]

export interface StateManagerInterface {
  getAccount(address: Address): Promise<Account | undefined>
  putAccount(address: Address, account?: Account): Promise<void>
  deleteAccount(address: Address): Promise<void>
  modifyAccountFields(address: Address, accountFields: AccountFields): Promise<void>
  putContractCode(address: Address, value: Uint8Array): Promise<void>
  getContractCode(address: Address): Promise<Uint8Array>
  getContractStorage(address: Address, key: Uint8Array): Promise<Uint8Array>
  putContractStorage(address: Address, key: Uint8Array, value: Uint8Array): Promise<void>
  clearContractStorage(address: Address): Promise<void>
  checkpoint(): Promise<void>
  commit(): Promise<void>
  revert(): Promise<void>
  getStateRoot(): Promise<Uint8Array>
  setStateRoot(stateRoot: Uint8Array, clearCache?: boolean): Promise<void>
  getProof?(address: Address, storageSlots: Uint8Array[]): Promise<Proof>
  hasStateRoot(root: Uint8Array): Promise<boolean> // only used in client
  shallowCopy(): StateManagerInterface
}

export interface EVMStateManagerInterface extends StateManagerInterface {
  originalStorageCache: {
    get(address: Address, key: Uint8Array): Promise<Uint8Array>
    clear(): void
  }

  dumpStorage(address: Address): Promise<StorageDump> // only used in client
  generateCanonicalGenesis(initState: any): Promise<void> // TODO make input more typesafe
  getProof(address: Address, storageSlots?: Uint8Array[]): Promise<Proof>

  shallowCopy(): EVMStateManagerInterface
}
