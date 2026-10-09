# Zapier: Instantly reply → Google Chat

Not application code. This is the body of a **Code by Zapier (JavaScript)**
step, kept here because it was written and tested against real traffic and
would otherwise live only in a Zapier editor where nobody can review it.

Everything above the wiring marker at the bottom of the file is pure, and
`test/zapier-chat-test.mjs` runs it — 93 checks with the Instantly API stubbed,
`npm run test:zapier`.

## Where it goes

The Zap is: Catch Hook → Filter → Custom Request POSTing a hand-built JSON
card to Google Chat. This replaces **the Custom Request only**.

**Leave the Filter alone.** Its `Is First: true` condition stops a
notification for every message in a thread. That is its own job, it works, and
it has nothing to do with newsletters.

The bulk-mail check could have gone there instead — Zapier does not bill for a
Zap a filter stops, while a Code step counts as a task. That saving is real
and small: a few dozen tasks a month at a few hundred agents. It is not worth
splitting the rules across a Zapier text box and this file, where they would
drift apart and only one of them could be reviewed or tested. Everything that
decides whether to post lives here.

## What was wrong

**The card could not survive ordinary replies.** It was built by pasting
values into a JSON string, and Zapier substitutes raw. Tested:

| Reply contains | Result |
| --- | --- |
| plain text | works |
| a `"` quote | breaks |
| a line break | breaks |
| a `\` backslash | breaks |

Almost every real email has a line break, so genuine replies failed while the
newsletters — a single run of text — got through. Exactly backwards.

**Nothing blocked bulk mail.** `Is First` passes any first message from a
lead, and a monthly marketing newsletter is a first message. One arrived from
an agent on the Oakland Realtor Campaign — an ActivePipe/MoxiWorks blast,
"Your October: bluegrass, Blue Angels, ballet" — and was posted to Chat as a
lead reply, tracking links and all.

That matters beyond the noise: Instantly stops a sequence when it detects a
reply, so a newsletter silently takes a real agent out of the campaign.

**The card showed the whole thread.** The reply went in as received, so the
card carried the agent's one line plus every quoted line of our own email
underneath it, plus their signature, plus the tracking links.

## What this does

The card is built with `JSON.stringify`, so escaping stops being anyone's
problem. The quoted thread, the phone signature and the tracking links are cut,
so what shows is what the agent typed. A picture in the reply is shown above
the text. The button is omitted rather than emitted broken when there is no
unibox URL.

## Input Data to map

Taken from a live payload, not from the published schema — the two disagree, and
reality wins. Instantly's docs call the lead's address `lead_email`; the webhook
sends both `Email` and `Lead Email`, and no HTML field at all.

| Name | Catch Hook field | Needed for |
| --- | --- | --- |
| `eventType` | Event Type | dropping auto-replies |
| `leadEmail` | Lead Email | |
| `replySubject` | Reply Subject | |
| `replyText` | Reply Text | the full body |
| `replySnippet` | Reply Text Snippet | fallback only |
| `emailId` | Email Id | fetching the picture |
| `campaign` | Campaign Name | |
| `inbox` | Email Account | |
| `received` | Timestamp | |
| `uniboxUrl` | Unibox Url | the Reply button |
| `chatWebhook` | the Google Chat space webhook URL, typed in | where it posts |
| `instantlyKey` | an Instantly API key, typed in | fetching the picture |

Scope that key to **`emails:read`** and nothing else. Instantly's reference for
`GET /api/v2/emails/{id}` accepts `emails:read`, `emails:all`, `all:read` or
`all:all`; the step only ever reads one email by id, so the narrowest of those is
the right one. The key sits in plain text inside a Zapier step, readable by
anyone who can open that Zap — a leaked `emails:read` key exposes message
contents, while a leaked `all:all` key lets someone delete campaigns. If the
dashboard offers nothing finer, `all:read` is an acceptable fallback; `all:all`
is not.

`reply_text` is the full body; `reply_text_snippet` is a teaser and will cut a
long reply mid-sentence. Map both — the snippet is used only when the full body
is empty.

Every field degrades rather than breaks when left unmapped: no `instantlyKey` or
`emailId` means a text-only card, no `eventType` means the event check stands
aside, no `uniboxUrl` means no button.

There is also an optional `replyHtml`. The webhook has no such field today, but
if Instantly ever adds one, mapping it skips the API call entirely.

## Cutting the quoted thread

A reply is mostly our own email quoted back. The step cuts at the first of:
Gmail's `On <date>, <name> wrote:`, Outlook's `-----Original Message-----`, its
`From:` header block and its `____` rule, `Sent from my iPhone`, and any line
starting `>`.

This assumes top-posting, which is what mail clients do by default. A reply
written *underneath* the quote loses its text and the card says `(no text)`.
The Reply button still opens the real thread, so nothing is lost beyond the
preview.

## Showing the picture

An image-built reply reads as a wall of tracking links in Chat while Instantly
renders it properly, so the card shows the picture above the text.

**The webhook does not carry the email body.** This was checked against a live
delivery, field by field: it sends `Email`, `Lead Email`, `Email Account`,
`Email Id`, `Event Type`, `Reply Subject`, `Reply Text`, `Reply Text Snippet`,
`Campaign Name`, `Company Name`, `Is First`, `Step`, `Variant`, `Campaign Id`,
`Timestamp` and `Unibox Url`. There is no HTML anywhere in it, so no amount of
Zapier mapping can produce a picture from the webhook alone.

What the webhook does carry is `Email Id`. So the step asks Instantly for the
message — `GET /api/v2/emails/{id}` with a bearer token — which returns both
`body.html` and `attachment_json.files[]`. One extra call per reply, and only on
replies that get past the event and bulk checks.

Every failure there returns null on purpose. A missing key, a refused call, a
network error, anything over five seconds: the card still posts, text-only. A
step that throws posts nothing, which is worse than a card without a picture.

Five seconds is not arbitrary. Zapier kills a Code step at its plan's limit —
30 seconds on Professional and Team, but as little as 10 on lower tiers and
**1 second on Free**, where this cannot work at all. Capping the Instantly call
at five leaves room for the Chat post that follows it.

Because a swallowed failure is invisible, the step reports what happened:
`picture: "ok"`, `"failed"` or `"skipped"` in its output. A wrong API key shows
up as `failed` on every run in the Zap history instead of quietly costing every
picture.

Instantly builds attachment URLs out of the raw filename, so a photo called
`IMG 1234.jpg` arrives with a literal space in its URL. Chat cannot fetch that,
so spaces are escaped — only spaces, since re-encoding an already-escaped URL
would break it.

Two kinds of picture come back, and they are not equal:

- **An attachment** — what a person does when they reply with a photo from their
  phone. Instantly stores it and gives a URL, which the card shows inline and
  also offers as a button.
- **Hosted in the HTML** — a marketing template's images, or a logo in a
  signature.

**The attachment wins when both are present**, because an attachment is the
reply while a hosted image is usually just a signature logo. Templates also open
with a 1x1 open-tracking pixel, so anything 1 pixel wide or tall is skipped, as
is any URL that reads as a pixel, beacon, spacer or `/o/` open tracker.

A `cid:` reference with no matching attachment record cannot be shown by
anything outside the mailbox, so the card says how many are attached rather than
leaving a gap.

Two consequences worth knowing:

- When Chat renders a hosted image it is Google fetching it from the sender's
  server, which registers as an email open. The sender can see when their mail
  was read.
- Instantly serves attachments with no authentication. Checked directly: a plain
  unauthenticated GET of an `attachments.unibox.instantly.ai` URL returns 200 and
  the file. So Chat can fetch them and the inline picture renders — but it also
  means anyone holding one of those links can download the attachment, no login
  required. Posting the URL into a Chat space hands it to everyone in that space,
  which is the intent here; it is worth knowing before those links go anywhere
  else.

## Which events post

Instantly fires `auto_reply_received` for autoresponders, separately from
`reply_received`. Reading the event name is exact where matching subject lines
only guesses, so the step drops anything that is not `reply_received` and says
which event it was in the Zap history.

The subject-line check is still there behind `skipBulk`, for the autoresponders
that arrive as ordinary replies because the sender's server did not mark them.

## Bulk mail is dropped by default

`skipBulk` is on unless set to `no` in Input Data.

This was the other way round at first, on the reasoning that an agent's
newsletter is still an agent who has your address and is active. A live test
settled it. Catherine Abalos's ActivePipe newsletter arrived and posted a card
carrying forty-odd bare `[` characters, seven `[https://…/empty.gif]` fragments
and a postal address broken one line per field — six hundred characters of
flattened markup, in the space where replies from real people are supposed to be
noticed. The goal was always that a reply from a person reaches a person fast
and readably, and that nothing else does. A newsletter is nothing else.

Anyone who wants them back sets `skipBulk` to `no`.

## Flattened HTML

The plain text Instantly sends for an HTML email is the markup walked over: each
image and link becomes a `[url]` fragment and the table cells around them leave
bare brackets. Those are stripped — the bracketed URLs, image URLs from any host
at all, and any line that is nothing but brackets. Brackets inside a sentence
are left alone, because `the price [as discussed] is firm` is something a person
wrote.

It is not a substitute for dropping bulk mail; it is what keeps a genuine reply
readable when the sender's client writes HTML.
