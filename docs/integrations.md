# Third-party integrations

The JSON file at `deploy/coolify/integration-register.json` is the source of truth. A pending disposition means the owner has not decided, so it blocks both connecting that integration and retiring the legacy service tracked by SHU-122.

| ID | Integration | Owner | Rotation state | Disposition |
| --- | --- | --- | --- | --- |
| INT-01 | Temporary AWS S3 upload | SHU-134 | rotate-revoke | replace |
| INT-02 | Primary AWS S3 storage | SHU-145 | rotate-revoke | replace |
| INT-03 | AWS MediaConvert | SHU-123 | operator-check | pending |
| INT-04 | AWS Textract OCR | SHU-145 | operator-check | keep |
| INT-05 | AWS SQS event leg | SHU-199 | operator-check | pending |
| INT-06 | Cloudinary | SHU-145 | operator-check | drop |
| INT-07 | Algolia | SHU-127 | rotate-revoke | replace |
| INT-08 | Auth0 | SHU-124 | none | drop |
| INT-09 | Google identity | SHU-124 | operator-check | drop |
| INT-10 | Apple identity | SHU-124 | operator-check | drop |
| INT-11 | reCAPTCHA | SHU-124 | rotate-revoke | pending |
| INT-12 | SMS gateway | SHU-189 | rotate-revoke | keep |
| INT-13 | OneSignal push | SHU-188 | operator-check | replace |
| INT-14 | SMTP mail transport | SHU-189 | rotate-revoke | keep |
| INT-15 | Ipstack geolocation | SHU-199 | rotate-revoke | pending |
| INT-16 | Google Maps and Places | SHU-199 | operator-check | keep |
| INT-17 | Mixpanel | SHU-199 | db-state-unknown | pending |
| INT-18 | Segment | SHU-199 | db-state-unknown | pending |
| INT-19 | Staff-configured outbound webhooks | SHU-190 | db-state-unknown | keep |
| INT-20 | Legacy Sentry | SHU-90 | rotate-revoke | keep |
| INT-21 | Slack logging and reports | SHU-198 | rotate-revoke | replace |
| INT-22 | Xero | SHU-213 | rotate-revoke | drop |
| INT-23 | Yeastar voicemail microservice | SHU-129 | rotate-revoke | pending |
| INT-24 | Jira | SHU-213 | rotate-revoke | drop |
| INT-25 | Wallet service | SHU-213 | operator-check | drop |
| INT-26 | PDF, Excel, QR and headless-browser libraries | SHU-196 | none | keep |
| INT-27 | Legacy MySQL, Redis and wallet database | SHU-97 | rotate-revoke | replace |
