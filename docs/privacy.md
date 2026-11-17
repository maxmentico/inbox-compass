# Inbox Compass privacy notice template

> Self-hosters: this is a template, not legal advice. Replace every bracketed field, confirm the
> description matches your configuration, publish it at a stable public URL, and use that URL in
> your Google OAuth branding settings. The Inbox Compass maintainers do not operate your deployment.

**Operator:** [your name or organisation]

**Contact:** [your contact email]

**Effective date:** [date]

Inbox Compass is a private, single-owner tool run by the operator named above. It reads mailboxes linked
by that operator and makes a daily summary. Sign-in is refused for every Google account except the
configured owner account.

## Data accessed

Inbox Compass requests basic Google profile information to verify the owner and identify linked
mailboxes. It also requests either:

- `gmail.readonly`, to read relevant messages; or
- `gmail.modify`, to read messages and mark an item as read when the owner marks it done.

The app reads sender and recipient headers, subject, date, Gmail labels and previews, message text,
conversation context, and the mailbox's send-as addresses. It does not read contacts, calendars,
Drive files, or attachment contents. The source code does not send, delete, trash, move, label, or
forward mail.

## Use of data

Mail data is used only to create the owner's digest. Message text is sent to a model hosted on
Cloudflare Workers AI for classification, summary, and suggested action. The model has no tools and
cannot act on the mailbox. The result is shown on the owner-only page and, if the operator enables
it, emailed to the operator through Cloudflare Email Routing.

Inbox Compass has no advertising or analytics integration and does not call an external AI provider at
runtime. The operator should update this notice if they modify that behaviour.

## Storage and retention

Data is stored in the operator's Cloudflare account. Google refresh tokens are encrypted with
AES-256-GCM and kept until the mailbox is unlinked. Digest excerpts are retained for up to 60 days;
classification cache entries for up to 30 days; classification history for up to 60 days after its
last update; re-check records for up to 14 days; done records for up to 61 days; and content-free run
logs for the last 10 runs, at most 30 days. Temporary OAuth state lasts 10 minutes. The encrypted
browser session lasts 7 days.

Security-email codes and recovery links are masked before storage or AI processing. Access tokens
are held in memory and are not stored.

## Service providers

- Google supplies Gmail data through the Gmail API.
- Cloudflare provides Worker execution, storage, Workers AI, and optional email routing.

The operator does not sell Google user data or use it for advertising. Inbox Compass's use and transfer
of information received from Google APIs must comply with the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including its Limited Use requirements.

## Security and deletion

Access is limited to the configured verified owner email. Stored refresh tokens are encrypted, and
state-changing web requests have session and cross-site request protections.

Unlinking a mailbox deletes its stored token and asks Google to revoke the grant. The owner can also
revoke access at <https://myaccount.google.com/permissions>. Other stored records expire according
to the schedule above. The operator can delete their Cloudflare KV namespace to remove the
installation's stored data immediately.

Questions or deletion requests should be sent to the operator contact above.
