import { useMemo } from "react"

/**
 * Text that arrives in pieces. Each word is one span keyed by position, so words already
 * on screen keep their element and only newly mounted spans run the fade-in animation.
 * Whitespace is preserved as the model sends it.
 */
export function StreamText({ text }: { text: string }) {
  const parts = useMemo(() => text.split(/(\s+)/), [text])
  return (
    <>
      {parts.map((part, i) =>
        part.trim() === "" ? (
          part
        ) : (
          <span key={i} className="w in">
            {part}
          </span>
        )
      )}
    </>
  )
}
