// Redfin source tests. No network: the fixtures are built from the bytes Redfin
// actually served for 547 Missouri St, so the escaping, the nested agent blocks
// and the two-agent "Bought with" case are the real thing.
import fs from 'node:fs'
import {
  parseRedfinHtml, parseAgents, parseRemarks, parseMls, dealSignals, parseLatestSale,
  sliceEscapedJson, parseEscapedJson, looksBlocked, lookupRedfin, fetchRedfin,
} from '../server/sources/redfin.js'

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}
const fx = (f) => fs.readFileSync(new URL(`./fixtures/${f}.html`, import.meta.url), 'utf8')
const sold = fx('redfin-sold')
const fixer = fx('redfin-fixer')
const blocked = fx('redfin-blocked')

// ---- the real sold page ----------------------------------------------------------
console.log('\n[Redfin] A sold property, as Redfin served it')
const r = parseRedfinHtml(sold)
check('page parses', r.ok === true && r.blocked === false)
check('listing agent name', r.listingAgent?.name === 'Alexander Clark', r.listingAgent?.name)
check('listing brokerage', r.listingAgent?.brokerage === 'The Front Steps')
check('DRE licence, label not doubled', r.listingAgent?.license === 'DRE #01339386', r.listingAgent?.license)
check('listing agent phone', r.listingAgent?.phone === '415-254-5351')
check('listing agent email', r.listingAgent?.email === 'alex@thefrontsteps.com')
check('buyer agent name', r.buyerAgent?.name === 'James Shinbori')
check('buyer brokerage', r.buyerAgent?.brokerage === 'Compass')
check('buyer broker phone used when no direct line', r.buyerAgent?.brokerPhone === '415-874-5000' && r.buyerAgent?.phone === '')
check('second buyer agent kept, not lost', r.otherAgents.some((a) => a.name === 'Eva Stoyanov'))
check('MLS named', /San Francisco/i.test(r.mlsSource), r.mlsSource)
check('MLS number comes from this property, not a neighbour', r.mlsNumber === '423907901', r.mlsNumber)
check('the sale the agents belong to is stated', /Oct 23, 2023/.test(r.agentsFor) && /4,850,000/.test(r.agentsFor), r.agentsFor)
check('a page with no history claims no sale', parseRedfinHtml('<html></html>').ok === false)
check('remarks captured whole', r.remarks.length > 900 && /Jonathan Pearlman/.test(r.remarks))
check('a designer home is not flagged a fixer', r.signals.length === 0, r.signals.join(','))

// ---- the fixer case --------------------------------------------------------------
console.log('\n[Redfin] Deal signals in the remarks')
const f = parseRedfinHtml(fixer)
check('fixer page parses', f.ok === true)
for (const want of ['as-is', 'probate', 'trust sale', 'court confirmation', 'contractor special', 'vacant', 'needs work']) {
  check(`signal "${want}"`, f.signals.includes(want), f.signals.join(', '))
}
check('missing email is empty, never guessed', f.listingAgent?.email === '')
check('agent still read when email absent', f.listingAgent?.name === 'Alexander Clark')
check('no remarks -> no signals', dealSignals('').length === 0)
check('plain remarks -> no signals', dealSignals('Charming remodelled Victorian with a new kitchen.').length === 0)
check('"as is" without hyphen is not a match', !dealSignals('The garden is as it was in 1970.').includes('as-is'))
check('fixer-upper matches', dealSignals('A true fixer-upper.').includes('fixer'))

// ---- blocked / junk --------------------------------------------------------------
console.log('\n[Redfin] Blocks and junk')
check('bot check detected', looksBlocked(blocked) === true)
const b = parseRedfinHtml(blocked)
check('blocked page reports blocked, not empty data', b.ok === false && b.blocked === true)
check('empty input is treated as blocked', looksBlocked('') === true)
check('a normal page is not blocked', looksBlocked(sold) === false)
check('garbage html yields nothing, throws nothing', parseRedfinHtml('<html><body>hello</body></html>').ok === false)
check('no agents in garbage', parseAgents('<html></html>', 'listingAgents').length === 0)
check('no remarks in garbage', parseRemarks('<html></html>') === '')
check('no mls in garbage', parseMls('<html></html>').mlsNumber === '')
check('no sale history in garbage', parseLatestSale('<html></html>') === null)

// ---- the escaped-JSON reader -----------------------------------------------------
console.log('\n[Redfin] Escaped JSON slicing')
const esc = (o) => JSON.stringify(JSON.stringify(o)).slice(1, -1)
const wrapped = `<script>x = "${esc({ listingAgents: [{ agentInfo: { agentName: 'A B' }, brokerName: 'Bro] Inc [' } ] })}"</script>`
check('a bracket inside a string does not end the slice', parseAgents(wrapped, 'listingAgents')[0]?.brokerage === 'Bro] Inc [')
check('missing key -> empty slice', sliceEscapedJson(sold, 'noSuchKeyHere') === '')
check('bad slice -> null, no throw', parseEscapedJson('[{oops') === null)
check('empty slice -> null', parseEscapedJson('') === null)
check('object slices work too', JSON.parse(JSON.stringify(parseEscapedJson(esc({ a: 1 })))) !== null)

// ---- the network wrapper ---------------------------------------------------------
console.log('\n[Redfin] Fetch wrapper (stubbed, no network)')
const okFetch = async () => ({ ok: true, status: 200, text: async () => sold })
const got = await fetchRedfin('https://www.redfin.com/x', { fetchImpl: okFetch })
check('200 returns html', got.html.length > 100 && got.error === '')
const badFetch = async () => ({ ok: false, status: 403, text: async () => '' })
const bad = await fetchRedfin('https://www.redfin.com/x', { fetchImpl: badFetch })
check('403 reported, not silently empty', /HTTP 403/.test(bad.error))
const noUrl = await lookupRedfin('')
check('no url -> clear reason', noUrl.ok === false && /No Redfin page/.test(noUrl.error))
const wrongSite = await lookupRedfin('https://www.zillow.com/x')
check('non-Redfin url refused', wrongSite.ok === false)

console.log('\n[Redfin] Refusals are not pages, and are not worth asking twice')
// Redfin throttles with a 202 and an empty body. A 2xx is not a page, and
// treating it as one is what let a city-sized run report "done" holding
// nothing.
let calls = 0
const refusing = async () => { calls++; return { ok: true, status: 202, text: async () => '' } }
const refused = await lookupRedfin('https://www.redfin.com/CA/San-Francisco/1-A-St/home/1', { fetchImpl: refusing, retries: 2, retryDelayMs: 1 })
check('an empty 202 is a refusal, not an empty page', refused.blocked === true, JSON.stringify(refused))
check('and is not reported as ok', refused.ok === false)
// A bot check does not become a page by asking again, and the retry costs a
// round trip plus a sleep on every property.
check('a refusal is asked for exactly once', calls === 1, `${calls} attempts`)

calls = 0
const flaky = async () => { calls++; return { ok: false, status: 500, text: async () => '' } }
await lookupRedfin('https://www.redfin.com/CA/San-Francisco/1-A-St/home/1', { fetchImpl: flaky, retries: 2, retryDelayMs: 1 })
// A 500 is a genuine error about that one page, so it is still worth retrying.
check('an ordinary error is still retried', calls === 3, `${calls} attempts`)

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'} (${pass} passed, ${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)
