// Lightweight persistence for investigation runs. Each run gets its own folder
// under runs/ containing report.json and an evidence/ subfolder of screenshots.

import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

let counter = 0
export function newRunId() {
  counter += 1
  return `run_${Date.now().toString(36)}_${counter.toString(36)}`
}

export function runDir(runId) {
  return path.join(config.runsDir, runId)
}

export function ensureRunDir(runId) {
  const dir = runDir(runId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function saveReport(runId, report) {
  const dir = ensureRunDir(runId)
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2))
}

export function loadReport(runId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir(runId), 'report.json'), 'utf-8'))
  } catch {
    return null
  }
}

export function listRuns() {
  try {
    if (!fs.existsSync(config.runsDir)) return []
    return fs
      .readdirSync(config.runsDir)
      .map((id) => loadReport(id))
      .filter(Boolean)
      .sort((a, b) => (a.meta?.date < b.meta?.date ? 1 : -1))
  } catch {
    return []
  }
}
