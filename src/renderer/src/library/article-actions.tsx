import { useEffect, useRef, useState } from 'react'
import type { ArticleDeletionPreview, ArticleDetail } from '../../../shared/library'
import { ARTICLE_TITLE_MAX_LENGTH } from '../../../shared/library'
import {
  deleteArticle,
  loadArticleDeletionPreview,
  renameArticle
} from '../api'
import { failureText } from '../errors'
import { deletionImpactLines } from './impact'

/**
 * 文章详情里的重命名与删除。删除先取影响面，确认后才真删；确认时把看到的那份影响面
 * 一起发给主进程，主进程在事务里重算，变了就拒绝并带回最新一份，界面重新摆出来让用户
 * 再确认一次。预览请求带序号与文章 id：换选中项后回来的旧预览不会贴到下一篇上，
 * 也不能拿 A 的预览去确认 B。
 */
export function LibraryArticleActions({
  detail,
  onRenamed,
  onDeleted,
  onError
}: {
  detail: ArticleDetail
  onRenamed: (title: string) => void
  onDeleted: (articleId: string) => void
  onError: (message: string) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(detail.title)
  const [renamingBusy, setRenamingBusy] = useState(false)
  const [renamingError, setRenamingError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ArticleDeletionPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewStale, setPreviewStale] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const previewRequest = useRef(0)
  /** 当前详情对应的文章；预览响应必须还属于它，否则丢弃。 */
  const detailId = useRef(detail.id)
  detailId.current = detail.id

  useEffect(() => {
    // 换文章（含重命名后刷新）时作废在途预览，旧响应回来也不再落到新文章上。
    previewRequest.current += 1
    setRenaming(false)
    setDraft(detail.title)
    setRenamingError(null)
    setPreview(null)
    setPreviewLoading(false)
    setPreviewStale(false)
    setDeleting(false)
  }, [detail.id, detail.title])

  async function submitRename(): Promise<void> {
    if (renamingBusy) return
    setRenamingError(null)
    setRenamingBusy(true)
    try {
      const result = await renameArticle({ articleId: detail.id, title: draft })
      if (result.status === 'renamed') {
        setRenaming(false)
        onRenamed(result.title)
        return
      }
      if (result.status === 'missing') {
        setRenaming(false)
        onError('这篇文章已经不在了。')
        return
      }
      setRenamingError(
        result.reason === 'empty' ? '篇名不能为空。' : '篇名太长了，换短一点的。'
      )
    } catch (error) {
      setRenamingError(failureText(error, '这次重命名没有保存，再试一次。'))
    } finally {
      setRenamingBusy(false)
    }
  }

  function startRenaming(): void {
    setDraft(detail.title)
    setRenamingError(null)
    setPreview(null)
    setPreviewStale(false)
    setRenaming(true)
  }

  async function requestDelete(): Promise<void> {
    if (previewLoading) return
    const requestedId = detail.id
    const request = previewRequest.current + 1
    previewRequest.current = request
    setRenaming(false)
    setPreviewLoading(true)
    setPreview(null)
    setPreviewStale(false)
    try {
      const value = await loadArticleDeletionPreview(requestedId)
      if (request !== previewRequest.current || detailId.current !== requestedId) return
      if (value === null) {
        onError('这篇文章已经不在了。')
        return
      }
      // 预览必须属于请求的那一篇，响应里的 id 对不上也不贴到眼前这一篇上。
      if (value.articleId !== requestedId) return
      setPreview(value)
    } catch (error) {
      if (request === previewRequest.current) {
        onError(failureText(error, '没能检查关联内容，请再试一次。'))
      }
    } finally {
      if (request === previewRequest.current) setPreviewLoading(false)
    }
  }

  async function confirmDelete(): Promise<void> {
    // 预览必须属于眼前这篇文章；拿旧文章的预览绝不能确认。
    if (deleting || preview === null || preview.articleId !== detail.id) return
    const confirmed = preview
    setDeleting(true)
    try {
      const result = await deleteArticle({ articleId: detail.id, confirmed })
      if (result.status === 'deleted') {
        setPreview(null)
        setPreviewStale(false)
        onDeleted(result.articleId)
        return
      }
      if (result.status === 'stale') {
        // 预览之后库变了：这次什么都没删，换上最新影响面等用户再确认一次。
        setPreview(result.preview)
        setPreviewStale(true)
        return
      }
      setPreview(null)
      onError('这篇文章已经不在了。')
    } catch (error) {
      onError(failureText(error, '这篇文章没有删掉，再试一次。'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="library-manage">
      {renaming ? (
        <form
          className="library-rename"
          aria-label="重命名文章"
          onSubmit={(event) => {
            event.preventDefault()
            void submitRename()
          }}
        >
          <label className="library-rename-field">
            <span>篇名</span>
            <input
              type="text"
              value={draft}
              autoFocus
              maxLength={ARTICLE_TITLE_MAX_LENGTH}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          {renamingError === null ? null : (
            <p className="entry-error" role="alert">
              {renamingError}
            </p>
          )}
          <div className="library-manage-row">
            <button type="submit" className="button" disabled={renamingBusy}>
              保存篇名
            </button>
            <button
              type="button"
              className="button"
              disabled={renamingBusy}
              onClick={() => setRenaming(false)}
            >
              取消
            </button>
          </div>
        </form>
      ) : null}

      <div className="library-detail-actions library-manage-row">
        {renaming ? null : (
          <button type="button" className="button" onClick={startRenaming}>
            重命名
          </button>
        )}
        <button
          type="button"
          className="button entry-action-danger"
          disabled={previewLoading || deleting}
          onClick={() => void requestDelete()}
        >
          {previewLoading ? '正在检查关联内容…' : '删除文章'}
        </button>
      </div>

      {preview === null ? null : (
        <div className="entry-confirm" role="alertdialog" aria-label="删除文章">
          <p>
            删除「{detail.title}」后，文章、段落与句子都会从库里消失，不能撤销。
          </p>
          <ul className="library-impact">
            {deletionImpactLines(preview).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {previewStale ? (
            <p className="library-impact-stale" role="status">
              关联内容有变化，请查看后重新确认。
            </p>
          ) : null}
          <div className="library-manage-row">
            <button
              type="button"
              className="button"
              disabled={deleting}
              onClick={() => {
                setPreview(null)
                setPreviewStale(false)
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="button entry-action-danger"
              disabled={deleting}
              onClick={() => void confirmDelete()}
            >
              {deleting ? '正在删除…' : '确认删除'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
