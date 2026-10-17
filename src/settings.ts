// Changed for Remotely Save Lite (2026): Dropbox only, no paid account, settings the free engine can't honour removed, its own name and protocol action, Smart Conflict offered and its copies cleared with the sync records
import { Eye, EyeOff, createElement } from 'lucide'
import {
  type App,
  Modal,
  Notice,
  Platform,
  PluginSettingTab,
  Setting,
} from 'obsidian'
import type { TextComponent } from 'obsidian'
import type {
  CipherMethodType,
  ConflictActionType,
  EmptyFolderCleanType,
  QRExportType,
  SUPPORTED_SERVICES_TYPE,
  SyncDirectionType,
} from './baseTypes'
import { COMMAND_URI } from './baseTypes'

import cloneDeep from 'lodash/cloneDeep'
import { messyConfigToNormal } from './configPersist'
import {
  exportVaultProfilerResultsToFiles,
  exportVaultSyncPlansToFiles,
} from './debugMode'
import {
  DEFAULT_DROPBOX_CONFIG,
  getAuthUrlAndVerifier as getAuthUrlAndVerifierDropbox,
  sendAuthReq as sendAuthReqDropbox,
  setConfigBySuccessfullAuthInplace,
} from './fsDropbox'
import { getClient } from './fsGetter'
import type { TransItemType } from './i18n'
import {
  exportQrCodeUri,
  importQrCodeUri,
  parseUriByHand,
} from './importExport'
import {
  clearAllPrevSyncRecordByVault,
  clearAllSyncBasesByVault,
  clearAllSyncPlanRecords,
  destroyDBs,
  upsertLastFailedSyncTimeByVault,
  upsertLastSuccessSyncTimeByVault,
} from './localdb'
import type RemotelySavePlugin from './main' // unavoidable
import {
  changeMobileStatusBar,
  checkHasSpecialCharForDir,
  stringToFragment,
} from './misc'
import { DEFAULT_PROFILER_CONFIG } from './profiler'

class PasswordModal extends Modal {
  plugin: RemotelySavePlugin
  newPassword: string
  encryptionMethodSetting: Setting
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    newPassword: string,
    encryptionMethodSetting: Setting,
  ) {
    super(app)
    this.plugin = plugin
    this.newPassword = newPassword
    this.encryptionMethodSetting = encryptionMethodSetting
  }

  onOpen() {
    const { contentEl } = this

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars)
    }

    // contentEl.setText("Add Or change password.");
    contentEl.createEl('h2', { text: t('modal_password_title') })
    t('modal_password_shortdesc')
      .split('\n')
      .forEach((val, idx) => {
        contentEl.createEl('p', {
          text: val,
        })
      })

    ;[
      t('modal_password_attn1'),
      t('modal_password_attn2'),
      t('modal_password_attn3'),
      t('modal_password_attn4'),
      t('modal_password_attn5'),
    ].forEach((val, idx) => {
      if (idx < 3) {
        contentEl.createEl('p', {
          text: val,
          cls: 'password-disclaimer',
        })
      } else {
        contentEl.createEl('p', {
          text: val,
        })
      }
    })

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText(t('modal_password_secondconfirm'))
        button.onClick(async () => {
          this.plugin.settings.password = this.newPassword
          if (this.newPassword !== '') {
            this.encryptionMethodSetting.settingEl.removeClass(
              'settings-encryption-method-hide',
            )
          } else {
            this.encryptionMethodSetting.settingEl.addClass(
              'settings-encryption-method-hide',
            )
          }

          await this.plugin.saveSettings()
          new Notice(t('modal_password_notice'))
          this.close()
        })
        button.setClass('password-second-confirm')
      })
      .addButton((button) => {
        button.setButtonText(t('goback'))
        button.onClick(() => {
          this.close()
        })
      })
  }

  onClose() {
    const { contentEl } = this
    contentEl.empty()
  }
}

class EncryptionMethodModal extends Modal {
  plugin: RemotelySavePlugin
  constructor(app: App, plugin: RemotelySavePlugin) {
    super(app)
    this.plugin = plugin
  }

  onOpen() {
    const { contentEl } = this

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars)
    }

    // contentEl.setText("Add Or change password.");
    contentEl.createEl('h2', { text: t('modal_encryptionmethod_title') })
    t('modal_encryptionmethod_shortdesc')
      .split('\n')
      .forEach((val, idx) => {
        contentEl.createEl('p', {
          text: stringToFragment(val),
        })
      })

    new Setting(contentEl).addButton((button) => {
      button.setButtonText(t('confirm'))
      button.onClick(async () => {
        this.close()
      })
      button.setClass('encryptionmethod-second-confirm')
    })
  }

  onClose() {
    const { contentEl } = this
    contentEl.empty()
  }
}

export class ChangeRemoteBaseDirModal extends Modal {
  readonly plugin: RemotelySavePlugin
  readonly newRemoteBaseDir: string
  readonly service: SUPPORTED_SERVICES_TYPE
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    newRemoteBaseDir: string,
    service: SUPPORTED_SERVICES_TYPE,
  ) {
    super(app)
    this.plugin = plugin
    this.newRemoteBaseDir = newRemoteBaseDir
    this.service = service
  }

  onOpen() {
    const { contentEl } = this

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars)
    }

    contentEl.createEl('h2', { text: t('modal_remotebasedir_title') })
    t('modal_remotebasedir_shortdesc')
      .split('\n')
      .forEach((val, idx) => {
        contentEl.createEl('p', {
          text: val,
        })
      })

    if (
      this.newRemoteBaseDir === '' ||
      this.newRemoteBaseDir === this.app.vault.getName()
    ) {
      new Setting(contentEl)
        .addButton((button) => {
          button.setButtonText(t('modal_remotebasedir_secondconfirm_vaultname'))
          button.onClick(async () => {
            // in the settings, the value is reset to the special case ""
            this.plugin.settings[this.service].remoteBaseDir = ''
            await this.plugin.saveSettings()
            new Notice(t('modal_remotebasedir_notice'))
            this.close()
          })
          button.setClass('remotebasedir-second-confirm')
        })
        .addButton((button) => {
          button.setButtonText(t('goback'))
          button.onClick(() => {
            this.close()
          })
        })
    } else if (checkHasSpecialCharForDir(this.newRemoteBaseDir)) {
      contentEl.createEl('p', {
        text: t('modal_remotebasedir_invaliddirhint'),
      })
      new Setting(contentEl).addButton((button) => {
        button.setButtonText(t('goback'))
        button.onClick(() => {
          this.close()
        })
      })
    } else {
      new Setting(contentEl)
        .addButton((button) => {
          button.setButtonText(t('modal_remotebasedir_secondconfirm_change'))
          button.onClick(async () => {
            this.plugin.settings[this.service].remoteBaseDir =
              this.newRemoteBaseDir
            await this.plugin.saveSettings()
            new Notice(t('modal_remotebasedir_notice'))
            this.close()
          })
          button.setClass('remotebasedir-second-confirm')
        })
        .addButton((button) => {
          button.setButtonText(t('goback'))
          button.onClick(() => {
            this.close()
          })
        })
    }
  }

  onClose() {
    const { contentEl } = this
    contentEl.empty()
  }
}

class DropboxAuthModal extends Modal {
  readonly plugin: RemotelySavePlugin
  readonly authDiv: HTMLDivElement
  readonly revokeAuthDiv: HTMLDivElement
  readonly revokeAuthSetting: Setting
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    authDiv: HTMLDivElement,
    revokeAuthDiv: HTMLDivElement,
    revokeAuthSetting: Setting,
  ) {
    super(app)
    this.plugin = plugin
    this.authDiv = authDiv
    this.revokeAuthDiv = revokeAuthDiv
    this.revokeAuthSetting = revokeAuthSetting
  }

  async onOpen() {
    const { contentEl } = this

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars)
    }

    let needManualPatse = false
    const userAgent = window.navigator.userAgent.toLocaleLowerCase() || ''
    // some users report that,
    // the Linux would open another instance Obsidian if jumping back,
    // so fallback to manual paste on Linux
    if (
      Platform.isDesktopApp &&
      !Platform.isMacOS &&
      (/linux/.test(userAgent) ||
        /ubuntu/.test(userAgent) ||
        /debian/.test(userAgent) ||
        /fedora/.test(userAgent) ||
        /centos/.test(userAgent))
    ) {
      needManualPatse = true
    }

    const { authUrl, verifier } = await getAuthUrlAndVerifierDropbox(
      this.plugin.settings.dropbox.clientID,
      needManualPatse,
    )

    if (needManualPatse) {
      t('modal_dropboxauth_manualsteps')
        .split('\n')
        .forEach((val) => {
          contentEl.createEl('p', {
            text: val,
          })
        })
    } else {
      this.plugin.oauth2Info.verifier = verifier

      t('modal_dropboxauth_autosteps')
        .split('\n')
        .forEach((val) => {
          contentEl.createEl('p', {
            text: val,
          })
        })
    }

    const div2 = contentEl.createDiv()
    div2.createEl(
      'button',
      {
        text: t('modal_dropboxauth_copybutton'),
      },
      (el) => {
        el.onclick = async () => {
          await navigator.clipboard.writeText(authUrl)
          new Notice(t('modal_dropboxauth_copynotice'))
        }
      },
    )

    contentEl.createEl('p').createEl('a', {
      href: authUrl,
      text: authUrl,
    })

    if (needManualPatse) {
      let authCode = ''
      new Setting(contentEl)
        .setName(t('modal_dropboxauth_maualinput'))
        .setDesc(t('modal_dropboxauth_maualinput_desc'))
        .addText((text) =>
          text
            .setPlaceholder('')
            .setValue('')
            .onChange((val) => {
              authCode = val.trim()
            }),
        )
        .addButton(async (button) => {
          button.setButtonText(t('submit'))
          button.onClick(async () => {
            new Notice(t('modal_dropboxauth_maualinput_notice'))
            try {
              const authRes = await sendAuthReqDropbox(
                this.plugin.settings.dropbox.clientID,
                verifier,
                authCode,
                async (e: any) => {
                  new Notice(t('protocol_dropbox_connect_fail'))
                  new Notice(`${e}`)
                  throw e
                },
              )
              const self = this
              setConfigBySuccessfullAuthInplace(
                this.plugin.settings.dropbox,
                authRes!,
                () => self.plugin.saveSettings(),
              )
              const client = getClient(
                this.plugin.settings,
                this.app.vault.getName(),
                () => this.plugin.saveSettings(),
              )
              const username = await client.getUserDisplayName()
              this.plugin.settings.dropbox.username = username
              await this.plugin.saveSettings()
              new Notice(
                t('modal_dropboxauth_maualinput_conn_succ', {
                  username: username,
                }),
              )
              this.authDiv.toggleClass(
                'dropbox-auth-button-hide',
                this.plugin.settings.dropbox.username !== '',
              )
              this.revokeAuthDiv.toggleClass(
                'dropbox-revoke-auth-button-hide',
                this.plugin.settings.dropbox.username === '',
              )
              this.revokeAuthSetting.setDesc(
                t('modal_dropboxauth_maualinput_conn_succ_revoke', {
                  username: this.plugin.settings.dropbox.username,
                }),
              )
              this.close()
            } catch (err) {
              console.error(err)
              new Notice(t('modal_dropboxauth_maualinput_conn_fail'))
            }
          })
        })
    }
  }

  onClose() {
    const { contentEl } = this
    contentEl.empty()
  }
}

class SyncConfigDirModal extends Modal {
  plugin: RemotelySavePlugin
  saveDropdownFunc: () => void
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    saveDropdownFunc: () => void,
  ) {
    super(app)
    this.plugin = plugin
    this.saveDropdownFunc = saveDropdownFunc
  }

  async onOpen() {
    const { contentEl } = this

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars)
    }

    t('modal_syncconfig_attn')
      .split('\n')
      .forEach((val) => {
        contentEl.createEl('p', {
          text: val,
        })
      })

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText(t('modal_syncconfig_secondconfirm'))
        button.onClick(async () => {
          this.plugin.settings.syncConfigDir = true
          await this.plugin.saveSettings()
          this.saveDropdownFunc()
          new Notice(t('modal_syncconfig_notice'))
          this.close()
        })
      })
      .addButton((button) => {
        button.setButtonText(t('goback'))
        button.onClick(() => {
          this.close()
        })
      })
  }

  onClose() {
    const { contentEl } = this
    contentEl.empty()
  }
}

class ExportSettingsQrCodeModal extends Modal {
  plugin: RemotelySavePlugin
  exportType: QRExportType
  constructor(app: App, plugin: RemotelySavePlugin, exportType: QRExportType) {
    super(app)
    this.plugin = plugin
    this.exportType = exportType
  }

  async onOpen() {
    const { contentEl } = this

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars)
    }

    const { rawUri, imgUri } = await exportQrCodeUri(
      this.plugin.settings,
      this.app.vault.getName(),
      this.plugin.manifest.version,
      this.exportType,
    )

    const div1 = contentEl.createDiv()
    t('modal_qr_shortdesc')
      .split('\n')
      .forEach((val) => {
        div1.createEl('p', {
          text: val,
        })
      })

    const div2 = contentEl.createDiv()
    div2.createEl(
      'button',
      {
        text: t('modal_qr_button'),
      },
      (el) => {
        el.onclick = async () => {
          await navigator.clipboard.writeText(rawUri)
          new Notice(t('modal_qr_button_notice'))
        }
      },
    )

    const div3 = contentEl.createDiv()
    div3.createEl(
      'img',
      {
        cls: 'qrcode-img',
      },
      async (el) => {
        el.src = imgUri
      },
    )
  }

  onClose() {
    const { contentEl } = this
    contentEl.empty()
  }
}

const getEyesElements = () => {
  const eyeEl = createElement(Eye)
  const eyeOffEl = createElement(EyeOff)
  return {
    eye: eyeEl.outerHTML,
    eyeOff: eyeOffEl.outerHTML,
  }
}

export const wrapTextWithPasswordHide = (text: TextComponent) => {
  const { eye, eyeOff } = getEyesElements()
  const hider = text.inputEl.insertAdjacentElement('afterend', createSpan())!
  // the init type of hider is "hidden" === eyeOff === password
  hider.innerHTML = eyeOff
  hider.addEventListener('click', (e) => {
    const isText = text.inputEl.getAttribute('type') === 'text'
    hider.innerHTML = isText ? eyeOff : eye
    text.inputEl.setAttribute('type', isText ? 'password' : 'text')
    text.inputEl.focus()
  })

  // the init type of text el is password
  text.inputEl.setAttribute('type', 'password')
  return text
}

export class RemotelySaveSettingTab extends PluginSettingTab {
  readonly plugin: RemotelySavePlugin

  constructor(app: App, plugin: RemotelySavePlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.style.setProperty('overflow-wrap', 'break-word')

    containerEl.empty()

    const t = (x: TransItemType, vars?: any) => {
      return this.plugin.i18n.t(x, vars)
    }

    containerEl.createEl('h1', { text: this.plugin.manifest.name })

    //////////////////////////////////////////////////
    // below for service chooser (part 1/2)
    //////////////////////////////////////////////////

    // we need to create the div in advance of any other service divs
    const serviceChooserDiv = containerEl.createDiv()
    serviceChooserDiv.createEl('h2', { text: t('settings_chooseservice') })

    //////////////////////////////////////////////////
    // below for dropbpx
    //////////////////////////////////////////////////

    const dropboxDiv = containerEl.createEl('div', { cls: 'dropbox-hide' })
    dropboxDiv.toggleClass(
      'dropbox-hide',
      this.plugin.settings.serviceType !== 'dropbox',
    )
    dropboxDiv.createEl('h2', { text: t('settings_dropbox') })

    const dropboxLongDescDiv = dropboxDiv.createEl('div', {
      cls: 'settings-long-desc',
    })
    for (const c of [
      t('settings_dropbox_disclaimer1'),
      t('settings_dropbox_disclaimer2'),
    ]) {
      dropboxLongDescDiv.createEl('p', {
        text: c,
        cls: 'dropbox-disclaimer',
      })
    }
    dropboxLongDescDiv.createEl('p', {
      text: t('settings_dropbox_folder', {
        pluginID: this.plugin.manifest.id,
        remoteBaseDir:
          this.plugin.settings.dropbox.remoteBaseDir ||
          this.app.vault.getName(),
      }),
    })

    const dropboxSelectAuthDiv = dropboxDiv.createDiv()
    const dropboxAuthDiv = dropboxSelectAuthDiv.createDiv({
      cls: 'dropbox-auth-button-hide settings-auth-related',
    })
    const dropboxRevokeAuthDiv = dropboxSelectAuthDiv.createDiv({
      cls: 'dropbox-revoke-auth-button-hide settings-auth-related',
    })

    const dropboxRevokeAuthSetting = new Setting(dropboxRevokeAuthDiv)
      .setName(t('settings_dropbox_revoke'))
      .setDesc(
        t('settings_dropbox_revoke_desc', {
          username: this.plugin.settings.dropbox.username,
        }),
      )
      .addButton(async (button) => {
        button.setButtonText(t('settings_dropbox_revoke_button'))
        button.onClick(async () => {
          try {
            const client = getClient(
              this.plugin.settings,
              this.app.vault.getName(),
              () => this.plugin.saveSettings(),
            )
            await client.revokeAuth()
            this.plugin.settings.dropbox = JSON.parse(
              JSON.stringify(DEFAULT_DROPBOX_CONFIG),
            )
            await this.plugin.saveSettings()
            dropboxAuthDiv.toggleClass(
              'dropbox-auth-button-hide',
              this.plugin.settings.dropbox.username !== '',
            )
            dropboxRevokeAuthDiv.toggleClass(
              'dropbox-revoke-auth-button-hide',
              this.plugin.settings.dropbox.username === '',
            )
            new Notice(t('settings_dropbox_revoke_notice'))
          } catch (err) {
            console.error(err)
            new Notice(t('settings_dropbox_revoke_noticeerr'))
          }
        })
      })

    new Setting(dropboxRevokeAuthDiv)
      .setName(t('settings_dropbox_clearlocal'))
      .setDesc(t('settings_dropbox_clearlocal_desc'))
      .addButton(async (button) => {
        button.setButtonText(t('settings_dropbox_clearlocal_button'))
        button.onClick(async () => {
          this.plugin.settings.dropbox = JSON.parse(
            JSON.stringify(DEFAULT_DROPBOX_CONFIG),
          )
          await this.plugin.saveSettings()
          dropboxAuthDiv.toggleClass(
            'dropbox-auth-button-hide',
            this.plugin.settings.dropbox.username !== '',
          )
          dropboxRevokeAuthDiv.toggleClass(
            'dropbox-revoke-auth-button-hide',
            this.plugin.settings.dropbox.username === '',
          )
          new Notice(t('settings_dropbox_clearlocal_notice'))
        })
      })

    new Setting(dropboxAuthDiv)
      .setName(t('settings_dropbox_auth'))
      .setDesc(t('settings_dropbox_auth_desc'))
      .addButton(async (button) => {
        button.setButtonText(t('settings_dropbox_auth_button'))
        button.onClick(async () => {
          const modal = new DropboxAuthModal(
            this.app,
            this.plugin,
            dropboxAuthDiv,
            dropboxRevokeAuthDiv,
            dropboxRevokeAuthSetting,
          )
          this.plugin.oauth2Info.helperModal = modal
          this.plugin.oauth2Info.authDiv = dropboxAuthDiv
          this.plugin.oauth2Info.revokeDiv = dropboxRevokeAuthDiv
          this.plugin.oauth2Info.revokeAuthSetting = dropboxRevokeAuthSetting
          modal.open()
        })
      })

    dropboxAuthDiv.toggleClass(
      'dropbox-auth-button-hide',
      this.plugin.settings.dropbox.username !== '',
    )
    dropboxRevokeAuthDiv.toggleClass(
      'dropbox-revoke-auth-button-hide',
      this.plugin.settings.dropbox.username === '',
    )

    let newDropboxRemoteBaseDir =
      this.plugin.settings.dropbox.remoteBaseDir || ''
    new Setting(dropboxDiv)
      .setName(t('settings_remotebasedir'))
      .setDesc(t('settings_remotebasedir_desc'))
      .addText((text) =>
        text
          .setPlaceholder(this.app.vault.getName())
          .setValue(newDropboxRemoteBaseDir)
          .onChange((value) => {
            newDropboxRemoteBaseDir = value.trim()
          }),
      )
      .addButton((button) => {
        button.setButtonText(t('confirm'))
        button.onClick(() => {
          new ChangeRemoteBaseDirModal(
            this.app,
            this.plugin,
            newDropboxRemoteBaseDir,
            'dropbox',
          ).open()
        })
      })

    new Setting(dropboxDiv)
      .setName(t('settings_checkonnectivity'))
      .setDesc(t('settings_checkonnectivity_desc'))
      .addButton(async (button) => {
        button.setButtonText(t('settings_checkonnectivity_button'))
        button.onClick(async () => {
          new Notice(t('settings_checkonnectivity_checking'))
          const client = getClient(
            this.plugin.settings,
            this.app.vault.getName(),
            () => this.plugin.saveSettings(),
          )

          const errors = { msg: '' }
          const res = await client.checkConnect((err: any) => {
            errors.msg = `${err}`
          })
          if (res) {
            new Notice(t('settings_dropbox_connect_succ'))
          } else {
            new Notice(t('settings_dropbox_connect_fail'))
            new Notice(errors.msg)
          }
        })
      })

    //////////////////////////////////////////////////
    // below for general chooser (part 2/2)
    //////////////////////////////////////////////////

    // we need to create chooser
    // after all service-div-s being created
    new Setting(serviceChooserDiv)
      .setName(t('settings_chooseservice'))
      .setDesc(t('settings_chooseservice_desc'))
      .addDropdown(async (dropdown) => {
        dropdown.addOption('dropbox', t('settings_chooseservice_dropbox'))

        dropdown
          .setValue(this.plugin.settings.serviceType)
          .onChange(async (val) => {
            this.plugin.settings.serviceType = val as SUPPORTED_SERVICES_TYPE
            dropboxDiv.toggleClass(
              'dropbox-hide',
              this.plugin.settings.serviceType !== 'dropbox',
            )

            await this.plugin.saveSettings()
          })
      })

    //////////////////////////////////////////////////
    // below for basic settings
    //////////////////////////////////////////////////

    const basicDiv = containerEl.createEl('div')
    basicDiv.createEl('h2', { text: t('settings_basic') })

    const passwordSetting = new Setting(basicDiv)
    const encryptionMethodSetting = new Setting(basicDiv)

    let newPassword = `${this.plugin.settings.password}`
    passwordSetting
      .setName(t('settings_password'))
      .setDesc(t('settings_password_desc'))
      .addText((text) => {
        wrapTextWithPasswordHide(text)
        text
          .setPlaceholder('')
          .setValue(`${this.plugin.settings.password}`)
          .onChange(async (value) => {
            newPassword = value.trim()
          })
      })
      .addButton(async (button) => {
        button.setButtonText(t('confirm'))
        button.onClick(async () => {
          new PasswordModal(
            this.app,
            this.plugin,
            newPassword,
            encryptionMethodSetting,
          ).open()
        })
      })

    if (this.plugin.settings.password === '') {
      encryptionMethodSetting.settingEl.addClass(
        'settings-encryption-method-hide',
      )
    }
    encryptionMethodSetting
      .setName(t('settings_encryptionmethod'))
      .setDesc(stringToFragment(t('settings_encryptionmethod_desc')))
      .addDropdown((dropdown) => {
        dropdown
          .addOption('rclone-base64', t('settings_encryptionmethod_rclone'))
          .addOption('openssl-base64', t('settings_encryptionmethod_openssl'))
          .setValue(this.plugin.settings.encryptionMethod ?? 'rclone-base64')
          .onChange(async (val: string) => {
            this.plugin.settings.encryptionMethod = val as CipherMethodType
            await this.plugin.saveSettings()
            if (this.plugin.settings.password !== '') {
              new EncryptionMethodModal(this.app, this.plugin).open()
            }
          })
      })

    new Setting(basicDiv)
      .setName(t('settings_autorun'))
      .setDesc(t('settings_autorun_desc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('-1', t('settings_autorun_notset'))
        dropdown.addOption(`${1000 * 60 * 1}`, t('settings_autorun_1min'))
        dropdown.addOption(`${1000 * 60 * 5}`, t('settings_autorun_5min'))
        dropdown.addOption(`${1000 * 60 * 10}`, t('settings_autorun_10min'))
        dropdown.addOption(`${1000 * 60 * 30}`, t('settings_autorun_30min'))

        dropdown
          .setValue(`${this.plugin.settings.autoRunEveryMilliseconds}`)
          .onChange(async (val: string) => {
            const realVal = Number.parseInt(val)
            this.plugin.settings.autoRunEveryMilliseconds = realVal
            await this.plugin.saveSettings()
            if (
              (realVal === undefined || realVal === null || realVal <= 0) &&
              this.plugin.autoRunIntervalID !== undefined
            ) {
              // clear
              window.clearInterval(this.plugin.autoRunIntervalID)
              this.plugin.autoRunIntervalID = undefined
            } else if (
              realVal !== undefined &&
              realVal !== null &&
              realVal > 0
            ) {
              const intervalID = window.setInterval(() => {
                console.info('auto run from settings.ts')
                this.plugin.syncRun('auto')
              }, realVal)
              this.plugin.autoRunIntervalID = intervalID
              this.plugin.registerInterval(intervalID)
            }
          })
      })

    new Setting(basicDiv)
      .setName(t('settings_runoncestartup'))
      .setDesc(t('settings_runoncestartup_desc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('-1', t('settings_runoncestartup_notset'))
        dropdown.addOption(`${1000 * 1 * 1}`, t('settings_runoncestartup_1sec'))
        dropdown.addOption(
          `${1000 * 10 * 1}`,
          t('settings_runoncestartup_10sec'),
        )
        dropdown.addOption(
          `${1000 * 30 * 1}`,
          t('settings_runoncestartup_30sec'),
        )
        dropdown
          .setValue(`${this.plugin.settings.initRunAfterMilliseconds}`)
          .onChange(async (val: string) => {
            const realVal = Number.parseInt(val)
            this.plugin.settings.initRunAfterMilliseconds = realVal
            await this.plugin.saveSettings()
          })
      })

    new Setting(basicDiv)
      .setName(t('settings_synconsave'))
      .setDesc(t('settings_synconsave_desc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('-1', t('settings_synconsave_disable'))
        dropdown.addOption('1000', t('settings_synconsave_enable'))
        // for backward compatibility, we need to use a number representing seconds
        let syncOnSaveEnabled = false
        if ((this.plugin.settings.syncOnSaveAfterMilliseconds ?? -1) > 0) {
          syncOnSaveEnabled = true
        }
        dropdown
          .setValue(`${syncOnSaveEnabled ? '1000' : '-1'}`)
          .onChange(async (val: string) => {
            this.plugin.settings.syncOnSaveAfterMilliseconds =
              Number.parseInt(val)
            await this.plugin.saveSettings()
            this.plugin.toggleSyncOnSaveIfSet()
          })
      })

    new Setting(basicDiv)
      .setName(t('settings_skiplargefiles'))
      .setDesc(t('settings_skiplargefiles_desc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('-1', t('settings_skiplargefiles_notset'))

        const mbs = [1, 5, 10, 20, 50, 100, 200, 500, 1000]
        for (const mb of mbs) {
          dropdown.addOption(`${mb * 1000 * 1000}`, `${mb} MB`)
        }
        dropdown
          .setValue(`${this.plugin.settings.skipSizeLargerThan}`)
          .onChange(async (val) => {
            this.plugin.settings.skipSizeLargerThan = Number.parseInt(val)
            await this.plugin.saveSettings()
          })
      })

    // custom status bar items is not supported on mobile
    if (!Platform.isMobileApp) {
      new Setting(basicDiv)
        .setName(t('settings_enablestatusbar_info'))
        .setDesc(t('settings_enablestatusbar_info_desc'))
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.settings.enableStatusBarInfo ?? false)
            .onChange(async (val) => {
              this.plugin.settings.enableStatusBarInfo = val
              await this.plugin.saveSettings()
              new Notice(t('settings_enablestatusbar_reloadrequired_notice'))
            })
        })

      new Setting(basicDiv)
        .setName(t('settings_resetstatusbar_time'))
        .setDesc(t('settings_resetstatusbar_time_desc'))
        .addButton((button) => {
          button.setButtonText(t('settings_resetstatusbar_button'))
          button.onClick(async () => {
            // reset last sync time
            await upsertLastSuccessSyncTimeByVault(
              this.plugin.db,
              this.plugin.vaultRandomID,
              -1,
            )
            await upsertLastFailedSyncTimeByVault(
              this.plugin.db,
              this.plugin.vaultRandomID,
              -1,
            )
            this.plugin.updateLastSyncMsg(undefined, 'not_syncing', null, null)
            new Notice(t('settings_resetstatusbar_notice'))
          })
        })
    }

    new Setting(basicDiv)
      .setName(t('settings_ignorepaths'))
      .setDesc(t('settings_ignorepaths_desc'))
      .setClass('ignorepaths-settings')

      .addTextArea((textArea) => {
        textArea
          .setValue(`${(this.plugin.settings.ignorePaths ?? []).join('\n')}`)
          .onChange(async (value) => {
            this.plugin.settings.ignorePaths = value
              .trim()
              .split('\n')
              .filter((x) => x.trim() !== '')
            await this.plugin.saveSettings()
          })
        textArea.inputEl.rows = 10
        textArea.inputEl.cols = 30

        textArea.inputEl.addClass('ignorepaths-textarea')
      })

    //////////////////////////////////////////////////
    // below for advanced settings
    //////////////////////////////////////////////////
    const advDiv = containerEl.createEl('div')
    advDiv.createEl('h2', {
      text: t('settings_adv'),
    })

    new Setting(advDiv)
      .setName(t('settings_concurrency'))
      .setDesc(t('settings_concurrency_desc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('1', '1')
        dropdown.addOption('2', '2')
        dropdown.addOption('3', '3')
        dropdown.addOption('5', '5 (default)')
        dropdown.addOption('10', '10')
        dropdown.addOption('15', '15')
        dropdown.addOption('20', '20')

        dropdown
          .setValue(`${this.plugin.settings.concurrency}`)
          .onChange(async (val) => {
            const realVal = Number.parseInt(val)
            this.plugin.settings.concurrency = realVal
            await this.plugin.saveSettings()
          })
      })

    new Setting(advDiv)
      .setName(t('settings_syncunderscore'))
      .setDesc(t('settings_syncunderscore_desc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('disable', t('disable'))
        dropdown.addOption('enable', t('enable'))
        dropdown
          .setValue(
            `${this.plugin.settings.syncUnderscoreItems ? 'enable' : 'disable'}`,
          )
          .onChange(async (val) => {
            this.plugin.settings.syncUnderscoreItems = val === 'enable'
            await this.plugin.saveSettings()
          })
      })

    new Setting(advDiv)
      .setName(t('settings_configdir'))
      .setDesc(
        t('settings_configdir_desc', {
          configDir: this.app.vault.configDir,
        }),
      )
      .addDropdown((dropdown) => {
        dropdown.addOption('disable', t('disable'))
        dropdown.addOption('enable', t('enable'))

        const bridge = {
          secondConfirm: false,
        }
        dropdown
          .setValue(
            `${this.plugin.settings.syncConfigDir ? 'enable' : 'disable'}`,
          )
          .onChange(async (val) => {
            if (val === 'enable' && !bridge.secondConfirm) {
              dropdown.setValue('disable')
              new SyncConfigDirModal(this.app, this.plugin, () => {
                bridge.secondConfirm = true
                dropdown.setValue('enable')
              }).open()
            } else {
              bridge.secondConfirm = false
              this.plugin.settings.syncConfigDir = false
              await this.plugin.saveSettings()
            }
          })
      })

    new Setting(advDiv)
      .setName(t('settings_deletetowhere'))
      .setDesc(t('settings_deletetowhere_desc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('system', t('settings_deletetowhere_system_trash'))
        dropdown.addOption(
          'obsidian',
          t('settings_deletetowhere_obsidian_trash'),
        )
        dropdown
          .setValue(this.plugin.settings.deleteToWhere ?? 'system')
          .onChange(async (val) => {
            this.plugin.settings.deleteToWhere = val as 'system' | 'obsidian'
            await this.plugin.saveSettings()
          })
      })

    new Setting(advDiv)
      .setName(t('settings_conflictaction'))
      .setDesc(stringToFragment(t('settings_conflictaction_desc')))
      .addDropdown((dropdown) => {
        dropdown
          .addOption('smart', t('settings_conflictaction_smart'))
          .addOption('keep_newer', t('settings_conflictaction_keep_newer'))
          .addOption('keep_larger', t('settings_conflictaction_keep_larger'))
          .setValue(this.plugin.settings.conflictAction ?? 'smart')
          .onChange(async (val) => {
            this.plugin.settings.conflictAction = val as ConflictActionType
            await this.plugin.saveSettings()
          })
      })

    const percentage1 = new Setting(advDiv)
      .setName(t('settings_protectmodifypercentage'))
      .setDesc(t('settings_protectmodifypercentage_desc'))

    const percentage2 = new Setting(advDiv)
      .setName(t('settings_protectmodifypercentage_customfield'))
      .setDesc(t('settings_protectmodifypercentage_customfield_desc'))
    if ((this.plugin.settings.protectModifyPercentage ?? 50) % 10 === 0) {
      percentage2.settingEl.addClass('settings-percentage-custom-hide')
    }
    let percentage2Text: TextComponent | undefined = undefined
    percentage2.addText((text) => {
      text.inputEl.type = 'number'
      percentage2Text = text
      text
        .setPlaceholder('0 ~ 100')
        .setValue(`${this.plugin.settings.protectModifyPercentage ?? 50}`)
        .onChange(async (val) => {
          let k = Number.parseFloat(val.trim())
          if (Number.isNaN(k)) {
            // do nothing!
          } else {
            if (k < 0) {
              k = 0
            } else if (k > 100) {
              k = 100
            }
            this.plugin.settings.protectModifyPercentage = k
            await this.plugin.saveSettings()
          }
        })
    })

    percentage1.addDropdown((dropdown) => {
      for (const i of Array.from({ length: 11 }, (x, i) => i * 10)) {
        let desc = `${i}`
        if (i === 0) {
          desc = t('settings_protectmodifypercentage_000_desc')
        } else if (i === 50) {
          desc = t('settings_protectmodifypercentage_050_desc')
        } else if (i === 100) {
          desc = t('settings_protectmodifypercentage_100_desc')
        }
        dropdown.addOption(`${i}`, desc)
      }
      dropdown.addOption(
        'custom',
        t('settings_protectmodifypercentage_custom_desc'),
      )

      const p = this.plugin.settings.protectModifyPercentage ?? 50
      let initVal = 'custom'
      if (p % 10 === 0) {
        initVal = `${p}`
      } else {
        // show custom
        percentage2.settingEl.removeClass('settings-percentage-custom')
      }
      dropdown.setValue(initVal).onChange(async (val) => {
        const k = Number.parseInt(val)
        if (val === 'custom' || Number.isNaN(k)) {
          // do nothing until user changes something in custom field
          percentage2.settingEl.removeClass('settings-percentage-custom-hide')
        } else {
          this.plugin.settings.protectModifyPercentage = k
          percentage2.settingEl.addClass('settings-percentage-custom-hide')
          percentage2Text?.setValue(`${k}`)
          await this.plugin.saveSettings()
        }
      })
    })

    new Setting(advDiv)
      .setName(t('setting_syncdirection'))
      .setDesc(stringToFragment(t('setting_syncdirection_desc')))
      .addDropdown((dropdown) => {
        dropdown.addOption(
          'bidirectional',
          t('setting_syncdirection_bidirectional_desc'),
        )
        dropdown.addOption(
          'incremental_push_only',
          t('setting_syncdirection_incremental_push_only_desc'),
        )
        dropdown.addOption(
          'incremental_pull_only',
          t('setting_syncdirection_incremental_pull_only_desc'),
        )

        dropdown
          .setValue(this.plugin.settings.syncDirection ?? 'bidirectional')
          .onChange(async (val) => {
            this.plugin.settings.syncDirection = val as SyncDirectionType
            await this.plugin.saveSettings()
          })
      })

    if (Platform.isMobile) {
      new Setting(advDiv)
        .setName(t('settings_enablemobilestatusbar'))
        .setDesc(t('settings_enablemobilestatusbar_desc'))
        .addDropdown(async (dropdown) => {
          dropdown
            .addOption('enable', t('enable'))
            .addOption('disable', t('disable'))

          dropdown
            .setValue(
              `${
                this.plugin.settings.enableMobileStatusBar
                  ? 'enable'
                  : 'disable'
              }`,
            )
            .onChange(async (val) => {
              if (val === 'enable') {
                this.plugin.settings.enableMobileStatusBar = true
                this.plugin.appContainerObserver =
                  changeMobileStatusBar('enable')
              } else {
                this.plugin.settings.enableMobileStatusBar = false
                changeMobileStatusBar(
                  'disable',
                  this.plugin.appContainerObserver,
                )
                this.plugin.appContainerObserver?.disconnect()
                this.plugin.appContainerObserver = undefined
              }
              await this.plugin.saveSettings()
            })
        })
    }

    //////////////////////////////////////////////////
    // below for import and export functions
    //////////////////////////////////////////////////

    // import and export
    const importExportDiv = containerEl.createEl('div')
    importExportDiv.createEl('h2', {
      text: t('settings_importexport'),
    })

    const importExportDivSetting1 = new Setting(importExportDiv)
      .setName(t('settings_export'))
      .setDesc(t('settings_export_desc'))
    importExportDivSetting1.settingEl.addClass('setting-need-wrapping')
    importExportDivSetting1
      .addButton(async (button) => {
        button.setButtonText(t('settings_export_basic_and_advanced_button'))
        button.onClick(async () => {
          new ExportSettingsQrCodeModal(
            this.app,
            this.plugin,
            'basic_and_advanced',
          ).open()
        })
      })
      .addButton(async (button) => {
        button.setButtonText(t('settings_export_dropbox_button'))
        button.onClick(async () => {
          new ExportSettingsQrCodeModal(this.app, this.plugin, 'dropbox').open()
        })
      })

    let importSettingVal = ''
    new Setting(importExportDiv)
      .setName(t('settings_import'))
      .setDesc(t('settings_import_desc'))
      .addText((text) =>
        text
          .setPlaceholder(`obsidian://${COMMAND_URI}?func=settings&...`)
          .setValue('')
          .onChange((val) => {
            importSettingVal = val
          }),
      )
      .addButton(async (button) => {
        button.setButtonText(t('confirm'))
        button.onClick(async () => {
          if (importSettingVal !== '') {
            // console.debug(importSettingVal);
            try {
              const inputParams = parseUriByHand(importSettingVal)
              const parsed = importQrCodeUri(
                inputParams,
                this.app.vault.getName(),
              )
              if (parsed.status === 'error') {
                new Notice(parsed.message)
              } else {
                const copied = cloneDeep(parsed.result)
                // new Notice(JSON.stringify(copied))
                this.plugin.settings = Object.assign(
                  {},
                  this.plugin.settings,
                  copied,
                )
                this.plugin.saveSettings()
                new Notice(
                  t('protocol_saveqr', {
                    manifestName: this.plugin.manifest.name,
                  }),
                )
              }
            } catch (e) {
              new Notice(`${e}`)
            }

            importSettingVal = ''
          } else {
            new Notice(t('settings_import_error_notice'))
            importSettingVal = ''
          }
        })
      })

    //////////////////////////////////////////////////
    // below for debug
    //////////////////////////////////////////////////

    const debugDiv = containerEl.createEl('div')
    debugDiv.createEl('h2', { text: t('settings_debug') })

    new Setting(debugDiv)
      .setName(t('settings_debuglevel'))
      .setDesc(t('settings_debuglevel_desc'))
      .addDropdown(async (dropdown) => {
        dropdown.addOption('info', 'info')
        dropdown.addOption('debug', 'debug')
        dropdown
          .setValue(this.plugin.settings.currLogLevel ?? 'info')
          .onChange(async (val: string) => {
            this.plugin.settings.currLogLevel = val
            await this.plugin.saveSettings()
            console.info(`the log level is changed to ${val}`)
          })
      })

    new Setting(debugDiv)
      .setName(t('settings_outputsettingsconsole'))
      .setDesc(t('settings_outputsettingsconsole_desc'))
      .addButton(async (button) => {
        button.setButtonText(t('settings_outputsettingsconsole_button'))
        button.onClick(async () => {
          const c = messyConfigToNormal(await this.plugin.loadData())
          console.info(c)
          new Notice(t('settings_outputsettingsconsole_notice'))
        })
      })

    new Setting(debugDiv)
      .setName(t('settings_obfuscatesettingfile'))
      .setDesc(t('settings_obfuscatesettingfile_desc'))
      .addDropdown(async (dropdown) => {
        dropdown
          .addOption('enable', t('enable'))
          .addOption('disable', t('disable'))

        dropdown
          .setValue(
            `${
              this.plugin.settings.obfuscateSettingFile ? 'enable' : 'disable'
            }`,
          )
          .onChange(async (val) => {
            if (val === 'enable') {
              this.plugin.settings.obfuscateSettingFile = true
            } else {
              this.plugin.settings.obfuscateSettingFile = false
            }
            await this.plugin.saveSettings()
          })
      })

    new Setting(debugDiv)
      .setName(t('settings_viewconsolelog'))
      .setDesc(stringToFragment(t('settings_viewconsolelog_desc')))

    const debugDivExportSyncPlans = new Setting(debugDiv)
      .setName(t('settings_syncplans'))
      .setDesc(t('settings_syncplans_desc'))
    debugDivExportSyncPlans.settingEl.addClass('setting-need-wrapping')
    debugDivExportSyncPlans
      .addButton(async (button) => {
        button.setButtonText(t('settings_syncplans_button_1_only_change'))
        button.onClick(async () => {
          await exportVaultSyncPlansToFiles(
            this.plugin.db,
            this.app.vault,
            this.plugin.vaultRandomID,
            1,
            true,
          )
          new Notice(t('settings_syncplans_notice'))
        })
      })
      .addButton(async (button) => {
        button.setButtonText(t('settings_syncplans_button_5_only_change'))
        button.onClick(async () => {
          await exportVaultSyncPlansToFiles(
            this.plugin.db,
            this.app.vault,
            this.plugin.vaultRandomID,
            5,
            true,
          )
          new Notice(t('settings_syncplans_notice'))
        })
      })
      .addButton(async (button) => {
        button.setButtonText(t('settings_syncplans_button_1'))
        button.onClick(async () => {
          await exportVaultSyncPlansToFiles(
            this.plugin.db,
            this.app.vault,
            this.plugin.vaultRandomID,
            1,
            false,
          )
          new Notice(t('settings_syncplans_notice'))
        })
      })
      .addButton(async (button) => {
        button.setButtonText(t('settings_syncplans_button_5'))
        button.onClick(async () => {
          await exportVaultSyncPlansToFiles(
            this.plugin.db,
            this.app.vault,
            this.plugin.vaultRandomID,
            5,
            false,
          )
          new Notice(t('settings_syncplans_notice'))
        })
      })
      .addButton(async (button) => {
        button.setButtonText(t('settings_syncplans_button_all'))
        button.onClick(async () => {
          await exportVaultSyncPlansToFiles(
            this.plugin.db,
            this.app.vault,
            this.plugin.vaultRandomID,
            -1,
            false,
          )
          new Notice(t('settings_syncplans_notice'))
        })
      })

    new Setting(debugDiv)
      .setName(t('settings_delsyncplans'))
      .setDesc(t('settings_delsyncplans_desc'))
      .addButton(async (button) => {
        button.setButtonText(t('settings_delsyncplans_button'))
        button.onClick(async () => {
          await clearAllSyncPlanRecords(this.plugin.db)
          new Notice(t('settings_delsyncplans_notice'))
        })
      })

    new Setting(debugDiv)
      .setName(t('settings_delprevsync'))
      .setDesc(t('settings_delprevsync_desc'))
      .addButton(async (button) => {
        button.setButtonText(t('settings_delprevsync_button'))
        button.onClick(async () => {
          await clearAllPrevSyncRecordByVault(
            this.plugin.db,
            this.plugin.vaultRandomID,
          )
          await clearAllSyncBasesByVault(
            this.plugin.db,
            this.plugin.vaultRandomID,
          )
          new Notice(t('settings_delprevsync_notice'))
        })
      })

    new Setting(debugDiv)
      .setName(t('settings_profiler_results'))
      .setDesc(t('settings_profiler_results_desc'))
      .addButton(async (button) => {
        button.setButtonText(t('settings_profiler_results_button_all'))
        button.onClick(async () => {
          await exportVaultProfilerResultsToFiles(
            this.plugin.db,
            this.app.vault,
            this.plugin.vaultRandomID,
          )
          new Notice(t('settings_profiler_results_notice'))
        })
      })

    new Setting(debugDiv)
      .setName(t('settings_profiler_enableprofiler'))
      .setDesc(t('settings_profiler_enableprofiler_desc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('enable', t('enable'))
        dropdown.addOption('disable', t('disable'))
        dropdown
          .setValue(
            this.plugin.settings.profiler?.enable ? 'enable' : 'disable',
          )
          .onChange(async (val: string) => {
            if (this.plugin.settings.profiler === undefined) {
              this.plugin.settings.profiler = DEFAULT_PROFILER_CONFIG
            }
            this.plugin.settings.profiler.enable = val === 'enable'
            await this.plugin.saveSettings()
          })
      })

    new Setting(debugDiv)
      .setName(t('settings_profiler_enabledebugprint'))
      .setDesc(t('settings_profiler_enabledebugprint_desc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('enable', t('enable'))
        dropdown.addOption('disable', t('disable'))
        dropdown
          .setValue(
            this.plugin.settings.profiler?.enablePrinting
              ? 'enable'
              : 'disable',
          )
          .onChange(async (val: string) => {
            if (this.plugin.settings.profiler === undefined) {
              this.plugin.settings.profiler = DEFAULT_PROFILER_CONFIG
            }
            this.plugin.settings.profiler.enablePrinting = val === 'enable'
            await this.plugin.saveSettings()
          })
      })

    new Setting(debugDiv)
      .setName(t('settings_profiler_recordsize'))
      .setDesc(t('settings_profiler_recordsize_desc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('enable', t('enable'))
        dropdown.addOption('disable', t('disable'))
        dropdown
          .setValue(
            this.plugin.settings.profiler?.recordSize ? 'enable' : 'disable',
          )
          .onChange(async (val: string) => {
            if (this.plugin.settings.profiler === undefined) {
              this.plugin.settings.profiler = DEFAULT_PROFILER_CONFIG
            }
            this.plugin.settings.profiler.recordSize = val === 'enable'
            await this.plugin.saveSettings()
          })
      })

    new Setting(debugDiv)
      .setName(t('settings_outputbasepathvaultid'))
      .setDesc(t('settings_outputbasepathvaultid_desc'))
      .addButton(async (button) => {
        button.setButtonText(t('settings_outputbasepathvaultid_button'))
        button.onClick(async () => {
          new Notice(this.plugin.getVaultBasePath())
          new Notice(this.plugin.vaultRandomID)
        })
      })

    new Setting(debugDiv)
      .setName(t('settings_resetcache'))
      .setDesc(t('settings_resetcache_desc'))
      .addButton(async (button) => {
        button.setButtonText(t('settings_resetcache_button'))
        button.onClick(async () => {
          await destroyDBs()
          new Notice(t('settings_resetcache_notice'))
          this.plugin.unload()
        })
      })
  }

  hide() {
    const { containerEl } = this
    containerEl.empty()
    super.hide()
  }
}
