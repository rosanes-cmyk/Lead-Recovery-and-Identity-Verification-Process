// Side-effect module: create .env from .env.example on first run, BEFORE
// config.js loads dotenv. Import this before ./config.js.

import fs from 'node:fs'
import path from 'node:path'

const env = path.resolve(process.cwd(), '.env')
const example = path.resolve(process.cwd(), '.env.example')
if (!fs.existsSync(env) && fs.existsSync(example)) {
  try {
    fs.copyFileSync(example, env)
    console.log('Created .env from .env.example (safe dry-run defaults).')
  } catch {
    /* ignore */
  }
}
