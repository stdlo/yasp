// Changed for Remotely Save Lite (2026): the restored engine, Dropbox only, no paid account, its own ids, no Biome comments, Smart Conflict as the default with a notice for each conflict copy
import AggregateError from 'aggregate-error'
import cloneDeep from 'lodash/cloneDeep'
import throttle from 'lodash/throttle'
import { FileText, RefreshCcw, RotateCcw, createElement } from 'lucide'
import {
  Events,
  FileSystemAdapter,
  type Modal,
  Notice,
  Platform,
  Plugin,
  type Setting,
  TFolder,
  addIcon,
  setIcon,
} from 'obsidian'
import type {
  RemotelySavePluginSettings,
  SyncTriggerSourceType,
} from './baseTypes'
import {
  COMMAND_CALLBACK,
  COMMAND_CALLBACK_DROPBOX,
  COMMAND_URI,
} from './baseTypes'
import { messyConfigToNormal, normalConfigToMessy } from './configPersist'
import { exportVaultSyncPlansToFiles } from './debugMode'
import {
  DEFAULT_DROPBOX_CONFIG,
  sendAuthReq as sendAuthReqDropbox,
  setConfigBySuccessfullAuthInplace as setConfigBySuccessfullAuthInplaceDropbox,
} from './fsDropbox'
import { FakeFsEncrypt } from './fsEncrypt'
import { getClient } from './fsGetter'
import { FakeFsLocal } from './fsLocal'
import { I18n } from './i18n'
import type { LangTypeAndAuto, TransItemType } from './i18n'
import { importQrCodeUri } from './importExport'
import {
  type InternalDBs,
  clearAllLoggerOutputRecords,
  clearExpiredSyncPlanRecords,
  getLastFailedSyncTimeByVault,
  getLastSuccessSyncTimeByVault,
  moveProfileRecords,
  prepareDBs,
  upsertLastFailedSyncTimeByVault,
  upsertLastSuccessSyncTimeByVault,
  upsertPluginVersionByVault,
} from './localdb'
import { changeMobileStatusBar } from './misc'
import { LEGACY_PROFILE_ID, migrateToRemotes, profileIdOf } from './remotes'
import { DEFAULT_PROFILER_CONFIG, Profiler } from './profiler'
import { RemotelySaveSettingTab } from './settings'
import {
  type RemoteResult,
  recordFolderRename,
  syncAllRemotes,
} from './multiSync'
import { remoteDetail, remoteMarks } from './statusBar'
import { askHeldQuestion } from './routesModals'
import { SyncAlgoV3Modal } from './syncAlgoV3Notice'

const DEFAULT_SETTINGS: RemotelySavePluginSettings = {
  dropbox: DEFAULT_DROPBOX_CONFIG,
  password: '',
  serviceType: 'dropbox',
  currLogLevel: 'info',
  // vaultRandomID: "", // deprecated
  autoRunEveryMilliseconds: -1,
  initRunAfterMilliseconds: -1,
  syncOnSaveAfterMilliseconds: -1,
  agreeToUploadExtraMetadata: true, // as of 20240106, it's safe to assume every new user agrees with this
  concurrency: 5,
  syncConfigDir: false,
  syncUnderscoreItems: false,
  lang: 'auto',
  logToDB: false,
  skipSizeLargerThan: -1,
  ignorePaths: [],
  enableStatusBarInfo: true,
  deleteToWhere: 'system',
  agreeToUseSyncV3: false,
  conflictAction: 'smart',
  howToCleanEmptyFolder: 'clean_both',
  protectModifyPercentage: 50,
  syncDirection: 'bidirectional',
  obfuscateSettingFile: true,
  enableMobileStatusBar: false,
  encryptionMethod: 'unknown',
  profiler: DEFAULT_PROFILER_CONFIG,
}

interface OAuth2Info {
  verifier?: string
  helperModal?: Modal
  authDiv?: HTMLElement
  revokeDiv?: HTMLElement
  revokeAuthSetting?: Setting
}

const iconNameSyncWait = `remotely-save-lite-sync-wait`
const iconNameSyncRunning = `remotely-save-lite-sync-running`
const iconNameLogs = `remotely-save-lite-logs`

const getIconSvg = () => {
  const iconSvgSyncWait = createElement(RotateCcw)
  iconSvgSyncWait.setAttribute('width', '100')
  iconSvgSyncWait.setAttribute('height', '100')
  const iconSvgSyncRunning = createElement(RefreshCcw)
  iconSvgSyncRunning.setAttribute('width', '100')
  iconSvgSyncRunning.setAttribute('height', '100')
  const iconSvgLogs = createElement(FileText)
  iconSvgLogs.setAttribute('width', '100')
  iconSvgLogs.setAttribute('height', '100')
  const res = {
    iconSvgSyncWait: iconSvgSyncWait.outerHTML,
    iconSvgSyncRunning: iconSvgSyncRunning.outerHTML,
    iconSvgLogs: iconSvgLogs.outerHTML,
  }

  iconSvgSyncWait.empty()
  iconSvgSyncRunning.empty()
  iconSvgLogs.empty()
  return res
}

const getStatusBarShortMsgFromSyncSource = (
  t: (x: TransItemType, vars?: any) => string,
  s: SyncTriggerSourceType | undefined,
) => {
  if (s === undefined) {
    return ''
  }
  switch (s) {
    case 'manual':
      return t('statusbar_sync_source_manual')
    case 'dry':
      return t('statusbar_sync_source_dry')
    case 'auto':
      return t('statusbar_sync_source_auto')
    case 'auto_once_init':
      return t('statusbar_sync_source_auto_once_init')
    case 'auto_sync_on_save':
      return t('statusbar_sync_source_auto_sync_on_save')
    default:
      throw Error(`no translate for ${s}`)
  }
}

export default class RemotelySavePlugin extends Plugin {
  settings!: RemotelySavePluginSettings
  db!: InternalDBs
  isSyncing!: boolean
  hasPendingSyncOnSave!: boolean
  statusBarElement!: HTMLSpanElement
  /** each remote's last result, for the status bar */
  remoteResults = new Map<string, RemoteResult>()
  /** the remote whose run is going, by name */
  syncingRemote?: string
  oauth2Info!: OAuth2Info
  currLogLevel!: string
  currSyncMsg?: string
  syncRibbon?: HTMLElement
  autoRunIntervalID?: number
  syncOnSaveIntervalID?: number
  i18n!: I18n
  vaultRandomID!: string
  debugServerTemp?: string
  syncEvent?: Events
  appContainerObserver?: MutationObserver

  async syncRun(triggerSource: SyncTriggerSourceType = 'manual') {
    let profiler: Profiler | undefined = undefined
    if (this.settings.profiler?.enable ?? false) {
      profiler = new Profiler(
        undefined,
        this.settings.profiler?.enablePrinting ?? false,
        this.settings.profiler?.recordSize ?? false,
      )
    }
    const fsLocal = new FakeFsLocal(
      this.app.vault,
      this.settings.syncConfigDir ?? false,
      this.app.vault.configDir,
      this.manifest.id,
      profiler,
      this.settings.deleteToWhere ?? 'system',
    )
    const t = (x: TransItemType, vars?: any) => {
      return this.i18n.t(x, vars)
    }

    const getProtectError = (
      protectModifyPercentage: number,
      realModifyDeleteCount: number,
      allFilesCount: number,
    ) => {
      const percent = ((100 * realModifyDeleteCount) / allFilesCount).toFixed(1)
      const res = t('syncrun_abort_protectmodifypercentage', {
        protectModifyPercentage,
        realModifyDeleteCount,
        allFilesCount,
        percent,
      })
      return res
    }

    const getNotice = (
      s: SyncTriggerSourceType,
      msg: string,
      timeout?: number,
    ) => {
      if (s === 'manual' || s === 'dry') {
        new Notice(msg, timeout)
      }
    }

    const notifyFunc = async (s: SyncTriggerSourceType, step: number) => {
      switch (step) {
        case 0:
          if (s === 'dry') {
            if (this.settings.currLogLevel === 'info') {
              getNotice(s, t('syncrun_shortstep0'))
            } else {
              getNotice(s, t('syncrun_step0'))
            }
          }

          break

        case 1:
          if (this.settings.currLogLevel === 'info') {
            getNotice(
              s,
              t('syncrun_shortstep1', {
                serviceType: this.settings.serviceType,
              }),
            )
          } else {
            getNotice(
              s,
              t('syncrun_step1', {
                serviceType: this.settings.serviceType,
              }),
            )
          }
          break

        case 2:
          if (this.settings.currLogLevel === 'info') {
            // pass
          } else {
            getNotice(s, t('syncrun_step2'))
          }
          break

        case 3:
          if (this.settings.currLogLevel === 'info') {
            // pass
          } else {
            getNotice(s, t('syncrun_step3'))
          }
          break

        case 4:
          if (this.settings.currLogLevel === 'info') {
            // pass
          } else {
            getNotice(s, t('syncrun_step4'))
          }
          break

        case 5:
          if (this.settings.currLogLevel === 'info') {
            // pass
          } else {
            getNotice(s, t('syncrun_step5'))
          }
          break

        case 6:
          if (this.settings.currLogLevel === 'info') {
            // pass
          } else {
            getNotice(s, t('syncrun_step6'))
          }
          break

        case 7:
          if (s === 'dry') {
            if (this.settings.currLogLevel === 'info') {
              getNotice(s, t('syncrun_shortstep2skip'))
            } else {
              getNotice(s, t('syncrun_step7skip'))
            }
          } else {
            if (this.settings.currLogLevel === 'info') {
              // pass
            } else {
              getNotice(s, t('syncrun_step7'))
            }
          }
          break

        case 8:
          if (this.settings.currLogLevel === 'info') {
            getNotice(s, t('syncrun_shortstep2'))
          } else {
            getNotice(s, t('syncrun_step8'))
          }
          break

        default:
          throw Error(`unknown step=${step} for showing notice`)
      }
    }

    const errNotifyFunc = async (s: SyncTriggerSourceType, error: Error) => {
      console.error(error)
      if (error instanceof AggregateError) {
        for (const e of error.errors) {
          getNotice(s, e.message, 10 * 1000)
        }
      } else {
        getNotice(s, error?.message ?? 'error while sync', 10 * 1000)
      }
    }

    const ribboonFunc = async (s: SyncTriggerSourceType, step: number) => {
      if (step === 1) {
        if (this.syncRibbon !== undefined) {
          setIcon(this.syncRibbon, iconNameSyncRunning)
          this.syncRibbon.setAttribute(
            'aria-label',
            t('syncrun_syncingribbon', {
              pluginName: this.manifest.name,
              triggerSource: s,
            }),
          )
        }
      } else if (step === 8) {
        // last step
        if (this.syncRibbon !== undefined) {
          setIcon(this.syncRibbon, iconNameSyncWait)
          const originLabel = `${this.manifest.name}`
          this.syncRibbon.setAttribute('aria-label', originLabel)
        }
      }
    }

    const statusBarFunc = async (
      s: SyncTriggerSourceType,
      step: number,
      everythingOk: boolean,
    ) => {
      if (step === 1) {
        // change status to "syncing..." on statusbar
        this.updateLastSyncMsg(s, 'syncing', -1, -1)
      } else if (step === 8 && everythingOk) {
        const ts = Date.now()
        await upsertLastSuccessSyncTimeByVault(this.db, this.vaultRandomID, ts)
        this.updateLastSyncMsg(s, 'not_syncing', ts, null) // hack: 'not_syncing'
      } else if (!everythingOk) {
        const ts = Date.now()
        await upsertLastFailedSyncTimeByVault(this.db, this.vaultRandomID, ts)
        this.updateLastSyncMsg(s, 'not_syncing', null, ts)
      }
    }

    const markIsSyncingFunc = async (isSyncing: boolean) => {
      this.isSyncing = isSyncing
    }

    // The engine reports progress without the trigger source; it's this run's.
    const callbackSyncProcess = async (
      realCounter: number,
      realTotalCount: number,
      pathName: string,
      decision: string,
    ) => {
      this.setCurrSyncMsg(
        t,
        triggerSource,
        realCounter,
        realTotalCount,
        pathName,
        decision,
      )
    }

    // Shown on every run, auto ones included: a conflict copy is a new file.
    const callbackConflictCopy = (key: string, copyKey: string) => {
      new Notice(
        t('syncrun_conflictcopy', {
          pluginName: this.manifest.name,
          key,
          copyKey,
        }),
        10 * 1000,
      )
    }

    if (this.isSyncing) {
      getNotice(
        triggerSource,
        t('syncrun_alreadyrunning', {
          pluginName: this.manifest.name,
          syncStatus: 'running',
          newTriggerSource: triggerSource,
        }),
      )

      if (this.currSyncMsg !== undefined && this.currSyncMsg !== '') {
        getNotice(triggerSource, this.currSyncMsg)
      }
      return
    }

    // one lock over every remote's run, which sync-on-save checks too
    await markIsSyncingFunc(true)
    try {
      await syncAllRemotes(this.settings, {
        fsLocal,
        db: this.db,
        vaultRandomID: this.vaultRandomID,
        configDir: this.app.vault.configDir,
        triggerSource,
        profiler,
        makeFs: (remote, slice) =>
          getClient(
            slice,
            this.app.vault.getName(),
            async () => await this.saveSettings(),
            remote.github,
            (msg) => new Notice(msg, 10 * 1000),
          ),
        makeEncrypt: (fs, slice) =>
          new FakeFsEncrypt(
            fs,
            slice.password ?? '',
            slice.encryptionMethod ?? 'rclone-base64',
          ),
        getProtectError,
        saveSettings: async () => await this.saveSettings(),
        notice: (msg) => new Notice(msg, 10 * 1000),
        askHeld: async (q) => await askHeldQuestion(this.app, q),
        onRemoteStart: (remote) => {
          this.syncingRemote =
            (this.settings.remotes ?? []).length > 1 ? remote.name : undefined
        },
        onRemoteResult: (remote, result) => {
          this.remoteResults.set(remote.id, result)
        },
        runCallbacks: {
          notifyFunc,
          errNotifyFunc,
          ribbonFunc: ribboonFunc,
          statusBarFunc,
          callbackSyncProcess,
          callbackConflictCopy,
        },
      })
    } finally {
      this.syncingRemote = undefined
      await markIsSyncingFunc(false)
    }

    ;(profiler as Profiler | undefined)?.clear()

    this.syncEvent?.trigger('SYNC_DONE')
  }

  async onload() {
    console.info(`loading plugin ${this.manifest.id}`)

    const { iconSvgSyncWait, iconSvgSyncRunning, iconSvgLogs } = getIconSvg()

    addIcon(iconNameSyncWait, iconSvgSyncWait)
    addIcon(iconNameSyncRunning, iconSvgSyncRunning)
    addIcon(iconNameLogs, iconSvgLogs)

    this.oauth2Info = {
      verifier: '',
      helperModal: undefined,
      authDiv: undefined,
      revokeDiv: undefined,
      revokeAuthSetting: undefined,
    } // init

    this.currSyncMsg = ''
    this.isSyncing = false
    this.hasPendingSyncOnSave = false

    this.syncEvent = new Events()

    await this.loadSettings()

    // lang should be load early, but after settings
    this.i18n = new I18n(this.settings.lang!, async (lang: LangTypeAndAuto) => {
      this.settings.lang = lang
      await this.saveSettings()
    })
    const t = (x: TransItemType, vars?: any) => {
      return this.i18n.t(x, vars)
    }

    await this.checkIfOauthExpires()

    // MUST before prepareDB()
    // And, it's also possible to be an empty string,
    // which means the vaultRandomID is read from db later!
    const vaultRandomIDFromOldConfigFile =
      await this.getVaultRandomIDFromOldConfigFile()

    // no need to await this
    this.tryToAddIgnoreFile()

    const vaultBasePath = this.getVaultBasePath()

    try {
      await this.prepareDBAndVaultRandomID(
        vaultBasePath,
        vaultRandomIDFromOldConfigFile,
        // the single-remote setup's profile; the records move on below
        LEGACY_PROFILE_ID,
      )
    } catch (err: any) {
      new Notice(
        err?.message ?? 'error of prepareDBAndVaultRandomID',
        10 * 1000,
      )
      throw err
    }

    // must AFTER preparing DB: every load, so a load cut short still moves them
    const migrated = this.settings.remotes?.find((r) => r.id === 'dropbox')
    if (migrated !== undefined) {
      await moveProfileRecords(
        this.db,
        this.vaultRandomID,
        LEGACY_PROFILE_ID,
        profileIdOf(migrated),
      )
    }

    // must AFTER preparing DB
    this.enableAutoClearOutputToDBHistIfSet()

    // must AFTER preparing DB
    this.enableAutoClearSyncPlanHist()

    // A routed folder renamed in Obsidian: the route follows, and the next
    // sync renames it on its remote and in its records before it runs.
    this.registerEvent(
      this.app.vault.on('rename', async (file, oldPath) => {
        if (
          file instanceof TFolder &&
          recordFolderRename(this.settings, oldPath, file.path, Date.now())
        ) {
          await this.saveSettings()
        }
      }),
    )

    this.registerObsidianProtocolHandler(COMMAND_URI, async (inputParams) => {
      // console.debug(inputParams);
      const parsed = importQrCodeUri(inputParams, this.app.vault.getName())
      if (parsed.status === 'error') {
        new Notice(parsed.message)
      } else {
        const copied = cloneDeep(parsed.result)
        // new Notice(JSON.stringify(copied))
        this.settings = Object.assign({}, this.settings, copied)
        this.saveSettings()
        new Notice(
          t('protocol_saveqr', {
            manifestName: this.manifest.name,
          }),
        )
      }
    })

    this.registerObsidianProtocolHandler(
      COMMAND_CALLBACK,
      async (inputParams) => {
        new Notice(
          t('protocol_callbacknotsupported', {
            params: JSON.stringify(inputParams),
          }),
        )
      },
    )

    this.registerObsidianProtocolHandler(
      COMMAND_CALLBACK_DROPBOX,
      async (inputParams) => {
        if (
          inputParams.code !== undefined &&
          this.oauth2Info?.verifier !== undefined
        ) {
          if (this.oauth2Info.helperModal !== undefined) {
            const k = this.oauth2Info.helperModal.contentEl
            k.empty()

            t('protocol_dropbox_connecting')
              .split('\n')
              .forEach((val) => {
                k.createEl('p', {
                  text: val,
                })
              })
          } else {
            new Notice(t('protocol_dropbox_no_modal'))
            return
          }

          const authRes = await sendAuthReqDropbox(
            this.settings.dropbox.clientID,
            this.oauth2Info.verifier,
            inputParams.code,
            async (e: any) => {
              new Notice(t('protocol_dropbox_connect_fail'))
              new Notice(`${e}`)
              throw e
            },
          )

          const self = this
          setConfigBySuccessfullAuthInplaceDropbox(
            this.settings.dropbox,
            authRes!,
            () => self.saveSettings(),
          )

          const client = getClient(
            this.settings,
            this.app.vault.getName(),
            () => self.saveSettings(),
          )
          const username = await client.getUserDisplayName()
          this.settings.dropbox.username = username
          await this.saveSettings()

          new Notice(
            t('protocol_dropbox_connect_succ', {
              username: username,
            }),
          )

          this.oauth2Info.verifier = '' // reset it
          this.oauth2Info.helperModal?.close() // close it
          this.oauth2Info.helperModal = undefined

          this.oauth2Info.authDiv?.toggleClass(
            'dropbox-auth-button-hide',
            this.settings.dropbox.username !== '',
          )
          this.oauth2Info.authDiv = undefined

          this.oauth2Info.revokeAuthSetting?.setDesc(
            t('protocol_dropbox_connect_succ_revoke', {
              username: this.settings.dropbox.username,
            }),
          )
          this.oauth2Info.revokeAuthSetting = undefined
          this.oauth2Info.revokeDiv?.toggleClass(
            'dropbox-revoke-auth-button-hide',
            this.settings.dropbox.username === '',
          )
          this.oauth2Info.revokeDiv = undefined
        } else {
          new Notice(t('protocol_dropbox_connect_fail'))
          throw Error(
            t('protocol_dropbox_connect_unknown', {
              params: JSON.stringify(inputParams),
            }),
          )
        }
      },
    )

    this.syncRibbon = this.addRibbonIcon(
      iconNameSyncWait,
      `${this.manifest.name}`,
      async () => this.syncRun('manual'),
    )

    this.enableMobileStatusBarIfSet()

    // Create Status Bar Item
    if (
      (!Platform.isMobile ||
        (Platform.isMobile && this.settings.enableMobileStatusBar)) &&
      this.settings.enableStatusBarInfo === true
    ) {
      const statusBarItem = this.addStatusBarItem()
      this.statusBarElement = statusBarItem.createEl('span')
      this.statusBarElement.setAttribute('data-tooltip-position', 'top')
      // the per-remote detail: last run, result, last error, a held question
      statusBarItem.onClickEvent(() => {
        if ((this.settings.remotes ?? []).length > 1) {
          new Notice(
            remoteDetail(this.settings.remotes ?? [], this.remoteResults).join(
              '\n',
            ),
            15 * 1000,
          )
        }
      })

      if (!this.isSyncing) {
        this.updateLastSyncMsg(
          undefined,
          'not_syncing',
          await getLastSuccessSyncTimeByVault(this.db, this.vaultRandomID),
          await getLastFailedSyncTimeByVault(this.db, this.vaultRandomID),
        )
      }
      // update statusbar text every 30 seconds
      this.registerInterval(
        window.setInterval(async () => {
          if (!this.isSyncing) {
            this.updateLastSyncMsg(
              undefined,
              'not_syncing',
              await getLastSuccessSyncTimeByVault(this.db, this.vaultRandomID),
              await getLastFailedSyncTimeByVault(this.db, this.vaultRandomID),
            )
          }
        }, 1000 * 30),
      )
    }

    this.addCommand({
      id: 'start-sync',
      name: t('command_startsync'),
      icon: iconNameSyncWait,
      callback: async () => {
        this.syncRun('manual')
      },
    })

    this.addCommand({
      id: 'start-sync-dry-run',
      name: t('command_drynrun'),
      icon: iconNameSyncWait,
      callback: async () => {
        this.syncRun('dry')
      },
    })

    this.addCommand({
      id: 'export-sync-plans-1-only-change',
      name: t('command_exportsyncplans_1_only_change'),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultSyncPlansToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID,
          1,
          true,
        )
        new Notice(t('settings_syncplans_notice'))
      },
    })

    this.addCommand({
      id: 'export-sync-plans-1',
      name: t('command_exportsyncplans_1'),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultSyncPlansToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID,
          1,
          false,
        )
        new Notice(t('settings_syncplans_notice'))
      },
    })

    this.addCommand({
      id: 'export-sync-plans-5',
      name: t('command_exportsyncplans_5'),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultSyncPlansToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID,
          5,
          false,
        )
        new Notice(t('settings_syncplans_notice'))
      },
    })

    this.addCommand({
      id: 'export-sync-plans-all',
      name: t('command_exportsyncplans_all'),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultSyncPlansToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID,
          -1,
          false,
        )
        new Notice(t('settings_syncplans_notice'))
      },
    })

    this.addSettingTab(new RemotelySaveSettingTab(this.app, this))

    // this.registerDomEvent(document, "click", (evt: MouseEvent) => {
    //   console.info("click", evt);
    // });

    this.enableCheckingFileStat()

    if (!this.settings.agreeToUseSyncV3) {
      const syncAlgoV3Modal = new SyncAlgoV3Modal(this.app, this)
      syncAlgoV3Modal.open()
    } else {
      this.enableAutoSyncIfSet()
      this.enableInitSyncIfSet()
      this.toggleSyncOnSaveIfSet()
    }

    // compare versions and read new versions
    const { oldVersion } = await upsertPluginVersionByVault(
      this.db,
      this.vaultRandomID,
      this.manifest.version,
    )
  }

  async onunload() {
    console.info(`unloading plugin ${this.manifest.id}`)
    this.syncRibbon = undefined
    if (this.appContainerObserver !== undefined) {
      this.appContainerObserver.disconnect()
      this.appContainerObserver = undefined
    }
    if (this.oauth2Info !== undefined) {
      this.oauth2Info.helperModal = undefined
      this.oauth2Info = {
        verifier: '',
        helperModal: undefined,
        authDiv: undefined,
        revokeDiv: undefined,
        revokeAuthSetting: undefined,
      }
    }
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      cloneDeep(DEFAULT_SETTINGS),
      messyConfigToNormal(await this.loadData()),
    )

    if (this.settings.dropbox.clientID === '') {
      this.settings.dropbox.clientID = DEFAULT_SETTINGS.dropbox.clientID
    }
    if (this.settings.dropbox.remoteBaseDir === undefined) {
      this.settings.dropbox.remoteBaseDir = ''
    }

    // Settings imported from upstream may name a service this fork dropped.
    if (this.settings.serviceType !== 'dropbox') {
      this.settings.serviceType = 'dropbox'
    }

    if (this.settings.ignorePaths === undefined) {
      this.settings.ignorePaths = []
    }
    if (this.settings.enableStatusBarInfo === undefined) {
      this.settings.enableStatusBarInfo = true
    }
    if (this.settings.syncOnSaveAfterMilliseconds === undefined) {
      this.settings.syncOnSaveAfterMilliseconds = -1
    }
    if (this.settings.deleteToWhere === undefined) {
      this.settings.deleteToWhere = 'system'
    }
    this.settings.logToDB = false // deprecated as of 20240113

    if (this.settings.agreeToUseSyncV3 === undefined) {
      this.settings.agreeToUseSyncV3 = false
    }
    // A choice the engine doesn't know (upstream's paid smart_conflict among
    // them) would leave a conflict undecided, so it falls back to the default.
    if (
      this.settings.conflictAction !== 'keep_newer' &&
      this.settings.conflictAction !== 'keep_larger' &&
      this.settings.conflictAction !== 'smart'
    ) {
      this.settings.conflictAction = 'smart'
    }
    if (this.settings.howToCleanEmptyFolder === undefined) {
      this.settings.howToCleanEmptyFolder = 'clean_both'
    }
    if (this.settings.protectModifyPercentage === undefined) {
      this.settings.protectModifyPercentage = 50
    }
    // Upstream's paid "and delete" directions fall back to their incremental
    // forms, which never delete, rather than to a full two-way sync.
    const syncDirection: string | undefined = this.settings.syncDirection
    if (syncDirection === 'incremental_pull_and_delete_only') {
      this.settings.syncDirection = 'incremental_pull_only'
    } else if (syncDirection === 'incremental_push_and_delete_only') {
      this.settings.syncDirection = 'incremental_push_only'
    } else if (syncDirection === undefined) {
      this.settings.syncDirection = 'bidirectional'
    }

    if (this.settings.obfuscateSettingFile === undefined) {
      this.settings.obfuscateSettingFile = true
    }

    if (this.settings.enableMobileStatusBar === undefined) {
      this.settings.enableMobileStatusBar = false
    }

    if (
      this.settings.encryptionMethod === undefined ||
      this.settings.encryptionMethod === 'unknown'
    ) {
      if (
        this.settings.password === undefined ||
        this.settings.password === ''
      ) {
        // we have a preferred way
        this.settings.encryptionMethod = 'rclone-base64'
      } else {
        // likely to be inherited from the old version
        this.settings.encryptionMethod = 'openssl-base64'
      }
    }

    if (this.settings.profiler === undefined) {
      this.settings.profiler = DEFAULT_PROFILER_CONFIG
    }
    if (this.settings.profiler.enable === undefined) {
      this.settings.profiler.enable = false
    }
    if (this.settings.profiler.enablePrinting === undefined) {
      this.settings.profiler.enablePrinting = false
    }
    if (this.settings.profiler.recordSize === undefined) {
      this.settings.profiler.recordSize = false
    }

    // A single-remote setup becomes the remote `dropbox`, `default → dropbox`;
    // its records move to that remote's profile once the database is open.
    migrateToRemotes(this.settings)

    await this.saveSettings()
  }

  async saveSettings() {
    if (this.settings.obfuscateSettingFile) {
      await this.saveData(normalConfigToMessy(this.settings))
    } else {
      await this.saveData(this.settings)
    }
  }

  async checkIfOauthExpires() {
    let needSave = false
    const current = Date.now()

    // fullfill old version settings
    if (
      this.settings.dropbox.refreshToken !== '' &&
      this.settings.dropbox.credentialsShouldBeDeletedAtTime === undefined
    ) {
      // It has a refreshToken, but not expire time.
      // Likely to be a setting from old version.
      // we set it to a month.
      this.settings.dropbox.credentialsShouldBeDeletedAtTime =
        current + 1000 * 60 * 60 * 24 * 30
      needSave = true
    }

    // check expired or not
    let dropboxExpired = false
    if (
      this.settings.dropbox.refreshToken !== '' &&
      current >= this.settings!.dropbox!.credentialsShouldBeDeletedAtTime!
    ) {
      console.warn(`dropbox expired`)
      dropboxExpired = true
      this.settings.dropbox = cloneDeep(DEFAULT_DROPBOX_CONFIG)
      needSave = true
    }

    // save back
    if (needSave) {
      await this.saveSettings()
    }

    // send notice
    if (dropboxExpired) {
      new Notice(
        `${this.manifest.name}: You haven't manually auth Dropbox for many days, you need to re-auth it again.`,
        6000,
      )
    }
  }

  async getVaultRandomIDFromOldConfigFile() {
    let vaultRandomID = ''
    if (this.settings.vaultRandomID !== undefined) {
      // In old version, the vault id is saved in data.json
      // But we want to store it in localForage later
      if (this.settings.vaultRandomID !== '') {
        // a real string was assigned before
        vaultRandomID = this.settings.vaultRandomID
      }
      console.debug('vaultRandomID is no longer saved in data.json')
      delete this.settings.vaultRandomID
      await this.saveSettings()
    }
    return vaultRandomID
  }

  async trash(x: string) {
    if (this.settings.deleteToWhere === 'obsidian') {
      await this.app.vault.adapter.trashLocal(x)
    } else {
      // "system"
      if (!(await this.app.vault.adapter.trashSystem(x))) {
        await this.app.vault.adapter.trashLocal(x)
      }
    }
  }

  getVaultBasePath() {
    if (this.app.vault.adapter instanceof FileSystemAdapter) {
      // in desktop
      return this.app.vault.adapter.getBasePath().split('?')[0]
    } else {
      // in mobile
      return this.app.vault.adapter.getResourcePath('').split('?')[0]
    }
  }

  async prepareDBAndVaultRandomID(
    vaultBasePath: string,
    vaultRandomIDFromOldConfigFile: string,
    profileID: string,
  ) {
    const { db, vaultRandomID } = await prepareDBs(
      vaultBasePath,
      vaultRandomIDFromOldConfigFile,
      profileID,
    )
    this.db = db
    this.vaultRandomID = vaultRandomID
  }

  enableAutoSyncIfSet() {
    if (
      this.settings.autoRunEveryMilliseconds !== undefined &&
      this.settings.autoRunEveryMilliseconds !== null &&
      this.settings.autoRunEveryMilliseconds > 0
    ) {
      this.app.workspace.onLayoutReady(() => {
        const intervalID = window.setInterval(() => {
          this.syncRun('auto')
        }, this.settings.autoRunEveryMilliseconds)
        this.autoRunIntervalID = intervalID
        this.registerInterval(intervalID)
      })
    }
  }

  enableInitSyncIfSet() {
    if (
      this.settings.initRunAfterMilliseconds !== undefined &&
      this.settings.initRunAfterMilliseconds !== null &&
      this.settings.initRunAfterMilliseconds > 0
    ) {
      this.app.workspace.onLayoutReady(() => {
        window.setTimeout(() => {
          this.syncRun('auto_once_init')
        }, this.settings.initRunAfterMilliseconds)
      })
    }
  }

  async _checkCurrFileModified(caller: 'SYNC' | 'FILE_CHANGES') {
    console.debug(`inside checkCurrFileModified`)
    const currentFile = this.app.workspace.getActiveFile()

    if (currentFile) {
      console.debug(`we have currentFile=${currentFile.path}`)
      // get the last modified time of the current file
      // if it has modified after lastSuccessSync
      // then schedule a run for syncOnSaveAfterMilliseconds after it was modified
      const lastModified = currentFile.stat.mtime
      const lastSuccessSyncMillis = await getLastSuccessSyncTimeByVault(
        this.db,
        this.vaultRandomID,
      )

      console.debug(
        `lastModified=${lastModified}, lastSuccessSyncMillis=${lastSuccessSyncMillis}`,
      )

      if (
        caller === 'SYNC' ||
        (caller === 'FILE_CHANGES' &&
          lastModified > (lastSuccessSyncMillis ?? 1))
      ) {
        console.debug(
          `so lastModified > lastSuccessSyncMillis or it's called while syncing before`,
        )
        console.debug(
          `caller=${caller}, isSyncing=${this.isSyncing}, hasPendingSyncOnSave=${this.hasPendingSyncOnSave}`,
        )
        if (this.isSyncing) {
          this.hasPendingSyncOnSave = true
          // wait for next event
          return
        } else {
          if (this.hasPendingSyncOnSave || caller === 'FILE_CHANGES') {
            this.hasPendingSyncOnSave = false
            await this.syncRun('auto_sync_on_save')
          }
          return
        }
      }
    } else {
      console.debug(`no currentFile here`)
    }
  }

  _syncOnSaveEvent1 = () => {
    this._checkCurrFileModified('SYNC')
  }

  _syncOnSaveEvent2 = throttle(
    async () => {
      await this._checkCurrFileModified('FILE_CHANGES')
    },
    1000 * 3,
    {
      leading: false,
      trailing: true,
    },
  )

  toggleSyncOnSaveIfSet() {
    if (
      this.settings.syncOnSaveAfterMilliseconds !== undefined &&
      this.settings.syncOnSaveAfterMilliseconds !== null &&
      this.settings.syncOnSaveAfterMilliseconds > 0
    ) {
      this.app.workspace.onLayoutReady(() => {
        // listen to sync done
        this.registerEvent(
          this.syncEvent?.on('SYNC_DONE', this._syncOnSaveEvent1)!,
        )

        // listen to current file save changes
        this.registerEvent(this.app.vault.on('modify', this._syncOnSaveEvent2))
        this.registerEvent(this.app.vault.on('create', this._syncOnSaveEvent2))
        this.registerEvent(this.app.vault.on('delete', this._syncOnSaveEvent2))
        this.registerEvent(this.app.vault.on('rename', this._syncOnSaveEvent2))
      })
    } else {
      this.syncEvent?.off('SYNC_DONE', this._syncOnSaveEvent1)
      this.app.vault.off('modify', this._syncOnSaveEvent2)
      this.app.vault.off('create', this._syncOnSaveEvent2)
      this.app.vault.off('delete', this._syncOnSaveEvent2)
      this.app.vault.off('rename', this._syncOnSaveEvent2)
    }
  }

  enableMobileStatusBarIfSet() {
    this.app.workspace.onLayoutReady(() => {
      if (Platform.isMobile && this.settings.enableMobileStatusBar) {
        this.appContainerObserver = changeMobileStatusBar('enable')
      }
    })
  }

  enableCheckingFileStat() {
    this.app.workspace.onLayoutReady(() => {
      const t = (x: TransItemType, vars?: any) => {
        return this.i18n.t(x, vars)
      }
      this.registerEvent(
        this.app.workspace.on('file-menu', (menu, file) => {
          if (file instanceof TFolder) {
            // folder not supported yet
            return
          }

          menu.addItem((item) => {
            item
              .setTitle(t('menu_check_file_stat'))
              .setIcon('file-cog')
              .onClick(async () => {
                const filePath = file.path
                const fsLocal = new FakeFsLocal(
                  this.app.vault,
                  this.settings.syncConfigDir ?? false,
                  this.app.vault.configDir,
                  this.manifest.id,
                  undefined,
                  this.settings.deleteToWhere ?? 'system',
                )
                const s = await fsLocal.stat(filePath)
                new Notice(JSON.stringify(s, null, 2), 10000)
              })
          })
        }),
      )
    })
  }

  async saveAgreeToUseNewSyncAlgorithm() {
    this.settings.agreeToUseSyncV3 = true
    await this.saveSettings()
  }

  setCurrSyncMsg(
    t: (x: TransItemType, vars?: any) => string,
    s: SyncTriggerSourceType,
    i: number,
    totalCount: number,
    pathName: string,
    decision: string,
  ) {
    const L = `${totalCount}`.length
    const iStr = `${i}`.padStart(L, '0')
    const prefix = getStatusBarShortMsgFromSyncSource(t, s)
    const shortMsg = prefix + `Syncing ${iStr}/${totalCount}`
    const longMsg =
      prefix +
      `Syncing progress=${iStr}/${totalCount},decision=${decision},path=${pathName},source=${s}`
    this.currSyncMsg = longMsg

    if (this.statusBarElement !== undefined) {
      this.statusBarElement.setText(shortMsg)
      this.statusBarElement.setAttribute('aria-label', longMsg)
    }
  }

  updateLastSyncMsg(
    s: SyncTriggerSourceType | undefined,
    syncStatus: 'not_syncing' | 'syncing',
    lastSuccessSyncMillis: number | null | undefined,
    lastFailedSyncMillis: number | null | undefined,
  ) {
    if (this.statusBarElement === undefined) return

    // console.debug(lastSuccessSyncMillis);
    // console.debug(lastFailedSyncMillis);

    const t = (x: TransItemType, vars?: any) => {
      return this.i18n.t(x, vars)
    }

    let lastSyncMsg = t('statusbar_lastsync_never')
    let lastSyncLabelMsg = t('statusbar_lastsync_never_label')

    const inputTs = Math.max(
      lastSuccessSyncMillis ?? -999,
      lastFailedSyncMillis ?? -999,
    )
    const isSuccess =
      (lastSuccessSyncMillis ?? -999) >= (lastFailedSyncMillis ?? -999)

    if (syncStatus === 'syncing' && this.syncingRemote !== undefined) {
      // several remotes: which one is running
      lastSyncMsg = `Syncing ${this.syncingRemote}…`
    } else if (syncStatus === 'syncing') {
      lastSyncMsg =
        getStatusBarShortMsgFromSyncSource(t, s!) + t('statusbar_syncing')
    } else if (inputTs > 0) {
      let prefix = ''
      if (isSuccess) {
        prefix = t('statusbar_sync_status_prefix_success')
      } else {
        prefix = t('statusbar_sync_status_prefix_failed')
      }

      const deltaTime = Date.now() - inputTs
      // create human readable time
      const years = Math.floor(deltaTime / 31556952000)
      const months = Math.floor(deltaTime / 2629746000)
      const weeks = Math.floor(deltaTime / 604800000)
      const days = Math.floor(deltaTime / 86400000)
      const hours = Math.floor(deltaTime / 3600000)
      const minutes = Math.floor(deltaTime / 60000)
      const seconds = Math.floor(deltaTime / 1000)
      let timeText = ''
      if (years > 0) {
        timeText = t('statusbar_time_years', { time: years })
      } else if (months > 0) {
        timeText = t('statusbar_time_months', { time: months })
      } else if (weeks > 0) {
        timeText = t('statusbar_time_weeks', { time: weeks })
      } else if (days > 0) {
        timeText = t('statusbar_time_days', { time: days })
      } else if (hours > 0) {
        timeText = t('statusbar_time_hours', { time: hours })
      } else if (minutes > 0) {
        timeText = t('statusbar_time_minutes', { time: minutes })
      } else if (seconds > 30) {
        timeText = t('statusbar_time_lessminute')
      } else {
        timeText = t('statusbar_time_now')
      }
      const dateText = new Date(inputTs).toLocaleTimeString(
        navigator.language,
        {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        },
      )

      lastSyncMsg = prefix + timeText
      lastSyncLabelMsg =
        prefix + t('statusbar_lastsync_label', { date: dateText })
    } else {
      // TODO: no idea what happened.
    }

    if (syncStatus !== 'syncing') {
      const marks = remoteMarks(this.settings.remotes ?? [], this.remoteResults)
      lastSyncMsg += marks.text
      lastSyncLabelMsg += marks.label
    }
    this.statusBarElement.setText(lastSyncMsg)
    this.statusBarElement.setAttribute('aria-label', lastSyncLabelMsg)
  }

  /**
   * Because data.json contains sensitive information,
   * We usually want to ignore it in the version control.
   * However, if there's already a an ignore file (even empty),
   * we respect the existing configure and not add any modifications.
   * @returns
   */
  async tryToAddIgnoreFile() {
    const pluginConfigDir =
      this.manifest.dir ||
      `${this.app.vault.configDir}/plugins/${this.manifest.dir}`
    const pluginConfigDirExists =
      await this.app.vault.adapter.exists(pluginConfigDir)
    if (!pluginConfigDirExists) {
      // what happened?
      return
    }
    const ignoreFile = `${pluginConfigDir}/.gitignore`
    const ignoreFileExists = await this.app.vault.adapter.exists(ignoreFile)

    const contentText = 'data.json\n'

    try {
      if (!ignoreFileExists) {
        // not exists, directly create
        // no need to await
        this.app.vault.adapter.write(ignoreFile, contentText)
      }
    } catch (error) {
      // just skip
    }
  }

  enableAutoClearOutputToDBHistIfSet() {
    const initClearOutputToDBHistAfterMilliseconds = 1000 * 30

    this.app.workspace.onLayoutReady(() => {
      // init run
      window.setTimeout(() => {
        clearAllLoggerOutputRecords(this.db)
      }, initClearOutputToDBHistAfterMilliseconds)
    })
  }

  enableAutoClearSyncPlanHist() {
    const initClearSyncPlanHistAfterMilliseconds = 1000 * 45
    const autoClearSyncPlanHistAfterMilliseconds = 1000 * 60 * 5

    this.app.workspace.onLayoutReady(() => {
      // init run
      window.setTimeout(() => {
        clearExpiredSyncPlanRecords(this.db)
      }, initClearSyncPlanHistAfterMilliseconds)

      // scheduled run
      const intervalID = window.setInterval(() => {
        clearExpiredSyncPlanRecords(this.db)
      }, autoClearSyncPlanHistAfterMilliseconds)
      this.registerInterval(intervalID)
    })
  }
}
