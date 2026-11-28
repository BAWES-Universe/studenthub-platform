/**
 * The integration register as the gateway shows it on `/platform/integrations` (release matrix
 * A-27). `deploy/coolify/integration-register.json` stays the source of truth (docs/integrations.md);
 * this copy carries only what the page shows, because the deploy file is not in the runtime image.
 * A test fails when the two drift apart. No owner card, credential name or value is carried.
 */
export type RotationState = "rotate-revoke" | "operator-check" | "db-state-unknown" | "none";
export type Disposition = "keep" | "replace" | "drop" | "pending";
export interface RegisteredIntegration {
  readonly id: string;
  readonly name: string;
  readonly rotationState: RotationState;
  readonly disposition: Disposition;
  readonly notes: string;
}

export const INTEGRATION_REGISTER: readonly RegisteredIntegration[] = Object.freeze([
  { id: "INT-01", name: "Temporary AWS S3 upload", rotationState: "rotate-revoke", disposition: "replace", notes: "Replace the temporary upload storage integration." },
  { id: "INT-02", name: "Primary AWS S3 storage", rotationState: "rotate-revoke", disposition: "replace", notes: "Replace the primary object storage integration." },
  { id: "INT-03", name: "AWS MediaConvert", rotationState: "operator-check", disposition: "pending", notes: "The inventory did not record credential names." },
  { id: "INT-04", name: "AWS Textract OCR", rotationState: "operator-check", disposition: "keep", notes: "Keep OCR subject to an operator check." },
  { id: "INT-05", name: "AWS SQS event leg", rotationState: "operator-check", disposition: "pending", notes: "The event queue disposition awaits an owner decision." },
  { id: "INT-06", name: "Cloudinary", rotationState: "operator-check", disposition: "drop", notes: "Drop the legacy media delivery integration." },
  { id: "INT-07", name: "Algolia", rotationState: "rotate-revoke", disposition: "replace", notes: "Replace the legacy search integration." },
  { id: "INT-08", name: "Auth0", rotationState: "none", disposition: "drop", notes: "Drop the superseded identity integration." },
  { id: "INT-09", name: "Google identity", rotationState: "operator-check", disposition: "drop", notes: "Drop this legacy social identity option." },
  { id: "INT-10", name: "Apple identity", rotationState: "operator-check", disposition: "drop", notes: "Drop this legacy social identity option." },
  { id: "INT-11", name: "reCAPTCHA", rotationState: "rotate-revoke", disposition: "pending", notes: "The challenge service disposition awaits an owner decision." },
  { id: "INT-12", name: "SMS gateway", rotationState: "rotate-revoke", disposition: "keep", notes: "The inventory did not record credential names." },
  { id: "INT-13", name: "OneSignal push", rotationState: "operator-check", disposition: "replace", notes: "Replace the legacy push notification integration." },
  { id: "INT-14", name: "SMTP mail transport", rotationState: "rotate-revoke", disposition: "keep", notes: "Keep mail transport with rotated credentials." },
  { id: "INT-15", name: "Ipstack geolocation", rotationState: "rotate-revoke", disposition: "pending", notes: "The geolocation service disposition awaits an owner decision." },
  { id: "INT-16", name: "Google Maps and Places", rotationState: "operator-check", disposition: "keep", notes: "Keep mapping services subject to an operator check." },
  { id: "INT-17", name: "Mixpanel", rotationState: "db-state-unknown", disposition: "pending", notes: "The inventory did not record credential names." },
  { id: "INT-18", name: "Segment", rotationState: "db-state-unknown", disposition: "pending", notes: "The inventory did not record credential names." },
  { id: "INT-19", name: "Staff-configured outbound webhooks", rotationState: "db-state-unknown", disposition: "keep", notes: "Keep staff-managed outbound webhook capability." },
  { id: "INT-20", name: "Legacy Sentry", rotationState: "rotate-revoke", disposition: "keep", notes: "Keep error reporting with rotated credentials." },
  { id: "INT-21", name: "Slack logging and reports", rotationState: "rotate-revoke", disposition: "replace", notes: "Replace the legacy messaging integration." },
  { id: "INT-22", name: "Xero", rotationState: "rotate-revoke", disposition: "drop", notes: "The inventory did not record credential names." },
  { id: "INT-23", name: "Yeastar voicemail microservice", rotationState: "rotate-revoke", disposition: "pending", notes: "The voicemail service disposition awaits an owner decision." },
  { id: "INT-24", name: "Jira", rotationState: "rotate-revoke", disposition: "drop", notes: "Drop the legacy issue tracker integration." },
  { id: "INT-25", name: "Wallet service", rotationState: "operator-check", disposition: "drop", notes: "Drop the standalone wallet service integration." },
  { id: "INT-26", name: "PDF, Excel, QR and headless-browser libraries", rotationState: "none", disposition: "keep", notes: "Keep these local document processing libraries." },
  { id: "INT-27", name: "Legacy MySQL, Redis and wallet database", rotationState: "rotate-revoke", disposition: "replace", notes: "The inventory did not record credential names." },
].map((entry) => Object.freeze(entry as RegisteredIntegration)));
