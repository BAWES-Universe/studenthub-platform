/**
 * Access lane: whether a person's current email address is verified (migration 0410).
 *
 * The fact is per principal and address: a row in principal_email_verifications
 * says what the issuer (or, at cutover, legacy) said about that address. It
 * applies only while the address is the principal's current one, so readers
 * compare it with principals.email through principal_email_key (migration 0658): spaces
 * trimmed, plain printable ASCII only, then A-Z lowered, independent of the database locale.
 * An address outside that form has no key and never reads as verified.
 */

/**
 * SQL that is true when the principal `p` (an SQL expression for a principal id)
 * has a current address that is recorded as verified. False for no address, an
 * address recorded as not verified, and an address nothing was recorded for.
 */
export const emailVerifiedSql = (p: string): string =>
  `EXISTS (SELECT 1 FROM principal_email_verifications pev JOIN principals pevp ON pevp.id = pev.principal_id`
  + ` WHERE pev.principal_id = ${p} AND pev.verified AND pev.email = principal_email_key(pevp.email))`;
