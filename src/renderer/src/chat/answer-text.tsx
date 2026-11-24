import type { Pin } from '../../../shared/pins'
import { Markdown, MarkdownBlock } from '../markdown/markdown'
import { parseMarkdown, type SourceRange } from '../markdown/parse-markdown'
import { targetLabel } from './pin-text'

export type PinMarks = {
  pins: readonly Pin[]
  freshPinIds: readonly string[]
  sourceHitPinId: string | null
}

type SavedAnswer = { id: string; marks: PinMarks }

export function AnswerText({ text, saved }: { text: string; saved?: SavedAnswer }) {
  const blocks = parseMarkdown(text)
  if (!saved) return <Markdown className="assistant-text" blocks={blocks} />

  const { id, marks } = saved
  const answerPins = marks.pins.filter((pin) => pin.provenance.answerId === id)
  const badged = new Set<string>()
  const decorations = new Map<SourceRange, { className: string; fresh: Pin[] }>()
  for (const block of blocks) {
    for (const range of block.kind === 'list' ? block.items : [block]) {
      const hits = answerPins.filter((pin) => pin.start < range.end && pin.end > range.start)
      if (hits.length === 0) continue
      const fresh: Pin[] = []
      for (const pin of hits) {
        if (marks.freshPinIds.includes(pin.id) && !badged.has(pin.id)) {
          badged.add(pin.id)
          fresh.push(pin)
        }
      }
      decorations.set(range, {
        className: [
          'is-pinned',
          hits.some((pin) => pin.id === marks.sourceHitPinId) ? 'is-source-hit' : '',
          fresh.length > 0 ? 'is-fresh-pin' : ''
        ]
          .filter(Boolean)
          .join(' '),
        fresh
      })
    }
  }

  return (
    <div className="assistant-text" data-answer-id={id}>
      {blocks.map((block) => (
        <MarkdownBlock key={block.start} block={block} decorate={(range) => {
          const mark = decorations.get(range)
          return mark ? {
            className: mark.className,
            suffix: mark.fresh.map((pin) => (
              <span key={pin.id} className="pin-badge">已钉 · {targetLabel(pin.target)}</span>
            ))
          } : undefined
        }} />
      ))}
    </div>
  )
}
