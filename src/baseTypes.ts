// Changed for Yet Another Sync Plugin (2026): Dropbox only, the free engine's choices, its own ids, Smart Conflict rebuilt
/**
 * Only type defs here.
 * To avoid circular dependency.
 */

import type { LangTypeAndAuto } from './i18n'
import type { PendingRename, RouteTable } from './routes'

declare global {
  var DEFAULT_DROPBOX_APP_KEY: string
}

export const DROPBOX_APP_KEY = global.DEFAULT_DROPBOX_APP_KEY

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

/**
 * The remote services this plugin syncs with. A new one is a member here,
 * its own `fs<Name>.ts` (a FakeFs), and its own part of the settings tab.
 */
export type SUPPORTED_SERVICES_TYPE = 'dropbox' | 'github'

export interface GithubConfig {
  owner: string
  repo: string
  branch: string
  /** a fine-grained personal access token for this one repo */
  token: string
  /** an optional folder inside the repo the vault syncs under */
  folder?: string
}

/**
 * One remote of several. Each run syncs with one, under the profile id
 * `remote-<id>`. A per-remote setting left undefined falls back to the
 * top-level one, so the remote migrated from a single-remote setup syncs
 * exactly as before.
 */
export interface RemoteConfig {
  id: string
  name: string
  type: SUPPORTED_SERVICES_TYPE
  enabled: boolean
  github?: GithubConfig
  password?: string
  encryptionMethod?: CipherMethodType
  concurrency?: number
  syncDirection?: SyncDirectionType
  conflictAction?: ConflictActionType
  protectModifyPercentage?: number
  syncConfigDir?: boolean
}

export interface DropboxConfig {
  accessToken: string
  clientID: string
  refreshToken: string
  accessTokenExpiresInSeconds: number
  accessTokenExpiresAtTime: number
  accountID: string
  username: string
  credentialsShouldBeDeletedAtTime?: number
  remoteBaseDir?: string
}

export type SyncDirectionType =
  | 'bidirectional'
  | 'incremental_pull_only'
  | 'incremental_push_only'

export type CipherMethodType = 'rclone-base64' | 'openssl-base64' | 'unknown'

export type QRExportType = 'basic_and_advanced' | 'dropbox'

export interface ProfilerConfig {
  enable?: boolean
  enablePrinting?: boolean
  recordSize?: boolean
}

export interface RemotelySavePluginSettings {
  dropbox: DropboxConfig

  password: string
  serviceType: SUPPORTED_SERVICES_TYPE
  currLogLevel?: string
  autoRunEveryMilliseconds?: number
  initRunAfterMilliseconds?: number
  syncOnSaveAfterMilliseconds?: number

  concurrency?: number
  syncConfigDir?: boolean
  syncUnderscoreItems?: boolean
  lang?: LangTypeAndAuto
  agreeToUseSyncV3?: boolean
  skipSizeLargerThan?: number
  ignorePaths?: string[]
  enableStatusBarInfo?: boolean
  deleteToWhere?: 'system' | 'obsidian'
  conflictAction?: ConflictActionType

  protectModifyPercentage?: number
  syncDirection?: SyncDirectionType

  obfuscateSettingFile?: boolean

  enableMobileStatusBar?: boolean

  encryptionMethod?: CipherMethodType

  profiler?: ProfilerConfig

  /** the remotes, in the order their runs go */
  remotes?: RemoteConfig[]
  /** the route table: `docs/design.md`, "How folders route" */
  routes?: RouteTable
  /** when this device's table last changed, against the ownership files */
  routesUpdatedAt?: number
  /** routed folders renamed in the vault, for the next sync to finish */
  pendingRenames?: PendingRename[]

  /**
   * @deprecated
   */
  agreeToUploadExtraMetadata?: boolean

  /**
   * @deprecated
   */
  vaultRandomID?: string

  /**
   * @deprecated
   */
  logToDB?: boolean

  howToCleanEmptyFolder?: EmptyFolderCleanType
}

export const COMMAND_URI = 'yasp'
export const COMMAND_CALLBACK = 'yasp-cb'
export const COMMAND_CALLBACK_DROPBOX = 'yasp-cb-dropbox'

export interface UriParams {
  func?: string
  vault?: string
  ver?: string
  data?: string
}

// 80 days
export const OAUTH2_FORCE_EXPIRE_MILLISECONDS = 1000 * 60 * 60 * 24 * 80

export type EmptyFolderCleanType = 'skip' | 'clean_both'

/**
 * `smart` (Smart Conflict) merges a small Markdown file edited on both sides,
 * and otherwise keeps both versions: the remote one as a copy beside the file.
 */
export type ConflictActionType = 'keep_newer' | 'keep_larger' | 'smart'

export type DecisionTypeForMixedEntity =
  | 'only_history'
  | 'equal'
  | 'local_is_modified_then_push'
  | 'remote_is_modified_then_pull'
  | 'local_is_created_then_push'
  | 'remote_is_created_then_pull'
  | 'local_is_created_too_large_then_do_nothing'
  | 'remote_is_created_too_large_then_do_nothing'
  | 'local_is_deleted_thus_also_delete_remote'
  | 'remote_is_deleted_thus_also_delete_local'
  | 'conflict_created_then_keep_local'
  | 'conflict_created_then_keep_remote'
  | 'conflict_created_then_do_nothing'
  | 'conflict_modified_then_keep_local'
  | 'conflict_modified_then_keep_remote'
  | 'conflict_created_then_smart_conflict'
  | 'conflict_modified_then_smart_conflict'
  | 'folder_existed_both_then_do_nothing'
  | 'folder_existed_local_then_also_create_remote'
  | 'folder_existed_remote_then_also_create_local'
  | 'folder_to_be_created'
  | 'folder_to_skip'
  | 'folder_to_be_deleted_on_both'
  | 'folder_to_be_deleted_on_remote'
  | 'folder_to_be_deleted_on_local'

/**
 * uniform representation
 * everything should be flat and primitive, so that we can copy.
 */
export interface Entity {
  key?: string
  keyEnc?: string
  keyRaw: string
  mtimeCli?: number
  mtimeCliFmt?: string
  ctimeCli?: number
  ctimeCliFmt?: string
  mtimeSvr?: number
  mtimeSvrFmt?: string
  prevSyncTime?: number
  prevSyncTimeFmt?: string
  size?: number // might be unknown or to be filled
  sizeEnc?: number
  sizeRaw: number
  hash?: string
  etag?: string
  synthesizedFolder?: boolean
  synthesizedFile?: boolean
}

export interface UploadedType {
  entity: Entity
  mtimeCli?: number
}

/**
 * A replacement of FileOrFolderMixedState
 */
export interface MixedEntity {
  key: string
  local?: Entity
  prevSync?: Entity
  remote?: Entity

  decisionBranch?: number
  decision?: DecisionTypeForMixedEntity
  conflictAction?: ConflictActionType

  change?: boolean

  sideNotes?: any
}

/**
 * @deprecated
 */
export interface FileOrFolderMixedState {
  key: string
  existLocal?: boolean
  existRemote?: boolean
  mtimeLocal?: number
  mtimeRemote?: number
  deltimeLocal?: number
  deltimeRemote?: number
  sizeLocal?: number
  sizeLocalEnc?: number
  sizeRemote?: number
  sizeRemoteEnc?: number
  changeRemoteMtimeUsingMapping?: boolean
  changeLocalMtimeUsingMapping?: boolean
  decision?: string // old DecisionType is deleted, fallback to string
  decisionBranch?: number
  syncDone?: 'done'
  remoteEncryptedKey?: string

  mtimeLocalFmt?: string
  mtimeRemoteFmt?: string
  deltimeLocalFmt?: string
  deltimeRemoteFmt?: string
}

export const DEFAULT_DEBUG_FOLDER = '_debug_yasp/'
export const DEFAULT_SYNC_PLANS_HISTORY_FILE_PREFIX =
  'sync_plans_hist_exported_on_'
export const DEFAULT_LOG_HISTORY_FILE_PREFIX = 'log_hist_exported_on_'
export const DEFAULT_PROFILER_RESULT_FILE_PREFIX =
  'profiler_results_exported_on_'

export type SyncTriggerSourceType =
  | 'manual'
  | 'dry'
  | 'auto'
  | 'auto_once_init'
  | 'auto_sync_on_save'

export const REMOTELY_SAVE_VERSION_2022 = '0.3.25'
export const REMOTELY_SAVE_VERSION_2024PREPARE = '0.3.32'
