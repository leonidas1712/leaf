/** The Leaf mark: a single leaf with a folded page corner for a midrib. */
export function LeafMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path d="M4.5 19.5C4.5 10.5 10 4.5 19.5 4.5c0 9.5-6 15-15 15Z" fill="currentColor" opacity="0.18" />
      <path
        d="M4.5 19.5C4.5 10.5 10 4.5 19.5 4.5c0 9.5-6 15-15 15Zm0 0L13 11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
