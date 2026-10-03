# Zapier: Instantly reply → Google Chat

Not application code. This is the body of a **Code by Zapier (JavaScript)**
step, kept here because it was written and tested against real traffic and
would otherwise live only in a Zapier editor where nobody can review it.

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

**Nothing blocked bulk mail.** `Is First` passes any first message from a
lead, and a monthly marketing newsletter is a first message. One arrived from an agent on the Oakland Realtor Campaign — an
ActivePipe/MoxiWorks blast, "Your October: bluegrass, Blue Angels, ballet" —
and was posted to Chat as a lead reply, tracking links and all.

That matters beyond the noise: Instantly stops a sequence when it detects a
reply, so a newsletter silently takes a real agent out of the campaign. And
ActivePipe is common enough among estate agents that this recurs monthly at
any useful list size.

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

**The whole body went in the card.** Instantly's `reply_text_snippet` for an
HTML newsletter is the stripped text, which is mostly tracking URLs.

## What this does

Bulk and automated mail is dropped with a reason that shows in the Zap
history, so nothing is posted and the Zap does not look broken. The card
is built with `JSON.stringify`, so escaping stops being anyone's problem. The
reply is stripped of URLs and capped at 600 characters. The button is omitted
rather than emitted broken when there is no unibox URL.

## Input Data to map

| Name | Catch Hook field |
| --- | --- |
| `leadEmail` | `lead_email` |
| `replySubject` | `reply_subject` |
| `replyText` | `reply_text_snippet` |
| `campaign` | `campaign_name` |
| `inbox` | `email_account` |
| `received` | `timestamp` |
| `uniboxUrl` | `unibox_url` |
| `chatWebhook` | the Google Chat space webhook URL, as a constant |

## Showing the picture

An image-built reply reads as a wall of tracking links in Chat while Instantly
renders it properly, so the card takes the first real picture out of the email
and shows it above the text.

**This needs the HTML body.** The text Instantly sends as
`reply_text_snippet` contains no image URLs at all — every link in it is a
`t.apemail.net/c/<token>` redirect with no file extension, so nothing in it
says which one is a picture. Map the webhook's HTML field to `replyHtml` and
the image appears; leave it unmapped and the card is text-only, with no broken
widget.

The first `<img>` is usually not the one you want. Marketing templates open
with a 1x1 open-tracking pixel, so `firstImage` skips anything 1 pixel wide or
tall, and anything whose URL reads as a pixel, beacon, spacer or `/o/` open
tracker.

One consequence worth knowing: when Chat renders that image it is Google
fetching it from the sender's server, which registers as an email open. The
sender can see when their mail was read.

## Bulk mail is let through by default

`skipBulk` is off unless set to `yes` in Input Data. An agent's newsletter is
still an agent who has your address and is active, and that is the campaign
owner's call rather than this file's.
