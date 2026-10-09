// Zapier > Code by Zapier (JavaScript). Replaces the Custom Request, so the
// card is built by JSON.stringify and cannot be broken by a quote, a newline
// or a backslash in someone's reply.
//
// Input Data to map (left side = these names, right side = the Catch Hook field):
//   eventType    <- Event Type          drop anything that is not a human reply
//   leadEmail    <- Lead Email
//   replySubject <- Reply Subject
//   replyText    <- Reply Text          the FULL body. Reply Text Snippet is a teaser
//   replySnippet <- Reply Text Snippet  fallback, only used if replyText is empty
//   emailId      <- Email Id            lets the step fetch the picture
//   campaign     <- Campaign Name
//   inbox        <- Email Account
//   received     <- Timestamp
//   uniboxUrl    <- Unibox Url
//   skipBulk     = "yes" to drop newsletters and autoresponders. Omitted, they post.
//   imageLayout  = "grid", "carousel" or "stack" to force one. Omitted, it picks by count.
// Plus two constants, typed in rather than picked from the dropdown:
//   chatWebhook   = your Google Chat space webhook URL
//   instantlyKey  = an Instantly API key (Settings > Integrations > API)
//
// Instantly's webhook does not carry the email body as HTML — checked against a
// live payload, there is no such field. So to show a picture the step asks
// Instantly for the message itself, by Email Id. Leave instantlyKey unset and
// everything else still works; the card is simply text-only.

const API = 'https://api.instantly.ai/api/v2/emails/';

// A Chat card holds 100 widgets and 32 KB. Thirty pictures plus the text sits
// well inside both, and is more of a newsletter than anyone scrolls anyway.
const MAX_IMAGES = 30;
// Carousels get fewer. Past roughly half a dozen slides Chat stops going back
// — you can still move forward, but the arrow will not return you past a
// certain point. Google documents no limit on carouselCards and this is not in
// the payload, so it is theirs, not ours. Staying under it is the only fix
// available from here; the grid has no such trouble and shows all thirty.
const MAX_CAROUSEL = 5;
// Up to this many pictures a grid shows them all at once and stays short.
// Past it the grid turns into ten rows of thumbnails, and a carousel - one
// image tall whatever the count - is the shorter card.
const GRID_UP_TO = 10;
const MAX_TEXT = 3000;
// Lines of body text before Chat hides the rest behind its own "show more".
const TEXT_LINES = 6;

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
    // What is left when an HTML email is flattened to text: every image and
    // link becomes a [url] fragment, and the table cells around them leave bare
    // brackets. None of it is anything a person typed.
    .replace(/\[\s*https?:\/\/[^\]]*\]/gi, '')
    .replace(/\bhttps?:\/\/\S+\.(?:gif|png|jpe?g|webp|svg)\b/gi, '')
    .replace(/^[\s\[\]()]+$/gm, '')
    .replace(/\bhttps?:\/\/\S{120,}/g, '')        // anything that long is a token
    .replace(/\S+@\S+\?subject=\S+/g, '')
    // Keep the gap between paragraphs — dropping every empty line runs a reply
    // into one block — but collapse the runs that stripping links leaves behind.
    .split('\n').map(l => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, max || 600)
    .trim();
}

// Pictures referenced inside the HTML. Two kinds:
//   remote — hosted on https, so Chat can fetch and render it
//   inline — an attached photo, written as cid:. That identifier means nothing
//            outside the message, so it is counted, never rendered.
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

const withTimeout = (p, ms) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error('instantly timed out')), ms)),
]);

// Ask Instantly for the message. Every failure returns null on purpose: a card
// without a picture beats no card at all, and a Zap step that throws posts
// nothing.
async function fetchEmail(id, key) {
  if (!id || !key) return null;
  try {
    const res = await withTimeout(fetch(API + encodeURIComponent(String(id)), {
      headers: { Authorization: 'Bearer ' + String(key) },
    }), 5000);
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// The files Instantly stored with the message, narrowed to actual pictures.
// Instantly builds these URLs out of the raw filename, so "IMG 1234.jpg" arrives
// with a literal space in it. Chat cannot fetch that, so encode it — and only
// the space, since re-encoding a URL that is already escaped would break it.
function photosOf(email) {
  const files = (email && email.attachment_json && email.attachment_json.files) || [];
  return files
    .filter(f => f && f.url && /^image\//i.test(String(f.type || '')))
    .map(f => Object.assign({}, f, { url: String(f.url).trim().replace(/ /g, '%20') }));
}

// How the pictures are laid out. Three shapes, because a stack of thirty
// full-width images is a long scroll and the alternatives are worth trying:
//   grid     - thumbnails, columnCount across. Inside a Grid the URL field is
//              imageUri, NOT the imageUrl every other widget uses.
//   carousel - one at a time with arrows. Documented for Chat apps; whether a
//              one-way webhook gets working arrows is the thing being tested.
//   stack    - the original, collapsed behind Chat own "Show more".
// A single picture is always just that picture: no grid cell, no one-slide
// carousel, nothing to collapse.
function pictureSection(shots, layout, uniboxUrl) {
  if (!shots.length) return [];
  const alt = (i) => (i ? 'Image ' + (i + 1) : 'The reply');
  const head = { header: `${shots.length} images in this reply` };
  // An Image carries its own onClick, so tapping one opens that picture full
  // size in a browser. A Grid does not: its single onClick is shared by every
  // item, so a per-thumbnail link is impossible and the whole grid opens the
  // thread in Instantly instead.
  const pic = (u, i) => ({ image: {
    imageUrl: u, altText: alt(i), onClick: { openLink: { url: u } },
  } });

  if (shots.length === 1) return [{ widgets: [pic(shots[0], 0)] }];

  if (layout === 'carousel') {
    return [{ ...head, widgets: [{ carousel: { carouselCards: shots.map((u, i) => ({
      widgets: [pic(u, i)],
    })) } }] }];
  }
  if (layout === 'stack') {
    return [{ ...head, collapsible: true, uncollapsibleWidgetsCount: 1,
      widgets: shots.map(pic) }];
  }
  return [{ ...head, widgets: [{ grid: {
    columnCount: shots.length > 4 ? 3 : 2,
    // Without a crop the thumbnails keep their own shapes and the rows go
    // ragged. 4:3 lines them up.
    items: shots.map((u, i) => ({
      image: { imageUri: u, altText: alt(i), cropStyle: { type: 'RECTANGLE_4_3' } },
    })),
    ...(uniboxUrl ? { onClick: { openLink: { url: String(uniboxUrl) } } } : {}),
  } }] }];
}

function buildCard(d, subject, body, html, photos) {
  const pics = images(html);
  // Everything the email shows, in the order it shows it. Attachments lead:
  // someone replying with a photo attaches it, while the hosted images are the
  // template around it. Duplicates drop out — a logo repeated in every row of a
  // newsletter should appear once.
  const seen = {};
  const every = photos.map(p => p.url).concat(pics.remote)
    .filter(u => u && !seen[u] && (seen[u] = true));
  // Chosen by how many there are, unless Input Data names one outright.
  const asked = String(d.imageLayout || 'auto').trim().toLowerCase();
  const layout = (asked === 'grid' || asked === 'carousel' || asked === 'stack')
    ? asked
    : (every.length > GRID_UP_TO ? 'carousel' : 'grid');

  const shots = every.slice(0, layout === 'carousel' ? MAX_CAROUSEL : MAX_IMAGES);
  const hidden = every.length - shots.length;   // count what is left after the
                                                // duplicates have gone, or a
                                                // repeated logo inflates it

  const said = clean(unquote(body), MAX_TEXT);
  const note = said
    || (shots.length ? '(the reply is a picture, with no text)'
      : pics.inline ? '(the reply is an attached picture, with no text)'
        : '(no text)');

  return {
    text: 'New Instantly reply received',
    cardsV2: [{
      cardId: 'instantly-reply-alert',
      card: {
        header: { title: '📩 New Instantly Reply', subtitle: 'Response required' },
        // Three sections so a long email stays a short card. Chat collapses a
        // section itself: the pictures past the first sit behind "Show more",
        // and maxLines does the same for a long body. Nothing is dropped —
        // it is one click away.
        sections: [
          { widgets: [
            { decoratedText: { topLabel: 'Lead Email', text: String(d.leadEmail || '—'), wrapText: true } },
            { decoratedText: { topLabel: 'Reply Subject', text: subject || '—', wrapText: true } },
          ] },
          ...pictureSection(shots, layout, d.uniboxUrl),
          { widgets: [
            // A picture the step knows about but cannot render: say so rather
            // than leaving a gap where an image should be.
            ...(!shots.length && pics.inline ? [{
              decoratedText: {
                topLabel: 'Attached',
                text: `📎 ${pics.inline} image${pics.inline > 1 ? 's' : ''} — open in Instantly to see ${pics.inline > 1 ? 'them' : 'it'}`,
                wrapText: true,
              },
            }] : []),
            { textParagraph: { text: note, maxLines: TEXT_LINES } },
            ...(hidden > 0 ? [{ decoratedText: {
              topLabel: 'More', wrapText: true,
              text: `${hidden} further image${hidden > 1 ? 's' : ''} not shown — open in Instantly for the whole email`,
            } }] : []),
            { decoratedText: { topLabel: 'Campaign', text: String(d.campaign || '—'), wrapText: true } },
            { decoratedText: { topLabel: 'Receiving Inbox', text: String(d.inbox || '—'), wrapText: true } },
            { decoratedText: { topLabel: 'Received', text: String(d.received || '—'), wrapText: true } },
            ...(d.uniboxUrl || photos.length ? [{ buttonList: { buttons: [
              ...(photos.length ? [{
                text: photos.length > 1 ? 'Open the photos' : 'Open the photo',
                onClick: { openLink: { url: String(photos[0].url) } },
                altText: 'Open the attached picture',
              }] : []),
              ...(d.uniboxUrl ? [{
                text: 'Reply in Instantly', type: 'FILLED',
                onClick: { openLink: { url: String(d.uniboxUrl) } },
                altText: 'Open Instantly and email this lead',
              }] : []),
            ] } }] : []),
          ] },
        ],
      },
    }],
  };
}

async function decide(d) {
  // Instantly fires auto_reply_received for autoresponders, separately from
  // reply_received. Reading the event name is exact where matching subject
  // lines only guesses. Unmapped, this check stands aside.
  const event = String(d.eventType || '').trim().toLowerCase();
  if (event && event !== 'reply_received') {
    return { post: false, reason: `event ${event} is not a human reply` };
  }

  const subject = String(d.replySubject || '').trim();
  const body = String(d.replyText || d.replySnippet || '');

  // A newsletter is not a lead replying. Off unless asked for: whether these
  // are worth seeing is the campaign owner's call, not this file's. Set
  // skipBulk to "yes" in Input Data to drop them.
  if (String(d.skipBulk || '').toLowerCase() === 'yes'
      && (BULK.test(body) || AUTO.test(subject))) {
    return { post: false, reason: 'bulk or automated mail, not a reply' };
  }

  // Use the HTML if the webhook ever starts sending it; otherwise go and get it.
  let html = String(d.replyHtml || '');
  let photos = [];
  let lookup = 'skipped';
  if (!d.replyHtml) {
    if (d.emailId && d.instantlyKey) {
      const email = await fetchEmail(d.emailId, d.instantlyKey);
      lookup = email ? 'ok' : 'failed';
      if (email) {
        html = String((email.body && email.body.html) || '');
        photos = photosOf(email);
      }
    }
  }

  return { post: true, lookup, card: buildCard(d, subject, body, html, photos) };
}

// ===== Zapier wiring. Everything above is pure and covered by test/zapier-chat-test.mjs =====

const decision = await decide(inputData);
if (!decision.post) {
  output = { posted: false, reason: decision.reason };
} else {
  const res = await fetch(inputData.chatWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(decision.card),   // <- escaping stops being our problem
  });
  if (!res.ok) {
    throw new Error('Google Chat refused the card: ' + res.status + ' ' + (await res.text()));
  }
  output = { posted: true, status: res.status, picture: decision.lookup };
}
