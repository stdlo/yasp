import { type App, Modal, Setting } from 'obsidian'
import type { HeldAnswer } from './multiSync'
import type { HeldQuestion } from './routes'

/**
 * The one question the routing asks: a routed folder is gone while the
 * plugin wasn't watching. Resolves undefined when closed unanswered, which
 * leaves the runs held.
 */
class HeldQuestionModal extends Modal {
  answer: HeldAnswer | undefined = undefined

  constructor(
    app: App,
    readonly q: HeldQuestion,
    readonly done: (a: HeldAnswer | undefined) => void,
  ) {
    super(app)
  }

  onOpen() {
    const { contentEl } = this
    const text =
      this.q.appeared === undefined
        ? `"${this.q.gone}" is gone. Its sync is held until you say what happened.`
        : `"${this.q.gone}" is gone and "${this.q.appeared}" is new: renamed?`
    contentEl.createEl('p', { text })
    const setting = new Setting(contentEl)
    const choose = (a: HeldAnswer) => {
      this.answer = a
      this.close()
    }
    if (this.q.appeared !== undefined) {
      setting.addButton((b) =>
        b
          .setButtonText('Rename the route')
          .setCta()
          .onClick(() => choose('rename')),
      )
      setting.addButton((b) =>
        b.setButtonText("It's new").onClick(() => choose('new')),
      )
    }
    setting.addButton((b) =>
      b
        .setButtonText(`Delete "${this.q.gone}" everywhere`)
        .setWarning()
        .onClick(() => choose('delete')),
    )
  }

  onClose() {
    this.contentEl.empty()
    this.done(this.answer)
  }
}

/** The offer after a route change: delete the old remote's copies. */
class RouteChangeModal extends Modal {
  deleteThem = false

  constructor(
    app: App,
    readonly folder: string,
    readonly oldRemote: string,
    readonly done: (deleteThem: boolean) => void,
  ) {
    super(app)
  }

  onOpen() {
    this.contentEl.createEl('p', {
      text: `"${this.folder}" no longer syncs with ${this.oldRemote}. Delete its copies there? Otherwise they stay, no longer updated.`,
    })
    new Setting(this.contentEl)
      .addButton((b) =>
        b
          .setButtonText(`Delete from ${this.oldRemote}`)
          .setWarning()
          .onClick(() => {
            this.deleteThem = true
            this.close()
          }),
      )
      .addButton((b) =>
        b.setButtonText('Keep them').onClick(() => this.close()),
      )
  }

  onClose() {
    this.contentEl.empty()
    this.done(this.deleteThem)
  }
}

export const askDeleteOldCopies = (
  app: App,
  folder: string,
  oldRemote: string,
) =>
  new Promise<boolean>((resolve) => {
    new RouteChangeModal(app, folder, oldRemote, resolve).open()
  })

export const askHeldQuestion = (app: App, q: HeldQuestion) =>
  new Promise<HeldAnswer | undefined>((resolve) => {
    new HeldQuestionModal(app, q, resolve).open()
  })

/** The confirm before a remote that has records points somewhere else. */
class ChangeLocationModal extends Modal {
  confirmed = false

  constructor(
    app: App,
    readonly remoteName: string,
    readonly done: (confirmed: boolean) => void,
  ) {
    super(app)
  }

  onOpen() {
    this.contentEl.createEl('p', {
      text: `${this.remoteName} has synced before. Pointing it somewhere else makes its records of the old place stale, so they are forgotten: the next sync compares the new place with your vault afresh, and nothing is deleted for being missing there. The old place keeps its copies.`,
    })
    new Setting(this.contentEl)
      .addButton((b) =>
        b
          .setButtonText('Change it')
          .setCta()
          .onClick(() => {
            this.confirmed = true
            this.close()
          }),
      )
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
  }

  onClose() {
    this.contentEl.empty()
    this.done(this.confirmed)
  }
}

export const askChangeLocation = (app: App, remoteName: string) =>
  new Promise<boolean>((resolve) => {
    new ChangeLocationModal(app, remoteName, resolve).open()
  })
