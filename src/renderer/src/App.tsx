import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImportReport } from '../../shared/library'
import { resolveTheme, type AppBootstrap } from '../../shared/types'
import { loadBootstrap, saveSidebarPreference } from './api'
import { setChatModel } from './chat/store'
import { GlobalNav } from './components/GlobalNav'
import { TitleBar } from './components/title-bar'
import { ToastHost } from './components/toast'
import { showToast } from './components/toast-store'
import { navCountsStore } from './nav-counts/instance'
import { ChatPage } from './pages/ChatPage'
import { EntriesPage } from './pages/EntriesPage'
import { HomePage } from './pages/HomePage'
import { LibraryPage } from './pages/LibraryPage'
import { ReadingPage } from './pages/ReadingPage'
import { ArticleWordsPage } from './reading/article-words-page'
import { GlobalSearch } from './search/global-search'
import { SettingsPage } from './pages/SettingsPage'
import { setThemePreference, useSystemPrefersDark, useThemePreference } from './theme'
import { useView } from './use-view'

/**
 * 应用外壳：融合标题栏 + 可折叠全局栏 + 页面 + 全局搜索 + 顶部 Toast。
 *
 * 侧栏折叠状态只在这里持有：收起 / 展开不重建导航节点，阅读页整栏不渲染，
 * 退出阅读后仍按用户偏好出现。Ctrl+B / Ctrl+K 也在这里统一监听，避免每页各写一份。
 */
export function App() {
  const view = useView()
  const themePreference = useThemePreference()
  const systemPrefersDark = useSystemPrefersDark()
  const openSearch = useCallback((query = '') => {
    setSearchQuery(query)
    setSearchOpen(true)
  }, [])
  const closeSearch = useCallback(() => setSearchOpen(false), [])
  const [bootstrap, setBootstrap] = useState<AppBootstrap | null>(null)
  const [corpusImport, setCorpusImport] = useState<ImportReport | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  // 搜索覆盖层只是叠在当前页面上方：开关它不写路由、不重挂载底页。
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // 键盘事件里读当前折叠态，不把 event 监听器绑在每次 state 变化上。
  const sidebarCollapsedRef = useRef(false)
  // 点搜索结果是一次显式定位请求：即使地址与当前完全相同（同一条学习内容/同一句），
  // 也要让底页重新执行一次「打开并滚到目标」。它与 URL 状态分开，不写历史、不重挂载。
  const [focusRevision, setFocusRevision] = useState(0)
  const requestTargetFocus = useCallback(() => setFocusRevision((revision) => revision + 1), [])

  useEffect(() => {
    let active = true
    loadBootstrap().then(
      (value) => {
        if (active) {
          setChatModel(value.chatModel)
          setThemePreference(value.theme)
          sidebarCollapsedRef.current = value.sidebarCollapsed
          setSidebarCollapsed(value.sidebarCollapsed)
          setCorpusImport(value.corpusImport)
          setBootstrap(value)
        }
      },
      (error: unknown) => {
        if (active) setBootError(error instanceof Error ? error.message : String(error))
      }
    )
    return () => {
      active = false
    }
  }, [])

  // 跟随系统时，Windows 切深浅不用重启；浅色与深色则按选择固定。
  useEffect(() => {
    document.documentElement.dataset.theme = resolveTheme(
      themePreference,
      systemPrefersDark
    )
  }, [themePreference, systemPrefersDark])

  /**
   * 切换侧栏：先在本地立即生效（不闪跳），再写 setting。
   * 写失败时界面仍保持用户刚选的样子，只给一条可看见的提示。
   */
  const toggleSidebar = useCallback(() => {
    const collapsed = !sidebarCollapsedRef.current
    sidebarCollapsedRef.current = collapsed
    setSidebarCollapsed(collapsed)
    saveSidebarPreference(collapsed).then(
      (result) => {
        if (!result.saved) {
          showToast({
            message: '侧栏偏好没有保存，下次启动会按上次保存的状态。',
            tone: 'error'
          })
        }
      },
      () => {
        showToast({
          message: '侧栏偏好没有保存，下次启动会按上次保存的状态。',
          tone: 'error'
        })
      }
    )
  }, [])

  // Ctrl/Cmd+B 折叠侧栏、Ctrl/Cmd+K 唤起搜索。输入法组合态与长按重复一律忽略；
  // 搜索覆盖层打开时不再去动底下的侧栏，Esc 的所有权仍归覆盖层与各页面。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      if (key === 'k') {
        event.preventDefault()
        if (searchOpen) {
          document.querySelector<HTMLInputElement>('.global-search-input')?.focus()
        } else {
          openSearch()
        }
        return
      }
      if (key === 'b') {
        event.preventDefault()
        if (!searchOpen && view.route !== 'reading') {
          toggleSidebar()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openSearch, searchOpen, toggleSidebar, view.route])

  // 每次进入一个页面（包括阅读页，那里没有全局栏）非阻塞重查一次计数。
  // store 自己在飞时只记一次补查：不轮询、不挡住导航；失败时保留已有数字。
  useEffect(() => {
    void navCountsStore.refresh()
  }, [view.route])

  if (bootError !== null) {
    return (
      <div className="boot boot-error" role="alert">
        <h1>启动失败</h1>
        <p>{bootError}</p>
        <button type="button" className="button" onClick={() => window.location.reload()}>
          再试一次
        </button>
      </div>
    )
  }

  if (!bootstrap) {
    return <div className="boot" aria-busy="true" />
  }

  const mainClass =
    view.route === 'chat'
      ? 'main main-chat'
      : view.route === 'settings'
        ? 'main main-settings'
        : 'main'

  // 阅读页收起全局栏，注意力只留在文章上；退出后仍按用户偏好恢复（状态未丢）。
  // 「本篇选词」是同一篇文章下的只读子视图，同样不显示全局栏。
  return (
    <div className="app-shell">
      <TitleBar route={view.route} />

      {view.route === 'reading' ? (
        <div className="app-stage" data-shell-stage="reading">
          {view.readingWords ? (
            <ArticleWordsPage
              articleId={view.articleId}
              readingFrom={view.readingFrom}
              wordsFrom={view.readingWordsFrom}
            />
          ) : (
            <ReadingPage
              articleId={view.articleId}
              entrySentenceId={view.entrySentenceId}
              reselect={view.reselect}
              readingFrom={view.readingFrom}
              searchParagraphId={view.searchParagraphId}
              searchSentenceOrdinal={view.searchSentenceOrdinal}
              searchQuery={view.searchQuery}
              focusRevision={focusRevision}
              onOpenSearch={openSearch}
            />
          )}
        </div>
      ) : (
        <div className={sidebarCollapsed ? 'app is-sidebar-collapsed' : 'app'}>
          <GlobalNav
            route={view.route}
            collapsed={sidebarCollapsed}
            onToggleCollapsed={toggleSidebar}
            onOpenSearch={() => openSearch()}
          />
          <main className={mainClass}>
            {view.route === 'home' ? (
              <HomePage />
            ) : view.route === 'entries' ? (
              <EntriesPage
                entryId={view.entryId}
                entrySentenceId={view.entrySentenceId}
                noteId={view.noteId}
                focusRevision={focusRevision}
              />
            ) : view.route === 'chat' ? (
              <ChatPage
                threadId={view.threadId}
                pinId={view.pinId}
                fromEntryId={view.fromEntryId}
              />
            ) : view.route === 'library' ? (
              <LibraryPage
                articleId={view.articleId}
                corpusImport={corpusImport ?? bootstrap.corpusImport}
                onReimport={setCorpusImport}
              />
            ) : (
              <SettingsPage />
            )}
          </main>
        </div>
      )}

      {searchOpen ? (
        <GlobalSearch
          initialQuery={searchQuery}
          onClose={closeSearch}
          onChooseResult={requestTargetFocus}
        />
      ) : null}
      <ToastHost />
    </div>
  )
}
