import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { Mic, MicOff } from "lucide-react"
import { BarVisualizer, type AgentState as BarState } from "@/components/ui/bar-visualizer"
import { Matrix, digits, loader, wave, type Frame } from "@/components/ui/matrix"
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ui/conversation"
import { Message, MessageContent } from "@/components/ui/message"
import { ShimmeringText } from "@/components/ui/shimmering-text"
import { Button } from "@/components/ui/button"
import { StreamText } from "@/components/StreamText"
import { readConfig, type VoiceUiConfig } from "@/lib/config"
import { LIVE_PHASES, useVoiceCall, type Phase } from "@/lib/voice-call"
import logo from "@/assets/nanoclaw-logo.png"

type Colorway = NonNullable<VoiceUiConfig["colorway"]>

const MATRIX_ROWS = 7
const MATRIX_COLS = 14
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
  listening: "var(--amber)",
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

// Call timer as four segment digits on tiny Matrix grids, the way a hardware readout shows it.
function SegmentTimer({ seconds, live }: { seconds: number; live: boolean }) {
  const m = Math.floor(seconds / 60)
  const sec = seconds % 60
  const ds = [Math.floor(m / 10) % 10, m % 10, Math.floor(sec / 10), sec % 10]
  return (
    <span className="segment" role="timer" aria-label={`Call duration ${pad(m)}:${pad(sec)}`}>
      {ds.map((d, i) => (
        <Fragment key={i}>
          {i === 2 && (
            <span className="colon" aria-hidden="true">
              <i />
              <i />
            </span>
          )}
          <Matrix rows={7} cols={5} pattern={digits[d]} size={4} gap={1} brightness={live ? 1 : 0.3} palette={{ on: "var(--te-orange)", off: "var(--dot-off)" }} ariaLabel="" />
        </Fragment>
      ))}
    </span>
  )
}

export default function App() {
  const cfg = useMemo(readConfig, [])
  const token = useMemo(() => new URLSearchParams(location.search).get("t") || "", [])
  const call = useVoiceCall(token, "your agent")
  const { phase, lines, streamingId, agentName, elapsed, muted, error, endedText } = call
  const live = LIVE_PHASES.has(phase)
  const skin = cfg.skin
  const rail = skin === "te" && cfg.layout === "rail"

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

  // Matrix levels ~20 times a second, badge glow every tick; both read the hook's refs.
  const [levels, setLevels] = useState<number[]>(() => Array(MATRIX_COLS).fill(0))
  const [glow, setGlow] = useState(1)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const lastLevelsAt = useRef(0)
  const presence = cfg.presence
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const now = performance.now()
      if (now - lastLevelsAt.current > 50) {
        lastLevelsAt.current = now
        const t = now / 1000
        const p = phaseRef.current
        if (presence === "matrix") {
          const base = p === "talking" ? call.outputLevel.current : p === "listening" ? call.inputLevel.current : 0
          setLevels(
            Array.from({ length: MATRIX_COLS }, (_, i) => {
              const shape = 0.5 + 0.5 * Math.abs(Math.sin(t * 5.2 + i * 0.9)) * (0.6 + 0.4 * Math.abs(Math.cos(t * 2.3 - i * 0.4)))
              return Math.max(0, Math.min(1, base * 1.35 * shape))
            })
          )
        }
        setGlow(
          p === "connecting" || p === "idle"
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
  }, [presence, call.inputLevel, call.outputLevel])

  // Keyboard: space toggles the microphone, escape ends the call.
  useEffect(() => {
    if (!cfg.shortcuts) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      const p = phaseRef.current
      if (e.code === "Space" && LIVE_PHASES.has(p)) {
        e.preventDefault()
        call.toggleMute()
      } else if (e.key === "Escape" && (LIVE_PHASES.has(p) || p === "connecting")) {
        call.end()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [cfg.shortcuts, call])

  const chipClass =
    phase === "idle" ? "idle" : phase === "ended" ? "ended" : phase === "error" ? "err" : phase === "listening" ? "you" : phase === "thinking" ? "think" : ""
  const hintText =
    phase === "error"
      ? HINT.error
      : muted && live
        ? "Your microphone is muted."
        : phase === "ended"
          ? `${pad(Math.floor(elapsed / 60))}:${pad(elapsed % 60)} · ${lines.length} ${lines.length === 1 ? "turn" : "turns"} · ${endedText ?? HINT.ended}`
          : HINT[phase]

  const stage =
    presence === "bars" ? (
      <div className={`bars-wrap${phase === "listening" ? " you" : ""}`}>
        <BarVisualizer demo={false} state={BAR_STATE[phase]} barCount={12} centerAlign minHeight={12} className="h-full w-full gap-2 rounded-none bg-transparent p-0" />
      </div>
    ) : (
      <div className="matrix-wrap">
        {phase === "thinking" ? (
          <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} frames={loader} fps={12} size={12} gap={3} palette={{ on: MATRIX_ON[phase], off: "var(--dot-off)" }} ariaLabel="Agent is thinking" />
        ) : phase === "connecting" ? (
          <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} frames={wave} fps={20} size={12} gap={3} brightness={glow} palette={{ on: MATRIX_ON[phase], off: "var(--dot-off)" }} ariaLabel="Connecting" />
        ) : live ? (
          <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} mode="vu" levels={levels} size={12} gap={3} palette={{ on: MATRIX_ON[phase], off: "var(--dot-off)" }} ariaLabel="Voice level" />
        ) : (
          <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} pattern={MATRIX_OFF} size={12} gap={3} brightness={glow} palette={{ on: MATRIX_ON[phase], off: "var(--dot-off)" }} ariaLabel="Idle" />
        )}
      </div>
    )

  const readout = (
    <span className={`state-chip ${chipClass}`} role="status" aria-live="polite">
      {live && phase !== "connecting" && <span className="pulse" aria-hidden="true" />}
      {phase === "thinking" ? (
        <ShimmeringText text={`Asking ${agentName}…`} duration={1.4} />
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

  const transcript = (
    <Conversation className="transcript-box">
      <ConversationContent className="flex flex-col gap-1 p-1">
        {error && <p className="error-line" role="alert">{error}</p>}
        {lines.length === 0 && !error ? (
          <ConversationEmptyState title="Nothing said yet" description={live ? "Say hello to start." : phase === "ended" ? "Call again to keep talking." : "Press call to talk to " + agentName + "."} />
        ) : (
          lines.map((l, i) => {
            const isLast = i === lines.length - 1
            const isStreaming = l.id === streamingId
            return (
              <Message key={l.id} from={l.from} className={`py-1.5 ${isLast ? "is-live" : "is-history"}`}>
                <MessageContent className={`${l.from === "user" ? "bubble-you" : "bubble-agent"}${isStreaming ? " is-streaming" : ""}`}>
                  <span className="speaker">
                    {l.from === "user" ? "You" : agentName}
                    {skin === "te" && cfg.timestamps && <span className="ts">{`${Math.floor(l.at / 60)}:${pad(l.at % 60)}`}</span>}
                  </span>
                  <p>
                    <StreamText text={l.text} animate={isStreaming} />
                  </p>
                </MessageContent>
              </Message>
            )
          })
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )

  const primaryLabel = live || phase === "connecting" ? "End" : phase === "ended" || phase === "error" ? "Call again" : "Call"
  const onPrimary = live || phase === "connecting" ? call.end : call.start

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
          <button type="button" className="cap orange" onClick={onPrimary} disabled={!token}>
            {primaryLabel}
          </button>
          <span className="label">
            <i className={`led${live ? " green" : ""}`} aria-hidden="true" />
            {live ? "On call" : phase === "connecting" ? "Connecting" : "Ready"}
            {cfg.shortcuts && (live || phase === "connecting") && <kbd>esc</kbd>}
          </span>
        </div>
        <div className="key key-mute">
          <button type="button" className={`cap${muted ? " dark" : ""}`} disabled={!live} aria-pressed={muted} onClick={call.toggleMute}>
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
        {live || phase === "connecting" ? (
          <Button size="lg" className="btn-hangup h-12 w-full rounded-full text-[15px] font-semibold" onClick={call.end}>
            Hang up
          </Button>
        ) : (
          <Button size="lg" className="btn-call h-12 w-full rounded-full text-[15px] font-semibold" onClick={call.start} disabled={!token}>
            {primaryLabel}
          </Button>
        )}
        <Button size="lg" variant="secondary" className={`btn-mute h-12 rounded-full ${muted ? "on" : ""}`} disabled={!live} aria-pressed={muted} onClick={call.toggleMute}>
          {muted ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
          {muted ? "Unmute" : "Mute"}
        </Button>
      </>
    )

  const footer = cfg.footer.replace("{agent}", agentName)

  return (
    <div className="voice-page" data-skin={skin} data-layout={rail ? "rail" : "stack"} data-colorway={skin === "te" && colorway !== "auto" ? colorway : undefined}>
      <main className={`call-card${rail ? " layout-rail" : ""}`} aria-label="Voice call">
        <header className="brand-row">
          {skin === "te" ? (
            <div className="badge" aria-hidden="true">
              <Matrix rows={9} cols={9} pattern={live ? CLAW_OPEN : CLAW_CLOSED} size={3} gap={1} brightness={glow} palette={{ on: "var(--te-orange)", off: "#1d1d1d" }} ariaLabel="" />
              <span className={`presence${live ? " live" : ""}`} />
            </div>
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
              <div className="screen-top">{stage}</div>
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
              <div className="presence-stage">{stage}</div>
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
          <p className="footer-line">{footer}</p>
          {skin === "te" && cfg.colorwayPicker && (
            <div className="colorways" role="radiogroup" aria-label="Colorway">
              {(["ivory", "field", "rabbit"] as Colorway[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={colorway === c}
                  aria-label={c}
                  title={c}
                  className={`swatch ${c}${colorway === c ? " on" : ""}`}
                  onClick={() => setColorway(colorway === c ? cfg.colorway : c)}
                />
              ))}
            </div>
          )}
        </div>
      </main>
      <audio ref={call.audioRef} autoPlay playsInline className="sr-only" />
    </div>
  )
}
