# Secret rotation runbook

## Purpose

Rotate or retire credentials for every entry in `deploy/coolify/integration-register.json` without exposing values.

## When to use

Use for scheduled rotation, suspected credential compromise, ownership change, or an integration disposition change.

## Who does it

The integration owner coordinates the change; platform-on-call observes service health and the incident commander coordinates urgent compromise response.

## Before you start (checks)

1. Open `deploy/coolify/integration-register.json` and confirm the integration ID, owner card, rotation state, disposition, and credential names.
2. For gateway deployment settings, compare names with `deploy/coolify/deployment-env-manifest.json`; never copy a value into a ticket, terminal history, or this repository.
3. Confirm an on-call primary and backup in [on-call](on-call.md), and define a synthetic verification.

## Steps

1. Open the provider credential screen and create or select the replacement using only the registered names below.
2. In the approved deployment configuration screen, replace each named credential atomically where supported.
3. Trigger the existing deployment path and perform the integration's synthetic verification.
4. In the provider credential screen, revoke the previous credential only after verification; for `operator-check`, `db-state-unknown`, or `none`, stop and obtain the owner decision described below.
5. Record only integration ID, credential name, role, time, outcome, and revocation state.

### INT-01 — Temporary AWS S3 upload
Owner card: SHU-134. State: rotate-revoke; disposition: replace. Rotate `temporaryBucketResourceManager.key` and `temporaryBucketResourceManager.secret`, verify a synthetic temporary upload, then revoke the prior pair.

### INT-02 — Primary AWS S3 storage
Owner card: SHU-145. State: rotate-revoke; disposition: replace. Rotate `resourceManager.key` and `resourceManager.secret`, verify synthetic object storage, then revoke the prior pair.

### INT-03 — AWS MediaConvert
Owner card: SHU-123. State: operator-check; disposition: pending. No credential name is registered; stop and have the owner inventory the provider screen before any change.

### INT-04 — AWS Textract OCR
Owner card: SHU-145. State: operator-check; disposition: keep. Check `AWS_TEXTRACT_ACCESS_KEY_ID` and `AWS_TEXTRACT_SECRET_ACCESS_KEY` with the owner, rotate only after approval, and verify synthetic OCR.

### INT-05 — AWS SQS event leg
Owner card: SHU-199. State: operator-check; disposition: pending. Check `eventManager.sqsKey` and `eventManager.sqsSecret`, obtain the disposition decision, and verify a synthetic queue event before revocation.

### INT-06 — Cloudinary
Owner card: SHU-145. State: operator-check; disposition: drop. Check `CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET`; remove the integration only after the owner confirms no required traffic.

### INT-07 — Algolia
Owner card: SHU-127. State: rotate-revoke; disposition: replace. Rotate `algolia.appId` and `algolia.apiKey`, verify synthetic search, then revoke the prior credential.

### INT-08 — Auth0
Owner card: SHU-124. State: none; disposition: drop. No credential name is registered; confirm the replacement is authoritative, then remove the integration without inventing a credential name.

### INT-09 — Google identity
Owner card: SHU-124. State: operator-check; disposition: drop. No credential name is registered; inventory the provider screen and confirm no required login path before removal.

### INT-10 — Apple identity
Owner card: SHU-124. State: operator-check; disposition: drop. No credential name is registered; inventory the provider screen and confirm no required login path before removal.

### INT-11 — reCAPTCHA
Owner card: SHU-124. State: rotate-revoke; disposition: pending. Rotate `reCaptcha.secretKey`, verify a synthetic challenge, then revoke the prior credential after the disposition decision.

### INT-12 — SMS gateway
Owner card: SHU-189. State: rotate-revoke; disposition: keep. No credential name is registered; stop and inventory it before rotating or revoking anything.

### INT-13 — OneSignal push
Owner card: SHU-188. State: operator-check; disposition: replace. Check `oneSignalCandidateAPIKey`, verify synthetic push delivery through the replacement, then follow the owner decision.

### INT-14 — SMTP mail transport
Owner card: SHU-189. State: rotate-revoke; disposition: keep. Rotate `MAIL_USERNAME` and `MAIL_PASSWORD`, verify synthetic mail delivery, then revoke the prior credential.

### INT-15 — Ipstack geolocation
Owner card: SHU-199. State: rotate-revoke; disposition: pending. Rotate `ipstack.accessKey`, verify a synthetic lookup, then revoke the prior credential after the disposition decision.

### INT-16 — Google Maps and Places
Owner card: SHU-199. State: operator-check; disposition: keep. Check `GOOGLE_MAPS_API_KEY` with the owner and verify a synthetic map lookup after an approved rotation.

### INT-17 — Mixpanel
Owner card: SHU-199. State: db-state-unknown; disposition: pending. No credential name is registered; inventory stored state and obtain a disposition decision before changing anything.

### INT-18 — Segment
Owner card: SHU-199. State: db-state-unknown; disposition: pending. No credential name is registered; inventory stored state and obtain a disposition decision before changing anything.

### INT-19 — Staff-configured outbound webhooks
Owner card: SHU-190. State: db-state-unknown; disposition: keep. No credential name is registered; inventory stored configuration and verify a synthetic delivery before any rotation.

### INT-20 — Legacy Sentry
Owner card: SHU-90. State: rotate-revoke; disposition: keep. Rotate `SENTRY_DSN`, verify approved error reporting without private data, then revoke the prior credential.

### INT-21 — Slack logging and reports
Owner card: SHU-198. State: rotate-revoke; disposition: replace. Rotate `slack.url`, verify a synthetic report through the replacement, then revoke the prior credential.

### INT-22 — Xero
Owner card: SHU-213. State: rotate-revoke; disposition: drop. No credential name is registered; inventory it first, then revoke only after removal is verified.

### INT-23 — Yeastar voicemail microservice
Owner card: SHU-129. State: rotate-revoke; disposition: pending. Rotate `microserviceApiKey`, verify a synthetic request, then revoke the prior credential after the disposition decision.

### INT-24 — Jira
Owner card: SHU-213. State: rotate-revoke; disposition: drop. Rotate or retire `jira.email` and `jira.apiToken`; verify removal before revoking the prior credential.

### INT-25 — Wallet service
Owner card: SHU-213. State: operator-check; disposition: drop. Check `walletManager.apiKey` and confirm no required traffic before removal.

### INT-26 — PDF, Excel, QR and headless-browser libraries
Owner card: SHU-196. State: none; disposition: keep. No credential is expected; verify local synthetic document processing and make no provider change.

### INT-27 — Legacy MySQL, Redis and wallet database
Owner card: SHU-97. State: rotate-revoke; disposition: replace. No credential name is registered; inventory it before replacement and revoke only after synthetic verification.

## How to verify

Verify the synthetic operation, deployment health, and absence of new alerts. Confirm the old credential is revoked when the registered state is rotate-revoke.

## If it goes wrong

Restore the last known working deployment configuration through the approved screen, keep the prior credential active if it has not been revoked, and open [incident](incident.md). If compromise is suspected, do not restore the suspected credential.

## Related

`deploy/coolify/integration-register.json`, `deploy/coolify/deployment-env-manifest.json`, [deploy](deploy.md), and [incident](incident.md).
