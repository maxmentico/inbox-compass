# Security policy

Inbox Compass reads private email and stores encrypted Google refresh tokens. Please do not report a vulnerability in a public issue or include real email, tokens, credentials, Worker logs, or database exports in a report.

Use [GitHub private vulnerability reporting](https://github.com/maxmentico/inbox-compass/security/advisories/new) to report a security problem. Include the affected version or commit, impact, and the smallest safe reproduction you can provide.

## Deployment responsibility

Each installation runs in its owner's Cloudflare account and uses that owner's Google OAuth client. The maintainers do not operate a shared hosted service and cannot access a self-hosted installation.

If a deployment credential may have leaked:

1. Rotate the affected Google OAuth client secret in Google Cloud.
2. Rotate `TOKEN_ENCRYPTION_KEY` only after unlinking all mailboxes; existing encrypted refresh tokens cannot be decrypted with a new key.
3. Revoke affected Google grants at <https://myaccount.google.com/permissions>.
4. Review Cloudflare account access and Worker deployment history.

Supported security fixes are made on the latest version of the `main` branch.
