// Zapier > Code by Zapier (JavaScript). Replaces the Filter and the Custom
// Request with one step, so the card is built by JSON.stringify and cannot be
// broken by a quote, a newline or a backslash in someone's reply.
//
// Input Data to map (left side = these names, right side = the Catch Hook field):
//   leadEmail, replySubject, replyText, campaign, inbox, received, uniboxUrl
//   replyHtml  <- the HTML body, if Instantly's webhook sends one. Without it
//                 there is no way to show the picture: the text version of the
//                 email contains no image URLs at all, only t.apemail.net/c/
//                 redirect tokens with no file extension.
// Plus one constant: chatWebhook = your Google Chat space webhook URL.

const BULK = /powered by activepipe|this email was sent to|list-unsubscribe|click here to unsubscribe|view this email in your browser/i;
const AUTO = /^(out of office|automatic reply|auto-reply|undeliverable|delivery status notification)/i;

// The first real picture in the email. Skips the 1x1 open-tracking pixels and
// spacer GIFs that every marketing template carries, or the card would show a
// transparent dot.
function firstImage(html) {
  const src = String(html || '')
  for (const m of src.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    const tag = m[0], url = m[1]
    if (!/^https:\/\//i.test(url)) continue          // Chat needs a public https URL
    if (/pixel|spacer|\/o\/|open\.gif|beacon|track/i.test(url)) continue
    if (/width=["']?1["']?|height=["']?1["']?/i.test(tag)) continue
    return url
  }
  return ''
}

function clean(text, max) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '')      // the tracking-link wall
    .replace(/\S+@\S+\?subject=\S+/g, '')
    .split('\n').map(l => l.trim()).filter(Boolean).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, max || 600)
    .trim();
}

const replyText = String(inputData.replyText || '');
const subject = String(inputData.replySubject || '');

// A newsletter is not a lead replying. Stop here, and say so, so the Zap
// history shows why nothing was posted rather than looking broken.
// Off by default: an agent's newsletter is still an agent who has your
// address and is active. Set skipBulk to "yes" in Input Data to drop them.
const skipBulk = String(inputData.skipBulk || '').toLowerCase() === 'yes';
if (skipBulk && (BULK.test(replyText) || AUTO.test(subject.trim()))) {
  output = { posted: false, reason: 'bulk or automated mail, not a reply' };
} else {
  const image = firstImage(inputData.replyHtml);

  const card = {
    text: 'New Instantly reply received',
    cardsV2: [{
      cardId: 'instantly-reply-alert',
      card: {
        header: { title: '📩 New Instantly Reply', subtitle: 'Response required' },
        sections: [{
          widgets: [
            { decoratedText: { topLabel: 'Lead Email', text: String(inputData.leadEmail || '—'), wrapText: true } },
            { decoratedText: { topLabel: 'Reply Subject', text: subject || '—', wrapText: true } },
            ...(image ? [{ image: { imageUrl: image, altText: 'The reply' } }] : []),
            { textParagraph: { text: clean(replyText, 600) || '(no text)' } },
            { decoratedText: { topLabel: 'Campaign', text: String(inputData.campaign || '—'), wrapText: true } },
            { decoratedText: { topLabel: 'Receiving Inbox', text: String(inputData.inbox || '—'), wrapText: true } },
            { decoratedText: { topLabel: 'Received', text: String(inputData.received || '—'), wrapText: true } },
            ...(inputData.uniboxUrl ? [{ buttonList: { buttons: [{
              text: 'Reply in Instantly', type: 'FILLED',
              onClick: { openLink: { url: String(inputData.uniboxUrl) } },
              altText: 'Open Instantly and email this lead',
            }] } }] : []),
          ],
        }],
      },
    }],
  };

  const res = await fetch(inputData.chatWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(card),   // <- the fix: escaping is not our problem any more
  });
  output = { posted: res.ok, status: res.status };
}
