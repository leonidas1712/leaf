/*
 * Render Mermaid locally to an SVG string. The view shows it through an <img> blob URL, so
 * diagram labels and links can never execute in the page.
 */
import type { Theme } from './api'

let counter = 0

export interface Diagram {
  url: string
  width: number
  height: number
}

/** Mermaid's colour parser predates oklch; sample each token through a canvas into hex. */
function tokenColors() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  const styles = getComputedStyle(document.documentElement)
  return (name: string) => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = styles.getPropertyValue(name).trim()
    context.fillRect(0, 0, 1, 1)
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
  }
}

export async function renderDiagram(source: string, theme: Theme): Promise<Diagram> {
  if (source.length > 50000) throw new Error('Diagram exceeds the 50,000-character limit.')
  // Mermaid is ~3 MB; a dynamic import keeps it out of the initial bundle until a diagram appears.
  const { default: mermaid } = await import('mermaid')
  const color = tokenColors()
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    themeVariables: {
      darkMode: theme === 'dark',
      background: color('--paper'),
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: '14px',
      primaryColor: color('--chrome-raised'),
      primaryBorderColor: color('--rule-strong'),
      primaryTextColor: color('--ink'),
      secondaryColor: color('--leaf-soft'),
      tertiaryColor: color('--chrome'),
      lineColor: color('--ink-muted'),
      textColor: color('--ink'),
      noteBkgColor: color('--leaf-soft'),
      noteTextColor: color('--ink'),
      noteBorderColor: color('--leaf'),
    },
    htmlLabels: false,
    flowchart: { htmlLabels: false, useMaxWidth: false },
    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels', 'flowchart'],
    maxTextSize: 50000,
    maxEdges: 500,
  })
  const { svg } = await mermaid.render('leaf-diagram-' + ++counter, source)
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  const box = (parsed.getAttribute('viewBox') ?? '').split(/[ ,]+/).map(Number)
  const width = box.length === 4 && box[2] > 0 ? box[2] : 800
  const height = box.length === 4 && box[3] > 0 ? box[3] : 400
  return { url: URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), width, height }
}
