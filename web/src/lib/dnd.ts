/*
 * Drag payloads shared by the sidebar and the tab strip. A drag carries an absolute document
 * path; drop targets decide what that means (open, move, or join a group). Leaf never moves
 * files on disk, so folders are not drop targets.
 */
export const PATH_TYPE = 'application/x-leaf-path'
const TAB_TYPE = 'application/x-leaf-tab'

export function startDrag(event: React.DragEvent, path: string, fromTab = false) {
  event.dataTransfer.setData(PATH_TYPE, path)
  event.dataTransfer.setData('text/plain', path)
  if (fromTab) event.dataTransfer.setData(TAB_TYPE, '1')
  event.dataTransfer.effectAllowed = fromTab ? 'move' : 'copyMove'
}

/** True while a Leaf document is being dragged; data itself is readable only on drop. */
export function carriesPath(event: React.DragEvent) {
  return event.dataTransfer.types.includes(PATH_TYPE)
}

export function draggedPath(event: React.DragEvent): string | null {
  return event.dataTransfer.getData(PATH_TYPE) || null
}

export function draggedFromTab(event: React.DragEvent) {
  return event.dataTransfer.types.includes(TAB_TYPE)
}
