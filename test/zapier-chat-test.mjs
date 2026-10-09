// Tests for the Code by Zapier step that posts an Instantly reply to Google Chat.
//
// The step is not a module — Zapier hands it `inputData` and expects `output` —
// so everything above the wiring marker is pure, and this file evaluates that
// prefix and exercises it. If the marker ever moves, these tests fail loudly
// rather than silently testing nothing.
//
// The step calls Instantly to fetch the email body, so `fetch` is stubbed here.
// It defaults to a flat refusal: every test that does not care about the API
// proves the card still gets built when the API gives nothing.
import fs from 'node:fs'

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

const SRC = fs.readFileSync('docs/zapier/instantly-reply-to-google-chat.js', 'utf8')
const MARK = '// ===== Zapier wiring'
const at = SRC.indexOf(MARK)
if (at < 0) { console.log('  FAIL  wiring marker missing — cannot load the pure helpers'); process.exit(1) }
const { unquote, clean, images, buildCard, decide, fetchEmail, photosOf } =
  new Function(SRC.slice(0, at) +
    '\nreturn { unquote, clean, images, buildCard, decide, fetchEmail, photosOf };')()

let calls = []
const refuse = async () => ({ ok: false, status: 404 })
const serve = (payload) => async (url, opts) => {
  calls.push({ url, auth: opts && opts.headers && opts.headers.Authorization })
  return { ok: true, status: 200, json: async () => payload }
}
globalThis.fetch = refuse

// the text a card actually shows
const said = card => card.cardsV2[0].card.sections[0].widgets.find(w => w.textParagraph).textParagraph.text
const widgets = card => card.cardsV2[0].card.sections[0].widgets
const imageOf = card => (widgets(card).find(w => w.image) || {}).image
const labelled = (card, label) => {
  const w = widgets(card).find(x => x.decoratedText && x.decoratedText.topLabel === label)
  return w ? w.decoratedText.text : ''
}
const buttons = card => {
  const w = widgets(card).find(x => x.buttonList)
  return w ? w.buttonList.buttons : []
}

// ---- the quoted thread ------------------------------------------------------------
console.log('\n[Zapier→Chat] Cutting the quoted thread')
check('Gmail "On ... wrote:" is cut',
  unquote('Sounds good, call me.\n\nOn Wed, Aug 5, 2026 at 10:02 AM Juan Diaz <juan@x.com> wrote:\n> my pitch').trim()
  === 'Sounds good, call me.')
check('Outlook original-message banner is cut',
  unquote('Yes please.\n\n-----Original Message-----\nFrom: Juan\nold stuff').trim() === 'Yes please.')
check('Outlook header block is cut',
  unquote('Interested.\n\nFrom: Juan Diaz <juan@x.com>\nSent: Monday\nSubject: hi').trim() === 'Interested.')
check('Outlook horizontal rule is cut',
  unquote('Call me.\n\n________________________________\nFrom: someone').trim() === 'Call me.')
check('phone signature is cut',
  unquote('Will do.\n\nSent from my iPhone').trim() === 'Will do.')
check('leading ">" lines are dropped',
  unquote('My answer.\n> your question\n>> older still').trim() === 'My answer.')
check('earliest marker wins when several appear',
  unquote('Short.\nSent from my iPhone\nOn Mon, X wrote:\nquoted').trim() === 'Short.')
check('a reply with no quote is untouched',
  unquote('Please send me the information on your buy box.').trim()
  === 'Please send me the information on your buy box.')
check('empty in, empty out', unquote('') === '' && unquote(null) === '')

// ---- link noise -------------------------------------------------------------------
console.log('\n[Zapier→Chat] Link noise')
check('apemail tracking link is stripped',
  !clean('see https://t.apemail.net/c/eJxVjk1vgzAMhn8N3IqSkAQ4cOi0_ x more').includes('apemail'))
check('sendgrid click wrapper is stripped',
  !clean('x https://u1964677.ct.sendgrid.net/ls/click?upn=u001.iNHD3r2W6mxD2eo y').includes('sendgrid'))
check('a very long token URL is stripped',
  !clean('go https://example.com/' + 'a'.repeat(140) + ' end').includes('aaaa'))
check('an ordinary link the agent meant to send survives',
  clean('Here are the disclosures: app.disclosures.io/link/27-Prague-Street').includes('disclosures.io'))
check('a short https link survives',
  clean('listing is at https://redfin.com/CA/Oakland/home/123').includes('redfin.com'))
check('a paragraph break survives', clean('Hi Juan,\n\nThanks for reaching out.') === 'Hi Juan,\n\nThanks for reaching out.')
check('runs of blank lines collapse to one', clean('a\n\n\n\n\nb') === 'a\n\nb')
check('blank lines left by stripping a link collapse',
  clean('Your October\nhttps://u1.ct.sendgrid.net/ls/click?upn=abc\n\nPowered by ActivePipe')
  === 'Your October\n\nPowered by ActivePipe')
// Catherine Abalos's ActivePipe newsletter, as the webhook actually sent it.
const NEWSLETTER = [
  'Catherine Abalos, (415) 286-5045', '[', '[', '[',
  '[https://d2wn0fwevmicfp.cloudfront.net/images/empty.gif]',
  '[https://d2wn0fwevmicfp.cloudfront.net/images/empty.gif]',
  '[', '[https://d2wn0fwevmicfp.cloudfront.net/images/empty.gif]',
  '592', '[', '3rd St.', '[', 'San Francisco', '[', 'California', '[', '94107',
  '[', 'https://kinokorealestate.com/', '[', '(415',
].join('\n')
const cleaned = clean(NEWSLETTER)
check('a flattened HTML email loses its [url] image fragments',
  !cleaned.includes('empty.gif') && !cleaned.includes('cloudfront'))
check('…and its bare bracket lines', !/^\s*\[\s*$/m.test(cleaned))
check('…while the words a person could use survive',
  cleaned.includes('Catherine Abalos') && cleaned.includes('San Francisco') && cleaned.includes('94107'))
check('…and it shrinks to something readable',
  cleaned.length < NEWSLETTER.length / 2, `${NEWSLETTER.length} -> ${cleaned.length} chars`)
check('a bare image URL goes even from a host nothing recognises',
  !clean('see https://d2wn0fwevmicfp.cloudfront.net/images/empty.gif here').includes('cloudfront'))
check('brackets inside a sentence are left alone',
  clean('the price [as discussed] is firm') === 'the price [as discussed] is firm')
check('capped at 600 by default', clean('x'.repeat(900)).length === 600)
check('custom cap honoured', clean('x'.repeat(900), 50).length === 50)

// ---- pictures inside the HTML -----------------------------------------------------
console.log('\n[Zapier→Chat] Pictures in the HTML')
check('a hosted picture is found',
  images('<img src="https://cdn.example.com/house.jpg">').remote[0] === 'https://cdn.example.com/house.jpg')
check('1x1 open-tracking pixel is skipped',
  images('<img src="https://x.com/t.gif" width="1" height="1">').remote.length === 0)
check('a URL that reads as a beacon is skipped',
  images('<img src="https://x.com/open/beacon.png">').remote.length === 0)
check('an /o/ open tracker is skipped',
  images('<img src="https://x.com/o/abc123.png">').remote.length === 0)
check('http (not https) is skipped — Chat needs https',
  images('<img src="http://x.com/a.jpg">').remote.length === 0)
check('the pixel is skipped and the real picture after it is kept',
  images('<img src="https://x.com/o/p.gif" width="1" height="1"><img src="https://x.com/real.jpg">')
    .remote[0] === 'https://x.com/real.jpg')
check('an attached photo (cid:) counts as inline, not remote', (() => {
  const r = images('<img src="cid:ii_19abc">')
  return r.inline === 1 && r.remote.length === 0
})())
check('several attachments are counted',
  images('<img src="cid:a"><img src="cid:b"><img src="cid:c">').inline === 3)
check('no html at all is safe', images(undefined).remote.length === 0 && images(undefined).inline === 0)

// ---- asking Instantly for the message ---------------------------------------------
console.log('\n[Zapier→Chat] Fetching the email from Instantly')
calls = []; globalThis.fetch = serve({ body: { html: '<p>hi</p>' } })
check('no API key means no call at all', await fetchEmail('abc', '') === null && calls.length === 0)
check('no email id means no call at all', await fetchEmail('', 'key') === null && calls.length === 0)
const got = await fetchEmail('019fc39c-1121-7b08-9835-5', 'k_live_123')
check('calls v2 emails with the id in the path',
  calls.length === 1 && calls[0].url === 'https://api.instantly.ai/api/v2/emails/019fc39c-1121-7b08-9835-5')
check('sends a bearer token', calls[0].auth === 'Bearer k_live_123')
check('returns the parsed email', got && got.body.html === '<p>hi</p>')
globalThis.fetch = refuse
check('a refused call returns null, it does not throw', await fetchEmail('x', 'k') === null)
globalThis.fetch = async () => { throw new Error('network down') }
check('a thrown network error returns null', await fetchEmail('x', 'k') === null)
globalThis.fetch = serve({})
check('photosOf copes with no attachments at all', photosOf({}).length === 0 && photosOf(null).length === 0)
check('a filename with a space is encoded — Chat cannot fetch a raw space', (() => {
  const p = photosOf({ attachment_json: { files: [
    { filename: 'IMG 1234.jpg', type: 'image/jpeg', url: 'https://att.instantly/v1/o/e/IMG 1234.jpg' }] } })
  return p[0].url === 'https://att.instantly/v1/o/e/IMG%201234.jpg'
})())
check('an already-escaped URL is not double-encoded', (() => {
  const p = photosOf({ attachment_json: { files: [
    { filename: 'a b.jpg', type: 'image/jpeg', url: 'https://att/IMG%201234.jpg' }] } })
  return p[0].url === 'https://att/IMG%201234.jpg'
})())
check('photosOf keeps images and drops other files', (() => {
  const p = photosOf({ attachment_json: { files: [
    { filename: 'a.pdf', type: 'application/pdf', url: 'https://x/a.pdf' },
    { filename: 'b.jpg', type: 'image/jpeg', url: 'https://x/b.jpg' },
    { filename: 'c.png', type: 'image/png' },            // no url — unusable
  ] } })
  return p.length === 1 && p[0].filename === 'b.jpg'
})())

// ---- which event ------------------------------------------------------------------
console.log('\n[Zapier→Chat] Which events post')
globalThis.fetch = refuse
check('reply_received posts', (await decide({ eventType: 'reply_received', replyText: 'hi' })).post === true)
const dropped = await decide({ eventType: 'auto_reply_received', replyText: 'I am away until Monday' })
check('auto_reply_received is dropped by name, not by guesswork',
  dropped.post === false && /auto_reply_received/.test(dropped.reason))
check('an unmapped eventType does not block anything',
  (await decide({ replyText: 'hi' })).post === true)
check('bulk mail posts by default — dropping it is the owner\'s call, not this file\'s',
  (await decide({ replyText: 'Powered by ActivePipe. Click here to unsubscribe' })).post === true)
check('skipBulk=yes drops a newsletter for anyone who wants that',
  (await decide({ skipBulk: 'yes', replyText: 'Powered by ActivePipe\nclick here to unsubscribe' })).post === false)
check('an ordinary reply is never mistaken for bulk',
  (await decide({ replyText: 'Yes, 1195 Palou might be a good fit. Call me.' })).post === true)
check('skipBulk=yes also drops an out-of-office by subject',
  (await decide({ skipBulk: 'yes', replySubject: 'Automatic reply: your note', replyText: 'away' })).post === false)
globalThis.fetch = serve({ body: { html: '' } })
calls = []
await decide({ eventType: 'auto_reply_received', replyText: 'away', emailId: 'x', instantlyKey: 'k' })
check('a dropped event never calls Instantly — no wasted API quota', calls.length === 0)

// ---- the card --------------------------------------------------------------------
console.log('\n[Zapier→Chat] The card')
const base = {
  leadEmail: 'agent@example.com', replySubject: 'Re: After the buyer walks',
  campaign: 'Oakland Realtor Campaign', inbox: 'juan@twinhomebuyer.com',
  received: '2026-10-02T17:04:00Z', uniboxUrl: 'https://app.instantly.ai/app/unibox/1',
  emailId: '019fc39c', instantlyKey: 'k_live',
}
globalThis.fetch = refuse
check('full reply_text is preferred over the snippet',
  said((await decide({ ...base, replyText: 'the whole body', replySnippet: 'the whole b…' })).card) === 'the whole body')
check('the snippet is used when reply_text is empty',
  said((await decide({ ...base, replyText: '', replySnippet: 'only a teaser' })).card) === 'only a teaser')
check('no unibox URL and no photo means no button at all',
  buttons((await decide({ ...base, uniboxUrl: '', replyText: 'x' })).card).length === 0)
check('the Reply button is there when the URL is',
  buttons((await decide({ ...base, replyText: 'x' })).card)[0].onClick.openLink.url === base.uniboxUrl)
check('a failed API call still produces a card',
  (await decide({ ...base, replyText: 'still fine' })).post === true)
check('…and says the lookup failed, so a bad key is visible in the Zap history',
  (await decide({ ...base, replyText: 'x' })).lookup === 'failed')
check('no key at all reports the lookup as skipped, not failed',
  (await decide({ ...base, instantlyKey: '', replyText: 'x' })).lookup === 'skipped')
check('…and that card is text-only, with no gap where a picture would be',
  !imageOf((await decide({ ...base, replyText: 'still fine' })).card))

console.log('\n[Zapier→Chat] Pictures, end to end')
globalThis.fetch = serve({ body: { html: '<p>see photo</p><img src="cid:ii_1">' },
  attachment_json: { files: [{ filename: 'house.jpg', type: 'image/jpeg', url: 'https://att.instantly/house.jpg' }] } })
let c = (await decide({ ...base, replyText: 'Here is the place' })).card
check('an attached photo is shown in the card', imageOf(c) && imageOf(c).imageUrl === 'https://att.instantly/house.jpg')
check('…and a button opens it full size',
  buttons(c)[0].text === 'Open the photo' && buttons(c)[0].onClick.openLink.url === 'https://att.instantly/house.jpg')
check('…with the Reply button still last', buttons(c).slice(-1)[0].text === 'Reply in Instantly')

globalThis.fetch = serve({ body: { html: '<img src="https://cdn.sig/logo.png">' },
  attachment_json: { files: [{ filename: 'p.jpg', type: 'image/jpeg', url: 'https://att/p.jpg' }] } })
const bothKinds = await decide({ ...base, replyText: 'x' })
check('an attachment leads, the template images follow', (() => {
  const urls = widgets(bothKinds.card).filter(w => w.image).map(w => w.image.imageUrl)
  return urls.length === 2 && urls[0] === 'https://att/p.jpg' && urls[1] === 'https://cdn.sig/logo.png'
})())

globalThis.fetch = serve({ body: { html: '<img src="https://cdn.example.com/listing.jpg">' } })
check('a hosted image is used when there is no attachment',
  imageOf((await decide({ ...base, replyText: 'x' })).card).imageUrl === 'https://cdn.example.com/listing.jpg')

globalThis.fetch = serve({ body: { html: '<img src="cid:ii_1">' } })
c = (await decide({ ...base, replyText: '' })).card
check('a cid picture with no attachment record says so', /1 image/.test(labelled(c, 'Attached')))
check('…and the text says the reply is a picture',
  said(c) === '(the reply is an attached picture, with no text)')

globalThis.fetch = serve({ attachment_json: { files: [
  { filename: 'a.jpg', type: 'image/jpeg', url: 'https://att/a.jpg' },
  { filename: 'b.jpg', type: 'image/jpeg', url: 'https://att/b.jpg' },
  { filename: 'c.jpg', type: 'image/jpeg', url: 'https://att/c.jpg' }] } })
c = (await decide({ ...base, replyText: '' })).card
check('every photo is shown, not just the first', (() => {
  const urls = widgets(c).filter(w => w.image).map(w => w.image.imageUrl)
  return urls.length === 3 && urls[0] === 'https://att/a.jpg' && urls[2] === 'https://att/c.jpg'
})())
check('a picture-only reply says so rather than "(no text)"',
  said(c) === '(the reply is a picture, with no text)')

globalThis.fetch = serve({ body: { html: '<img src="https://cdn/x.jpg">' } })
calls = []
await decide({ ...base, replyText: 'x', replyHtml: '<img src="https://inline/y.jpg">' })
check('a mapped replyHtml short-circuits the fetch', calls.length === 0)
check('…and reports the lookup as skipped',
  (await decide({ ...base, replyText: 'x', replyHtml: '<img src="https://i/y.jpg">' })).lookup === 'skipped')
check('…and that HTML is what gets shown',
  imageOf((await decide({ ...base, replyText: 'x', replyHtml: '<img src="https://inline/y.jpg">' })).card)
    .imageUrl === 'https://inline/y.jpg')

console.log('\n[Zapier→Chat] A whole newsletter')
const many = Array.from({ length: 42 }, (_, i) => `<img src="https://cdn.news/pic${i}.jpg">`).join('')
globalThis.fetch = serve({ body: { html: many + '<img src="https://cdn.news/pic0.jpg">' } })
const big = (await decide({ ...base, replyText: 'October edition' })).card
const bigShots = widgets(big).filter(w => w.image)
check('a picture-heavy email shows many, not one', bigShots.length > 10, bigShots.length + ' images')
check('…capped so the card stays inside Chat limits', bigShots.length === 30)
check('…and says how many it held back',
  /12 further images not shown/.test(labelled(big, 'More')))
check('…a repeated image appears once', (() => {
  const urls = bigShots.map(w => w.image.imageUrl)
  return new Set(urls).size === urls.length
})())
check('…and the whole card still fits in 32 KB',
  JSON.stringify(big).length < 32000, JSON.stringify(big).length + ' bytes')
check('…and inside the 100-widget ceiling', widgets(big).length < 100, widgets(big).length + ' widgets')

// ---- the original bug: the card could not survive ordinary replies ----------------
console.log('\n[Zapier→Chat] Characters that used to break the card')
globalThis.fetch = refuse
for (const [label, body] of [
  ['a double quote', 'He said "yes" to the price'],
  ['a line break', 'line one\nline two'],
  ['a backslash', 'the path is C:\\Users\\agent'],
  ['all three at once', 'he said "yes"\non C:\\x\tand left'],
  ['a curly quote and emoji', '“ADU” sounds good 👍🏽'],
]) {
  const card = (await decide({ ...base, replyText: body })).card
  const round = JSON.parse(JSON.stringify(card))
  check(`${label} survives JSON.stringify`, said(round) === clean(unquote(body), 600))
}

// ---- real replies pulled from the Instantly audit ---------------------------------
console.log('\n[Zapier→Chat] Real replies')
check('Don Dunbar keeps his two addresses', (() => {
  const t = said(buildCard(base, '', 'good daY\nWHAt aRE YOU LOOKING FOR\nDUPLEX 7443 wELD ST\n2 PROPERTIES ON ONE LOT 670 32ND ST', '', []))
  return t.includes('7443 wELD ST') && t.includes('670 32ND ST')
})())
check('Jonathan Lee shows his words, not the thread under them', (() => {
  const t = said(buildCard(base, '', 'Just came from an easy fixer at 115 Forest View Rd in Woodside. My friend is the trustee.\n\n'
    + 'On Mon, Sep 1, 2026 at 9:14 AM Juan Diaz <juan@twinhomebuyer.com> wrote:\n'
    + '> I buy Bay Area properties directly\n> CA GC Lic. #1066892', '', []))
  return t.includes('115 Forest View Rd') && !t.includes('1066892') && !t.includes('>')
})())
check('John Anagnostou, the live sample, comes out clean', (() => {
  const t = said(buildCard(base, '', 'Stop\nJohn Anagnostou\n650-255-7840\nJohnanagnostou@me.com\n> > > >', '', []))
  return t.startsWith('Stop') && !t.includes('>')
})())
check('Thom Ruben: signature only, with a photo attached, reads honestly', (() => {
  const c2 = buildCard(base, '', 'Sent from my iPhone! Please pardon any syntax errors, Siri has comprehension issues!',
    '<img src="cid:ii_abc123">', [])
  return said(c2) === '(the reply is an attached picture, with no text)' && /1 image/.test(labelled(c2, 'Attached'))
})())
check('the ActivePipe newsletter loses its tracking wall', (() => {
  const t = said(buildCard(base, '', 'Your October: bluegrass, Blue Angels\nhttps://u1964677.ct.sendgrid.net/ls/click?upn=u001.abcdefghijklmnop\nPowered by ActivePipe', '', []))
  return !t.includes('sendgrid') && t.includes('Blue Angels')
})())

// ---- the step is still pasteable into Zapier --------------------------------------
console.log('\n[Zapier→Chat] Still a Zapier step')
check('reads inputData and assigns output', /await decide\(inputData\)/.test(SRC) && /output\s*=/.test(SRC))
check('posts with JSON.stringify, never a hand-built string',
  /body:\s*JSON\.stringify\(decision\.card\)/.test(SRC))
check('documents Email Id, which is how the picture is found', /emailId\s*<-\s*Email Id/.test(SRC))
check('documents the Instantly key as a typed constant', /instantlyKey\s*=\s*an Instantly API key/.test(SRC))
check('says plainly that the webhook carries no HTML', /webhook does not carry the email body as HTML/.test(SRC))
check('a refused Chat post throws rather than reading as success',
  /if \(!res\.ok\)[\s\S]{0,120}throw new Error\('Google Chat refused the card/.test(SRC))
check('…and carries the explanation Chat sends back', /await res\.text\(\)/.test(SRC))
check('the Instantly call is capped well inside a Zapier step budget',
  /\}\), 5000\);/.test(SRC))
check('no stray imports or exports', !/^\s*(import|export)\s/m.test(SRC))

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'} (${pass} passed, ${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)
