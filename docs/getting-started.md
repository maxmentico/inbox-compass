# Getting started: check your first inbox

This guide takes a new self-hoster from an empty Cloudflare account to their first Inbox Compass
digest. Expect about 20–30 minutes. You do not need credentials from the Inbox Compass maintainer:
every installation has its own Google OAuth client, secrets, storage, and Worker.

## What you need

- A Cloudflare account. Workers Paid is recommended for regular use, especially with several
  mailboxes.
- A Google account that will own the installation.
- Node.js 20 or newer and Git.

The Deploy to Cloudflare button and the command-line route create the same application. The
command-line route below is the easiest one to troubleshoot and to keep developing afterward.

## 1. Download Inbox Compass

```bash
git clone https://github.com/maxmentico/inbox-compass.git
cd inbox-compass
npm install
cp .dev.vars.example .dev.vars
```

`.dev.vars` is ignored by Git. Never commit or share it.

## 2. Create your Google OAuth app

1. Open the Google Cloud console and create a project.
2. Enable the **Gmail API** for that project.
3. Open **Google Auth Platform → Branding**. Set an app name and support email. Add privacy and
   terms pages that you control; the repository includes [privacy](privacy.md) and
   [terms](terms.md) templates.
4. Under **Audience**, choose **External** if you will connect Google accounts from different
   Workspace organisations. Choose **Internal** only when every account belongs to your one
   Workspace organisation.
5. Under **Data access**, add `openid`, `userinfo.email`, `userinfo.profile`, and `gmail.modify`.
6. Publish the app to **In production**. In Google's Testing mode, refresh tokens can expire after
   seven days.
7. Under **Clients**, create an **OAuth client ID** of type **Web application**. Copy its client ID
   and client secret. You will add its redirect URL after the Worker exists.

This Google client belongs only to you. Other self-hosters make their own, and your client secret
must never be put in this repository.

## 3. Fill in your private settings

Generate a new encryption key:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Open `.dev.vars` and replace all four example values:

```dotenv
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret
TOKEN_ENCRYPTION_KEY=the-random-value-you-just-generated
OWNER_EMAIL=you@example.com
```

`OWNER_EMAIL` is the Google identity allowed to open your Inbox Compass page. Keep the encryption key
safe: changing it later makes existing linked-mailbox tokens unreadable.

## 4. Deploy your Worker

```bash
npx wrangler login
npx wrangler deploy --secrets-file .dev.vars
```

Wrangler opens Cloudflare sign-in, deploys the Worker, and provisions its KV and Durable Object.
Copy the final URL, which looks like:

```text
https://inbox-digest.YOUR-SUBDOMAIN.workers.dev
```

## 5. Finish the Google callback

Return to the Google OAuth Web client from step 2. Add this exact **Authorized redirect URI**,
using the Worker URL that Wrangler printed:

```text
https://inbox-digest.YOUR-SUBDOMAIN.workers.dev/callback
```

Do not add a trailing slash. Google compares this value exactly.

## 6. Check your first inbox

1. Open the Worker URL.
2. Sign in as the exact `OWNER_EMAIL` from `.dev.vars`.
3. Under **Mailboxes**, enter a short name such as `personal`, then choose **Link mailbox**.
4. Select the Gmail account, approve access, and return to Inbox Compass.
5. Choose **Run now** and keep the progress page open until it finishes.

The first run checks the last three days of mail. A successful run opens a digest with **To
action**, **Possible phishing**, and **For information** sections. Later, the checked-in schedule
runs every day at 06:30 UTC. You can choose **Run now** whenever you want another check.

## Continue developing and deploying

Use the same checkout and the same `.dev.vars` file:

```bash
npm run dev       # local Worker at http://localhost:8788
npm run check     # type-check and run the test suite
npm run deploy    # deploy code; existing Cloudflare secrets and data remain in place
```

For local Google sign-in, also add `http://localhost:8788/callback` to the OAuth client's
Authorized redirect URIs. `npm run deploy` does not upload `.dev.vars`; that is intentional. The
secrets uploaded in step 4 remain attached to the Worker until you replace them.

Never rotate `TOKEN_ENCRYPTION_KEY` on an existing installation unless you intend to unlink and
re-link every mailbox.

## Common setup problems

- **`redirect_uri_mismatch`:** copy the deployed Worker URL exactly and append `/callback`; check
  the scheme, hostname, and absence of a trailing slash.
- **Google access stops after seven days:** publish the OAuth app to **In production**, then re-link
  the mailbox.
- **Blocked by your administrator:** a Google Workspace administrator must trust your OAuth client
  under **Security → Access and data control → API controls**.
- **The digest is empty:** the first run searches only the last three days and, by default, only
  mail matching `in:inbox`. Confirm the linked Gmail inbox contains recent mail.
- **Only local sign-in fails:** add `http://localhost:8788/callback` as another authorized redirect
  URI; do not replace the deployed callback.

