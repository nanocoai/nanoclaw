import { useEffect, useRef } from "react"

/**
 * Text that arrives in pieces. Words already on screen stay put; only the words
 * added since the last render fade in, so a live transcript reads like speech
 * instead of a paste. Whitespace is preserved as the model sends it.
 */
export function StreamText({ text, animate }: { text: string; animate: boolean }) {
  const parts = text.split(/(\s+)/)
  const seen = useRef(0)
  const settled = seen.current
  useEffect(() => {
    seen.current = parts.length
  })
  return (
    <>
      {parts.map((part, i) =>
        part.trim() === "" ? (
          part
        ) : (
          <span key={i} className={animate && i >= settled ? "w in" : "w"}>
            {part}
          </span>
        )
      )}
    </>
  )
}
