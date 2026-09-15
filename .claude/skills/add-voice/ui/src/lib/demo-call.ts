import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { LIVE_PHASES, type Line, type Phase, type Speaker, type VoiceCall } from "./voice-call"

/**
 * A scripted call with the same shape as the real one, for `?demo=1`: the page can be
 * tried without a microphone or a wired agent, and every state can be looked at.
 * Nothing here touches the host; the words and the levels are made up.
 */

type Step = { phase: Phase; ms: number; from?: Speaker; text?: string }

const AGENT = "Casa"
const SCRIPT: Step[] = [
  { phase: "connecting", ms: 1300 },
  { phase: "listening", ms: 2800, from: "user", text: "Hey Casa, what did we decide about the launch date?" },
  { phase: "thinking", ms: 1700 },
  {
    phase: "talking",
    ms: 4800,
    from: "assistant",
    text: "We settled on the 24th, right after the beta feedback round closes. Want a reminder on Thursday so you can brief the team?",
  },
  { phase: "listening", ms: 1900, from: "user", text: "Yes, and let Laura know." },
  { phase: "thinking", ms: 1400 },
  {
    phase: "talking",
    ms: 3800,
    from: "assistant",
    text: "Done. Thursday at nine is on your calendar, and Laura has a note in the family group.",
  },
  { phase: "listening", ms: 2200 },
]

export function useDemoCall(enabled: boolean): VoiceCall {
  const [phase, setPhase] = useState<Phase>("idle")
  const [lines, setLines] = useState<Line[]>([])
  const [streamingId, setStreamingId] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [muted, setMuted] = useState(false)
  const [endedText, setEndedText] = useState<string | null>(null)

  const phaseRef = useRef<Phase>("idle")
  const mutedRef = useRef(false)
  const streamingRef = useRef(false)
  const timers = useRef<number[]>([])
  const startedAt = useRef(0)
  const nextId = useRef(1)
  const inputLevel = useRef(0)
  const outputLevel = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  phaseRef.current = phase
  mutedRef.current = muted

  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t))
    timers.current = []
    streamingRef.current = false
    setStreamingId(null)
  }, [])

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms))
  }, [])

  const streamLine = useCallback(
    (from: Speaker, text: string, ms: number) => {
      const id = nextId.current++
      const words = text.split(" ")
      const interval = Math.max(70, Math.min(160, (ms * 0.8) / words.length))
      const at = Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000))
      setLines((prev) => [...prev, { id, from, text: "", at }])
      streamingRef.current = true
      setStreamingId(id)
      words.forEach((word, i) => {
        later(() => {
          setLines((prev) => prev.map((l) => (l.id === id ? { ...l, text: l.text ? `${l.text} ${word}` : word } : l)))
          if (i === words.length - 1) {
            streamingRef.current = false
            later(() => setStreamingId((cur) => (cur === id ? null : cur)), 350)
          }
        }, 300 + i * interval)
      })
    },
    [later]
  )

  const runStep = useCallback(
    (i: number) => {
      const step = SCRIPT[i]
      if (!step) return
      setPhase(step.phase)
      if (step.text && step.from) streamLine(step.from, step.text, step.ms)
      later(() => runStep(i + 1), step.ms)
    },
    [later, streamLine]
  )

  const start = useCallback(() => {
    clearTimers()
    setLines([])
    setMuted(false)
    setEndedText(null)
    startedAt.current = Date.now()
    setElapsed(0)
    runStep(0)
  }, [clearTimers, runStep])

  const end = useCallback(() => {
    if (phaseRef.current === "idle" || phaseRef.current === "ended") return
    clearTimers()
    setEndedText("Call ended.")
    setPhase("ended")
  }, [clearTimers])

  const toggleMute = useCallback(() => setMuted((m) => !m), [])

  useEffect(() => {
    if (!enabled) return
    const t = window.setTimeout(start, 500)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  useEffect(() => {
    if (!LIVE_PHASES.has(phase)) return
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 500)
    return () => window.clearInterval(t)
  }, [phase])

  // Fake levels shaped like speech.
  useEffect(() => {
    if (!enabled) return
    let raf = 0
    const tick = () => {
      const t = performance.now() / 1000
      const p = phaseRef.current
      const outTarget = p === "talking" ? 0.3 + 0.45 * Math.abs(Math.sin(t * 7.3)) * (0.55 + 0.45 * Math.abs(Math.sin(t * 2.1))) : 0
      const inTarget =
        p === "listening" && streamingRef.current && !mutedRef.current
          ? 0.28 + 0.38 * Math.abs(Math.sin(t * 9.1)) * (0.5 + 0.5 * Math.abs(Math.sin(t * 1.7)))
          : mutedRef.current
            ? 0
            : 0.03
      outputLevel.current += (outTarget - outputLevel.current) * 0.25
      inputLevel.current += (inTarget - inputLevel.current) * 0.3
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [enabled])

  return useMemo(
    () => ({
      phase,
      lines,
      streamingId,
      agentName: AGENT,
      elapsed,
      muted,
      error: null,
      endedText,
      micStream: null,
      remoteStream: null,
      start,
      end,
      toggleMute,
      inputLevel,
      outputLevel,
      audioRef,
    }),
    [phase, lines, streamingId, elapsed, muted, endedText, start, end, toggleMute]
  )
}
