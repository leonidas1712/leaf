/* Build the sidebar tree from granted entries. Paths are absolute; folders are workspace roots. */
import type { Entry } from './api'
import { TEXT_FILE } from './store'

export interface TreeNode {
  name: string
  path: string
  folder: boolean
  children: TreeNode[]
  documents: number
}

export function buildTree(root: string, entries: Map<string, Entry>, query: string): TreeNode {
  const top: TreeNode = { name: root.slice(root.lastIndexOf('/') + 1) || root, path: root, folder: true, children: [], documents: 0 }
  const folders = new Map<string, TreeNode>([[root, top]])
  const needle = query.trim().toLowerCase()
  const prefix = root + '/'
  for (const path of entries.keys()) {
    if (!path.startsWith(prefix) || !TEXT_FILE.test(path)) continue
    const relative = path.slice(prefix.length)
    if (needle && !relative.toLowerCase().includes(needle)) continue
    const parts = relative.split('/')
    let parent = top
    let current = root
    for (const part of parts.slice(0, -1)) {
      current += '/' + part
      let node = folders.get(current)
      if (!node) {
        node = { name: part, path: current, folder: true, children: [], documents: 0 }
        folders.set(current, node)
        parent.children.push(node)
      }
      parent = node
    }
    parent.children.push({ name: parts.at(-1)!, path, folder: false, children: [], documents: 1 })
  }
  const finish = (node: TreeNode): number => {
    node.children.sort((a, b) =>
      a.folder === b.folder ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.folder ? -1 : 1,
    )
    node.documents = node.folder ? node.children.reduce((sum, child) => sum + finish(child), 0) : 1
    return node.documents
  }
  finish(top)
  return top
}
