/**
 * Notion-style image resizing in the reader. Widths are a reading preference kept in this
 * browser, as a share of the column, so the Markdown file is never changed.
 */
const KEY = 'leaf:image-widths'
const MIN = 80

function readWidths(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}
  } catch {
    return {}
  }
}

function saveWidth(id: string, percent: number | null) {
  const widths = readWidths()
  if (percent === null) delete widths[id]
  else widths[id] = percent
  try {
    localStorage.setItem(KEY, JSON.stringify(widths))
  } catch {
    // Private windows and blocked storage resize for this view only.
  }
}

/** Wrap a loaded image in a frame with side handles, at its saved width. */
export function frameImage(img: HTMLImageElement, path: string, reference: string) {
  const frame = document.createElement('span')
  frame.className = 'image-frame'
  frame.dataset.image = path + '\n' + reference
  const saved = readWidths()[frame.dataset.image]
  if (saved) frame.style.width = `${saved}%`
  img.replaceWith(frame)
  frame.append(img)
  for (const side of ['left', 'right']) {
    const handle = document.createElement('span')
    handle.className = 'image-handle'
    handle.dataset.side = side
    handle.title = 'Drag to resize · double-click to reset'
    frame.append(handle)
  }
}

/** Drag a handle to resize its image symmetrically; double-click resets. Returns a cleanup. */
export function attachImageResize(article: HTMLElement) {
  const onPointerDown = (event: PointerEvent) => {
    const handle = (event.target as HTMLElement).closest<HTMLElement>('.image-handle')
    const frame = handle?.parentElement
    if (!handle || !frame || event.button !== 0) return
    event.preventDefault()
    const column = article.getBoundingClientRect().width
    const start = frame.getBoundingClientRect().width
    const direction = handle.dataset.side === 'left' ? -1 : 1
    const max = Math.min(column, (frame.querySelector('img')?.naturalWidth ?? column) * 2)
    handle.setPointerCapture(event.pointerId)
    frame.dataset.resizing = ''
    const move = (next: PointerEvent) => {
      // The image stays centred, so each side moves by the pointer's distance.
      const width = Math.max(MIN, Math.min(max, start + 2 * direction * (next.clientX - event.clientX)))
      frame.style.width = `${(width / column) * 100}%`
    }
    const end = () => {
      handle.removeEventListener('pointermove', move)
      delete frame.dataset.resizing
      if (frame.dataset.image) saveWidth(frame.dataset.image, Math.round(parseFloat(frame.style.width) * 10) / 10)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end, { once: true })
    handle.addEventListener('pointercancel', end, { once: true })
  }
  const onDoubleClick = (event: MouseEvent) => {
    const frame = (event.target as HTMLElement).closest('.image-handle')?.parentElement
    if (!frame?.dataset.image) return
    frame.style.width = ''
    saveWidth(frame.dataset.image, null)
  }
  article.addEventListener('pointerdown', onPointerDown)
  article.addEventListener('dblclick', onDoubleClick)
  return () => {
    article.removeEventListener('pointerdown', onPointerDown)
    article.removeEventListener('dblclick', onDoubleClick)
  }
}
