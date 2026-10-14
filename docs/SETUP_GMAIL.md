# Gmail OAuth & API setup

Sender account: `connectaurumbespoke@gmail.com`

## 1. Google Cloud project

1. <https://console.cloud.google.com> → create project **Aurum Bespoke Outreach**.
2. **APIs & Services → Library** → enable **Gmail API**.
   (Enable **Cloud Pub/Sub API** too only if you want push notifications.)

## 2. OAuth consent screen

* User type: **External**
* App name: `Aurum Bespoke Outreach`
* Support + developer email: your Aurum Bespoke address
* App domain / privacy policy: `https://aurumbespoke.com`
* **Scopes — add exactly these three, nothing more:**
  * `https://www.googleapis.com/auth/gmail.send`
  * `https://www.googleapis.com/auth/gmail.readonly`
  * `https://www.googleapis.com/auth/userinfo.email`
* **Test users:** add `connectaurumbespoke@gmail.com`.

> You can stay in **Testing** publication status indefinitely for a single internal
> sender. The only consequence is that the refresh token expires every 7 days, so you
> must re-run "Connect Gmail" weekly. **For unattended production, submit the app for
> verification** (restricted-scope review, typically a few weeks) **or** use a Google
> Workspace account with internal publication. This is an unresolved prerequisite until
> you choose one — see `docs/ACTIVATION.md`.

`gmail.readonly` is a restricted scope. `gmail.modify` and `gmail.full` are deliberately
not requested.

## 3. OAuth client

**Credentials → Create credentials → OAuth client ID → Web application**

* Authorised redirect URI:
  `https://<your-domain>/api/oauth/gmail/callback`
  (must match `GOOGLE_REDIRECT_URI` exactly, including scheme and trailing path)

Copy the client id and secret into `.env`:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://<your-domain>/api/oauth/gmail/callback
TOKEN_ENCRYPTION_KEY=<openssl rand -hex 32>
```

`TOKEN_ENCRYPTION_KEY` is mandatory: refresh and access tokens are stored
AES-256-GCM encrypted in `oauth_accounts`. Authorisation is refused without it.

## 4. Authorise

Sign in to the dashboard → **Connect Gmail** → consent as
`connectaurumbespoke@gmail.com`.

Verify: `GET /api/health` → `checks.gmail.ok === true` and
`checks.gmail.detail` shows the sender address.

The authorized account **must** equal `settings.senderEmail`, otherwise every prospect
fails eligibility with "Authorized Gmail account does not match configured sender".

## 5. Reply monitoring

**Default: polling.** `poll_replies` runs every 2 minutes over
`in:inbox newer_than:14d` — far inside Gmail's quota for a single mailbox.

**Optional: push.** Create a Pub/Sub topic, grant
`gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role on it, then
create a **push** subscription to:

```
https://<your-domain>/api/gmail/push?token=<GMAIL_PUSH_SECRET>
```

Set `GMAIL_PUBSUB_TOPIC` and `GMAIL_PUSH_SECRET`. The endpoint rejects any request
without the exact secret, deduplicates on the Pub/Sub `messageId`, and only *enqueues a
reconciliation job* — it never trusts the payload. `watch` is renewed daily by the
`gmail_watch_renew` job (Gmail expires watches after 7 days).

Polling remains active as the durable reconciliation path even when push is enabled, so
a missed or dropped push event cannot lose a reply.

## 6. Deliverability

* Keep SPF/DKIM/DMARC as Google manages them for `gmail.com`; do not spoof a
  `From` domain you do not control.

### Your account's real sending limit

Google publishes different recipient-per-day limits for free `gmail.com` accounts and
for Workspace tiers, and applies additional undocumented throttling to new or
low-reputation senders. **This system will not assert an official number on your
behalf.**

Check the limit that actually applies to your account in Google's current Gmail/Workspace
sending-limit documentation and in the Admin console (Workspace), then set
`providerDailyLimit` in settings to that verified figure.

The adaptive controller treats it as a hard outer bound and always applies the strictest
of: `providerDailyLimit`, `budgetCeiling`, and the health-derived budget. It starts at 5
per day regardless, and grows only on clean measured metrics — see
`docs/RUNBOOK.md`. Never rotate accounts or domains to exceed a limit; if a genuine
restriction is encountered the system reduces or stops.
