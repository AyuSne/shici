export function matchesContextSearch(item: { label: string; text: string; source: string }, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  return needle === '' || [item.label, item.text, item.source].some((value) => value.toLocaleLowerCase().includes(needle))
}
