// One-time setup helper. Creates .env from .env.example (if missing) and
// installs the Chromium browser Playwright needs. Safe to run repeatedly.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const env = path.join(root, '.env')
const example = path.join(root, '.env.example')
if (!fs.existsSync(env) && fs.existsSync(example)) {
  fs.copyFileSync(example, env)
  console.log('Created .env from .env.example')
} else {
  console.log('.env already present — leaving it as is')
}

console.log('Installing Chromium for Playwright (first run only)…')
try {
  execSync('npx playwright install chromium', { cwd: root, stdio: 'inherit' })
} catch {
  console.log(
    '\nCould not auto-install the browser. Run this manually:\n  npx playwright install chromium\n',
  )
}

console.log('\nSetup done. Start the app with:  npm start')
