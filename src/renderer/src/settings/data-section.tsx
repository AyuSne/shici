import { useEffect, useState } from 'react'
import type { SettingsOverview } from '../../../shared/settings'
import type { ThreadListItem } from '../../../shared/threads'
import {
  createBackup,
  exportThreadJsonl,
  loadThreads,
  openDataDirectory,
  pickRestoreFile,
  restoreBackup
} from '../api'
import { failureText } from '../errors'
import {
  backupSummaryText,
  fileNameOf,
  formatBytes,
  formatMoment,
  restoreRejectionText
} from './format'

type PendingRestore = {
  file: string
  createdAt: string
  bytes: number
}

type Busy = 'open' | 'backup' | 'pick' | 'restore' | 'export' | null

/** 数据：本机资料库在哪、整库备份与恢复、单条线程导出。 */
export function DataSection({
  overview,
  onChange,
  notify
}: {
  overview: SettingsOverview
  onChange: (overview: SettingsOverview) => void
  notify: (message: string) => void
}) {
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingRestore | null>(null)
  const [threads, setThreads] = useState<ThreadListItem[] | null>(null)
  const [threadId, setThreadId] = useState('')
  const [exportedTo, setExportedTo] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    loadThreads().then(
      (result) => {
        if (active) setThreads(result.threads)
      },
      () => {
        if (active) setThreads([])
      }
    )
    return () => {
      active = false
    }
  }, [])

  async function open(): Promise<void> {
    if (busy !== null) return
    setBusy('open')
    try {
      const result = await openDataDirectory()
      notify(result.opened ? '已打开数据目录' : '没能打开数据目录')
    } catch (caught) {
      notify(failureText(caught))
    } finally {
      setBusy(null)
    }
  }

  async function backup(): Promise<void> {
    if (busy !== null) return
    setBusy('backup')
    setError(null)
    try {
      const result = await createBackup()
      onChange(result.overview)
      if (result.status === 'saved') {
        notify(`已备份到 ${fileNameOf(result.backup.file)}`)
      } else if (result.status === 'failed') {
        setError(
          result.reason === 'same-file'
            ? '不能把备份写到正在用的资料库上。'
            : '备份没有写成，看看目标位置还能不能写。'
        )
      }
    } catch (caught) {
      setError(failureText(caught))
    } finally {
      setBusy(null)
    }
  }

  async function chooseRestoreFile(): Promise<void> {
    if (busy !== null) return
    setBusy('pick')
    setError(null)
    try {
      const result = await pickRestoreFile()
      if (result.status === 'picked') {
        setPending({
          file: result.file,
          createdAt: result.createdAt,
          bytes: result.bytes
        })
      } else if (result.status === 'rejected') {
        setError(restoreRejectionText(result.reason))
      }
    } catch (caught) {
      setError(failureText(caught))
    } finally {
      setBusy(null)
    }
  }

  async function confirmRestore(): Promise<void> {
    if (busy !== null || pending === null) return
    setBusy('restore')
    setError(null)
    try {
      const result = await restoreBackup(pending.file)
      onChange(result.overview)
      setPending(null)
      if (result.status === 'restored') {
        notify('已恢复，正在重新载入…')
        // 整库换过之后，各页读到的都是旧数据；重新加载最省事也最准确。
        window.setTimeout(() => window.location.reload(), 900)
        return
      }
      if (result.status === 'rejected') {
        setError(restoreRejectionText(result.reason))
        return
      }
      if (result.rolledBack) {
        setError(
          `恢复没有完成，已经退回恢复前的数据${
            result.snapshot === null ? '' : `；快照在 ${result.snapshot.file}`
          }`
        )
        return
      }
      setError(
        result.snapshot === null
          ? '恢复没有完成，资料库可能停在中间状态。'
          : `恢复没有完成，也没能自动退回；请从快照恢复：${result.snapshot.file}`
      )
    } catch (caught) {
      setError(failureText(caught))
    } finally {
      setBusy(null)
    }
  }

  async function exportThread(): Promise<void> {
    if (busy !== null || threadId === '') return
    setBusy('export')
    setError(null)
    setExportedTo(null)
    try {
      const result = await exportThreadJsonl(threadId)
      if (result.status === 'saved') {
        setExportedTo(result.file)
        notify('已导出为 JSONL')
      } else if (result.status === 'missing') {
        setError('这段对话已经不在了。')
      } else if (result.status === 'failed') {
        setError('没能写入导出文件，看看目标位置还能不能写。')
      }
    } catch (caught) {
      setError(failureText(caught))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="settings-section" aria-labelledby="settings-data-title">
      <h2 id="settings-data-title">数据</h2>
      <p className="settings-desc">
        文章、词条和学习内容保存在这台设备上。
      </p>

      <div className="data-card">
        <p className="data-card-title">本机资料库</p>
        <code className="data-path">{overview.dataDirectory}</code>
        <div className="settings-actions">
          <button
            type="button"
            className="button"
            onClick={() => void open()}
            disabled={busy !== null}
          >
            {busy === 'open' ? '正在打开…' : '打开数据目录'}
          </button>
        </div>
      </div>

      <div className="data-card">
        <p className="data-card-title">备份</p>
        <p className="data-line">
          上次备份：{overview.lastBackup === null ? '还没有备份' : backupSummaryText(overview.lastBackup)}
        </p>
        <p className="data-line">
          恢复前快照：
          {overview.lastSnapshot === null ? '还没恢复过' : backupSummaryText(overview.lastSnapshot)}
        </p>
        <p className="settings-hint">
          备份默认放在 <code className="data-inline-path">{overview.backupDirectory}</code>；
          恢复前的备份放在{' '}
          <code className="data-inline-path">{overview.snapshotDirectory}</code>。备份不含密钥，恢复后需要重新填写。
        </p>
        <div className="settings-actions">
          <button
            type="button"
            className="button"
            onClick={() => void backup()}
            disabled={busy !== null}
          >
            {busy === 'backup' ? '正在备份…' : '立即备份'}
          </button>
          <button
            type="button"
            className="button"
            onClick={() => void chooseRestoreFile()}
            disabled={busy !== null}
          >
            {busy === 'pick' ? '正在选择…' : '从备份恢复…'}
          </button>
        </div>

        {pending === null ? null : (
          <div className="data-confirm" role="alertdialog" aria-label="确认恢复">
            <p className="data-confirm-title">
              用「{fileNameOf(pending.file)}」替换本机资料库？
            </p>
            <p className="settings-hint">
              备份时间 {formatMoment(pending.createdAt)} · {formatBytes(pending.bytes)}。
              恢复将替换当前资料，替换前会自动备份。恢复后需要重新填写密钥。
            </p>
            <div className="settings-actions">
              <button
                type="button"
                className="button"
                onClick={() => setPending(null)}
                disabled={busy !== null}
              >
                取消
              </button>
              <button
                type="button"
                className="button button-danger"
                onClick={() => void confirmRestore()}
                disabled={busy !== null}
              >
                {busy === 'restore' ? '正在恢复…' : '恢复'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="data-card">
        <p className="data-card-title">导出</p>
        <p className="settings-hint">将一段对话导出为 JSONL，只包含当前分支。</p>
        {threads === null ? (
          <p className="settings-empty">正在读取对话…</p>
        ) : threads.length === 0 ? (
          <p className="settings-empty">还没有对话。</p>
        ) : (
          <>
            <label className="settings-field">
              <span>对话</span>
              <select
                value={threadId}
                onChange={(event) => setThreadId(event.target.value)}
                disabled={busy !== null}
              >
                <option value="">选择一段对话</option>
                {threads.map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {thread.title} · {thread.turnCount} 轮
                  </option>
                ))}
              </select>
            </label>
            <div className="settings-actions">
              <button
                type="button"
                className="button"
                onClick={() => void exportThread()}
                disabled={busy !== null || threadId === ''}
              >
                {busy === 'export' ? '正在导出…' : '导出为 JSONL'}
              </button>
            </div>
          </>
        )}
        {exportedTo === null ? null : (
          <p className="settings-hint">已导出到 {exportedTo}</p>
        )}
      </div>

      {error === null ? null : (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
