# Open-source release checklist

Use this checklist before changing the repository visibility to public.

## Credentials and private data

- Confirm `.dev.vars`, `.env*`, credential JSON files, private keys, Worker logs, KV exports, and
  screenshots of real mail are untracked.
- Search the full Git history with a secret scanner such as Gitleaks. The source tree has been
  checked for common credential shapes, but an automated scanner in GitHub is still worthwhile.
- Review old commits for personal deployment metadata such as owner emails, Worker URLs, account
  names, and KV namespace IDs. These are not authentication secrets, but they remain visible in a
  public Git history. If that history should not be public, publish a fresh squashed repository
  instead of rewriting the working repository in place.
- Rotate any credential that was ever committed, even if the commit was later removed. Deleting a
  Git line does not revoke a secret.

## Repository settings

- Enable GitHub secret scanning and push protection.
- Enable private vulnerability reporting and point the Security tab to `SECURITY.md`.
- Require the CI workflow on pull requests to `main`.
- Confirm Dependabot alerts and security updates are enabled.
- Add a short repository description and topics such as `cloudflare-workers`, `gmail`,
  `self-hosted`, and `ai-agent`.

## Fresh-account test

Test the public instructions with a Cloudflare account, Google project, OAuth client, and Worker
name that have never been used by the maintainer's deployment:

1. Use the Deploy to Cloudflare button and confirm all required secrets are requested.
2. Confirm KV and the Durable Object are created in the new account.
3. Add the new `/callback` URL to the new Google OAuth Web client.
4. Sign in only as the configured owner, link a disposable mailbox, and run a digest.
5. Confirm another Google identity is refused.
6. Unlink the mailbox and confirm the Google grant is revoked.

Do not test the public setup by giving anyone the maintainer's Google client secret. Each
self-hoster must create their own OAuth client.
