// Zapier > Code by Zapier (JavaScript). Replaces the Custom Request, so the
// card is built by JSON.stringify and cannot be broken by a quote, a newline
// or a backslash in someone's reply.
//
// Input Data to map (left side = these names, right side = the Catch Hook field):
//   eventType    <- event_type          drop anything that is not a human reply
//   leadEmail    <- lead_email
//   replySubject <- reply_subject
//   replyText    <- reply_text          the FULL body. reply_text_snippet is a teaser
//   replySnippet <- reply_text_snippet  fallback, only used if replyText is empty
//   replyHtml    <- reply_html          needed to show a picture
//   campaign     <- campaign_name
//   inbox        <- email_account
//   received     <- timestamp
//   uniboxUrl    <- unibox_url
// Plus one constant: chatWebhook = your Google Chat space webhook URL.

const BULK = /powered by activepipe|this email was sent to|list-unsubscribe|click here to unsubscribe|view this email in your browser/i;
const AUTO = /^(out of office|automatic reply|auto-reply|undeliverable|delivery status notification)/i;

// Where the person stopped writing and the quoted thread began. Cut at the
// earliest one: people top-post, so their own words come first. A bottom-posted
// reply loses its text and falls back to "(no text)" — rare enough to accept,
// and the Reply button still opens the real thing.
const QUOTE = [
  /^On .{0,160}\bwrote:\s*$/im,            // Gmail, Apple Mail
  /^-{2,}\s*Original Message\s*-{2,}/im,   // Outlook
  /^_{10,}\s*$/m,                          // Outlook's horizontal rule
  /^From:\s*.+$/im,                        // Outlook's quoted header block
  /^\s*Sent from my (iPhone|iPad|Android|Samsung|mobile)/im,
  /^\s*Get Outlook for (iOS|Android)/im,
];

// Tracking links are the wall of noise. A normal link may be the whole point of
// the reply ("here are the disclosures"), so those stay.
const TRACKER = /\bhttps?:\/\/\S*?(?:apemail\.net|sendgrid\.net|list-manage\.com|mailchimp|mcusercontent|hubspot|activepipe|\/ls\/click|\/c\/[A-Za-z0-9_\-=]{16,})\S*/gi;

function unquote(text) {
  const src = String(text || '');
  let cut = src.length;
  for (const re of QUOTE) {
    const m = re.exec(src);
    if (m && m.index < cut) cut = m.index;
  }
  return src.slice(0, cut)
    .split('\n').filter(l => !/^\s*>/.test(l)).join('\n');
}

function clean(text, max) {
  return String(text || '')
    .replace(TRACKER, '')
    .replace(/\bhttps?:\/\/\S{120,}/g, '')        // anything that long is a token
    .replace(/\S+@\S+\?subject=\S+/g, '')
    // Keep the gap between paragraphs — dropping every empty line runs a reply
    // into one block — but collapse the runs that stripping links leaves behind.
    .split('\n').map(l => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, max || 600)
    .trim();
}

// Pictures in the reply. Two kinds, and only one can be shown:
//   remote — hosted on https, so Chat can fetch and render it
//   inline — an attached photo, referenced as cid:. Chat cannot reach those,
//            so the card says a picture is attached instead of showing nothing.
// Skips the 1x1 open-tracking pixels and spacer GIFs every template carries.
function images(html) {
  const remote = [];
  let inline = 0;
  for (const m of String(html || '').matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    const tag = m[0], url = m[1].trim();
    if (/^cid:/i.test(url)) { inline++; continue; }
    if (!/^https:\/\//i.test(url)) continue;
    if (/pixel|spacer|\/o\/|open\.gif|beacon|track/i.test(url)) continue;
    if (/width=["']?1["']?|height=["']?1["']?/i.test(tag)) continue;
    remote.push(url);
  }
  return { remote, inline };
}

function buildCard(d, subject, body) {
  const pics = images(d.replyHtml);
  const said = clean(unquote(body), 600);
  const note = said
    || (pics.remote.length ? '(the reply is a picture, with no text)'
      : pics.inline ? '(the reply is an attached picture, with no text)'
        : '(no text)');

  return {
    text: 'New Instantly reply received',
    cardsV2: [{
      cardId: 'instantly-reply-alert',
      card: {
        header: { title: '📩 New Instantly Reply', subtitle: 'Response required' },
        sections: [{
          widgets: [
            { decoratedText: { topLabel: 'Lead Email', text: String(d.leadEmail || '—'), wrapText: true } },
            { decoratedText: { topLabel: 'Reply Subject', text: subject || '—', wrapText: true } },
            ...(pics.remote.length ? [{ image: { imageUrl: pics.remote[0], altText: 'The reply' } }] : []),
            ...(!pics.remote.length && pics.inline ? [{
              decoratedText: {
                topLabel: 'Attached',
                text: `📎 ${pics.inline} image${pics.inline > 1 ? 's' : ''} — open in Instantly to see ${pics.inline > 1 ? 'them' : 'it'}`,
                wrapText: true,
              },
            }] : []),
            { textParagraph: { text: note } },
            { decoratedText: { topLabel: 'Campaign', text: String(d.campaign || '—'), wrapText: true } },
            { decoratedText: { topLabel: 'Receiving Inbox', text: String(d.inbox || '—'), wrapText: true } },
            { decoratedText: { topLabel: 'Received', text: String(d.received || '—'), wrapText: true } },
            ...(d.uniboxUrl ? [{ buttonList: { buttons: [{
              text: 'Reply in Instantly', type: 'FILLED',
              onClick: { openLink: { url: String(d.uniboxUrl) } },
              altText: 'Open Instantly and email this lead',
            }] } }] : []),
          ],
        }],
      },
    }],
  };
}

function decide(d) {
  // Instantly fires auto_reply_received for autoresponders, separately from
  // reply_received. Reading the event name is exact where matching subject
  // lines only guesses. Unmapped, this check stands aside.
  const event = String(d.eventType || '').trim().toLowerCase();
  if (event && event !== 'reply_received') {
    return { post: false, reason: `event ${event} is not a human reply` };
  }

  const subject = String(d.replySubject || '').trim();
  const body = String(d.replyText || d.replySnippet || '');

  // A newsletter is not a lead replying. Off by default: an agent's newsletter
  // is still an agent who has your address and is active. Set skipBulk to "yes"
  // in Input Data to drop them.
  if (String(d.skipBulk || '').toLowerCase() === 'yes'
      && (BULK.test(body) || AUTO.test(subject))) {
    return { post: false, reason: 'bulk or automated mail, not a reply' };
  }

  return { post: true, card: buildCard(d, subject, body) };
}

// ===== Zapier wiring. Everything above is pure and covered by test/zapier-chat-test.mjs =====

const decision = decide(inputData);
if (!decision.post) {
  output = { posted: false, reason: decision.reason };
} else {
  const res = await fetch(inputData.chatWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(decision.card),   // <- escaping stops being our problem
  });
  output = { posted: res.ok, status: res.status };
}
