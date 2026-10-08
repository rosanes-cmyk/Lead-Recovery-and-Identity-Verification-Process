# Zapier: Instantly reply → Google Chat

Not application code. This is the body of a **Code by Zapier (JavaScript)**
step, kept here because it was written and tested against real traffic and
would otherwise live only in a Zapier editor where nobody can review it.

Everything above the wiring marker at the bottom of the file is pure, and
`test/zapier-chat-test.mjs` runs it — 58 checks, `npm run test:zapier`.

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

Field names are from Instantly's published webhook schema. Confirm them against
one live delivery before trusting the mapping — point the hook at a request
inspector, send yourself a reply, and compare.

| Name | Catch Hook field | Needed for |
| --- | --- | --- |
| `eventType` | `event_type` | dropping auto-replies |
| `leadEmail` | `lead_email` | |
| `replySubject` | `reply_subject` | |
| `replyText` | `reply_text` | the full body |
| `replySnippet` | `reply_text_snippet` | fallback only |
| `replyHtml` | `reply_html` | showing a picture |
| `campaign` | `campaign_name` | |
| `inbox` | `email_account` | |
| `received` | `timestamp` | |
| `uniboxUrl` | `unibox_url` | the Reply button |
| `chatWebhook` | the Google Chat space webhook URL, as a constant | |

`reply_text` is the full body; `reply_text_snippet` is a teaser and will cut a
long reply mid-sentence. Map both — the snippet is used only when the full body
is empty.

Every field is optional in the sense that leaving it unmapped degrades rather
than breaks: no `replyHtml` means a text-only card, no `eventType` means the
event check stands aside, no `uniboxUrl` means no button.

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
renders it properly, so the card takes the first real picture out of the email
and shows it above the text. **This needs `reply_html`.** The text Instantly
sends contains no image URLs at all — every link in it is a redirect token with
no file extension, so nothing in it says which one is a picture.

There are two kinds of picture and only one can be shown:

- **Hosted on `https://`** — a marketing template's images. Chat fetches the
  URL and renders it.
- **Attached to the email** — what a person does when they reply with a photo
  from their phone. The HTML refers to it as `cid:something`, an identifier
  that only means anything inside that one message. Chat cannot fetch it, and
  neither can anything outside the mailbox.

For the second case the card says `📎 1 image — open in Instantly to see it`
rather than silently showing nothing or rendering a broken widget. That is the
honest ceiling here: a Chat card cannot display a file that only exists as an
attachment. Showing it would mean re-hosting it somewhere public first, which
is a bigger change than a notification warrants.

The first `<img>` is usually not the one you want. Marketing templates open
with a 1x1 open-tracking pixel, so the step skips anything 1 pixel wide or
tall, and anything whose URL reads as a pixel, beacon, spacer or `/o/` open
tracker.

Two consequences worth knowing:

- When Chat renders a hosted image it is Google fetching it from the sender's
  server, which registers as an email open. The sender can see when their mail
  was read.
- If the image sits behind a login, Chat gets a 403 and shows a broken widget.
  Nothing in the payload says in advance whether a URL is public.

## Which events post

Instantly fires `auto_reply_received` for autoresponders, separately from
`reply_received`. Reading the event name is exact where matching subject lines
only guesses, so the step drops anything that is not `reply_received` and says
which event it was in the Zap history.

The subject-line check is still there behind `skipBulk`, for the autoresponders
that arrive as ordinary replies because the sender's server did not mark them.

## Bulk mail is let through by default

`skipBulk` is off unless set to `yes` in Input Data. An agent's newsletter is
still an agent who has your address and is active, and that is the campaign
owner's call rather than this file's.
