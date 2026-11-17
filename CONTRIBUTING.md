# Contributing to Inbox Compass

Thanks for helping improve Inbox Compass.

## Before opening a change

- Use an issue for substantial behavior or architecture changes so the approach can be discussed first.
- Never commit Google credentials, Cloudflare tokens, `.dev.vars`, email content, production logs, KV exports, or screenshots containing private mail.
- Keep the single-owner threat model intact unless a change explicitly redesigns authentication and data isolation.
- Prefer the least Gmail permission that supports the feature. Do not add send, delete, trash, or full-mailbox behavior without an explicit security review.

## Development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Local development uses local Cloudflare storage by default. Use fake or disposable accounts and data for development.

Before opening a pull request, run:

```bash
npm run check
```

Explain user-visible changes, security or privacy impact, and the tests you added. By contributing, you agree that your contribution is licensed under the MIT License.
