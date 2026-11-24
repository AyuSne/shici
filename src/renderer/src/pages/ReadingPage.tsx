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
import type { CreateThreadRequest, ThreadContextItem } from '../../../shared/threads'
import type {
  ReadingGlobalPreferences,
  ReadingPreferences,
  ReadingSettings,
  ReadingSettingsResult,
  ReadingView
} from '../../../shared/reading'
import { DEFAULT_READING_GLOBAL_PREFERENCES, DEFAULT_READING_PREFERENCES } from '../../../shared/reading'
import {
  collectSelection,
  completeArticleReading,
  deleteEntrySentence,
  loadEntrySentenceTarget,
  loadWordEntryCard,
  openReadingView,
  reselectEntrySentence,
  restoreEntrySentence,
  saveReadingGlobalPreferences,
  saveReadingSettings
} from '../api'
import { lookupDictionaryOrUnavailable, type DictionaryLookupState } from '../dictionary/lookup'
import { phoneticText, posLabel, statusText } from '../dictionary/presentation'
import { getChatStore, openThreadForMain } from '../chat/store'
import { ErrorBlock } from '../components/error-block'
import { failureText } from '../errors'
import { showToast, toastStore } from '../components/toast-store'
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
import { ReadingParagraphView, type ReadingMarginNote } from '../reading/paragraph'
import { QuestionDrawer } from '../reading/question-drawer'
import { scrollTargetIntoReading } from '../reading/scroll'
import { readParagraphSelection, readReadingExcerpt, selectionOffsets, locateWordAt, selectParagraphRange, type ReadingSelection, type ReadingExcerpt } from '../reading/selection'
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
  /** 刚收下的这一处做一次落墨；不是收集反馈，重复收词不触发。 */
  ink?: boolean
}

/** 从词条页跳过来时的目标：把这一句滚到眼前、底色高亮，或就地换范围。 */
type FocusTarget = {
  entryId: string
  entryMainForm: string
  sentence: EntrySentence
  mode: 'highlight' | 'reselect'
}

/** 悬停一瞥：独立浮层的位置与词典结果，不参与正文布局。 */
type GlanceState = {
  mark: ReadingCollectionMark
  rect: DOMRect
  dictionary: DictionaryLookupState
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
  const [knownWordCount, setKnownWordCount] = useState(0)
  const [settings, setSettings] = useState<ReadingSettings | null>(null)
  const [globals, setGlobals] = useState<ReadingGlobalPreferences>(
    DEFAULT_READING_GLOBAL_PREFERENCES
  )
  /** 全局偏好的最新一份；连点两个开关时以后一次的结果为准，不从旧渲染快照叠加。 */
  const globalsRef = useRef<ReadingGlobalPreferences>(DEFAULT_READING_GLOBAL_PREFERENCES)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [collected, setCollected] = useState<ReadingCollectionMark[]>([])
  const [activeSelection, setActiveSelection] = useState<ActiveSelection | null>(null)
  const [panel, setPanel] = useState<PanelState | null>(null)
  const [focus, setFocus] = useState<FocusTarget | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [collectError, setCollectError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerOpening, setDrawerOpening] = useState(false)
  const drawerToken = useRef(0)
  const drawerAbort = useRef<AbortController | null>(null)
  /** 阅读页底部「读完并整理本篇选词」是唯一写完成时间的显式手势。 */
  const [completing, setCompleting] = useState(false)
  const [completeError, setCompleteError] = useState<string | null>(null)
  const [excerpt, setExcerpt] = useState<(ReadingExcerpt & { rect: DOMRect }) | null>(null)
  const [glance, setGlance] = useState<GlanceState | null>(null)
  const [revealedMaskIds, setRevealedMaskIds] = useState<ReadonlySet<string>>(new Set())
  const later = useLaterMark()

  const { scrollRef, position, writeError, retryWrite } = useReadingPosition(view)
  const settingsRequest = useRef(0)
  const globalsRequest = useRef(0)
  /** 保存失败时留住「本来想存的那一份」，重试存的还是它，不是回退后的旧值。 */
  const failedPreferences = useRef<ReadingPreferences | null>(null)
  const settingsPanelRef = useRef<HTMLElement>(null)
  const settingsButtonRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const collectRequest = useRef(0)
  const collecting = useRef(false)
  /** 换文章就递增；所有异步返回先对一次，旧文章的结果不能写到新文章界面上。 */
  const articleToken = useRef(0)
  /** 卸载后迟到的完成 / 删除结果连导航与提示都不做，数据库那笔写仍已完成。 */
  const mounted = useRef(true)
  /** 当前可撤销的那次收词；Toast 被替换或过期后 Ctrl+Z 不再动它。 */
  const undoRef = useRef<{
    toastId: number
    articleToken: number
    entryId: string
    entrySentenceId: string
  } | null>(null)
  /** 悬停 250ms 的计时器与词典请求代次；离开、开卡、换文章、卸载都要清。 */
  const glanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const glanceRequest = useRef(0)

  /** 收起悬停一瞥，并让在途的词典结果作废。 */
  function clearGlance(): void {
    if (glanceTimer.current !== null) {
      clearTimeout(glanceTimer.current)
      glanceTimer.current = null
    }
    glanceRequest.current += 1
    setGlance(null)
  }

  /**
   * 悬停到已收集词上先等 250ms：期间移开就什么都不发生。
   * 浮层位置当场从元素量一次，之后不再读写正文布局。
   */
  function glanceAfterHover(mark: ReadingCollectionMark, element: HTMLElement): void {
    if (glanceTimer.current !== null) {
      clearTimeout(glanceTimer.current)
    }
    const token = articleToken.current
    glanceTimer.current = setTimeout(() => {
      glanceTimer.current = null
      const request = glanceRequest.current + 1
      glanceRequest.current = request
      setGlance({
        mark,
        rect: element.getBoundingClientRect(),
        dictionary: { lookup: null, loading: true }
      })
      lookupDictionaryOrUnavailable(mark.surface).then((lookup) => {
        if (request !== glanceRequest.current || token !== articleToken.current) return
        setGlance((current) =>
          current !== null && current.mark.id === mark.id
            ? { ...current, dictionary: { lookup, loading: false } }
            : current
        )
      })
    }, 250)
  }

  useEffect(() => {
    return () => {
      mounted.current = false
      if (glanceTimer.current !== null) {
        clearTimeout(glanceTimer.current)
        glanceTimer.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (articleId === null) {
      setView(null)
      setLoadError(null)
      setFocus(null)
      return
    }

    let active = true
    articleToken.current += 1
    settingsRequest.current += 1
    globalsRequest.current += 1
    undoRef.current = null
    collecting.current = false
    clearGlance()
    setRevealedMaskIds(new Set())
    setView(null)
    setKnownWordCount(0)
    setLoadError(null)
    setSettingsError(null)
    setCollected([])
    setActiveSelection(null)
    setExcerpt(null)
    setPanel(null)
    setFocus(null)
    setHint(null)
    setCollectError(null)
    setCompleting(false)
    setCompleteError(null)
    drawerToken.current += 1
    drawerAbort.current?.abort()
    drawerAbort.current = null
    setDrawerOpen(false)
    setDrawerOpening(false)
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
        setKnownWordCount(value.knownWordCount)
        setSettings(value.settings)
        globalsRef.current = value.globalPreferences
        setGlobals(value.globalPreferences)
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
  // 抽屉打开时 Esc 归抽屉：内层钉住弹层 → 选中胶囊 → 收回抽屉，不到这里退出阅读页。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return
      if (drawerOpening) {
        closeQuestionDrawer()
        return
      }
      if (drawerOpen) return
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
  }, [excerpt, focus, panel, settingsOpen, readingFrom, entrySentenceId, onOpenSearch, drawerOpen, drawerOpening])

  /**
   * Ctrl/Cmd+Z 只撤销当前那条还活着的收词提示。输入框里不抢浏览器自身的撤销，
   * Toast 已被替换或过期时也是 no-op。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.altKey || event.shiftKey) return
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]') !== null) return
      const undo = undoRef.current
      const snapshot = toastStore.getSnapshot()
      if (undo === null || snapshot === null || snapshot.id !== undo.toastId) return
      if (snapshot.action === null) return
      event.preventDefault()
      void toastStore.runAction(undo.toastId)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

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
      // 顶部 Toast 是全局操作条：点「撤销」不该顺手收掉正文选中、词条卡或摘录工具。
      if (target.closest('.toast') !== null) return
      clearGlance()
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
    // 弱高亮只决定「已收集」的样式；轻遮重读是独立开关，关掉弱高亮也不能
    // 连遮罩与首字母线索一起过滤掉。两个开关都关时才不渲染已收集标记。
    const showCollected = settings?.weakHighlight !== false || globals.lightMask
    return view.paragraphs.map((paragraph) => {
      const highlights = [
        ...(showCollected
          ? collected
              .filter((mark) => mark.paragraphId === paragraph.id)
              .map((mark) => ({
                entryId: mark.entryId,
                markId: mark.id,
                label: mark.entryMainForm,
                start: mark.start,
                end: mark.end,
                masked: globals.lightMask,
                maskRevealed: revealedMaskIds.has(mark.id)
              }))
          : []),
        ...(activeSelection === null || activeSelection.paragraphId !== paragraph.id
          ? []
          : [
              {
                entryId: activeSelection.entryId,
                label: activeSelection.entryMainForm,
                start: activeSelection.start,
                end: activeSelection.end,
                selected: true,
                ...(activeSelection.ink === true ? { ink: true } : {})
              }
            ])
      ]
      return {
        paragraph,
        blocks: buildReadingBlocks(paragraph, highlights)
      }
    })
  }, [view, collected, activeSelection, settings?.weakHighlight, globals.lightMask, revealedMaskIds])

  /**
   * 本段已拾词里带置顶学习内容的那几条。同一个词条在一段里出现多次只留一行；
   * 页边眉批顺序跟正文里的首次出现走。
   */
  const marginPinnedByParagraph = useMemo(() => {
    const notes = new Map<string, ReadingMarginNote[]>()
    const seen = new Map<string, Set<string>>()
    for (const mark of collected) {
      const pinned = mark.glance.pinnedNote
      if (pinned === null) continue
      const paragraphSeen = seen.get(mark.paragraphId) ?? new Set<string>()
      if (paragraphSeen.has(mark.entryId)) continue
      paragraphSeen.add(mark.entryId)
      seen.set(mark.paragraphId, paragraphSeen)
      const rows = notes.get(mark.paragraphId) ?? []
      rows.push({
        entryId: mark.entryId,
        mainForm: mark.entryMainForm,
        excerpt: pinned.excerpt
      })
      notes.set(mark.paragraphId, rows)
    }
    return notes
  }, [collected])

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
    const token = articleToken.current
    saveReadingSettings({ articleId, preferences }).then(
      (result: ReadingSettingsResult | null) => {
        if (request !== settingsRequest.current || token !== articleToken.current) return
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
        if (request === settingsRequest.current && token === articleToken.current) {
          setSettings(previous)
          failedPreferences.current = preferences
          setSettingsError(failureText(error, '这次阅读设置没有写入本机资料库。'))
        }
      }
    )
  }

  function updateGlobals(patch: Partial<ReadingGlobalPreferences>): void {
    const token = articleToken.current
    const previous = globalsRef.current
    const preferences = { ...globalsRef.current, ...patch }
    globalsRef.current = preferences
    setGlobals(preferences)
    const request = globalsRequest.current + 1
    globalsRequest.current = request
    saveReadingGlobalPreferences(preferences).then(
      (result) => {
        if (request !== globalsRequest.current || token !== articleToken.current) return
        if (!result.saved) {
          globalsRef.current = previous
          setGlobals(previous)
          setCollectError('这次阅读偏好没有写入本机资料库。')
          return
        }
        globalsRef.current = result.preferences
        setGlobals(result.preferences)
      },
      (error: unknown) => {
        if (request !== globalsRequest.current || token !== articleToken.current) return
        globalsRef.current = previous
        setGlobals(previous)
        setCollectError(failureText(error, '这次阅读偏好没有记住。'))
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
    // 右侧同一时间只留一块：开词条卡就收回抽屉，避免两层浮层互相遮挡。
    closeQuestionDrawer()
    clearGlance()
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
    const token = articleToken.current
    loadWordEntryCard(entryId, view?.article.id).then(
      (card) => {
        if (!mounted.current || token !== articleToken.current) return
        updateEntryPanel((current) =>
          current.entryId === entryId
            ? { ...current, card, error: card === null ? '这个词条已经不在了。' : null }
            : current
        )
      },
      (error: unknown) => {
        if (!mounted.current || token !== articleToken.current) return
        updateEntryPanel((current) =>
          current.entryId === entryId
            ? { ...current, error: failureText(error, '这个词条没有读出来。') }
            : current
        )
      }
    )
  }

  /** 撤销删除后按库里的真实状态重读这张卡；只属于当前文章与当前挂载。 */
  function reloadEntryCard(entryId: string, articleId: string, token: number): void {
    loadWordEntryCard(entryId, articleId).then(
      (card) => {
        if (!mounted.current || token !== articleToken.current) return
        updateEntryPanel((current) =>
          current.kind === 'entry' && current.entryId === entryId
            ? { ...current, card, error: card === null ? '这个词条已经不在了。' : null }
            : current
        )
      },
      (error: unknown) => {
        if (!mounted.current || token !== articleToken.current) return
        updateEntryPanel((current) =>
          current.kind === 'entry' && current.entryId === entryId
            ? { ...current, error: failureText(error, '这个词条没有读出来。') }
            : current
        )
      }
    )
  }

  /**
   * 撤销刚收下的一条原句。只删这次新加的关联：词条若因此空了会一并清掉，
   * 之前就存在的同篇同句重复关联不在撤销范围内（duplicate 不弹撤销）。
   * 换文章后迟到的删除仍会落库，但不再改新文章的界面。
   */
  async function undoCollected(target: {
    articleToken: number
    entryId: string
    entrySentenceId: string
  }): Promise<void> {
    const result = await deleteEntrySentence(target.entrySentenceId)
    if (result.status === 'missing') {
      throw new Error('这条原句已经不在了。')
    }
    if (target.articleToken !== articleToken.current) {
      return
    }
    if (result.articleId === view?.article.id) {
      setCollected(result.marks)
      setKnownWordCount(result.knownWordCount)
    }
    setActiveSelection(null)
    setFocus((current) =>
      current !== null && current.sentence.id === target.entrySentenceId ? null : current
    )
    setPanel((current) =>
      current !== null && current.entryId === target.entryId ? null : current
    )
  }

  function collectCurrentSelection(): void {
    if (!view || collecting.current) return
    const token = articleToken.current
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
          if (request !== collectRequest.current || token !== articleToken.current) return
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
          if (request !== collectRequest.current || token !== articleToken.current) return
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
        if (request !== collectRequest.current || token !== articleToken.current) return
        collecting.current = false
        if (result.status === 'rejected') {
          setActiveSelection(null)
          setCollectError('这次没有收进来，再圈一次试试。')
          return
        }
        setCollected(result.marks)
        setKnownWordCount(result.knownWordCount)
        setActiveSelection((current) =>
          current !== null &&
          current.paragraphId === selection.paragraphId &&
          current.start === selection.start &&
          current.end === selection.end
            ? {
                ...current,
                entryId: result.entry.id,
                entryMainForm: result.entry.mainForm,
                ink: result.status === 'collected'
              }
            : current
        )
        if (result.status === 'collected') {
          const toast = showToast({
            message: `已拾下「${result.sentence.surface}」`,
            action: {
              label: '撤销',
              run: () =>
                undoCollected({
                  articleToken: token,
                  entryId: result.entry.id,
                  entrySentenceId: result.sentence.id
                }),
              failureMessage: '撤销没有完成，再试一次。'
            }
          })
          undoRef.current =
            toast === null
              ? null
              : {
                  toastId: toast.id,
                  articleToken: token,
                  entryId: result.entry.id,
                  entrySentenceId: result.sentence.id
                }
        } else {
          // 重复收词没有可撤销的新关联；换掉上一条撤销提示，免得 Ctrl+Z 误删旧原句。
          undoRef.current = null
          showToast({ message: '这条原句已经收过' })
        }
        if (!globals.silentCollection) {
          setPanel({
            kind: 'collected',
            entryId: result.entry.id,
            entryMainForm: result.entry.mainForm,
            surface: result.sentence.surface,
            sentenceText: result.sentence.sentenceText,
            sentenceCount: result.entry.sentenceCount,
            articleCount: result.entry.articleCount,
            duplicate: result.status === 'duplicate',
            dictionary: { lookup: null, loading: true },
            glance: result.glance
          })
          lookupCollectedWord(result.entry.id, result.sentence.surface)
        }
      },
      (error: unknown) => {
        if (request !== collectRequest.current || token !== articleToken.current) return
        collecting.current = false
        setActiveSelection(null)
        undoRef.current = null
        setCollectError(failureText(error, '这次没有收进来，再圈一次试试。'))
      }
    )
  }

  function removeSentence(entrySentenceId: string): void {
    const token = articleToken.current
    const articleAtDelete = view?.article.id ?? null
    if (articleAtDelete === null) return
    updateEntryPanel((current) => ({
      ...current,
      deleting: true,
      error: null,
      confirmingDelete: false
    }))
    deleteEntrySentence(entrySentenceId).then(
      (result) => {
        // 换文章 / 离开阅读页后，数据库那笔删除已经完成，但不再改新文章的界面或提示。
        if (!mounted.current || token !== articleToken.current) return
        if (result.status === 'missing') {
          updateEntryPanel((current) => ({
            ...current,
            deleting: false,
            error: '这条原句已经不在了。'
          }))
          return
        }
        const panelEntryId = panel?.kind === 'entry' ? panel.entryId : null

        if (result.articleId === view?.article.id) {
          setCollected(result.marks)
          setKnownWordCount(result.knownWordCount)
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
            ? {
                ...current,
                entryId: entry.id,
                entrySentenceId:
                  current.entrySentenceId === entrySentenceId ? null : current.entrySentenceId,
                deleting: false,
                error: null,
                confirmingDelete: false
              }
            : {
                ...current,
                entryId: entry.id,
                entrySentenceId:
                  current.entrySentenceId === entrySentenceId ? null : current.entrySentenceId,
                deleting: false,
                error: null,
                confirmingDelete: false,
                card: {
                  ...current.card,
                  entry,
                  sentences: current.card.sentences.filter(
                    (sentence) => sentence.id !== entrySentenceId
                  )
                }
              }
        )

        const snapshot = result.snapshot
        if (snapshot === undefined) return
        showToast({
          message: '原句已删除。',
          action: {
            label: '撤销',
            run: async () => {
              const restored = await restoreEntrySentence(snapshot)
              if (restored.status !== 'restored') {
                throw new Error('restore rejected')
              }
              // 撤销可以晚于离开/换文章：数据库照原样恢复，但界面只在自己的生命周期里更新。
              if (!mounted.current || token !== articleToken.current) return
              if (restored.articleId === articleAtDelete) {
                setCollected(restored.marks)
                setKnownWordCount(restored.knownWordCount)
              }
              if (panelEntryId !== null) {
                reloadEntryCard(panelEntryId, articleAtDelete, token)
              }
            },
            failureMessage: '撤销没有完成，原句可能已被改动，再试一次。'
          }
        })
      },
      (error: unknown) => {
        if (!mounted.current || token !== articleToken.current) return
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
   * 顶栏「查看本篇已拾词」只是查看：不写完成时间、不改阅读位置与设置。
   * 子视图与正文共用同一篇的文章地址（`#/reading/<id>/words`），刷新或直接打开
   * 都能回到这里；`wordsFrom=reader` 让子视图的返回目标明确指向阅读页，同时把
   * 阅读页自己的来源原样带回去。
   */
  function openArticleWords(forArticleId: string | null = view?.article.id ?? null): void {
    if (forArticleId === null) return
    setCompleteError(null)
    navigate('reading', {
      articleId: forArticleId,
      words: true,
      readingFrom,
      wordsFrom: 'reader'
    })
  }

  /**
   * 底部「读完并整理本篇选词」：先发显式完成命令，成功后才进子视图。
   * 失败就留在阅读页、把原因摆出来并可再试，不拿乐观的 100% 冒充已读完。
   * 回调只属于发起它的那一篇与那一次挂载；离开、换文章后迟到的结果不导航。
   */
  function finishAndOpenArticleWords(): void {
    if (!view || completing) return
    const articleId = view.article.id
    const token = articleToken.current
    setCompleting(true)
    setCompleteError(null)
    completeArticleReading(articleId).then(
      (result) => {
        if (!mounted.current || token !== articleToken.current) return
        setCompleting(false)
        if (result.status === 'missing') {
          setCompleteError('这篇文章已经不在库里了。')
          return
        }
        openArticleWords(articleId)
      },
      (failure: unknown) => {
        if (!mounted.current || token !== articleToken.current) return
        setCompleting(false)
        setCompleteError(failureText(failure, '没有把这篇标记成已读完，再试一次。'))
      }
    )
  }

  /**
   * 就地打开轻问抽屉：复用同一份对话 store 与打开语义，只是不跳去对话页。
   * 每次打开有自己的所有权；Esc / 换文章 / 卸载后迟到的结果既不重开也不导航。
   */
  async function openQuestionDrawer(request: {
    main: CreateThreadRequest['main']
    ensureSentenceContext?: boolean
    contextItem?: ThreadContextItem
  }): Promise<void> {
    if (drawerOpening) return
    const controller = new AbortController()
    drawerAbort.current?.abort()
    drawerAbort.current = controller
    const token = ++drawerToken.current
    setCollectError(null)
    setDrawerOpening(true)
    const threadId = await openThreadForMain(request.main, {
      openInPlace: true,
      signal: controller.signal,
      ...(request.ensureSentenceContext === true ? { ensureSentenceContext: true } : {}),
      ...(request.contextItem === undefined ? {} : { contextItem: request.contextItem })
    })
    if (token !== drawerToken.current || controller.signal.aborted) return
    setDrawerOpening(false)
    if (threadId === null) {
      setCollectError(getChatStore().error ?? '没能就着原文打开轻问，再试一次。')
      return
    }
    // 旧请求可能被更新的打开意图接管：它拿到的线程已经不是当前线程时，
    // 不打开抽屉去呈现别人的对话。
    if (getChatStore().currentId !== threadId) return
    // 抽屉和词条卡是同一块右侧空间：打开抽屉就收起卡、选中与摘录工具条。
    clearGlance()
    setPanel(null)
    setActiveSelection(null)
    setExcerpt(null)
    setDrawerOpen(true)
  }

  /** 收回抽屉：取消还在路上的打开请求，但不停止一条已经在生成的回答。 */
  function closeQuestionDrawer(): void {
    drawerToken.current += 1
    drawerAbort.current?.abort()
    drawerAbort.current = null
    setDrawerOpen(false)
    setDrawerOpening(false)
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
    // 轻遮重读：第一次轻点只揭开词形，再点才打开词条卡。
    if (globals.lightMask) {
      const maskElement = (event.target as Element | null)?.closest<HTMLElement>('[data-mark-id]')
      const maskId = maskElement?.dataset.markId
      if (maskElement !== null && maskElement !== undefined && maskId !== undefined) {
        if (!revealedMaskIds.has(maskId)) {
          setRevealedMaskIds((current) => new Set(current).add(maskId))
          return
        }
      }
    }
    const entryId = entryIdOf(event.target)
    if (entryId !== null) openEntryCard(entryId, sentenceIdOf(event.target, entryId))
  }

  const handleBodyMouseOver = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const element = (event.target as Element | null)?.closest<HTMLElement>('[data-mark-id]')
    const markId = element?.dataset.markId
    if (element === null || element === undefined || markId === undefined) return
    if (glance?.mark.id === markId) return
    const mark = collected.find((candidate) => candidate.id === markId)
    if (mark === undefined) return
    glanceAfterHover(mark, element)
  }

  const handleBodyMouseOut = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const from = (event.target as Element | null)?.closest<HTMLElement>('[data-mark-id]')
    if (from === null || from === undefined) return
    const to = event.relatedTarget as Element | null
    if (to !== null && (from === to || from.contains(to))) return
    clearGlance()
  }

  /**
   * 双击英文词直接收词。落点先吸附成完整词形；已经是收集过的词就交给单击打开词条卡，
   * 不再产生 duplicate 的选词结果。双击的第二下 mouseup 不重复走拖选流程。
   */
  const handleBodyDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (view === null || collecting.current) return
    const paragraphElement = (event.target as Element | null)?.closest<HTMLElement>(
      '.reading-paragraph'
    )
    if (!paragraphElement) return
    const paragraph = view.paragraphs.find(
      (candidate) => candidate.id === paragraphElement.dataset.paragraphId
    )
    if (!paragraph) return
    const offsets = selectionOffsets(paragraphElement)
    if (offsets === null) return
    const word = locateWordAt(paragraph, offsets.start)
    if (word === null) return
    if (
      focus?.mode !== 'reselect' &&
      collected.some(
        (mark) =>
          mark.paragraphId === word.paragraphId &&
          mark.start < word.end &&
          mark.end > word.start
      )
    ) {
      return
    }
    if (!selectParagraphRange(paragraphElement, word.start, word.end)) return
    collectCurrentSelection()
  }

  const handleBodyKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const entryId = entryIdOf(event.target)
    if (entryId === null) return
    event.preventDefault()
    openEntryCard(entryId, sentenceIdOf(event.target, entryId))
  }

  const hasLetters = view?.article.kind === 'long_match'
  const showAnnotationRows =
    globals.marginNoteMode === 'all' && settings?.annotationsVisible !== false
  const marginColumnVisible =
    view !== null &&
    globals.marginNoteMode !== 'hidden' &&
    view.paragraphs.some(
      (paragraph) =>
        (showAnnotationRows && paragraph.annotations.length > 0) ||
        (marginPinnedByParagraph.get(paragraph.id)?.length ?? 0) > 0
    )
  const bodyClassName = [
    'reading-body',
    hasLetters ? 'reading-body-letters' : '',
    marginColumnVisible ? 'reading-body-with-notes' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const glanceLookup = glance?.dictionary.lookup ?? null
  const glancePhonetic =
    glanceLookup?.status === 'found' ? phoneticText(glanceLookup.entry.phonetic) : ''
  const glanceBody =
    glance === null
      ? ''
      : glance.mark.glance.pinnedNote !== null
        ? glance.mark.glance.pinnedNote.excerpt
        : glance.dictionary.loading || glanceLookup === null
          ? '正在查词典…'
          : glanceLookup.status !== 'found'
            ? statusText(glanceLookup)
            : glanceLookup.entry.senses.length === 0
              ? '词典里没有释义。'
              : `${posLabel(glanceLookup.entry.senses[0]!.pos)} ${
                  glanceLookup.entry.senses[0]!.text
                }`.trim()

  const backTarget = readingBackTarget(readingFrom, entrySentenceId)
  const backLabel = backTarget.label

  return (
    <div
      className="reading"
      data-annotations={settings?.annotationsVisible === false ? 'hidden' : 'visible'}
      data-reading-page="true"
      data-margin-notes={marginColumnVisible ? 'true' : 'false'}
      data-panel={panel === null ? 'false' : 'true'}
      data-drawer={drawerOpen || drawerOpening ? 'true' : 'false'}
      style={
        {
          '--reading-font-size': `${settings?.fontSize ?? DEFAULT_READING_PREFERENCES.fontSize}px`,
          '--reading-line-height':
            settings?.lineHeight ?? DEFAULT_READING_PREFERENCES.lineHeight,
          '--reading-grid-width': `${hasLetters ? 852 : 820}px`
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
          {view === null ? null : (
            <p className="reading-bar-meta">本篇含 {knownWordCount} 个曾收词</p>
          )}
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
                className="reading-tool reading-words-preview"
                onClick={() => openArticleWords()}
              >
                查看本篇已拾词
              </button>
              <button
                type="button"
                className="reading-tool"
                disabled={drawerOpening}
                onClick={() =>
                  void openQuestionDrawer({ main: { kind: 'article', articleId: view.article.id } })
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
                    globals={globals}
                    error={settingsError}
                    onChange={updatePreferences}
                    onGlobalsChange={updateGlobals}
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
        <div className="reading-scroll" ref={scrollRef} onScroll={clearGlance}>
          <div className="reading-sheet">
            {writeError === null ? null : (
              <ErrorBlock
                className="reading-write-error"
                message={writeError}
                actionLabel="重试保存"
                onAction={retryWrite}
              />
            )}
            {completeError === null ? null : (
              <ErrorBlock
                className="reading-write-error"
                message={completeError}
                actionLabel="再试一次"
                onAction={finishAndOpenArticleWords}
              />
            )}
            <div
              className={bodyClassName}
              onMouseUp={(event) => {
                // 双击的第二下由 onDoubleClick 统一处理，避免 duplicate 选词卡盖住词条卡。
                if (event.detail < 2) collectCurrentSelection()
              }}
              onDoubleClick={handleBodyDoubleClick}
              onMouseOver={handleBodyMouseOver}
              onMouseOut={handleBodyMouseOut}
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
                  showAnnotationRows={showAnnotationRows}
                  marginNotes={
                    globals.marginNoteMode === 'hidden'
                      ? []
                      : (marginPinnedByParagraph.get(paragraph.id) ?? [])
                  }
                />
              ))}
              <footer className="reading-foot">
                <span>{position ? `读到 ${readingPointText(position)}` : '还没开始读'}</span>
                <button
                  type="button"
                  className="reading-foot-words"
                  disabled={completing}
                  onClick={finishAndOpenArticleWords}
                >
                  {completing ? '正在标记已读完…' : '读完并整理本篇选词'}
                </button>
                <span>位置自动记住</span>
              </footer>
            </div>
          </div>
        </div>
      )}

      {excerpt !== null && view !== null ? (
        <div className="reading-excerpt-toolbar" role="toolbar" aria-label="摘录操作" style={{ left: Math.max(110, Math.min(window.innerWidth - 110, excerpt.rect.left + excerpt.rect.width / 2)), top: Math.max(8, excerpt.rect.top - 48) }}>
          <button type="button" disabled={drawerOpening} onClick={() => {
            void openQuestionDrawer({
              main: { kind: 'article', articleId: view.article.id },
              contextItem: {
                id: `excerpt:${crypto.randomUUID()}`,
                kind: 'excerpt',
                label: '摘录',
                text: excerpt.text,
                source: `${view.article.title} · ${excerpt.source}`
              }
            })
          }}>问模型</button>
          <button type="button" onClick={() => { void navigator.clipboard.writeText(excerpt.text).then(() => { setHint('已复制'); setExcerpt(null); window.getSelection()?.removeAllRanges() }, () => setCollectError('复制失败，请再试一次。')) }}>复制</button>
        </div>
      ) : null}

      {glance === null ? null : (
        <div
          className="reading-glance"
          role="tooltip"
          style={{
            left: Math.max(
              12,
              Math.min(glance.rect.left, Math.max(12, window.innerWidth - 300))
            ),
            top: Math.min(glance.rect.bottom + 8, window.innerHeight - 120)
          }}
        >
          <p className="reading-glance-head">
            <span className="reading-glance-word">{glance.mark.entryMainForm}</span>
            {glancePhonetic === '' ? null : (
              <span className="reading-glance-phonetic">{glancePhonetic}</span>
            )}
          </p>
          <p className="reading-glance-body">{glanceBody}</p>
        </div>
      )}

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
              void openQuestionDrawer({
                main: { kind: 'sentence', entrySentenceId: panel.entrySentenceId },
                ensureSentenceContext: true
              })
            }
          }}
          openingThread={drawerOpening}
          laterBusy={panel.kind === 'entry' && later.busyEntryId === panel.entryId}
          onToggleLater={togglePanelLater}
          onDelete={requestDeleteSentence}
          onConfirmDeleteLast={confirmDeleteLast}
          onCancelConfirm={() =>
            updateEntryPanel((current) => ({ ...current, confirmingDelete: false }))
          }
        />
      )}

      {drawerOpen ? (
        <QuestionDrawer
          onClose={closeQuestionDrawer}
          onExpand={(threadId) => {
            setDrawerOpen(false)
            navigate('chat', { threadId })
          }}
        />
      ) : null}
    </div>
  )
}
