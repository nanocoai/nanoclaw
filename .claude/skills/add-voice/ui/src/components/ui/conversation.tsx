"use client"

import type { ComponentProps } from "react"
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { ArrowDownIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

type ConversationState = {
  viewport: React.RefObject<HTMLDivElement | null>
  content: React.RefObject<HTMLDivElement | null>
  isAtBottom: boolean
  scrollToBottom: () => void
}

const ConversationContext = createContext<ConversationState | null>(null)

function useConversation() {
  const context = useContext(ConversationContext)
  if (!context) throw new Error("Conversation components must be inside Conversation")
  return context
}

export type ConversationProps = ComponentProps<"div">

export const Conversation = ({ className, children, ...props }: ConversationProps) => {
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const lastTop = useRef(0)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const scrollToBottom = useCallback(() => {
    const el = viewport.current
    if (!el) return
    following.current = true
    el.scrollTop = el.scrollHeight
    lastTop.current = el.scrollTop
    setIsAtBottom(true)
  }, [])

  useEffect(() => {
    const el = viewport.current
    const body = content.current
    if (!el || !body) return
    let frame = 0
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop <= 2
      // A viewport growing can clamp scrollTop upward while still at the bottom.
      // Only detach when the reader actually moves away from the newest text.
      if (atBottom) following.current = true
      else if (el.scrollTop < lastTop.current) following.current = false
      lastTop.current = el.scrollTop
      setIsAtBottom(following.current)
    }
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (following.current || el.scrollHeight <= el.clientHeight) scrollToBottom()
      })
    })
    observer.observe(body)
    observer.observe(el)
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      el.removeEventListener("scroll", onScroll)
    }
  }, [scrollToBottom])

  return (
    <ConversationContext.Provider value={{ viewport, content, isAtBottom, scrollToBottom }}>
      <div className={cn("relative min-h-0 flex-1 overflow-hidden", className)} role="log" {...props}>
        {children}
      </div>
    </ConversationContext.Provider>
  )
}

export type ConversationContentProps = ComponentProps<"div"> & { scrollClassName?: string }

export const ConversationContent = ({ className, scrollClassName, ...props }: ConversationContentProps) => {
  const { viewport, content } = useConversation()
  return (
    <div ref={viewport} className={cn("h-full w-full overflow-y-auto overscroll-contain [overflow-anchor:none]", scrollClassName)} style={{ scrollbarGutter: "stable both-edges" }}>
      <div ref={content} className={cn("p-4", className)} {...props} />
    </div>
  )
}

export type ConversationEmptyStateProps = Omit<
  ComponentProps<"div">,
  "title"
> & {
  title?: React.ReactNode
  description?: React.ReactNode
  icon?: React.ReactNode
}

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
)

export type ConversationScrollButtonProps = ComponentProps<typeof Button>

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useConversation()

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom()
  }, [scrollToBottom])

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "bg-background dark:bg-background absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full shadow-md",
          className
        )}
        onClick={handleScrollToBottom}
        aria-label="Scroll to latest message"
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  )
}
