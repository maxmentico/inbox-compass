# Inbox Compass: customer-owned deployment and paid local tooling

Revised 26 October 2026. This replaces the earlier managed-hosting proposal. Inbox Compass does not host customer agents or hold customer deployment credentials. The product described here is proposed; the desktop app, licensing API and update protocol have not been implemented or tested end to end.

## Product and trust boundary

Two products:

| Component | License/distribution | Runs where | Purpose |
| --- | --- | --- | --- |
| Email Worker | Open source | Customer's Cloudflare account | Reads Gmail, creates private digests and optionally marks selected mail read |
| Deployment app | Closed source, paid convenience tooling | Customer's computer | Guides setup, provisions resources, installs approved releases, checks compatibility and offers rollback |

A small vendor-operated licensing API and release service support the deployment app. They run in the vendor's Cloudflare account and receive billing identity and minimal licensing metadata, never customer cloud tokens, Gmail grants or mail content.

Customers can deploy and maintain the public Worker themselves. Paid customers buy the installation and maintenance experience. The installed Worker keeps working if the subscription ends or the vendor disappears, subject to the customer's provider accounts and any shared OAuth application's availability.

The vendor holds no membership in customer cloud accounts and no remote administration endpoint. Cloudflare and Google still process the email to provide the service.

The local deployment app is trusted software on the customer's machine. Closed source does not make it incapable of leaking credentials. An honest claim is: “Your credentials stay on your device and in your cloud account; our service receives no mailbox content or cloud credentials.” Claiming technical impossibility of access even through malicious publisher updates requires an additional independently controlled enforcement or approval boundary.

## Architecture

~~~mermaid
flowchart LR
    U[Customer] --> D[Local deployment app]
    D -->|Customer's OAuth authorization| C[Customer's Cloudflare account]
    C --> W[Open-source email Worker and KV]
    W <-->|Gmail API| G[Customer's Gmail]
    W --> A[Cloudflare-hosted Workers AI]
    D -->|Customer login and entitlement request| L[Vendor licensing API]
    L <-->|Server-side payment API| S[Payment provider]
    D -->|Fetch signed public releases| R[Release service]
    W -->|Fetch generic update metadata| R
~~~

Cloud credentials flow between the local app and Cloudflare. Gmail credentials flow only through the selected customer-side authorization path and the customer Worker. They never flow through the licensing or release service.

Once installed, the Worker runs without the desktop app being open. Updates initiated by that desktop app require it to be running; links opened on another device need an “Update on your computer” fallback.

No language model is needed for payment checks or privileged deployment. A conversational guide can explain progress, but credential handling, URLs, resource selection and deployment actions are fixed, validated operations. Mail content and error text are never instructions for the deployment app.

## Who holds which keys

| Credential | Location and use |
| --- | --- |
| Customer Cloudflare access/refresh tokens | Local OS credential store; sent only to Cloudflare |
| Customer Worker encryption key | Generated locally and installed directly as a secret in the customer Worker; any retained recovery copy stays under customer control |
| Customer Gmail refresh tokens | Customer Worker, encrypted; a temporary local copy exists only if needed by the chosen authorization flow |
| Customer-owned Google web OAuth secret, if used | Customer's local credential store and Worker; never the vendor service |
| Deployment app device private key | Local credential store; proves possession of that installation's identity to the licensing API |
| Vendor payment API key | Vendor backend only, scoped to required operations |
| Vendor webhook verification secret | Vendor webhook receiver only |
| Vendor entitlement signing private key | Vendor backend only |
| Vendor release signing private keys | Separate protected release process; not the payment API or customer app |
| Entitlement/release verification public keys and public OAuth client IDs | Safe to distribute with the local app |

Runtime secrets cannot literally stay only on the laptop: the scheduled Worker needs its own Gmail grant and encryption key in the customer's cloud. The requirement is that neither leaves customer-controlled storage for vendor systems.

Use an OS-protected credential store, redacted local logs and no automatic upload of support bundles. Avoid command-line arguments containing tokens, cloud credentials in ordinary configuration files, production mail reads during diagnostics and cloud authorization through a vendor-controlled token proxy.

## Cloudflare login and deployment

Cloudflare documents Authorization Code with PKCE for desktop/CLI public clients, with token endpoint authentication set to none and no client secret embedded in the app. See [Cloudflare OAuth client configuration](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/).

Register a public OAuth client for the deployment app. The local app opens the system browser, creates its own PKCE verifier, receives the callback locally and exchanges the code directly with Cloudflare. Validate the exact supported callback method in a prototype; desktop PKCE support alone does not prove every custom scheme or loopback configuration works. Use only verified provider endpoints and validate state.

If a callback must pass through a vendor domain, do not put a token exchange or credential logging there. Prefer a direct local callback so even authorization codes avoid the vendor.

Grant the narrowest scopes Cloudflare actually offers. Do not assume OAuth can restrict authorization to exactly one Worker before it exists. Show the real permission scope to the customer; do not request billing administration merely to deploy. Confirm token renewal and revocation behavior.

Cloudflare account creation, terms acceptance and paid-plan activation remain customer actions. The app can guide and resume after them. The customer pays Cloudflare directly; the vendor charges separately for tooling.

[Workers Paid starts at $5/month per account](https://developers.cloudflare.com/workers/platform/pricing/). [Workers AI has a daily free allocation and separately metered paid usage](https://developers.cloudflare.com/workers-ai/platform/pricing/). The customer's other applications share their account allowances. The current README recommends Paid in practice. A constrained free-tier demo must be benchmarked before it is advertised as supported.

A fixed deployment recipe creates the customer's own Worker, KV namespace, owner configuration, schedule and self-binding. It records resource IDs locally and refuses to overwrite unrelated resources, including the existing personal production instance in this repository. Generate secrets securely rather than embedding them in recipes.

Initial setup can temporarily need permission to create resources. Investigate whether it can be reduced afterward; do not claim a resource-level permission boundary the provider cannot enforce.

## Payment verification without exposing vendor keys

The desktop app does not query private Stripe subscription data directly and cannot safely contain even a “restricted” Stripe secret API key. Only publishable keys are designed for distribution; they do not establish whether a customer has an active subscription. See [Stripe API key types](https://docs.stripe.com/keys).

Use one narrow licensing API:

1. The customer signs in to the vendor's account service through their system browser. The local app receives a device session through a public-client flow. This is a vendor-app session, not a Cloudflare or Gmail token.
2. The backend creates a hosted Checkout session with a server-selected product and price. No cloud account access is involved.
3. Signed payment webhooks update the entitlement store. Deduplicate events and reconcile current state when notifications arrive late or out of order. The browser returning from Checkout is not payment evidence.
4. Before an install or paid update, the app proves possession of its device key and requests an operation-specific entitlement.
5. The backend checks the authenticated customer's current paid/trial entitlement and returns a short-lived signed grant.
6. The app verifies the signature and claims using a bundled public key, then executes the customer's locally approved operation with their local cloud credentials.

[Stripe Entitlements](https://docs.stripe.com/billing/entitlements?dashboard-or-api=api) can map subscription products to features and notify the backend about changes. A small explicit entitlement table is also possible. Neither requires distributing payment-provider secrets to customers.

Proposed API surface:

| Route | Purpose | Must not do |
| --- | --- | --- |
| POST /checkout | Create hosted Checkout for the authenticated customer | Accept arbitrary prices or trust a caller-supplied customer ID |
| POST /webhooks/stripe | Verify Stripe event and reconcile entitlements | Receive cloud credentials or accept unsigned events |
| POST /v1/operation-grants | Issue an install/update grant to an authenticated device | Return commands, cloud tokens or deployment scripts |
| POST /billing-portal | Open that customer's billing management | Permit access to another customer's subscription |

A grant contains only issuer, audience, opaque customer/device IDs, feature, operation, approved release ID/hash, request nonce, issued-at and expiry. Bind it to proof of possession of the local device key; the app checks all relevant fields, pins permitted signature algorithms and has an explicit verification-key rotation policy. Do not treat a copied customer ID or email address as authentication.

Licensing and release signatures use different keys and audiences. An entitlement proves eligibility for tooling; it cannot authorize a different cloud account, change a release, reveal a secret or execute code.

Check payment immediately before starting each paid install/update. Use a short documented validity window; revocation is not instantaneous for already issued grants or an in-progress operation. Do not interrupt an update halfway through because the grant expires. Do not make disaster recovery or access to the existing Worker depend on a successful payment check.

A customer controls their own machine and can patch a local license check, even in a closed-source binary. This architecture protects vendor keys and the honest paid workflow; it is not unbreakable DRM. Gate vendor-hosted paid services server-side. Accept that the public Worker can always be installed manually.

## Deep-link update protocol

Proposed customer experience:

1. The Worker checks generic signed release metadata, or the local app discovers an update itself.
2. The Worker shows “An update is available” with an “Open updater” link outside email-derived content.
3. An OS app link opens the deployment app and selects a locally known installation.
4. The app independently fetches trusted release metadata, verifies it, compares installed state and displays the changes.
5. It checks payment through the licensing API.
6. The customer clicks “Install update”, unless they previously selected an explicit automatic-update policy.
7. The app deploys directly to Cloudflare, checks non-sensitive health/version endpoints and reports success or recovery options.

A conceptual link might carry an opaque installation handle and a release identifier. It contains no bearer tokens, cloud credentials, mailbox identifiers, arbitrary download URL, shell command or file path. The handle is not an authorization credential.

Treat every incoming link as untrusted, even if it appears on the customer's Worker page. Resolve the handle against local records and ignore caller-supplied destinations. Unknown or malformed links open a safe explanation, never create a new deployment target or run a command. Repeated links cannot trigger parallel updates.

Where supported, an app-associated HTTPS link offers an install/help fallback. A registered custom scheme is another routing option, with platform-specific limitations. In both cases the link opens a review screen rather than authorizing an operation. Apple's [universal-link guidance](https://developer.apple.com/documentation/xcode/supporting-universal-links-in-your-app) explicitly calls for validating parameters and limiting link-triggered actions.

The app must work if the email Worker cannot notify it: the local app also checks the release feed when opened. The Worker never holds Cloudflare deployment credentials and cannot invoke a remote shell or update itself through the vendor.

## Release and update security

Publish the open-source Worker source, pinned source revision, dependency lockfile, artifact hash and signed release metadata. Do not run arbitrary publisher-supplied shell recipes or package installation hooks inside a credential-bearing deployment process.

Build artifacts separately from deployment credentials. The fixed deployer uploads an explicitly approved, verified Worker bundle. Handle declared configuration/schema changes through typed migrations with known operations; a “migration” must not be an arbitrary remote command.

Use a maintained update-security design for signed metadata, freshness, rollback protection and signing-key rotation. [The Update Framework](https://theupdateframework.io/docs/overview/) is a candidate. A checksum fetched beside the artifact is insufficient, and a valid publisher signature does not establish that code is benign.

Ship the local app as a signed platform application. Its own update mechanism is also inside the trust boundary. Replacing only Worker-update policy while silently auto-updating the privileged desktop app would leave the same publisher-control issue.

For the initial product, use user-initiated updates: discover and prepare automatically, then install after one local confirmation. Offer unattended updates only as an explicit customer choice about trusting future releases. If preventing unilateral publisher changes is an absolute requirement, approvals or release signatures must include a party the vendor does not control. Document that no independent release reviewer exists until one actually does.

Keep the credential broker and operation runner small. It exposes fixed operations, enforces local account/resource selection, and never returns cloud tokens to a UI webview or language model. Splitting processes reduces accidental exposure; it does not by itself constrain a malicious Worker payload the customer has authorized for deployment.

Before update, record the previous code/configuration version. Preserve existing secrets. Make migrations resumable and avoid destructive migration by default. Test code rollback separately from storage rollback; reverting code cannot undo incompatible data changes. No automatic backup uploads to vendor storage.

## Google authorization: the feasibility gate for simple onboarding

The licensing problem is straightforward. Gmail integration needs a separate prototype and provider review.

Option A, compatible with today's app: customer-owned Google web OAuth application, with direct authorization on their own Worker. The local tool validates configuration and guides the customer through Google setup. This preserves the current browser sign-in/linking model, but it is not a first-install one-click experience. Repository guidance currently treats Google Cloud setup as browser-only; do not promise API automation for OAuth client provisioning.

Option B, investigate for the simpler product: an Inbox Compass desktop OAuth application using the system browser and PKCE. Google documents local loopback callbacks and treats desktop clients as public clients. The local app could receive authorization without vendor servers handling the grant. See [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app).

This does not yet establish that an issued Gmail refresh token can appropriately be provisioned into an unattended customer-owned Worker under the intended distribution model. Validate that architecture with Google, including restricted-scope verification and assessment scope. Customer ownership alone must not be assumed to exempt a commercially distributed application. See [restricted-scope requirements and exceptions](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

Option B also requires a design for ongoing browser login, mailbox linking, reauthorization and account recovery. A native OAuth callback solves initial desktop authorization, not the existing Worker's web-login callback. Do not ship a shared confidential web client secret in the desktop binary, or quietly relay Gmail tokens through the vendor to preserve the old flow.

Default to Option A for an engineering prototype. Treat Option B as a prerequisite for advertising the desired streamlined public installation. Request a provider assessment decision before building an elaborate workaround.

## User experience

### Hierarchy

The primary promise is ownership: “Your email assistant, in your own cloud account.” The first action is “Set up my assistant”. Explain before authorization that credentials stay with the customer and that cloud charges are paid directly to the provider.

The guided flow is: install/open the deployment app; sign in or start a tooling trial; connect Cloudflare in the system browser; connect Gmail through the selected supported flow; confirm “Deploy my assistant”; open the private digest. Avoid terminals, copied API tokens and cloud resource IDs in the ordinary path. Account creation, consent and provider billing prompts cannot honestly be compressed into a literal single click.

For updates, the primary element is the installed assistant and proposed version. The primary action is “Install update”; permission changes and cloud-cost effects appear before confirmation. Release details and “Do this manually” are secondary.

Follow the existing Inbox Compass type, spacing, monochrome accent and narrow-column conventions. Any update notice in the Worker must respect the current script/CSP and escaping rules; no third-party payment or analytics scripts on email pages.

### States

- First use: one setup action and a plain ownership explanation.
- Waiting for browser authorization: show which provider is open and support cancellation/resume.
- No subscription: offer Checkout; keep manual deployment and existing data accessible.
- Payment pending: wait for server confirmation; do not repeat purchases.
- Creating resources: stable progress with resumable steps and no duplicate Workers.
- Partial setup: identify the failed step and preserve completed customer resources.
- No installed deployment app: provide download/help; on a different device, say which computer is needed.
- Update review: show version, permissions and migration effects.
- Invalid link or signature: stop and explain; preserve the working version.
- Network or licensing outage: retry later, use an explicitly valid cached grant only within policy, leave the running agent alone.
- Update failure: retain the last working code or present a tested recovery path.
- Success: open the same private assistant URL; the app can be closed.
- Long names, mobile and accessibility: wrap account names, label controls, preserve visible focus and do not rely on color alone.

## Monetization and cancellation

Sell initial guided setup, an annual/monthly maintenance subscription, or a bundle. Price selection is separate from architecture. Subscription rights apply to the deployment tool, update preparation, compatibility work and support.

No payment check in the open-source email processing loop, no vendor kill switch, no forced deletion on cancellation and no vendor-hosted AI proxy. Public source and manual updates remain available.

A tooling trial is separate from the customer's Cloudflare Free/Paid plan. Make each price and renewal clear. Do not collect a cloud markup or claim consolidated cloud billing in this initial model.

## Implementation order and acceptance

1. **Local Cloudflare proof.** A minimal desktop/CLI harness completes public-client PKCE, keeps tokens local and creates a synthetic Worker plus KV in a designated test account. Verify callback support, permission scope, refresh and revocation. No vendor token exchange and no live mailbox reads.
2. **Google and login proof.** Validate the direct customer-owned flow, investigate native onboarding, get the necessary Google decision and demonstrate secure browser access/relinking. Record what is supported and what remains manual.
3. **Licensing in payment test mode.** Authenticate a device, start Checkout, reconcile verified webhooks and issue signed operation grants. Unpaid, forged, expired, wrong-device and wrong-release grants fail without exposing payment keys. Duplicate/out-of-order events converge.
4. **Resumable local deployment.** Use a typed resource plan and approved bundle. Never reuse repository personal settings. Interrupt/retry without duplication; do not overwrite unrelated resources or rotate existing encryption keys during an update.
5. **Update handoff with synthetic data.** A forged email or deep link cannot choose a command, artifact host or cloud account. App-not-installed, another-device, stale-manifest, invalid-signature and repeated-link cases are deliberate.
6. **Recovery and privacy checks.** Check every outbound path and local log for test secrets; no cloud/Gmail token enters vendor traffic or support reports. Prove known-good update/rollback and safe handling of incompatible migrations. Keep recovery available without an active subscription.
7. **Packaging and pilot.** Sign the desktop app, publish the Worker source under a chosen license, document manual recovery, and test the complete first-run flow on a fresh customer machine/account. Benchmark Free before offering a free-cloud demo. Update the personal-only privacy/terms documents before commercial signup.

No production deployment, payment integration or end-to-end privacy claim is established by this document. The first implementation slice is a local Cloudflare authorization/deployment harness and a test-mode signed entitlement flow, without adding commercial control to the current email Worker.
