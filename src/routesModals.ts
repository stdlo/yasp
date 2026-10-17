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

export const askHeldQuestion = (app: App, q: HeldQuestion) =>
  new Promise<HeldAnswer | undefined>((resolve) => {
    new HeldQuestionModal(app, q, resolve).open()
  })
