import type { RefObject } from 'react'
import type { EntryLearningGlance, WordEntryCard } from '../../../shared/entries'
import { DictionaryView } from '../dictionary/dictionary-view'
import { phoneticText } from '../dictionary/presentation'
import type { DictionaryLookupState } from '../dictionary/lookup'
import { laterToggleLabel } from '../later/format'

/**
 * 阅读页右侧的两张浮层：
 * 刚收下时的选词结果（带内置词典的音标与释义），以及点开已收集词后的词条卡
 * （含删原句与删最后一条的确认）。
 */

export type CollectedPanel = {
  kind: 'collected'
  entryId: string
  entryMainForm: string
  surface: string
  sentenceText: string
  sentenceCount: number
  articleCount: number
  duplicate: boolean
  /** 内置词典对圈下这个词形的查询状态。 */
  dictionary: DictionaryLookupState
  /** 词条的置顶学习内容与跨篇故人重逢。 */
  glance: EntryLearningGlance
}

export type EntryPanel = {
  kind: 'entry'
  entryId: string
  /** 正文中点开的这一处，而非词条里最新收集的原句。 */
  entrySentenceId: string | null
  card: WordEntryCard | null
  error: string | null
  /** 删最后一条原句前先确认，会连词条一起删。 */
  confirmingDelete: boolean
  deleting: boolean
  /** 稍后看写入成功后的那句反馈；在途状态由页面传进来。 */
  laterNotice: string | null
}

export type PanelState = CollectedPanel | EntryPanel

export function CollectedPanelView({
  panel,
  panelRef,
  onOpenEntry,
  onClose
}: {
  panel: CollectedPanel
  panelRef: RefObject<HTMLElement | null>
  onOpenEntry: () => void
  onClose: () => void
}) {
  return (
    <aside className="reading-panel" aria-label="选词结果" ref={panelRef}>
      <header className="reading-panel-head">
        <p className="reading-panel-eyebrow">
          {panel.duplicate ? '这条原句已经收过' : '已收下'}
        </p>
        <button type="button" className="reading-panel-close" aria-label="关闭" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="reading-panel-headline">
        <p className="reading-panel-word">{panel.surface}</p>
        {panel.dictionary.lookup?.status === 'found' &&
        panel.dictionary.lookup.entry.phonetic !== '' ? (
          <span className="reading-panel-phonetic">
            {phoneticText(panel.dictionary.lookup.entry.phonetic)}
          </span>
        ) : null}
      </div>
      <p className="reading-panel-entry">
        {panel.surface === panel.entryMainForm
          ? '已收进词条'
          : `归入词条 ${panel.entryMainForm}`}
      </p>
      <PanelGlance glance={panel.glance} />
      <DictionaryView
        lookup={panel.dictionary.lookup}
        loading={panel.dictionary.loading}
        showHead={false}
      />
      <blockquote className="reading-panel-sentence">{panel.sentenceText}</blockquote>
      <p className="reading-panel-meta">
        已有 {panel.sentenceCount} 条原句 · 来自 {panel.articleCount} 篇文章
      </p>
      <div className="reading-panel-actions">
        <button type="button" className="button" onClick={onOpenEntry}>
          查看词条
        </button>
      </div>
    </aside>
  )
}

/**
 * 阅读卡首屏要先看到的置顶学习内容与故人重逢。两样都只读；
 * 没有置顶内容或只在当前篇收过时，对应块整块不出现。
 */
function PanelGlance({ glance }: { glance: EntryLearningGlance }) {
  return (
    <>
      {glance.pinnedNote === null ? null : (
        <section className="reading-panel-pinned" aria-label="置顶学习内容">
          <p className="reading-panel-glance-label">置顶学习内容</p>
          <p className="reading-panel-pinned-body">{glance.pinnedNote.excerpt}</p>
        </section>
      )}
      {glance.encounter === null ? null : (
        <section className="reading-panel-encounter" aria-label="故人重逢">
          <p className="reading-panel-glance-label">故人重逢</p>
          <blockquote className="reading-panel-encounter-sentence">
            {glance.encounter.sentenceText}
          </blockquote>
          <p className="reading-panel-source">
            {glance.encounter.articleTitle} · 第 {glance.encounter.paragraphOrdinal} 段 ·{' '}
            {glance.encounter.surface}
          </p>
        </section>
      )}
    </>
  )
}

export function EntryPanelView({
  panel,
  panelRef,
  onClose,
  onOpenEntry,
  onAsk,
  onAskNew,
  openingThread,
  laterBusy,
  onToggleLater,
  onDelete,
  onConfirmDeleteLast,
  onCancelConfirm
}: {
  panel: EntryPanel
  panelRef: RefObject<HTMLElement | null>
  onClose: () => void
  onOpenEntry: () => void
  onAsk: () => void
  onAskNew: () => void
  openingThread: boolean
  laterBusy: boolean
  onToggleLater: () => void
  onDelete: (entrySentenceId: string) => void
  onConfirmDeleteLast: () => void
  onCancelConfirm: () => void
}) {
  return (
    <aside className="reading-panel" aria-label="词条" ref={panelRef}>
      <header className="reading-panel-head">
        <p className="reading-panel-eyebrow">词条</p>
        <button type="button" className="reading-panel-close" aria-label="关闭" onClick={onClose}>
          ×
        </button>
      </header>

      {panel.card === null ? (
        panel.error === null ? (
          <p className="reading-panel-loading" aria-busy="true">
            正在打开词条…
          </p>
        ) : (
          <p className="reading-panel-error" role="alert">
            {panel.error}
          </p>
        )
      ) : (
        <>
          <h2 className="reading-panel-word">{panel.card.entry.mainForm}</h2>
          <p className="reading-panel-meta">
            已收集 {panel.card.entry.sentenceCount} 条原句 · 来自{' '}
            {panel.card.entry.articleCount} 篇文章
          </p>
          {panel.card.entry.variants.length === 0 ? null : (
            <p className="reading-panel-variants">
              变体：{panel.card.entry.variants.join('、')}
            </p>
          )}

          <PanelGlance glance={panel.card.glance} />

          <div className="reading-panel-actions">
            <button type="button" className="button" onClick={onOpenEntry}>
              打开词条
            </button>
            <button
              type="button"
              className="button"
              disabled={openingThread || panel.entrySentenceId === null}
              onClick={onAsk}
            >
              就这个词提问
            </button>
            <button
              type="button"
              className="button"
              aria-label="为这句新建对话"
              disabled={openingThread || panel.entrySentenceId === null}
              onClick={onAskNew}
            >
              新建对话
            </button>
            <button
              type="button"
              className="button"
              aria-pressed={panel.card.entry.laterMarkedAt !== null}
              disabled={laterBusy}
              onClick={onToggleLater}
            >
              {laterToggleLabel(panel.card.entry.laterMarkedAt !== null)}
            </button>
          </div>

          {panel.laterNotice === null ? null : (
            <p className="reading-panel-later-status" role="status">
              {panel.laterNotice}
            </p>
          )}

          <ul className="reading-panel-sentences">
            {panel.card.sentences.map((sentence) => (
              <li className="reading-panel-sentence-row" key={sentence.id}>
                <blockquote className="reading-panel-sentence">
                  {sentence.sentenceText}
                </blockquote>
                <p className="reading-panel-source">
                  {sentence.articleTitle} · 第 {sentence.paragraphOrdinal} 段 ·{' '}
                  {sentence.surface}
                </p>
                <button
                  type="button"
                  className="reading-panel-delete"
                  aria-label="删除这条原句"
                  disabled={panel.deleting}
                  onClick={() => onDelete(sentence.id)}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>

          {panel.confirmingDelete ? (
            <div className="reading-panel-confirm" role="alert">
              <p>
                这是最后一条原句。删掉后「{panel.card.entry.mainForm}」词条
                {panel.card.entry.noteCount > 0
                  ? `与 ${panel.card.entry.noteCount} 条学习内容`
                  : ''}
                也会一起删除。
              </p>
              <div className="reading-panel-actions">
                <button type="button" className="button" onClick={onCancelConfirm}>
                  取消
                </button>
                <button
                  type="button"
                  className="button reading-button-danger"
                  onClick={onConfirmDeleteLast}
                >
                  删除词条与原句
                </button>
              </div>
            </div>
          ) : null}

          {panel.error === null ? null : (
            <p className="reading-panel-error" role="alert">
              {panel.error}
            </p>
          )}
        </>
      )}
    </aside>
  )
}
