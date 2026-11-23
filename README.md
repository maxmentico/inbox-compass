# Inbox Compass

[![CI](https://github.com/maxmentico/inbox-compass/actions/workflows/ci.yml/badge.svg)](https://github.com/maxmentico/inbox-compass/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A private, self-hosted Gmail triage agent. Inbox Compass reads your inboxes each morning and turns
them into one focused action list using Cloudflare Workers AI.

**[Try the live synthetic demo](https://maxmentico.github.io/inbox-compass/)** ·
**[Get started](docs/getting-started.md)** ·
[Read the technical reference](REFERENCE.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/maxmentico/inbox-compass)

## What it does

- Combines several Gmail or Google Workspace inboxes into one daily digest.
- Separates messages that need action from messages that are only informational.
- Understands direct requests, deadlines, conversation replies, Gmail labels, and sender rules.
- Lets you mark work done and optionally marks the matching Gmail message as read.
- Runs in your own Cloudflare account; there is no shared Inbox Compass service or database.

The demo uses invented mailboxes and messages. It does not connect to Gmail, call an AI model, or
make network requests.

## Start here

The **[step-by-step getting-started guide](docs/getting-started.md)** takes you from an empty
Cloudflare account to your first real digest. You will create your own Google OAuth client, deploy
the Worker, add its callback URL, and link your mailboxes.

You will need:

- a Cloudflare account (Workers Paid is recommended for normal multi-mailbox use);
- a Google account that owns the installation; and
- Node.js 20 or newer if you deploy from the command line.

## Privacy in one minute

Your mail stays between Google, your Cloudflare account, and Cloudflare Workers AI. Runtime code
does not call Anthropic or another AI provider. OAuth credentials and mailbox tokens are not stored
in this repository. AI classification can still be wrong, so treat the digest as a prioritisation
tool rather than a replacement for Gmail.

## Documentation

| Guide | Use it for |
|---|---|
| [Getting started](docs/getting-started.md) | First deployment and mailbox setup |
| [Technical reference](REFERENCE.md) | Models, triage rules, costs, operations, troubleshooting, and limitations |
| [Architecture](ARCHITECTURE.md) | Trust boundaries and system design |
| [Security policy](SECURITY.md) | Reporting a vulnerability |
| [Privacy template](docs/privacy.md) | Publishing a notice for your installation |
| [Terms template](docs/terms.md) | Publishing terms for your installation |
| [Contributing](CONTRIBUTING.md) | Local development and pull requests |

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
npm run check
```

See [Contributing](CONTRIBUTING.md) for the full development workflow.
