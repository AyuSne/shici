import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type { EntrySentence, ReadingCollectionMark } from '../../../shared/entries'
import type { DictionaryLookup } from '../../../shared/dictionary'
import type { CreateThreadRequest } from '../../../shared/threads'
import type {
  ReadingPreferences,
  ReadingSettings,
  ReadingSettingsResult,
  ReadingView
} from '../../../shared/reading'
import { DEFAULT_READING_PREFERENCES } from '../../../shared/reading'
import {
  collectSelection,
  deleteEntrySentence,
  loadEntrySentenceTarget,
  loadWordEntryCard,
  openReadingView,
  reselectEntrySentence,
  saveReadingSettings
} from '../api'
import { lookupDictionaryOrUnavailable } from '../dictionary/lookup'
import { getChatStore, openThreadForMain } from '../chat/store'
import { ErrorBlock } from '../components/error-block'
import { failureText } from '../errors'
import { showToast } from '../components/toast-store'
import { Icon } from '../components/icons'
import { useLaterMark } from '../later/use-later-mark'
import { readingPointText } from '../library/format'
import {
  forgetLibraryArticle,
  goBack,
  navigate,
  replaceLocation,
  replaceRoute
} from '../navigate'
import { buildReadingBlocks } from '../reading/content'
import { readingBackTarget } from '../reading/back-target'
import { searchUiOwns } from '../search/ownership'
import { readSearchSession } from '../search/session'
import {
  CollectedPanelView,
  EntryPanelView,
  type EntryPanel,
  type PanelState
} from '../reading/entry-panel'
import { ReadingParagraphView } from '../reading/paragraph'
import { scrollTargetIntoReading } from '../reading/scroll'
import { readParagraphSelection, readReadingExcerpt, type ReadingSelection, type ReadingExcerpt } from '../reading/selection'
import { ReadingSettingsPanel } from '../reading/settings-panel'
import { useReadingPosition } from '../reading/use-reading-position'
import type { ReadingSource } from '../routes'

type ReadingPageProps = {
  articleId: string | null
  /** 从词条页跳过来时要定位的那条原句。 */
  entrySentenceId: string | null
  /** 定位的同时就把这条原句的范围换掉。 */
  reselect: boolean
  readingFrom: ReadingSource | null
  /** 全局搜索命中的普通句：段落 id + 段内句序（0 起）；它与原句 id 是两回事。 */
  searchParagraphId: string | null
  searchSentenceOrdinal: number | null
  /** 产生这次正文定位的搜索词。 */
  searchQuery: string | null
  /** 显式点搜索结果的代次；同 hash 时也靠它重新滚回命中句/段。 */
  focusRevision: number
  /** 阅读顶栏的搜索入口：与全局栏共用同一个覆盖层。 */
  onOpenSearch: (query?: string) => void
}

/** 本次圈下的表达：先画麦色底，收下后再补上词条 id，点它可以打开词条卡。 */
type ActiveSelection = ReadingSelection & {
  entryId: string | null
  entryMainForm: string
}

/** 从词条页跳过来时的目标：把这一句滚到眼前、底色高亮，或就地换范围。 */
type FocusTarget = {
  entryId: string
  entryMainForm: string
  sentence: EntrySentence
  mode: 'highlight' | 'reselect'
}

/** 从点击目标找到已收集标记的词条 id；普通正文返回 null。 */
function entryIdOf(target: EventTarget | null): string | null {
  const mark = (target as Element | null)?.closest<HTMLElement>('[data-entry-id]')
  return mark?.dataset.entryId ?? null
}

/**
 * 阅读页：收起全局栏，620 列宽正文居中，长篇匹配在段首标原卷字母。
 * 字号行距、注释与弱高亮按篇记住；滚动时把最后读到的位置写回本机库。
 *
 * 圈选一个词或短语就完成选词：当场麦色高亮，落成词条下的一条原句；
 * 已收集的表达在重读时弱高亮，点一下打开词条卡，可从卡里删原句。
 */
export function ReadingPage({
  articleId,
  entrySentenceId,
  reselect,
  readingFrom,
  searchParagraphId,
  searchSentenceOrdinal,
  searchQuery,
  focusRevision,
  onOpenSearch
}: ReadingPageProps) {
  const [view, setView] = useState<ReadingView | null>(null)
  const [settings, setSettings] = useState<ReadingSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [collected, setCollected] = useState<ReadingCollectionMark[]>([])
  const [activeSelection, setActiveSelection] = useState<ActiveSelection | null>(null)
  const [panel, setPanel] = useState<PanelState | null>(null)
  const [focus, setFocus] = useState<FocusTarget | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [collectError, setCollectError] = useState<string | null>(null)
  const [openingThread, setOpeningThread] = useState(false)
  const [excerpt, setExcerpt] = useState<(ReadingExcerpt & { rect: DOMRect }) | null>(null)
  const later = useLaterMark()

  const { scrollRef, position, writeError, retryWrite } = useReadingPosition(view)
  const settingsRequest = useRef(0)
  /** 保存失败时留住「本来想存的那一份」，重试存的还是它，不是回退后的旧值。 */
  const failedPreferences = useRef<ReadingPreferences | null>(null)
  const settingsPanelRef = useRef<HTMLElement>(null)
  const settingsButtonRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const collectRequest = useRef(0)
  const collecting = useRef(false)

  useEffect(() => {
    if (articleId === null) {
      setView(null)
      setLoadError(null)
      setFocus(null)
      return
    }

    let active = true
    setView(null)
    setLoadError(null)
    setSettingsError(null)
    setCollected([])
    setActiveSelection(null)
    setExcerpt(null)
    setPanel(null)
    setFocus(null)
    setHint(null)
    setCollectError(null)
    openReadingView(articleId).then(
      (value) => {
        if (!active) return
        if (value === null) {
          // 文章可能刚在文章库里被删掉；清掉最近文章并回到文章库，不把阅读页停在死地址上。
          forgetLibraryArticle(articleId)
          replaceRoute('library')
          return
        }
        setView(value)
        setSettings(value.settings)
        setCollected(value.collected)
      },
      (error: unknown) => {
        if (active) setLoadError(failureText(error, '这篇文章没有打开。'))
      }
    )

    if (entrySentenceId !== null) {
      loadEntrySentenceTarget(entrySentenceId).then(
        (target) => {
          if (!active) return
          if (target === null) {
            setHint('这条原句已经不在了。')
            return
          }
          setFocus({
            entryId: target.entry.id,
            entryMainForm: target.entry.mainForm,
            sentence: target.sentence,
            mode: reselect ? 'reselect' : 'highlight'
          })
        },
        (error: unknown) => {
          if (active) setHint(failureText(error, '这条原句没有读出来。'))
        }
      )
    }

    return () => {
      active = false
    }
  }, [articleId, entrySentenceId, reselect])

  // 从词条跳过来：把那一句滚到眼前。位置恢复了之后再做，免得被「上次读到」盖住。
  useEffect(() => {
    if (view === null || focus === null) return
    const container = scrollRef.current
    if (!container) return
    const target = Array.from(
      container.querySelectorAll<HTMLElement>('.reading-sentence')
    ).find(
      (element) =>
        element.dataset.paragraphId === focus.sentence.paragraphId &&
        element.dataset.sentenceOrdinal === String(focus.sentence.sentenceOrdinal)
    )
    if (!target) return
    scrollTargetIntoReading(container, target)
  }, [view, focus, scrollRef])

  // 全局搜索的正文定位：等正文渲染、上次读到的位置恢复之后再滚，
  // 保证搜索目标最后覆盖旧进度；同一篇再次搜索也会重新落到新的一句。
  useEffect(() => {
    if (view === null || searchParagraphId === null) return
    const container = scrollRef.current
    if (!container) return
    const sentences = Array.from(
      container.querySelectorAll<HTMLElement>('.reading-sentence')
    )
    const target =
      searchSentenceOrdinal === null
        ? Array.from(container.querySelectorAll<HTMLElement>('.reading-paragraph')).find(
            (element) => element.dataset.paragraphId === searchParagraphId
          )
        : sentences.find(
            (element) =>
              element.dataset.paragraphId === searchParagraphId &&
              element.dataset.sentenceOrdinal === String(searchSentenceOrdinal)
          )
    if (!target) return
    scrollTargetIntoReading(container, target)
  }, [view, searchParagraphId, searchSentenceOrdinal, scrollRef, focusRevision])

  /**
   * 离开阅读页。来自全局搜索时，返回的是「搜索结果」本身：按原来的查询重新打开
   * 覆盖层，并回到搜索前的那一页——不伪装标签，也不把用户丢到首页。
   */
  function leaveReading(): void {
    if (readingFrom === 'search') {
      const session = readSearchSession()
      onOpenSearch(session?.query ?? '')
      if (session !== null) replaceLocation(session.originHash)
      return
    }
    const target = readingBackTarget(readingFrom, entrySentenceId)
    goBack(target.route, target.options)
  }

  // Esc 先取消词条定位，再关词条卡，再关设置，最后离开阅读页（来自搜索时回搜索结果）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return
      if (excerpt !== null) {
        setExcerpt(null)
        window.getSelection()?.removeAllRanges()
        return
      }
      if (focus !== null) {
        setFocus(null)
        return
      }
      if (panel !== null) {
        setPanel(null)
        setActiveSelection(null)
        return
      }
      if (settingsOpen) {
        setSettingsOpen(false)
        return
      }
      leaveReading()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [excerpt, focus, panel, settingsOpen, readingFrom, entrySentenceId, onOpenSearch])

  useEffect(() => {
    if (!settingsOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Element | null
      if (target === null) return
      // 搜索覆盖层与它的入口都不归阅读页处理，别顺手收掉前面的选中态。
      if (searchUiOwns(target)) return
      if (settingsPanelRef.current?.contains(target)) return
      if (settingsButtonRef.current?.contains(target)) return
      setSettingsOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [settingsOpen])

  // 点正文别处、栏位按钮或空白都收起词条卡与这次的选中态；点已收集的词、定位条或
  // 被定位的那一句不算，底色留着方便对照。
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Element | null
      if (target === null) return
      if (searchUiOwns(target)) return
      if (target.closest('.reading-excerpt-toolbar')) return
      setExcerpt(null)
      if (panelRef.current?.contains(target)) return
      if (target.closest('.reading-settings') !== null) return
      if (settingsButtonRef.current?.contains(target)) return
      if (target.closest('.reading-context') !== null) return
      if (target.closest('.reading-foot') !== null) return
      if (target.closest('.reading-sentence-focused') !== null) return
      if (entryIdOf(target) !== null) return
      setActiveSelection(null)
      setPanel(null)
      setHint(null)
      setCollectError(null)
      setFocus(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  // 阅读页的轻提示与失败都交给全局顶部 Toast：5 秒、同一套计时与动作形态。
  useEffect(() => {
    if (hint === null) return
    showToast({ message: hint })
    setHint(null)
  }, [hint])

  useEffect(() => {
    if (collectError === null) return
    showToast({ message: collectError, tone: 'error' })
    setCollectError(null)
  }, [collectError])

  const blocks = useMemo(() => {
    if (!view) return []
    return view.paragraphs.map((paragraph) => {
      const highlights = [
        ...(settings?.weakHighlight === false
          ? []
          : collected
              .filter((mark) => mark.paragraphId === paragraph.id)
              .map((mark) => ({
                entryId: mark.entryId,
                label: mark.entryMainForm,
                start: mark.start,
                end: mark.end
              }))),
        ...(activeSelection === null || activeSelection.paragraphId !== paragraph.id
          ? []
          : [
              {
                entryId: activeSelection.entryId,
                label: activeSelection.entryMainForm,
                start: activeSelection.start,
                end: activeSelection.end,
                selected: true
              }
            ])
      ]
      return {
        paragraph,
        blocks: buildReadingBlocks(paragraph, highlights)
      }
    })
  }, [view, collected, activeSelection, settings?.weakHighlight])

  function updatePreferences(patch: Partial<ReadingPreferences>): void {
    if (!view || !settings) return
    const previous = settings
    const preferences: ReadingPreferences = {
      fontSize: patch.fontSize ?? settings.fontSize,
      lineHeight: patch.lineHeight ?? settings.lineHeight,
      annotationsVisible: patch.annotationsVisible ?? settings.annotationsVisible,
      weakHighlight: patch.weakHighlight ?? settings.weakHighlight
    }
    setSettings({ ...preferences, source: 'article' })
    setSettingsError(null)
    failedPreferences.current = null
    persistPreferences(view.article.id, preferences, previous)
  }

  /** 保存失败后再存一次：重发上一次没写进去的那份值。 */
  function retryPreferences(): void {
    const preferences = failedPreferences.current
    if (!view || !settings || preferences === null) return
    setSettingsError(null)
    persistPreferences(view.article.id, preferences, settings)
  }

  function persistPreferences(
    articleId: string,
    preferences: ReadingPreferences,
    previous: ReadingSettings
  ): void {
    const request = settingsRequest.current + 1
    settingsRequest.current = request
    saveReadingSettings({ articleId, preferences }).then(
      (result: ReadingSettingsResult | null) => {
        if (request !== settingsRequest.current) return
        if (result === null) {
          setSettings(previous)
          failedPreferences.current = preferences
          setSettingsError('这篇的阅读设置没有记住。')
          return
        }
        setSettings(result.settings)
        if (!result.saved) {
          failedPreferences.current = preferences
          setSettingsError('这次阅读设置没有写入本机资料库。')
        } else {
          failedPreferences.current = null
        }
      },
      (error: unknown) => {
        if (request === settingsRequest.current) {
          setSettings(previous)
          failedPreferences.current = preferences
          setSettingsError(failureText(error, '这次阅读设置没有写入本机资料库。'))
        }
      }
    )
  }

  function updateEntryPanel(update: (panel: EntryPanel) => EntryPanel): void {
    setPanel((current) =>
      current !== null && current.kind === 'entry' ? update(current) : current
    )
  }

  /** 选词卡上的词典只认这一次圈下的词形，换词或关面板后到的结果直接丢掉。 */
  function updateCollectedDictionary(
    entryId: string,
    surface: string,
    dictionary: DictionaryLookup
  ): void {
    setPanel((current) =>
      current !== null &&
      current.kind === 'collected' &&
      current.entryId === entryId &&
      current.surface === surface
        ? { ...current, dictionary: { lookup: dictionary, loading: false } }
        : current
    )
  }

  function lookupCollectedWord(entryId: string, surface: string): void {
    lookupDictionaryOrUnavailable(surface).then((dictionary) =>
      updateCollectedDictionary(entryId, surface, dictionary)
    )
  }

  function openEntryCard(entryId: string, entrySentenceId: string | null): void {
    setActiveSelection(null)
    setHint(null)
    setPanel({
      kind: 'entry',
      entryId,
      entrySentenceId,
      card: null,
      error: null,
      confirmingDelete: false,
      deleting: false,
      laterNotice: null
    })
    loadWordEntryCard(entryId).then(
      (card) => {
        updateEntryPanel((current) =>
          current.entryId === entryId
            ? { ...current, card, error: card === null ? '这个词条已经不在了。' : null }
            : current
        )
      },
      (error: unknown) => {
        updateEntryPanel((current) =>
          current.entryId === entryId
            ? { ...current, error: failureText(error, '这个词条没有读出来。') }
            : current
        )
      }
    )
  }

  function collectCurrentSelection(): void {
    if (!view || collecting.current) return
    const read = readParagraphSelection(view.paragraphs)
    setExcerpt(null)
    if (read === null) {
      const passage = readReadingExcerpt(view.paragraphs)
      if (passage && focus?.mode !== 'reselect') {
        setHint(null)
        setPanel(null)
        setActiveSelection(null)
        setExcerpt(passage)
        return
      }
      if ((window.getSelection()?.toString().trim().length ?? 0) > 0) {
        setHint('一次圈一个词或短语（同一句内）。')
      }
      return
    }

    const { paragraph, selection } = read

    if (focus !== null && focus.mode === 'reselect') {
      if (
        paragraph.id !== focus.sentence.paragraphId ||
        selection.sentenceOrdinal !== focus.sentence.sentenceOrdinal
      ) {
        setHint('重新圈定只在原句所在的这一句里换范围。')
        return
      }
      window.getSelection()?.removeAllRanges()
      collecting.current = true
      setHint(null)
      setCollectError(null)

      const request = collectRequest.current + 1
      collectRequest.current = request
      reselectEntrySentence({
        entrySentenceId: focus.sentence.id,
        start: selection.start,
        end: selection.end
      }).then(
        (result) => {
          if (request !== collectRequest.current) return
          collecting.current = false
          if (result.status === 'resaved') {
            setCollected(result.marks)
            setFocus({
              entryId: result.entry.id,
              entryMainForm: result.entry.mainForm,
              sentence: result.sentence,
              mode: 'highlight'
            })
            setHint(`已重新圈定为「${result.sentence.surface}」。`)
            return
          }
          if (result.status === 'missing') {
            setCollectError('这条原句已经不在了。')
            return
          }
          setCollectError(
            result.reason === 'empty'
              ? '圈中的内容不算一个词，再圈一次试试。'
              : '圈中的范围不在原句里，再圈一次试试。'
          )
        },
        (error: unknown) => {
          if (request !== collectRequest.current) return
          collecting.current = false
          setCollectError(`${failureText(error, '这次没有收进来')} 再圈一次试试。`)
        }
      )
      return
    }

    window.getSelection()?.removeAllRanges()
    collecting.current = true
    setHint(null)
    setCollectError(null)
    setPanel(null)
    setActiveSelection({
      ...selection,
      entryId: null,
      entryMainForm: selection.surface
    })

    const request = collectRequest.current + 1
    collectRequest.current = request
    collectSelection({
      articleId: view.article.id,
      paragraphId: paragraph.id,
      sentenceOrdinal: selection.sentenceOrdinal,
      start: selection.start,
      end: selection.end
    }).then(
      (result) => {
        if (request !== collectRequest.current) return
        collecting.current = false
        if (result.status === 'rejected') {
          setActiveSelection(null)
          setCollectError('这次没有收进来，再圈一次试试。')
          return
        }
        setCollected(result.marks)
        setActiveSelection((current) =>
          current !== null &&
          current.paragraphId === selection.paragraphId &&
          current.start === selection.start &&
          current.end === selection.end
            ? { ...current, entryId: result.entry.id, entryMainForm: result.entry.mainForm }
            : current
        )
        setPanel({
          kind: 'collected',
          entryId: result.entry.id,
          entryMainForm: result.entry.mainForm,
          surface: result.sentence.surface,
          sentenceText: result.sentence.sentenceText,
          sentenceCount: result.entry.sentenceCount,
          articleCount: result.entry.articleCount,
          duplicate: result.status === 'duplicate',
          dictionary: { lookup: null, loading: true }
        })
        lookupCollectedWord(result.entry.id, result.sentence.surface)
      },
      (error: unknown) => {
        if (request !== collectRequest.current) return
        collecting.current = false
        setActiveSelection(null)
        setCollectError(failureText(error, '这次没有收进来，再圈一次试试。'))
      }
    )
  }

  function removeSentence(entrySentenceId: string): void {
    updateEntryPanel((current) => ({
      ...current,
      deleting: true,
      error: null,
      confirmingDelete: false
    }))
    deleteEntrySentence(entrySentenceId).then(
      (result) => {
        if (result.status === 'missing') {
          updateEntryPanel((current) => ({
            ...current,
            deleting: false,
            error: '这条原句已经不在了。'
          }))
          return
        }

        if (result.articleId === view?.article.id) {
          setCollected(result.marks)
        }
        const entry = result.entry
        if (result.entryDeleted || entry === null) {
          setPanel(null)
          setActiveSelection(null)
          setHint('原句与这个词条已删除。')
          return
        }
        updateEntryPanel((current) =>
          current.card === null
            ? current
            : {
                ...current,
                entryId: entry.id,
                entrySentenceId:
                  current.entrySentenceId === entrySentenceId ? null : current.entrySentenceId,
                deleting: false,
                error: null,
                confirmingDelete: false,
                card: {
                  entry,
                  sentences: current.card.sentences.filter(
                    (sentence) => sentence.id !== entrySentenceId
                  )
                }
              }
        )
      },
      (error: unknown) => {
        updateEntryPanel((current) => ({
          ...current,
          deleting: false,
          error: failureText(error, '这条原句没有删掉，再试一次。')
        }))
      }
    )
  }

  function requestDeleteSentence(entrySentenceId: string): void {
    if (panel === null || panel.kind !== 'entry' || panel.card === null) return
    if (panel.card.entry.sentenceCount <= 1) {
      updateEntryPanel((current) => ({ ...current, confirmingDelete: true }))
      return
    }
    removeSentence(entrySentenceId)
  }

  /** 阅读词条卡上的「稍后看」：只写独立标记，卡片与首页共享同一份持久状态。 */
  function togglePanelLater(): void {
    if (panel === null || panel.kind !== 'entry' || panel.card === null) return
    const entry = panel.card.entry
    const next = entry.laterMarkedAt === null
    void later.setLater(
      { entryId: entry.id, mainForm: entry.mainForm, later: next },
      {
        failureMessage: '稍后看没有改成功，再试一次。',
        onSettled: ({ entryId, markedAt, notice }) => {
          updateEntryPanel((current) => {
            if (current.entryId !== entryId || current.card === null) return current
            return {
              ...current,
              laterNotice: notice,
              card: {
                ...current.card,
                entry: { ...current.card.entry, laterMarkedAt: markedAt }
              }
            }
          })
        },
        onMissing: (entryId) => {
          updateEntryPanel((current) =>
            current.entryId === entryId
              ? { ...current, error: '这个词条已经不在了。' }
              : current
          )
        },
        onError: ({ entryId, message }) => {
          updateEntryPanel((current) =>
            current.entryId === entryId ? { ...current, error: message } : current
          )
        }
      }
    )
  }

  function confirmDeleteLast(): void {
    if (panel === null || panel.kind !== 'entry' || panel.card === null) return
    const last = panel.card.sentences[0]
    if (last) removeSentence(last.id)
  }

  function closePanel(): void {
    setPanel(null)
    setActiveSelection(null)
  }

  /**
   * 进入本篇选词。子视图与正文共用同一篇的文章地址（`#/reading/<id>/words`），
   * 刷新或直接打开都能回到这里，也不写阅读位置与本篇阅读设置。
   * 「进入即读完」由子视图页面先发 `reading:complete` 再读视图；`wordsFrom=reader`
   * 让子视图的返回目标明确指向阅读页，同时把阅读页自己的来源原样带回去。
   */
  function openArticleWords(): void {
    if (!view) return
    navigate('reading', {
      articleId: view.article.id,
      words: true,
      readingFrom,
      wordsFrom: 'reader'
    })
  }

  async function openReadingThread(
    main: CreateThreadRequest['main']
  ): Promise<void> {
    if (openingThread) return
    setOpeningThread(true)
    setCollectError(null)
    const threadId = await openThreadForMain(main, {
      ensureSentenceContext: main.kind === 'sentence'
    })
    if (threadId === null) {
      setCollectError(getChatStore().error ?? '没能开对话，再试一次。')
      setOpeningThread(false)
    }
  }

  function sentenceIdOf(target: EventTarget | null, entryId: string): string | null {
    const sentence = (target as Element | null)?.closest<HTMLElement>('.reading-sentence')
    if (!sentence) return null
    return (
      collected.find(
        (mark) =>
          mark.entryId === entryId &&
          mark.paragraphId === sentence.dataset.paragraphId &&
          String(mark.sentenceOrdinal) === sentence.dataset.sentenceOrdinal
      )?.id ?? null
    )
  }

  const handleBodyClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const entryId = entryIdOf(event.target)
    if (entryId !== null) openEntryCard(entryId, sentenceIdOf(event.target, entryId))
  }

  const handleBodyKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const entryId = entryIdOf(event.target)
    if (entryId === null) return
    event.preventDefault()
    openEntryCard(entryId, sentenceIdOf(event.target, entryId))
  }

  const hasLetters = view?.article.kind === 'long_match'
  const annotationCount = view
    ? view.paragraphs.reduce((total, paragraph) => total + paragraph.annotations.length, 0)
    : 0
  const bodyClassName = [
    'reading-body',
    hasLetters ? 'reading-body-letters' : '',
    annotationCount > 0 ? 'reading-body-with-notes' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const backTarget = readingBackTarget(readingFrom, entrySentenceId)
  const backLabel = backTarget.label

  return (
    <div
      className="reading"
      data-annotations={settings?.annotationsVisible === false ? 'hidden' : 'visible'}
      data-reading-page="true"
      style={
        {
          '--reading-font-size': `${settings?.fontSize ?? DEFAULT_READING_PREFERENCES.fontSize}px`,
          '--reading-line-height':
            settings?.lineHeight ?? DEFAULT_READING_PREFERENCES.lineHeight
        } as CSSProperties
      }
    >
      <header className="reading-bar">
        <button
          type="button"
          className="reading-back"
          aria-label={backTarget.ariaLabel}
          onClick={leaveReading}
        >
          <span aria-hidden="true">←</span> {backLabel || '返回'}
        </button>
        <div className="reading-bar-text">
          <h1 className="reading-bar-title">{view?.article.title ?? '阅读'}</h1>
        </div>
        <div className="reading-bar-actions">
          {/* 搜索入口与全局栏共用同一个覆盖层；阅读页收起全局栏后仍能搜。 */}
          <button
            type="button"
            className="reading-tool reading-search-trigger"
            aria-label="全局搜索"
            data-search-trigger="true"
            onClick={() => onOpenSearch()}
          >
            <Icon name="search" size={14} />
            搜索
          </button>
          {view && settings ? (
            <>
              <button
                type="button"
                className="reading-tool"
                disabled={openingThread}
                onClick={() =>
                  void openReadingThread({ kind: 'article', articleId: view.article.id })
                }
              >
                <Icon name="chat" size={14} />
                问模型
              </button>
              <button
                type="button"
                className="reading-tool"
                aria-pressed={settings.annotationsVisible}
                aria-label={settings.annotationsVisible ? '隐藏原文注释' : '显示原文注释'}
                onClick={() =>
                  updatePreferences({ annotationsVisible: !settings.annotationsVisible })
                }
              >
                <Icon name="eye" size={14} />
                注释：{settings.annotationsVisible ? '开' : '关'}
              </button>
              <div className="reading-settings-anchor" ref={settingsButtonRef}>
                <button
                  type="button"
                  className="reading-tool"
                  aria-expanded={settingsOpen}
                  aria-haspopup="true"
                  onClick={() => setSettingsOpen((open) => !open)}
                >
                  <Icon name="settings" size={14} />
                  阅读设置
                </button>
                {settingsOpen ? (
                  <ReadingSettingsPanel
                    settings={settings}
                    error={settingsError}
                    onChange={updatePreferences}
                    onRetry={retryPreferences}
                    panelRef={settingsPanelRef}
                  />
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </header>

      {focus !== null ? (
        <div className="reading-context" role="status">
          <p className="reading-context-text">
            {focus.mode === 'reselect'
              ? `重新圈定「${focus.entryMainForm}」· 在这一句里圈出正确范围`
              : `来自词条 ${focus.entryMainForm}`}
          </p>
          <div className="reading-context-actions">
            {focus.mode === 'reselect' ? (
              <button
                type="button"
                className="reading-tool"
                onClick={() => setFocus({ ...focus, mode: 'highlight' })}
              >
                取消重新圈定
              </button>
            ) : null}
            <button
              type="button"
              className="reading-tool"
              onClick={() => navigate('entries', { entryId: focus.entryId })}
            >
              回词条
            </button>
          </div>
        </div>
      ) : searchParagraphId === null ? null : (
        <div className="reading-context" role="status">
          <p className="reading-context-text">
            {searchQuery === null
              ? '来自全局搜索 · 命中正文这一段'
              : `来自搜索「${searchQuery}」· 命中正文这一段`}
          </p>
          <div className="reading-context-actions">
            {readingFrom === 'search' ? (
              <button type="button" className="reading-tool" onClick={leaveReading}>
                回搜索结果
              </button>
            ) : null}
          </div>
        </div>
      )}

      {articleId === null ? (
        <div className="reading-empty">
          <p className="eyebrow">还没有打开文章</p>
          <h2 className="reading-empty-title">先挑一篇</h2>
          <p className="reading-empty-line">文章按场次收在文章库里，打开就能接着上次读。</p>
          <button
            type="button"
            className="button button-primary"
            onClick={() => navigate('library')}
          >
            从文章库挑一篇
          </button>
        </div>
      ) : loadError !== null ? (
        <div className="reading-empty" role="alert">
          <p className="eyebrow">打不开这篇</p>
          <h2 className="reading-empty-title">{loadError}</h2>
          <button
            type="button"
            className="button button-primary"
            onClick={() => navigate('library')}
          >
            从文章库挑一篇
          </button>
        </div>
      ) : view === null ? (
        <div className="reading-empty" aria-busy="true">
          <p className="reading-empty-line">正在打开文章…</p>
        </div>
      ) : (
        <div className="reading-scroll" ref={scrollRef}>
          <div className="reading-sheet">
            {writeError === null ? null : (
              <ErrorBlock
                className="reading-write-error"
                message={writeError}
                actionLabel="重试保存"
                onAction={retryWrite}
              />
            )}
            <div
              className={bodyClassName}
              onMouseUp={collectCurrentSelection}
              onKeyUp={(event) => {
                if (event.shiftKey || event.key === 'Shift') collectCurrentSelection()
              }}
              onClick={handleBodyClick}
              onKeyDown={handleBodyKeyDown}
            >
              {blocks.map(({ paragraph, blocks: paragraphBlocks }) => (
                <ReadingParagraphView
                  key={paragraph.id}
                  paragraph={paragraph}
                  blocks={paragraphBlocks}
                  focusedSentenceOrdinal={
                    focus !== null && focus.sentence.paragraphId === paragraph.id
                      ? focus.sentence.sentenceOrdinal
                      : searchParagraphId === paragraph.id
                        ? searchSentenceOrdinal
                        : null
                  }
                  focusedParagraph={
                    searchParagraphId === paragraph.id && searchSentenceOrdinal === null
                  }
                />
              ))}
              <footer className="reading-foot">
                <span>{position ? `读到 ${readingPointText(position)}` : '还没开始读'}</span>
                <button type="button" className="reading-foot-words" onClick={openArticleWords}>
                  进入本篇选词
                </button>
                <span>位置自动记住</span>
              </footer>
            </div>
          </div>
        </div>
      )}

      {excerpt !== null && view !== null ? (
        <div className="reading-excerpt-toolbar" role="toolbar" aria-label="摘录操作" style={{ left: Math.max(110, Math.min(window.innerWidth - 110, excerpt.rect.left + excerpt.rect.width / 2)), top: Math.max(8, excerpt.rect.top - 48) }}>
          <button type="button" disabled={openingThread} onClick={() => {
            setOpeningThread(true)
            void openThreadForMain({ kind: 'article', articleId: view.article.id }, { contextItem: {
              id: `excerpt:${crypto.randomUUID()}`, kind: 'excerpt', label: '摘录', text: excerpt.text,
              source: `${view.article.title} · ${excerpt.source}`
            } }).then((id) => {
              if (id === null) { setOpeningThread(false); setCollectError(getChatStore().error ?? '摘录没有带上，再试一次。') }
            })
          }}>问模型</button>
          <button type="button" onClick={() => { void navigator.clipboard.writeText(excerpt.text).then(() => { setHint('已复制'); setExcerpt(null); window.getSelection()?.removeAllRanges() }, () => setCollectError('复制失败，请再试一次。')) }}>复制</button>
        </div>
      ) : null}

      {panel === null ? null : panel.kind === 'collected' ? (
        <CollectedPanelView
          panel={panel}
          panelRef={panelRef}
          onOpenEntry={() => navigate('entries', { entryId: panel.entryId })}
          onClose={closePanel}
        />
      ) : (
        <EntryPanelView
          panel={panel}
          panelRef={panelRef}
          onClose={closePanel}
          onOpenEntry={() => navigate('entries', { entryId: panel.entryId })}
          onAsk={() => {
            if (panel.entrySentenceId !== null) {
              void openReadingThread({ kind: 'sentence', entrySentenceId: panel.entrySentenceId })
            }
          }}
          openingThread={openingThread}
          laterBusy={panel.kind === 'entry' && later.busyEntryId === panel.entryId}
          onToggleLater={togglePanelLater}
          onDelete={requestDeleteSentence}
          onConfirmDeleteLast={confirmDeleteLast}
          onCancelConfirm={() =>
            updateEntryPanel((current) => ({ ...current, confirmingDelete: false }))
          }
        />
      )}
    </div>
  )
}
