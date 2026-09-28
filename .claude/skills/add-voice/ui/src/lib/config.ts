/** Runtime config the host injects as window.__VOICE_UI__ (see GPT_LIVE_UI in SKILL.md). */
export interface VoiceUiConfig {
  skin?: "te" | "nanoclaw"
  colorway?: "auto" | "ivory" | "field" | "rabbit"
  layout?: "rail" | "stack"
  presence?: "matrix" | "bars"
  brand?: string
  footer?: string
  shortcuts?: boolean
  timestamps?: boolean
  colorwayPicker?: boolean
}

export const DEFAULTS: Required<VoiceUiConfig> = {
  skin: "te",
  colorway: "auto",
  layout: "rail",
  presence: "matrix",
  brand: "NanoClaw Voice",
  footer: "Voice by GPT-Live-1 · answers by {agent}",
  shortcuts: true,
  timestamps: true,
  colorwayPicker: true,
}

export function readConfig(): Required<VoiceUiConfig> {
  const raw = (typeof window !== "undefined" && window.__VOICE_UI__) || {}
  const c = { ...DEFAULTS }
  if (raw.skin === "te" || raw.skin === "nanoclaw") c.skin = raw.skin
  if (raw.colorway === "auto" || raw.colorway === "ivory" || raw.colorway === "field" || raw.colorway === "rabbit") c.colorway = raw.colorway
  if (raw.layout === "rail" || raw.layout === "stack") c.layout = raw.layout
  if (raw.presence === "matrix" || raw.presence === "bars") c.presence = raw.presence
  if (typeof raw.brand === "string" && raw.brand.trim()) c.brand = raw.brand.trim().slice(0, 60)
  if (typeof raw.footer === "string") c.footer = raw.footer.slice(0, 120)
  if (typeof raw.shortcuts === "boolean") c.shortcuts = raw.shortcuts
  if (typeof raw.timestamps === "boolean") c.timestamps = raw.timestamps
  if (typeof raw.colorwayPicker === "boolean") c.colorwayPicker = raw.colorwayPicker
  return c
}
