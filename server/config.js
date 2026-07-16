// Central configuration. Reads .env (via dotenv) with safe defaults.
// Safety flags default to the "prepare only, change nothing" posture.

import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(__dirname, '..')

const bool = (v, def) => {
  if (v === undefined || v === '') return def
  return String(v).toLowerCase() === 'true'
}
const num = (v, def) => {
  const n = parseInt(v, 10)
  return Number.isNaN(n) ? def : n
}

export const config = {
  // Safety — everything off by default.
  liveMode: bool(process.env.LIVE_MODE, false),
  dryRun: bool(process.env.DRY_RUN, true),
  autoOutreach: bool(process.env.AUTO_OUTREACH, false),
  autoSaveNote: bool(process.env.AUTO_SAVE_NOTE, false),
  autoChangeStatus: bool(process.env.AUTO_CHANGE_STATUS, false),
  autoCreateTask: bool(process.env.AUTO_CREATE_TASK, false),
  autoReassign: bool(process.env.AUTO_REASSIGN, false),

  // Demo mode: run the whole flow with synthetic findings and NO real browser,
  // so the UI can be explored without logging into any site. Off by default.
  demoMode: bool(process.env.DEMO_MODE, false),

  // Browser
  headless: bool(process.env.HEADLESS, false),
  userDataDir: path.resolve(ROOT, process.env.USER_DATA_DIR || '.browser-profile'),
  chromeChannel: process.env.CHROME_CHANNEL || '',
  // Optional: point directly at a Chromium/Chrome binary. Leave blank to let
  // Playwright use the browser it installed via `npm run install-browser`.
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '',

  // Time limits (minutes)
  standardLimitMin: num(process.env.STANDARD_TIME_LIMIT_MIN, 30),
  enhancedLimitMin: num(process.env.ENHANCED_TIME_LIMIT_MIN, 60),

  // Server
  port: num(process.env.PORT, 4319),

  // Where run artifacts (screenshots, reports) are written.
  runsDir: path.resolve(ROOT, 'runs'),
}

// True when the app is allowed to make real CRM changes. In the first version
// this must be false; every write path checks this.
export function canWrite() {
  return config.liveMode && !config.dryRun
}

// Human-readable summary of the current safety posture, for the UI banner.
export function safetySummary() {
  return {
    liveMode: config.liveMode,
    dryRun: config.dryRun,
    canWrite: canWrite(),
    autoOutreach: config.autoOutreach,
    autoSaveNote: config.autoSaveNote,
    autoChangeStatus: config.autoChangeStatus,
    autoCreateTask: config.autoCreateTask,
    autoReassign: config.autoReassign,
  }
}
