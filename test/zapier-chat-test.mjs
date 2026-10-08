// Tests for the Code by Zapier step that posts an Instantly reply to Google Chat.
//
// The step is not a module — Zapier hands it `inputData` and expects `output` —
// so everything above the wiring marker is pure, and this file evaluates that
// prefix and exercises it. If the marker ever moves, these tests fail loudly
// rather than silently testing nothing.
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
const { unquote, clean, images, buildCard, decide } =
  new Function(SRC.slice(0, at) + '\nreturn { unquote, clean, images, buildCard, decide };')()

// the text a card actually shows
const said = card => card.cardsV2[0].card.sections[0].widgets.find(w => w.textParagraph).textParagraph.text
const widgets = card => card.cardsV2[0].card.sections[0].widgets
const imageOf = card => (widgets(card).find(w => w.image) || {}).image
const attachNote = card => {
  const w = widgets(card).find(x => x.decoratedText && x.decoratedText.topLabel === 'Attached')
  return w ? w.decoratedText.text : ''
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
check('capped at 600 by default', clean('x'.repeat(900)).length === 600)
check('custom cap honoured', clean('x'.repeat(900), 50).length === 50)

// ---- pictures ---------------------------------------------------------------------
console.log('\n[Zapier→Chat] Pictures')
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

// ---- which event ------------------------------------------------------------------
console.log('\n[Zapier→Chat] Which events post')
check('reply_received posts', decide({ eventType: 'reply_received', replyText: 'hi' }).post === true)
check('auto_reply_received is dropped by name, not by guesswork', (() => {
  const d = decide({ eventType: 'auto_reply_received', replyText: 'I am away until Monday' })
  return d.post === false && /auto_reply_received/.test(d.reason)
})())
check('an unmapped eventType does not block anything',
  decide({ replyText: 'hi' }).post === true)
check('bulk mail passes by default',
  decide({ replyText: 'Powered by ActivePipe. Click here to unsubscribe' }).post === true)
check('skipBulk=yes drops a newsletter', (() => {
  const d = decide({ skipBulk: 'yes', replyText: 'Powered by ActivePipe\nclick here to unsubscribe' })
  return d.post === false && /bulk/.test(d.reason)
})())
check('skipBulk=yes drops an out-of-office by subject',
  decide({ skipBulk: 'yes', replySubject: 'Automatic reply: your note', replyText: 'away' }).post === false)

// ---- the card --------------------------------------------------------------------
console.log('\n[Zapier→Chat] The card')
const base = {
  leadEmail: 'agent@example.com', replySubject: 'Re: After the buyer walks',
  campaign: 'Oakland Realtor Campaign', inbox: 'juan@twinhomebuyer.com',
  received: '2026-10-02T17:04:00Z', uniboxUrl: 'https://app.instantly.ai/app/unibox/1',
}
check('full reply_text is preferred over the snippet',
  said(decide({ ...base, replyText: 'the whole body', replySnippet: 'the whole b…' }).card) === 'the whole body')
check('the snippet is used when reply_text is empty',
  said(decide({ ...base, replyText: '', replySnippet: 'only a teaser' }).card) === 'only a teaser')
check('a hosted picture appears above the text',
  imageOf(decide({ ...base, replyText: 'look', replyHtml: '<img src="https://x.com/a.jpg">' }).card)
    .imageUrl === 'https://x.com/a.jpg')
check('an attached photo says so instead of showing nothing', (() => {
  const c = decide({ ...base, replyText: 'see attached', replyHtml: '<img src="cid:x">' }).card
  return !imageOf(c) && /1 image/.test(attachNote(c))
})())
check('two attachments read as plural',
  /2 images — open in Instantly to see them/.test(
    attachNote(decide({ ...base, replyText: 'x', replyHtml: '<img src="cid:a"><img src="cid:b">' }).card)))
check('a picture-only reply says so rather than "(no text)"',
  said(decide({ ...base, replyText: '', replyHtml: '<img src="https://x.com/a.jpg">' }).card)
  === '(the reply is a picture, with no text)')
check('an attachment-only reply says so',
  said(decide({ ...base, replyText: '', replyHtml: '<img src="cid:x">' }).card)
  === '(the reply is an attached picture, with no text)')
check('a truly empty reply still says something',
  said(decide({ ...base, replyText: '' }).card) === '(no text)')
check('no unibox URL means no button, not a broken one', (() => {
  const c = decide({ ...base, uniboxUrl: '', replyText: 'x' }).card
  return !widgets(c).some(w => w.buttonList)
})())
check('the button is there when the URL is',
  widgets(decide({ ...base, replyText: 'x' }).card)
    .find(w => w.buttonList).buttonList.buttons[0].onClick.openLink.url === base.uniboxUrl)

// ---- the original bug: the card could not survive ordinary replies ----------------
console.log('\n[Zapier→Chat] Characters that used to break the card')
for (const [label, body] of [
  ['a double quote', 'He said "yes" to the price'],
  ['a line break', 'line one\nline two'],
  ['a backslash', 'the path is C:\\Users\\agent'],
  ['all three at once', 'he said "yes"\non C:\\x\tand left'],
  ['a curly quote and emoji', '“ADU” sounds good 👍🏽'],
]) {
  const card = decide({ ...base, replyText: body }).card
  const round = JSON.parse(JSON.stringify(card))
  check(`${label} survives JSON.stringify`, said(round) === clean(unquote(body), 600))
}

// ---- real replies pulled from the Instantly audit ---------------------------------
console.log('\n[Zapier→Chat] Real replies')
check('Don Dunbar keeps his two addresses', (() => {
  const t = said(decide({ ...base, replyText:
    'good daY\nWHAt aRE YOU LOOKING FOR\nDUPLEX 7443 wELD ST\n2 PROPERTIES ON ONE LOT 670 32ND ST' }).card)
  return t.includes('7443 wELD ST') && t.includes('670 32ND ST')
})())
check('Jonathan Lee shows his words, not the thread under them', (() => {
  const t = said(decide({ ...base, replyText:
    'Just came from an easy fixer at 115 Forest View Rd in Woodside. My friend is the trustee.\n\n'
    + 'On Mon, Sep 1, 2026 at 9:14 AM Juan Diaz <juan@twinhomebuyer.com> wrote:\n'
    + '> I buy Bay Area properties directly\n> CA GC Lic. #1066892' }).card)
  return t.includes('115 Forest View Rd') && !t.includes('1066892') && !t.includes('>')
})())
check('Thom Ruben: signature only, with a photo attached, reads honestly', (() => {
  const c = decide({ ...base,
    replyText: 'Sent from my iPhone! Please pardon any syntax errors, Siri has comprehension issues!',
    replyHtml: '<img src="cid:ii_abc123">' }).card
  return said(c) === '(the reply is an attached picture, with no text)' && /1 image/.test(attachNote(c))
})())
check('the ActivePipe newsletter loses its tracking wall', (() => {
  const t = said(decide({ ...base, replyText:
    'Your October: bluegrass, Blue Angels\nhttps://u1964677.ct.sendgrid.net/ls/click?upn=u001.abcdefghijklmnop\nPowered by ActivePipe' }).card)
  return !t.includes('sendgrid') && t.includes('Blue Angels')
})())

// ---- the step is still pasteable into Zapier --------------------------------------
console.log('\n[Zapier→Chat] Still a Zapier step')
check('reads inputData and assigns output', /decide\(inputData\)/.test(SRC) && /output\s*=/.test(SRC))
check('posts with JSON.stringify, never a hand-built string',
  /body:\s*JSON\.stringify\(decision\.card\)/.test(SRC))
check('documents reply_html, without which no picture can be shown', /replyHtml\s*<-\s*reply_html/.test(SRC))
check('documents reply_text as the full body', /replyText\s*<-\s*reply_text\b/.test(SRC))
check('no stray imports or exports', !/^\s*(import|export)\s/m.test(SRC))

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'} (${pass} passed, ${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)
