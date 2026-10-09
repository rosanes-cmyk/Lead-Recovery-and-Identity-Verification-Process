# Zapier: Instantly reply → Google Chat

Not application code. This is the body of a **Code by Zapier (JavaScript)**
step, kept here because it was written and tested against real traffic and
would otherwise live only in a Zapier editor where nobody can review it.

Everything above the wiring marker at the bottom of the file is pure, and
`test/zapier-chat-test.mjs` runs it — 123 checks with the Instantly API stubbed,
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

**Every picture is shown, in the order the email shows them**, attachments
first: someone replying with a photo attaches it, while the hosted images are the
template around it. Duplicates drop out, so a logo repeated in every row of a
newsletter appears once. Templates also open with a 1x1 open-tracking pixel, so
anything 1 pixel wide or tall is skipped, as is any URL that reads as a pixel,
beacon, spacer or `/o/` open tracker.

A Chat card holds 100 widgets and 32 KB, so the pictures stop at thirty and the
text at 3,000 characters — a 42-image newsletter renders as 30 pictures, 38
widgets and 3.2 KB, with a line saying how many were held back. Both ceilings
are constants at the top of the file.

## Three ways to lay the pictures out

`imageLayout` in Input Data picks one. Unset, or set to anything unrecognised,
it is `grid`.

- **`grid`** — thumbnails, two columns up to four pictures and three above that,
  cropped to 4:3 so the rows line up. The shortest card that still shows
  everything at once. One trap: inside a `Grid` the URL field is **`imageUri`**,
  not the `imageUrl` every other widget uses, and the wrong one renders nothing
  without complaint.
- **`carousel`** — one picture at a time with arrows, a `carouselCards[]` entry
  each. Google documents it for Chat apps and says nothing about webhooks;
  tested against a live space, **the arrows work**. The catch is height: slides
  size to the tallest picture in the set, so a short one sits in a tall black
  box, and there is no crop setting on a plain `Image` to prevent it.
- **`stack`** — the original: full-width, one under another, folded behind
  Chat's own "Show more" past the first.

A reply with a single picture is shown plainly under all three. There is no
sense making a one-cell grid, a one-slide carousel, or collapsing one image.

## Opening a picture

An `Image` carries its own `onClick`, so tapping a picture under `carousel` or
`stack` opens that one full size in a browser.

A `Grid` cannot do this. Its single `onClick` is shared by every item — the
item's id arrives as a callback parameter, which a one-way webhook has no way to
receive — so a per-thumbnail link is impossible. The whole grid opens the thread
in Instantly instead, which is the next most useful thing, and carries no
`onClick` at all when there is no thread URL rather than a dead one.

## Keeping a long email short

Showing every picture made a monthly newsletter into a card you scroll for
half a minute. Chat can collapse its own sections, so it does: the card is in
three parts, and only the middle one folds.

- Who replied and the subject — always visible.
- The pictures — their own section, laid out as above. Under `stack` it is
  `collapsible` with `uncollapsibleWidgetsCount: 1`, so one shows and the rest
  sit behind Chat's **Show more**. `grid` and `carousel` are compact already and
  are never collapsed.
- The body, the campaign, the inbox, the timestamp and the Reply button —
  always visible. The body carries `maxLines: 6`, so a long one gets the same
  treatment from Chat without the card growing.

Nothing is dropped to achieve this. Everything is one click away, and the
things you need in order to decide whether to care — who it was, what they
wrote, and the button to answer them — never move.

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

## Bulk mail is let through by default

`skipBulk` is off unless set to `yes` in Input Data. An agent's newsletter is
still an agent who has your address and is active, and whether that is worth a
notification is the campaign owner's call rather than this file's.

It was briefly the other way round, after a newsletter posted a screenful of
flattened markup. That was the markup's fault, not the newsletter's — see below
— and changing a default nobody asked for is not the way to fix a rendering bug.

## Flattened HTML

The plain text Instantly sends for an HTML email is the markup walked over: each
image and link becomes a `[url]` fragment and the table cells around them leave
bare brackets. Those are stripped — the bracketed URLs, image URLs from any host
at all, and any line that is nothing but brackets. Brackets inside a sentence
are left alone, because `the price [as discussed] is firm` is something a person
wrote.

It is not a substitute for dropping bulk mail; it is what keeps a genuine reply
readable when the sender's client writes HTML.
