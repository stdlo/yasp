// Changed for Yet Another Sync Plugin (2026): only the Apache strings, no paid ones; a chosen language is honoured
import Mustache from 'mustache'
import { moment } from 'obsidian'

import { LANGS } from './langs'

export type LangType = keyof typeof LANGS
export type LangTypeAndAuto = LangType | 'auto'
export type TransItemType = keyof (typeof LANGS)['en']

export class I18n {
  lang: LangTypeAndAuto
  readonly saveSettingFunc: (tolang: LangTypeAndAuto) => Promise<void>
  constructor(
    lang: LangTypeAndAuto,
    saveSettingFunc: (tolang: LangTypeAndAuto) => Promise<void>,
  ) {
    this.lang = lang
    this.saveSettingFunc = saveSettingFunc
  }
  async changeTo(anotherLang: LangTypeAndAuto) {
    this.lang = anotherLang
    await this.saveSettingFunc(anotherLang)
  }

  _get(key: TransItemType) {
    const wanted =
      this.lang === 'auto' ? moment.locale().replace('-', '_') : this.lang
    const realLang: LangType = wanted in LANGS ? (wanted as LangType) : 'en'

    const res: string =
      (LANGS[realLang] as (typeof LANGS)['en'])[key] || LANGS['en'][key] || key
    return res
  }

  t(key: TransItemType, vars?: Record<string, string>) {
    if (vars === undefined) {
      return this._get(key)
    }
    return Mustache.render(this._get(key), vars)
  }
}
