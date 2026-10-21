/* Path presentation. The workspace stores absolute paths; people read them home-relative. */

const home = /^\/(Users|home)\/[^/]+/

export function displayPath(path: string) {
  return path.replace(home, '~')
}

export function basename(path: string) {
  return path.slice(path.lastIndexOf('/') + 1) || path
}

/** Shortest distinguishing label for each path: name, plus parent folders only where names collide. */
export function tabLabels(paths: string[]): Map<string, string> {
  const labels = new Map<string, string>()
  const depth = new Map(paths.map((path) => [path, 1]))
  for (let round = 0; round < 4; round++) {
    const seen = new Map<string, string[]>()
    for (const path of paths) {
      const label = path.split('/').slice(-depth.get(path)!).join('/')
      labels.set(path, label)
      seen.set(label, [...(seen.get(label) ?? []), path])
    }
    const clashes = [...seen.values()].filter((group) => group.length > 1).flat()
    if (!clashes.length) break
    for (const path of clashes) depth.set(path, depth.get(path)! + 1)
  }
  return labels
}
