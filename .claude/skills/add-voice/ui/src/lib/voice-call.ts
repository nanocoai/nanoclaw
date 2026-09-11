import { useCallback, useEffect, useRef, useState } from "react"

/**
 * The browser side of a Live Voice call, as one hook.
 *
 * Same wire protocol as the hand-written page it replaces: the microphone goes
 * out over WebRTC, the OpenAI events come back on the `oai-events` data
 * channel, and three host routes next to the page do the rest: `info` (who
 * answers), `sdp` (start a session) and `hangup` (end it, with keepalive so a
 * closing tab still reaches the host).
 */

export type Phase = "idle" | "connecting" | "listening" | "thinking" | "talking" | "ended" | "error"
export type Speaker = "user" | "assistant"
export interface Line {
  id: number
  from: Speaker
  text: string
  /** Seconds into the call when the turn started. */
  at: number
}

interface LiveEvent {
  type?: string
  delta?: string
}

export interface VoiceCall {
  phase: Phase
  lines: Line[]
  /** Id of the line still receiving transcript, if any. */
  streamingId: number | null
  agentName: string
  elapsed: number
  muted: boolean
  /** Human-readable problem when phase is "error". */
  error: string | null
  /** Why the last call ended, for the readout. */
  endedText: string | null
  start: () => void
  end: () => void
  toggleMute: () => void
  /** Smoothed 0..1 levels, updated every frame; read them from a rAF loop, they never re-render. */
  inputLevel: React.RefObject<number>
  outputLevel: React.RefObject<number>
  audioRef: React.RefObject<HTMLAudioElement | null>
}

export const LIVE_PHASES: ReadonlySet<Phase> = new Set(["listening", "thinking", "talking"])

function errorText(status: number, body: string): string {
  if (status === 403) return "This call link is not valid."
  if (status === 503) return "The voice line is offline right now."
  if (status === 502) return `Could not start the call. ${body}`
  return `Could not start the call (HTTP ${status}).`
}

function waitForIce(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve()
    let done = false
    const finish = () => {
      if (!done) {
        done = true
        resolve()
      }
    }
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") finish()
    })
    setTimeout(finish, 1500)
  })
}

const buf = new Uint8Array(512)
function rms(an: AnalyserNode | null): number {
  if (!an) return 0
  an.getByteTimeDomainData(buf)
  let s = 0
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128
    s += v * v
  }
  return Math.min(1, Math.sqrt(s / buf.length) * 3.2)
}

export function useVoiceCall(token: string, fallbackAgent = "your agent"): VoiceCall {
  const [phase, setPhaseState] = useState<Phase>(token ? "idle" : "error")
  const [error, setError] = useState<string | null>(token ? null : "This link is missing its token. Ask for the full call link.")
  const [endedText, setEndedText] = useState<string | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [streamingId, setStreamingId] = useState<number | null>(null)
  const [agentName, setAgentName] = useState(fallbackAgent)
  const [elapsed, setElapsed] = useState(0)
  const [muted, setMutedState] = useState(false)

  const phaseRef = useRef<Phase>(phase)
  const mutedRef = useRef(false)
  const pc = useRef<RTCPeerConnection | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const actx = useRef<AudioContext | null>(null)
  const micAn = useRef<AnalyserNode | null>(null)
  const agentAn = useRef<AnalyserNode | null>(null)
  const receiver = useRef<RTCRtpReceiver | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const startedAt = useRef(0)
  const lastWho = useRef<Speaker | "">("")
  const lastLineId = useRef<number | null>(null)
  const nextId = useRef(1)
  const lastAgentDelta = useRef(0)
  const lastDeltaAt = useRef(0)
  const streamingRef = useRef<number | null>(null)
  const inputLevel = useRef(0)
  const outputLevel = useRef(0)

  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p
    setPhaseState(p)
  }, [])

  const setStreaming = useCallback((id: number | null) => {
    streamingRef.current = id
    setStreamingId(id)
  }, [])

  // Who answers this line, so the page can greet by name before the call.
  useEffect(() => {
    if (!token) return
    const ctl = new AbortController()
    fetch(new URL("info?t=" + encodeURIComponent(token), location.href), { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { agent?: unknown } | null) => {
        if (j && typeof j.agent === "string" && j.agent.trim()) setAgentName(j.agent.trim())
      })
      .catch(() => {})
    return () => ctl.abort()
  }, [token])

  const caption = useCallback(
    (from: Speaker, delta: string) => {
      if (!delta) return
      lastDeltaAt.current = Date.now()
      const at = Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000))
      if (from !== lastWho.current || lastLineId.current === null) {
        const id = nextId.current++
        lastWho.current = from
        lastLineId.current = id
        setLines((prev) => [...prev, { id, from, text: delta, at }])
        setStreaming(id)
      } else {
        const id = lastLineId.current
        setLines((prev) => prev.map((l) => (l.id === id ? { ...l, text: l.text + delta } : l)))
        setStreaming(id)
      }
    },
    [setStreaming]
  )

  const teardown = useCallback(
    (tellHost: boolean) => {
      if (tellHost && token) {
        fetch(new URL("hangup?t=" + encodeURIComponent(token), location.href), { method: "POST", keepalive: true }).catch(() => {})
      }
      if (pc.current) {
        try {
          pc.current.close()
        } catch {
          /* already closed */
        }
        pc.current = null
      }
      if (stream.current) {
        stream.current.getTracks().forEach((t) => t.stop())
        stream.current = null
      }
      if (actx.current) {
        actx.current.close().catch(() => {})
        actx.current = null
      }
      micAn.current = null
      agentAn.current = null
      receiver.current = null
      if (audioRef.current) audioRef.current.srcObject = null
      mutedRef.current = false
      setMutedState(false)
      setStreaming(null)
    },
    [token, setStreaming]
  )

  const end = useCallback(
    (tellHost: boolean, text: string) => {
      const p = phaseRef.current
      if (p === "idle" || p === "ended") return
      teardown(tellHost)
      setEndedText(text)
      setPhase("ended")
    },
    [teardown, setPhase]
  )

  const onEvent = useCallback(
    (raw: string) => {
      let ev: LiveEvent
      try {
        ev = JSON.parse(raw) as LiveEvent
      } catch {
        return
      }
      const p = phaseRef.current
      if (ev.type === "session.input_transcript.delta") {
        caption("user", ev.delta ?? "")
        if (p === "listening" || p === "talking") setPhase("listening")
      } else if (ev.type === "session.output_transcript.delta") {
        caption("assistant", ev.delta ?? "")
        lastAgentDelta.current = Date.now()
        if (p !== "thinking" || ev.delta) setPhase("talking")
      } else if (ev.type === "session.delegation.created") {
        lastWho.current = ""
        setPhase("thinking")
      } else if (ev.type === "session.commentary.appended") {
        if (p === "thinking") setPhase("listening")
      } else if (ev.type === "session.closed") {
        end(false, "The call ended.")
      }
    },
    [caption, setPhase, end]
  )

  const start = useCallback(async () => {
    if (!token) return
    const p = phaseRef.current
    if (p === "connecting" || LIVE_PHASES.has(p)) return
    setError(null)
    setEndedText(null)
    setLines([])
    lastWho.current = ""
    lastLineId.current = null
    setStreaming(null)
    setElapsed(0)
    setPhase("connecting")
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      stream.current = s
      const ctx = new AudioContext()
      actx.current = ctx
      const an = ctx.createAnalyser()
      an.fftSize = 512
      ctx.createMediaStreamSource(s).connect(an)
      micAn.current = an

      const conn = new RTCPeerConnection()
      pc.current = conn
      conn.ontrack = (e) => {
        if (audioRef.current) audioRef.current.srcObject = e.streams[0]
        receiver.current = e.receiver
        try {
          const a2 = ctx.createAnalyser()
          a2.fftSize = 512
          ctx.createMediaStreamSource(e.streams[0]).connect(a2)
          agentAn.current = a2
        } catch {
          /* some browsers refuse remote streams here; the receiver's audio level covers it */
        }
      }
      s.getTracks().forEach((t) => conn.addTrack(t, s))
      const dc = conn.createDataChannel("oai-events")
      dc.onmessage = (e) => onEvent(String(e.data))
      conn.onconnectionstatechange = () => {
        if (conn.connectionState === "connected" && phaseRef.current === "connecting") {
          startedAt.current = Date.now()
          setPhase("listening")
        } else if (conn.connectionState === "failed") {
          end(true, "The connection dropped.")
        }
      }
      const offer = await conn.createOffer()
      await conn.setLocalDescription(offer)
      await waitForIce(conn)
      const res = await fetch(new URL("sdp?t=" + encodeURIComponent(token), location.href), {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: conn.localDescription?.sdp ?? "",
      })
      const body = await res.text()
      if (!res.ok) throw new Error(errorText(res.status, body))
      const named = res.headers.get("x-voice-agent")
      if (named && named.trim()) setAgentName(named.trim())
      await conn.setRemoteDescription({ type: "answer", sdp: body })
    } catch (err) {
      const msg =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone permission was refused."
          : err instanceof Error
            ? err.message
            : String(err)
      teardown(false)
      setError(msg)
      setPhase("error")
    }
  }, [token, onEvent, end, teardown, setPhase, setStreaming])

  const endCall = useCallback(() => end(true, "Call ended."), [end])

  const toggleMute = useCallback(() => {
    const s = stream.current
    if (!s) return
    const next = !mutedRef.current
    mutedRef.current = next
    s.getAudioTracks().forEach((t) => {
      t.enabled = !next
    })
    setMutedState(next)
  }, [])

  // Call timer.
  useEffect(() => {
    if (!LIVE_PHASES.has(phase)) return
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 500)
    return () => window.clearInterval(t)
  }, [phase])

  // Levels every frame: the agent's from the WebRTC receiver (works where Web Audio
  // cannot read a remote stream), yours from the microphone analyser. The output
  // level also drives listening/talking when transcripts lag the audio.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const p = phaseRef.current
      const live = LIVE_PHASES.has(p)
      let out = 0
      if (live) {
        const r = receiver.current
        let got = false
        try {
          if (r && typeof r.getSynchronizationSources === "function") {
            const srcs = r.getSynchronizationSources()
            if (srcs.length && typeof srcs[0].audioLevel === "number") {
              out = Math.min(1, srcs[0].audioLevel * 3)
              got = true
            }
          }
        } catch {
          got = false
        }
        if (!got) out = rms(agentAn.current)
      }
      outputLevel.current += (out - outputLevel.current) * 0.3
      const inp = live && !mutedRef.current ? rms(micAn.current) : 0
      inputLevel.current += (inp - inputLevel.current) * 0.35
      if (live && outputLevel.current > 0.05 && p !== "thinking") {
        if (p !== "talking") setPhase("talking")
        lastAgentDelta.current = Date.now()
      } else if (p === "talking" && Date.now() - lastAgentDelta.current > 900) {
        setPhase("listening")
      }
      if (streamingRef.current !== null && Date.now() - lastDeltaAt.current > 700) setStreaming(null)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [setPhase, setStreaming])

  // A closing tab still tells the host to hang up.
  useEffect(() => {
    const onHide = () => {
      if (pc.current) teardown(true)
    }
    window.addEventListener("pagehide", onHide)
    return () => window.removeEventListener("pagehide", onHide)
  }, [teardown])

  return {
    phase,
    lines,
    streamingId,
    agentName,
    elapsed,
    muted,
    error,
    endedText,
    start: () => {
      void start()
    },
    end: endCall,
    toggleMute,
    inputLevel,
    outputLevel,
    audioRef,
  }
}
