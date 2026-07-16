// Playwright browser manager.
//
// Uses a PERSISTENT browser context (a real on-disk Chrome profile) so the
// operator's manual logins survive between runs. The app never sees or stores
// passwords — the operator types them into the real browser window; only the
// resulting session cookies live in the profile directory on the operator's
// own machine.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

let context = null

export async function getContext() {
  if (context) return context
  fs.mkdirSync(config.userDataDir, { recursive: true })

  const launchOpts = {
    headless: config.headless,
    viewport: { width: 1360, height: 900 },
    // A normal-looking UA reduces the odds of being served a stripped-down page.
    args: ['--disable-blink-features=AutomationControlled'],
  }
  if (config.chromeChannel) launchOpts.channel = config.chromeChannel
  if (config.executablePath) launchOpts.executablePath = config.executablePath

  context = await chromium.launchPersistentContext(config.userDataDir, launchOpts)

  context.on('close', () => {
    context = null
  })
  return context
}

// Return a page to work with. Reuses the first open page when possible so the
// operator sees one window rather than many tabs.
export async function getPage() {
  const ctx = await getContext()
  const pages = ctx.pages()
  return pages.length ? pages[0] : await ctx.newPage()
}

export async function closeBrowser() {
  if (context) {
    try {
      await context.close()
    } catch {
      /* ignore */
    }
    context = null
  }
}

// Heuristic login-wall detection. Returns true when the current page looks like
// a sign-in screen (so the orchestrator can pause and ask the operator to log
// in). Deliberately conservative — false negatives are better than pausing on
// every page.
export async function looksLikeLogin(page, { hostHint = '' } = {}) {
  try {
    const url = page.url().toLowerCase()
    if (/\/(login|signin|sign-in|auth|account\/login)(\/|\?|$)/.test(url)) return true

    const hasPassword = (await page.locator('input[type="password"]:visible').count()) > 0
    if (hasPassword) return true

    // Text cues, but only when there's little else on the page (avoids matching
    // a "Log out" link on an already-authenticated page).
    const bodyText = ((await page.locator('body').innerText().catch(() => '')) || '')
      .toLowerCase()
      .slice(0, 4000)
    const loginCue = /(sign in|log in|sign into your account|please log in|session expired)/.test(
      bodyText,
    )
    const shortPage = bodyText.length < 1500
    if (loginCue && shortPage) return true

    return false
  } catch {
    return false
  }
}

// Take a screenshot into the given run's evidence folder and return a record
// describing it (relative path + absolute path + the URL it was taken on).
export async function capture(page, runDir, label) {
  try {
    const dir = path.join(runDir, 'evidence')
    fs.mkdirSync(dir, { recursive: true })
    const safe = label.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60)
    const file = `${Date.now()}_${safe}.png`
    const abs = path.join(dir, file)
    await page.screenshot({ path: abs, fullPage: false })
    return {
      label,
      url: page.url(),
      file: path.join('evidence', file),
      abs,
    }
  } catch (err) {
    return { label, url: page.url?.() || '', error: String(err) }
  }
}
