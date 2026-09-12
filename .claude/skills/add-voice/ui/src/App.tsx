import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Mic, MicOff } from "lucide-react"
import { BarVisualizer, type AgentState as BarState } from "@/components/ui/bar-visualizer"
import { Matrix, digits, loader, wave, type Frame } from "@/components/ui/matrix"
import { Conversation, ConversationAutoStick, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ui/conversation"
import { Message, MessageContent } from "@/components/ui/message"
import { ShimmeringText } from "@/components/ui/shimmering-text"
import { Button } from "@/components/ui/button"
import { StreamText } from "@/components/StreamText"
import { readConfig, type VoiceUiConfig } from "@/lib/config"
import { LIVE_PHASES, useVoiceCall, type Phase, type Speaker, type VoiceCall } from "@/lib/voice-call"
import { useDemoCall } from "@/lib/demo-call"
import logo from "@/assets/nanoclaw-logo.png"

type Colorway = NonNullable<VoiceUiConfig["colorway"]>
const COLORWAYS: Colorway[] = ["ivory", "field", "rabbit"]

const MATRIX_ROWS = 7
const MATRIX_COLS = 14
const BAR_COUNT = 12
const MATRIX_OFF: Frame = Array.from({ length: MATRIX_ROWS }, () => Array(MATRIX_COLS).fill(0))

// The mascot as a pincer drawn in dots: a disc with a notch that opens while the call is live.
function clawFrame(open: boolean): Frame {
  const n = 9
  const c = 4
  const r = 3.45
  const f: Frame = Array.from({ length: n }, () => Array(n).fill(0))
  const spread = open ? 0.62 : 0.16
  const dir = -Math.PI / 4
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x - c
      const dy = y - c
      const d = Math.hypot(dx, dy)
      if (d > r) continue
      const a = Math.atan2(dy, dx)
      const diff = Math.atan2(Math.sin(a - dir), Math.cos(a - dir))
      if (Math.abs(diff) < spread && d > 0.9) continue
      f[y][x] = d < 1.2 ? 0.5 : 1
    }
  }
  return f
}
const CLAW_OPEN = clawFrame(true)
const CLAW_CLOSED = clawFrame(false)

const MATRIX_ON: Record<Phase, string> = {
  idle: "var(--muted-foreground)",
  connecting: "var(--muted-foreground)",
  listening: "var(--dot-you)",
  thinking: "var(--think)",
  talking: "var(--teal)",
  ended: "var(--muted-foreground)",
  error: "var(--coral)",
}

const BAR_STATE: Record<Phase, BarState> = {
  idle: "listening",
  connecting: "connecting",
  listening: "listening",
  thinking: "thinking",
  talking: "speaking",
  ended: "listening",
  error: "listening",
}

const HINT: Record<Phase, string> = {
  idle: "Allow the microphone when asked.",
  connecting: "Setting up the call.",
  listening: "Go ahead. I’m listening.",
  thinking: "Your agent is working on it.",
  talking: "You can interrupt at any time.",
  ended: "Thanks for calling.",
  error: "Try again, or ask for a fresh link.",
}

function pad(n: number) {
  return n < 10 ? `0${n}` : String(n)
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => (typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)").matches : false))
  useEffect(() => {
    if (typeof matchMedia !== "function") return
    const mq = matchMedia("(prefers-reduced-motion: reduce)")
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])
  return reduced
}

// Level and glow samples ~20 times a second, read from the call's refs. Only the
// component that calls this re-renders, so the transcript and keys stay still.
function useLevelTicker(call: VoiceCall, phase: Phase, wantLevels: boolean, reduced: boolean, count = MATRIX_COLS) {
  const [levels, setLevels] = useState<number[]>(() => Array(count).fill(0))
  const [glow, setGlow] = useState(1)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const lastAt = useRef(0)
  const wasZero = useRef(true)
  // Nothing moves on the ended and error screens, so the loop stops there.
  const running = phase !== "ended" && phase !== "error"
  useEffect(() => {
    if (!running) return
    let raf = 0
    const tick = () => {
      const now = performance.now()
      if (now - lastAt.current > 50) {
        lastAt.current = now
        const t = now / 1000
        const p = phaseRef.current
        if (wantLevels) {
          const base = p === "talking" ? call.outputLevel.current : p === "listening" ? call.inputLevel.current : 0
          // A silent stage is already drawn: re-publishing an all-zero array every
          // tick would re-render the whole dot grid for no visible change.
          if (base > 0.001 || !wasZero.current) {
            wasZero.current = base <= 0.001
            setLevels(
              Array.from({ length: count }, (_, i) => {
                const shape = 0.5 + 0.5 * Math.abs(Math.sin(t * 5.2 + i * 0.9)) * (0.6 + 0.4 * Math.abs(Math.cos(t * 2.3 - i * 0.4)))
                return Math.max(0, Math.min(1, base * 1.35 * shape))
              })
            )
          }
        }
        setGlow(
          reduced
            ? 1
            : p === "connecting" || p === "idle"
              ? 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2.2))
              : p === "talking"
                ? 0.6 + 0.4 * Math.min(1, call.outputLevel.current * 1.4)
                : 1
        )
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [call.inputLevel, call.outputLevel, wantLevels, reduced, running, count])
  return { levels, glow }
}

// Call timer as four segment digits on tiny Matrix grids; the text version is for assistive tech.
function SegmentTimer({ seconds, live }: { seconds: number; live: boolean }) {
  const m = Math.floor(seconds / 60)
  const sec = seconds % 60
  const ds = [Math.floor(m / 10) % 10, m % 10, Math.floor(sec / 10), sec % 10]
  return (
    <span className="segment" role="timer" aria-label="Call duration">
      <span className="sr-only">{`${pad(m)}:${pad(sec)}`}</span>
      <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
        {ds.map((d, i) => (
          <Fragment key={i}>
            {i === 2 && (
              <span className="colon">
                <i />
                <i />
              </span>
            )}
            <Matrix rows={7} cols={5} pattern={digits[d]} size={4} gap={1} brightness={live ? 1 : 0.3} palette={{ on: "var(--te-orange)", off: "var(--dot-off)" }} ariaLabel="" />
          </Fragment>
        ))}
      </span>
    </span>
  )
}

const Badge = memo(function Badge({ call, phase, live, reduced }: { call: VoiceCall; phase: Phase; live: boolean; reduced: boolean }) {
  const { glow } = useLevelTicker(call, phase, false, reduced)
  return (
    <div className="badge" aria-hidden="true">
      <Matrix rows={9} cols={9} pattern={live ? CLAW_OPEN : CLAW_CLOSED} size={3} gap={1} brightness={glow} palette={{ on: "var(--te-orange)", off: "#1d1d1d" }} ariaLabel="" />
      <span className={`presence${live ? " live" : ""}`} />
    </div>
  )
})

const Stage = memo(function Stage({
  call,
  phase,
  live,
  presence,
  reduced,
}: {
  call: VoiceCall
  phase: Phase
  live: boolean
  presence: "matrix" | "bars"
  reduced: boolean
}) {
  const bars = presence === "bars"
  const { levels, glow } = useLevelTicker(call, phase, true, reduced, bars ? BAR_COUNT : MATRIX_COLS)
  if (bars) {
    // The bars read the same metering as the matrix. Handing the component a
    // MediaStream instead would open an AudioContext on the call's own microphone,
    // which silences the outgoing track on iOS Safari.
    return (
      <div className={`bars-wrap${phase === "listening" ? " you" : ""}`}>
        <BarVisualizer state={BAR_STATE[phase]} volumeBands={levels} barCount={BAR_COUNT} centerAlign minHeight={12} className="h-full w-full gap-2 rounded-none bg-transparent p-0" />
      </div>
    )
  }
  const palette = { on: MATRIX_ON[phase], off: "var(--dot-off)" }
  return (
    <div className="matrix-wrap">
      {phase === "thinking" ? (
        reduced ? (
          <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} pattern={loader[0]} size={12} gap={3} palette={palette} ariaLabel="Agent is thinking" />
        ) : (
          <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} frames={loader} fps={12} size={12} gap={3} palette={palette} ariaLabel="Agent is thinking" />
        )
      ) : phase === "connecting" ? (
        reduced ? (
          <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} pattern={wave[0]} size={12} gap={3} brightness={glow} palette={palette} ariaLabel="Connecting" />
        ) : (
          <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} frames={wave} fps={20} size={12} gap={3} brightness={glow} palette={palette} ariaLabel="Connecting" />
        )
      ) : live ? (
        <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} mode="vu" levels={levels} size={12} gap={3} palette={palette} ariaLabel="Voice level" />
      ) : (
        <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} pattern={MATRIX_OFF} size={12} gap={3} brightness={glow} palette={palette} ariaLabel="Idle" />
      )}
    </div>
  )
})

const TranscriptLine = memo(function TranscriptLine({
  from,
  text,
  at,
  isLast,
  isStreaming,
  agentName,
  showTs,
}: {
  from: Speaker
  text: string
  at: number
  isLast: boolean
  isStreaming: boolean
  agentName: string
  showTs: boolean
}) {
  return (
    <Message from={from} className={`py-1.5 ${isLast ? "is-live" : "is-history"}`}>
      <MessageContent className={`${from === "user" ? "bubble-you" : "bubble-agent"}${isStreaming ? " is-streaming" : ""}`}>
        <span className="speaker">
          {from === "user" ? "You" : agentName}
          {showTs && <span className="ts">{`${Math.floor(at / 60)}:${pad(at % 60)}`}</span>}
        </span>
        <p>
          <StreamText text={text} />
        </p>
      </MessageContent>
    </Message>
  )
})

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.closest !== "function") return false
  return !!el.closest("button, a, input, textarea, select, [contenteditable], [role='radio'], [role='button']")
}

export default function App() {
  const cfg = useMemo(readConfig, [])
  const params = useMemo(() => new URLSearchParams(location.search), [])
  const token = params.get("t") || ""
  const demo = params.get("demo") === "1"
  const realCall = useVoiceCall(demo ? "" : token, "your agent")
  const demoCall = useDemoCall(demo)
  const call = demo ? demoCall : realCall
  const { phase, lines, streamingId, agentName, elapsed, muted, error, endedText } = call
  const live = LIVE_PHASES.has(phase)
  const skin = cfg.skin
  const rail = skin === "te" && cfg.layout === "rail"
  const reduced = useReducedMotion()
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  const [colorway, setColorway] = useState<Colorway>(() => {
    try {
      const v = localStorage.getItem("voice-colorway")
      if (v === "ivory" || v === "field" || v === "rabbit") return v
    } catch {
      /* storage may be unavailable */
    }
    return cfg.colorway
  })
  useEffect(() => {
    try {
      if (colorway === cfg.colorway) localStorage.removeItem("voice-colorway")
      else localStorage.setItem("voice-colorway", colorway)
    } catch {
      /* storage may be unavailable */
    }
  }, [colorway, cfg.colorway])
  const onColorwayKey = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, current: Colorway) => {
      const i = COLORWAYS.indexOf(current)
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault()
        setColorway(COLORWAYS[(i + 1) % COLORWAYS.length])
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault()
        setColorway(COLORWAYS[(i - 1 + COLORWAYS.length) % COLORWAYS.length])
      }
    },
    []
  )

  // Right after "call" the same key would read "end"; ignore taps for a moment so a double tap cannot cancel.
  const [cancelArmed, setCancelArmed] = useState(false)
  useEffect(() => {
    if (phase !== "connecting") {
      setCancelArmed(false)
      return
    }
    const t = window.setTimeout(() => setCancelArmed(true), 700)
    return () => window.clearTimeout(t)
  }, [phase])

  // Keyboard: space toggles the microphone, escape ends the call. Never while a control has focus.
  const { toggleMute, end: endCall, start: startCall } = call
  useEffect(() => {
    if (!cfg.shortcuts) return
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || isTypingTarget(e.target)) return
      const p = phaseRef.current
      if (e.code === "Space" && LIVE_PHASES.has(p)) {
        e.preventDefault()
        toggleMute()
      } else if (e.key === "Escape" && (LIVE_PHASES.has(p) || p === "connecting")) {
        endCall()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [cfg.shortcuts, toggleMute, endCall])

  const chipClass =
    phase === "idle" ? "idle" : phase === "ended" ? "ended" : phase === "error" ? "err" : phase === "listening" ? "you" : phase === "thinking" ? "think" : ""
  const hintText =
    phase === "error"
      ? HINT.error
      : muted && live
        ? "Your microphone is muted."
        : phase === "ended"
          ? `${pad(Math.floor(elapsed / 60))}:${pad(elapsed % 60)} · ${lines.length} ${lines.length === 1 ? "turn" : "turns"} · ${
              endedText && endedText !== "Call ended." ? endedText.replace(/\.$/, "").toLowerCase() : "thanks for calling"
            }.`
          : HINT[phase]

  const readout = (
    <span className={`state-chip ${chipClass}`} role="status" aria-live="polite">
      {live && phase !== "connecting" && <span className="pulse" aria-hidden="true" />}
      {phase === "thinking" ? (
        reduced ? (
          `Asking ${agentName}…`
        ) : (
          <ShimmeringText text={`Asking ${agentName}…`} duration={1.4} />
        )
      ) : phase === "idle" ? (
        "Ready"
      ) : phase === "connecting" ? (
        "Connecting…"
      ) : phase === "listening" ? (
        "Listening"
      ) : phase === "talking" ? (
        "Speaking"
      ) : phase === "error" ? (
        "Something went wrong"
      ) : (
        "Call ended"
      )}
    </span>
  )

  const showTs = skin === "te" && cfg.timestamps
  const transcript = (
    <Conversation className="transcript-box">
      <ConversationContent className="flex flex-col gap-1 p-1">
        {error && (
          <p className="error-line" role="alert">
            {error}
          </p>
        )}
        {lines.length === 0 && !error ? (
          <ConversationEmptyState title="Nothing said yet" description={live ? "Say hello to start." : phase === "ended" ? "Call again to keep talking." : `Press call to talk to ${agentName}.`} />
        ) : (
          lines.map((l, i) => (
            <TranscriptLine key={l.id} from={l.from} text={l.text} at={l.at} isLast={i === lines.length - 1} isStreaming={l.id === streamingId} agentName={agentName} showTs={showTs} />
          ))
        )}
      </ConversationContent>
      <ConversationAutoStick trigger={lines.length} />
      <ConversationScrollButton />
    </Conversation>
  )

  const primaryLabel = live ? "End" : phase === "connecting" ? "Cancel" : phase === "ended" || phase === "error" ? "Call again" : "Call"
  const primaryDisabled = (!token && !demo) || (phase === "connecting" && !cancelArmed)
  const onPrimary = live || phase === "connecting" ? endCall : startCall

  const keys =
    skin === "te" ? (
      <>
        <div className="key key-time">
          <SegmentTimer seconds={live || phase === "ended" ? elapsed : 0} live={live} />
          <span className="label">
            <i className={`led${live ? " on" : ""}`} aria-hidden="true" />
            Time
          </span>
        </div>
        <div className="key key-end">
          <button type="button" className="cap orange" onClick={onPrimary} aria-disabled={primaryDisabled} disabled={primaryDisabled}>
            {primaryLabel}
          </button>
          <span className="label">
            <i className={`led${live ? " green" : ""}`} aria-hidden="true" />
            {live ? "On call" : phase === "connecting" ? "Connecting" : "Ready"}
            {cfg.shortcuts && (live || phase === "connecting") && <kbd>esc</kbd>}
          </span>
        </div>
        <div className="key key-mute">
          <button type="button" className={`cap${muted ? " dark" : ""}`} disabled={!live} aria-pressed={muted} onClick={toggleMute}>
            {muted ? <MicOff size={15} aria-hidden="true" /> : <Mic size={15} aria-hidden="true" />}
            Mute
          </button>
          <span className="label">
            <i className={`led${muted ? " on" : ""}`} aria-hidden="true" />
            {muted ? "Muted" : "Mic on"}
            {cfg.shortcuts && <kbd>space</kbd>}
          </span>
        </div>
      </>
    ) : (
      <>
        <span className="timer" role="timer" aria-label="Call duration">
          {live ? `${pad(Math.floor(elapsed / 60))}:${pad(elapsed % 60)}` : ""}
        </span>
        <Button size="lg" className={`${live || phase === "connecting" ? "btn-hangup" : "btn-call"} h-12 w-full rounded-full text-[15px] font-semibold`} onClick={onPrimary} disabled={primaryDisabled}>
          {live ? "Hang up" : primaryLabel}
        </Button>
        <Button size="lg" variant="secondary" className={`btn-mute h-12 rounded-full ${muted ? "on" : ""}`} disabled={!live} aria-pressed={muted} onClick={toggleMute}>
          {muted ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
          {muted ? "Unmute" : "Mute"}
        </Button>
      </>
    )

  const footer = cfg.footer.split("{agent}").join(agentName)

  return (
    <div className="voice-page" data-skin={skin} data-layout={rail ? "rail" : "stack"} data-colorway={skin === "te" && colorway !== "auto" ? colorway : undefined}>
      <main className={`call-card${rail ? " layout-rail" : ""}`} aria-label="Voice call">
        <header className="brand-row">
          {skin === "te" ? (
            <Badge call={call} phase={phase} live={live} reduced={reduced} />
          ) : (
            <div className="tile">
              <img src={logo} alt="" />
              <span className={`presence${live ? " live" : ""}`} aria-hidden="true" />
            </div>
          )}
          <div>
            <h1 className="product-name">{cfg.brand}</h1>
            <p className="agent-line">
              {live ? "On a call with " : phase === "connecting" ? "Calling " : phase === "ended" ? "Call ended with " : "Ready to call "}
              <strong>{agentName}</strong>
            </p>
          </div>
        </header>

        {rail ? (
          <div className="device">
            <section className="screen" aria-label="Screen">
              <div className="screen-top">
                <Stage call={call} phase={phase} live={live} presence={cfg.presence} reduced={reduced} />
              </div>
              <div className="screen-readout">
                {readout}
                <span className="screen-hint">{hintText}</span>
              </div>
              <div className="console" aria-label="Live transcript">
                {transcript}
              </div>
            </section>
            <aside className="rail" aria-label="Controls">
              {keys}
            </aside>
          </div>
        ) : (
          <>
            <section className="stage" aria-label="Agent presence">
              <div className="presence-stage">
                <Stage call={call} phase={phase} live={live} presence={cfg.presence} reduced={reduced} />
              </div>
              {readout}
              <p className="hint">{hintText}</p>
            </section>
            <section aria-label="Live transcript">
              <div className="transcript-head">
                <p className="eyebrow">Live transcript</p>
              </div>
              {transcript}
            </section>
            <div className="control-bar">{keys}</div>
          </>
        )}

        <div className="foot">
          <p className="footer-line">{demo ? "Demo call. Nothing is connected." : footer}</p>
          {skin === "te" && cfg.colorwayPicker && (
            <div className="colorways" role="radiogroup" aria-label="Colorway">
              {COLORWAYS.map((c) => {
                const checked = colorway === c
                return (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-label={c}
                    title={c}
                    tabIndex={checked || (colorway === "auto" && c === COLORWAYS[0]) ? 0 : -1}
                    className={`swatch ${c}${checked ? " on" : ""}`}
                    onClick={() => setColorway(c)}
                    onKeyDown={(e) => onColorwayKey(e, checked ? c : COLORWAYS[0])}
                  />
                )
              })}
            </div>
          )}
        </div>
      </main>
      <audio ref={call.audioRef} autoPlay playsInline className="sr-only" />
    </div>
  )
}
