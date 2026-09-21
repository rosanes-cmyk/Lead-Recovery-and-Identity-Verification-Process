#!/usr/bin/env node
// Open a temporary public link to the running app, via a Cloudflare quick
// tunnel. Run `npm start` in one terminal, `npm run share` in another.
//
// Two things this does that typing the cloudflared command by hand does not:
//   1. It finds cloudflared even when the terminal's PATH is stale (very
//      common right after `winget install` — the open window never sees it).
//   2. It refuses to open the tunnel unless SHARE_PASSWORD is set. A tunnel
//      reaches the server over loopback, so without that password it would
//      publish an unauthenticated app that drives your signed-in browser.
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { config } from '../server/config.js'

const PORT = config.port

// cloudflared prints its quick-tunnel address inside an ASCII banner.
export function findTunnelUrl(line = '') {
  const m = String(line).match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i)
  return m ? m[0] : ''
}

export function candidatePaths(env = process.env, platform = process.platform) {
  const out = []
  if (env.CLOUDFLARED_PATH) out.push(env.CLOUDFLARED_PATH)
  if (platform === 'win32') {
    // Build Windows paths with Windows separators even when this runs (in
    // tests) on another platform.
    const join = path.win32.join
    const exe = 'cloudflared.exe'
    const pf = env['ProgramFiles'] || 'C:\\Program Files'
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const local = env.LOCALAPPDATA || ''
    const home = env.USERPROFILE || ''
    out.push(
      join(pf86, 'cloudflared', exe),
      join(pf, 'cloudflared', exe),
      local && join(local, 'Microsoft', 'WinGet', 'Links', exe),
      home && join(home, 'scoop', 'shims', exe),
      home && join(home, '.cloudflared', exe),
    )
  } else {
    out.push('/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared')
  }
  return out.filter(Boolean)
}

function onPath(cmd) {
  const probe = spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: false })
  return !probe.error
}

function locateCloudflared() {
  if (process.env.CLOUDFLARED_PATH && fs.existsSync(process.env.CLOUDFLARED_PATH)) return process.env.CLOUDFLARED_PATH
  if (onPath('cloudflared')) return 'cloudflared'
  for (const p of candidatePaths()) {
    if (p !== process.env.CLOUDFLARED_PATH && fs.existsSync(p)) return p
  }
  return ''
}

function appIsRunning(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2500 }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

function die(lines) {
  console.error('\n' + lines.join('\n') + '\n')
  process.exit(1)
}

// --- main ---------------------------------------------------------------------
// Everything below runs only when this file is executed directly, so the pure
// helpers above can be unit-tested without opening a tunnel.
const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (!runDirectly) {
  // imported for its helpers
} else {
  await main()
}

async function main() {
if (!config.sharePassword) {
  die([
    '  No SHARE_PASSWORD set — refusing to open a public link.',
    '',
    '  A tunnel would put this app on the internet with no sign-in, and anyone',
    '  who found the address could run searches in your signed-in browser and',
    '  download every CSV in runs/.',
    '',
    '  Add these two lines to .env, restart `npm start`, then try again:',
    '',
    '    SHARE_PASSWORD=pick-a-long-passphrase',
    '    SHARE_TTL_HOURS=12',
  ])
}

if (!(await appIsRunning(PORT))) {
  die([
    `  Nothing is answering on http://localhost:${PORT}.`,
    '',
    '  Start the app first, in its own terminal window:',
    '',
    '    npm start',
    '',
    '  Leave it running, then run `npm run share` again here.',
  ])
}

const bin = locateCloudflared()
if (!bin) {
  die([
    '  cloudflared is not installed, or this window cannot see it yet.',
    '',
    '  Install it:      winget install --id Cloudflare.cloudflared',
    '  Already did?     Close this window and open a NEW one. A terminal keeps',
    '                   the PATH it started with, so it never sees a program',
    '                   installed after it opened.',
    '',
    '  Still stuck? Point this script straight at the file:',
    '',
    '    set CLOUDFLARED_PATH=C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    '    npm run share',
  ])
}

console.log(`\n  Opening a temporary public link to http://localhost:${PORT} …`)
console.log(`  cloudflared: ${bin}`)
console.log('  Press Ctrl+C to close the link.\n')

const child = spawn(bin, ['tunnel', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
let announced = false

function watch(chunk) {
  const text = chunk.toString()
  const url = announced ? '' : findTunnelUrl(text)
  if (url) {
    announced = true
    const line = '  ' + '='.repeat(64)
    console.log(`\n${line}`)
    console.log('  Send these two things, ideally by two different channels:')
    console.log(`\n    Link:     ${url}`)
    console.log('    Password: the SHARE_PASSWORD from your .env')
    console.log(`\n  The link dies when you press Ctrl+C. Sign-ins last ${config.shareTtlHours}h.`)
    console.log(line + '\n')
  } else if (!announced) {
    process.stdout.write(text)
  }
}

child.stdout.on('data', watch)
child.stderr.on('data', watch) // cloudflared logs the banner to stderr
child.on('error', (err) => die([`  Could not start cloudflared: ${err.message}`]))
child.on('exit', (code) => {
  console.log(`\n  Link closed${code ? ` (cloudflared exited with ${code})` : ''}.\n`)
  process.exit(code || 0)
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill())
}
