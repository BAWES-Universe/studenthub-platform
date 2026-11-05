/** Isolated acceptance fixture. No control is reachable over HTTP.
 * Normal profile and language traffic use the exact runtime composition. Explicit
 * faults use the exported editor/language service and real PostgreSQL stores.
 * Documents use the actual lifecycle and
 * a new private synthetic FileDocumentStore; only its failure boundary is injected.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import pg from 'pg';
import { createOrganization, createPrincipal } from '@studenthub/contracts';
import { PostgresAuthzStore, PostgresLoginStore, PostgresPersonProfileStore, PostgresSafeWriteStore, runMigrations, readLiveLoginSessionPerson, safeWritePrincipalRef } from '@studenthub/db';
import { InMemoryApprovedProfileAdapter, SYNTHETIC_PROFILE_FIXTURES, createPersonImportedFallbackReader } from '@studenthub/profile';
import { createBrowserWriteTokens, BROWSER_WRITE_LIFETIME_MS } from '@studenthub/safe-write-contract';
import { createRuntimeLoginFromEnv } from '../../dist/apps/gateway/src/login-runtime.js';
import { createGatewayServer } from '../../dist/apps/gateway/src/index.js';
import { createCandidateDocuments } from '../../dist/apps/gateway/src/candidate-documents-runtime.js';
import { FileDocumentStore } from '../../dist/packages/private-documents/src/index.js';
import { createIdempotencyKey } from '../../dist/packages/idempotency-contract/src/index.js';
import { png } from '../../packages/private-documents/test/candidate-fixtures.mjs';
import { createProfileBrowserEdit } from '../../dist/apps/gateway/src/profile-browser-edit-http.js';
import { createLanguagePreference } from '../../dist/apps/gateway/src/language-preference.js';

export async function createFixture({
  databaseUrl = process.env.BROWSER_ACCEPTANCE_DATABASE_URL,
  certPath = process.env.BROWSER_ACCEPTANCE_TLS_CERT,
  keyPath = process.env.BROWSER_ACCEPTANCE_TLS_KEY,
  sourceRevision = process.env.BROWSER_ACCEPTANCE_SOURCE_REVISION,
} = {}) {
  assert(databaseUrl && certPath && keyPath, 'Disposable database and trusted TLS certificate/key paths required');
  const dbURL = new URL(databaseUrl);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(dbURL.hostname), 'Acceptance database must be loopback only');
  const cleanups = [];
  let closing;
  const close = () => closing ??= (async () => {
    const results = await Promise.allSettled(cleanups.reverse().map(cleanup => Promise.resolve().then(cleanup)));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Fixture cleanup failed');
  })();
  const admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
  cleanups.push(() => admin.end());
  try {
  const version = (await admin.query('SHOW server_version_num')).rows[0].server_version_num;
  assert(Number(version) >= 170000 && Number(version) < 180000, 'PostgreSQL 17 is required');
  const schema = `browser_acceptance_${randomBytes(10).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  dbURL.searchParams.set('options', `-c search_path=${schema}`);
  const connectionString = dbURL.href;
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 10000 });
  cleanups.push(() => pool.end());
  // @studenthub/db resolves packages/db/dist/migrate.js, whose sibling source
  // migrations directory exists. Never use root dist/packages/db/src/migrate.js.
  await runMigrations(pool);
  await pool.query(`CREATE TABLE acceptance_profile_writes (principal_id text NOT NULL);
    CREATE FUNCTION acceptance_count_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO acceptance_profile_writes(principal_id) VALUES(NEW.principal_id); RETURN NEW; END $$;
    CREATE TRIGGER acceptance_count_profile_write AFTER INSERT OR UPDATE ON person_profiles
    FOR EACH ROW EXECUTE FUNCTION acceptance_count_write()`);
  // Separate trigger-backed counts: preference writes are not profile writes.
  // These records participate in the real transaction, including its rollback.
  await pool.query(`CREATE TABLE acceptance_language_writes (principal_id text NOT NULL);
    CREATE FUNCTION acceptance_count_language_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO acceptance_language_writes(principal_id) VALUES(NEW.principal_id); RETURN NEW; END $$;
    CREATE TRIGGER acceptance_count_language_write AFTER INSERT OR UPDATE ON person_preferences
    FOR EACH ROW EXECUTE FUNCTION acceptance_count_language_write()`);
  const authz = new PostgresAuthzStore(pool), sessions = new PostgresLoginStore(pool);
  const actorAdapters = new Map(), actors = new Map();
  // A new private throwaway store only. Never discover or open configured data.
  const documentTemp = await mkdtemp(join(tmpdir(), 'studenthub-browser-documents-'));
  cleanups.push(() => rm(documentTemp, { recursive: true, force: true }));
  const documentRoot = join(documentTemp, 'private');
  const documentDisk = await FileDocumentStore.create(documentRoot);
  assert.equal((await lstat(documentRoot)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(documentRoot, 'state.json'))).mode & 0o777, 0o600);
  const documentOrg = `synthetic-documents-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id: documentOrg, name: 'Synthetic document acceptance' }));
  let documentStoreFailure = false, documentStoreCalls = 0;
  const documents = createCandidateDocuments({ authz, sessions: sessions.sessions,
    origin: 'https://localhost', orgId: documentOrg, signingKey: randomBytes(32),
    store: { transaction(fn) {
      documentStoreCalls++;
      if (documentStoreFailure) throw new Error('synthetic-document-store-private-sentinel');
      return documentDisk.transaction(fn);
    } },
  });

  const approvedProfiles = {
    async resolveLink(id) { return actorAdapters.get(id)?.resolveLink(id) ?? { kind: 'missing' }; },
    async readCandidate(ref) { for (const adapter of actorAdapters.values()) { const row = await adapter.readCandidate(ref); if (row) return row; } },
  };
  const secret = randomBytes(32);
  const countries = { KW: randomUUID(), BH: randomUUID() };
  for (const [code, id] of Object.entries(countries)) {
    await pool.query(`INSERT INTO catalogue_items(id,catalogue_type,name,normalized_name,code,status,created_by_ref,updated_by_ref,created_at,updated_at)
      VALUES($1,'country',$2,$3,$4,'active',$5,$5,clock_timestamp(),clock_timestamp())`,
    [id, code === 'KW' ? 'Kuwait' : 'Bahrain', code === 'KW' ? 'kuwait' : 'bahrain', code, 'a'.repeat(64)]);
  }
  let gateway, runtime, dropResponse = null, faultArmed = false;
  const evidence = { transportResponsesDropped: 0, transportSaveRequestsObserved: 0, commitBoundaryThrows: 0, nearExpiryIssuances: 0 };
  const server = createServer({ cert: await readFile(certPath), key: await readFile(keyPath) }, (req, res) => {
    if (dropResponse && req.method === 'POST' && /^\/profile\/edit\/[^/]+\/save$/.test(req.url ?? '')) {
      const transportFault = dropResponse;
      evidence.transportSaveRequestsObserved++;
      const writeHead = res.writeHead.bind(res), end = res.end.bind(res);
      let dropped = false;
      res.writeHead = function(status, ...args) {
        if (status === 303 && dropResponse === transportFault) {
          // Chromium may transparently retransmit after losing a response on a
          // reused connection. Persistent mode drops those real successful
          // responses too, until the runner observes failure and restores.
          if (!transportFault.untilRestored) dropResponse = null;
          dropped = true; evidence.transportResponsesDropped++;
          res.destroy(); return res;
        }
        return writeHead(status, ...args);
      };
      res.end = function(...args) { return dropped ? res : end(...args); };
    }
    gateway.emit('request', req, res);
  });
  cleanups.push(async () => { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, 'localhost', resolve); });
  const baseURL = `https://localhost:${server.address().port}`;
  const env = {
    DATABASE_URL: connectionString, SAFE_WRITE_SIGNING_KEY: secret.toString('base64'),
    OIDC_ISSUER: 'https://synthetic-provider.invalid', OIDC_CLIENT_ID: 'synthetic-browser-acceptance',
    OIDC_CLIENT_SECRET: 'synthetic-unused-not-a-provider-credential',
    OIDC_CALLBACK_URL: `${baseURL}/login/callback`, LOGIN_ALLOWED_RETURN_URLS: `${baseURL}/profile`,
    OIDC_AUTHORIZATION_URL: 'https://synthetic-provider.invalid/authorize',
    OIDC_TOKEN_URL: 'https://synthetic-provider.invalid/token', OIDC_JWKS_URL: 'https://synthetic-provider.invalid/jwks',
  };
  runtime = createRuntimeLoginFromEnv(env, approvedProfiles);
  assert(runtime, 'Complete runtime must be constructed');
  cleanups.push(() => runtime.close());
  const application = runtime.application, normalEditor = application.browserEdit;
  const normalPreferences = application.preferences;
  let languageOverride = false;
  gateway = createGatewayServer(undefined, undefined, undefined, application, sourceRevision ?? null);
  const tokens = createBrowserWriteTokens({ activeKeyVersion: 'profile-browser-key-v1', keys: { 'profile-browser-key-v1': secret } });
  const fallback = createPersonImportedFallbackReader({ source: approvedProfiles });
  const faultPool = new Proxy(pool, { get(target, key) {
    if (key === 'connect') return async () => {
      const client = await target.connect(); let wroteReceipt = false;
      return new Proxy(client, { get(c, k) {
        if (k === 'query') return async (...args) => {
          const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
          const result = await c.query(...args);
          if (/INSERT INTO authorization_mutation_audit/.test(sql ?? '')) wroteReceipt = true;
          if (sql === 'COMMIT' && wroteReceipt && faultArmed) {
            faultArmed = false; evidence.commitBoundaryThrows++;
            // Database has committed. Only the real client boundary fails.
            throw new Error('Synthetic lost COMMIT acknowledgement');
          }
          return result;
        };
        const value = Reflect.get(c, k); return typeof value === 'function' ? value.bind(c) : value;
      } });
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  function composeEditor({ nearExpiryMs } = {}) {
    const store = new PostgresPersonProfileStore({ pool: faultPool });
    const issuance = nearExpiryMs === undefined ? tokens : { ...tokens, issue(binding, baseline, now) {
      evidence.nearExpiryIssuances++;
      // Real production signer, unchanged five-minute validity, explicitly
      // disclosed near-expiry issuance. Verification uses real database time.
      return tokens.issue(binding, baseline, new Date(now.getTime() - BROWSER_WRITE_LIFETIME_MS + nearExpiryMs));
    } };
    return createProfileBrowserEdit({ secret, secure: true, choices: () => store.readOriginChoices(),
      async authorize(session) {
        if (!session) return null;
        const id = await readLiveLoginSessionPerson(pool, session);
        if (!id || !await authz.getPrincipal(id)) return null;
        const own = await application.web.profiles.readOwn({ requesterPrincipalId: id, targetPersonId: id });
        const canEdit = async field => {
          if (field !== 'kuwaitiMother') return true;
          if (own.kind !== 'found' || own.profile.fields.nationality.state !== 'available') return false;
          const idValue = own.profile.fields.nationality.editValue;
          const { countries: choices } = await store.readOriginChoices();
          return choices.some(c => c.id === idValue && c.code !== 'KW') && !choices.some(c => c.id === idValue && c.code === 'KW') && await store.originValueAvailable(id, field, 'true');
        };
        const language = own.kind === 'found' && own.profile.fields.language.state === 'available' && own.profile.fields.language.value === 'ar' ? 'ar' : 'en';
        return { actorRef: safeWritePrincipalRef(id), language, store: {
          ...store.forBrowserSession({ principalId: id, sessionToken: session, tokens: issuance,
            normalizationVersion: 'profile-browser-normalization-v1', sessionLiveness: { read: readLiveLoginSessionPerson }, importedFallback: fallback }),
          canEdit,
          async validate(field, value) {
            if (field === 'kuwaitiMother' && !await canEdit(field)) return 'choice';
            if (field === 'phone' || field === 'handle') return value !== '' && !await store.contactValueAvailable(id, field, value) ? 'contact_unavailable' : null;
            if (['nationality', 'university', 'kuwaitiMother'].includes(field)) return await store.originValueAvailable(id, field, value) ? null : 'choice';
            return null;
          },
        } };
      },
    });
  }
  function overrideLanguagePreferences(preferences) {
    assert(!languageOverride, 'Restore the previous language hook first');
    languageOverride = true;
    application.preferences = preferences;
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      application.preferences = normalPreferences;
      languageOverride = false;
    };
  }
  return {
    baseURL, countries, evidence,
    useLanguageFault(mode) {
      assert(['preview-read', 'confirm-before-commit', 'confirm-after-commit'].includes(mode), 'Unknown language fault mode');
      const faultEvidence = { previewReadThrows: 0, beforeCommitThrows: 0, afterCommitThrows: 0,
        rollbacks: 0, commits: 0, preferenceWriteStatements: 0, receiptInsertStatements: 0 };
      let armed = true;
      const languageFaultPool = new Proxy(pool, { get(target, key) {
        if (key === 'query') return async (...args) => {
          const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
          // Only this store's language read fails. Session/profile reads use
          // their unchanged production pools, so the intended boundary is hit.
          if (armed && mode === 'preview-read' && /^SELECT language FROM person_preferences WHERE principal_id = \$1$/.test(sql ?? '')) {
            armed = false; faultEvidence.previewReadThrows++;
            throw new Error('Synthetic language preference read failure');
          }
          return target.query(...args);
        };
        if (key === 'connect') return async () => {
          const client = await target.connect();
          let wroteReceipt = false;
          return new Proxy(client, { get(c, k) {
            if (k === 'query') return async (...args) => {
              const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
              if (sql === 'COMMIT' && wroteReceipt && armed && mode === 'confirm-before-commit') {
                armed = false; faultEvidence.beforeCommitThrows++;
                // Both real writes ran, but COMMIT did not: the production
                // store's catch must roll back preference, receipt and counter.
                throw new Error('Synthetic language COMMIT dependency failure');
              }
              const result = await c.query(...args);
              if (/^(?:INSERT INTO|UPDATE) person_preferences\b/.test(sql ?? '')) faultEvidence.preferenceWriteStatements++;
              if (/INSERT INTO authorization_mutation_audit/.test(sql ?? '')) {
                wroteReceipt = true; faultEvidence.receiptInsertStatements++;
              }
              if (sql === 'ROLLBACK') faultEvidence.rollbacks++;
              if (sql === 'COMMIT') faultEvidence.commits++;
              if (sql === 'COMMIT' && wroteReceipt && armed && mode === 'confirm-after-commit') {
                armed = false; faultEvidence.afterCommitThrows++;
                // COMMIT really succeeded. The application receives an actual
                // dependency exception and must report its honest unknown outcome.
                throw new Error('Synthetic lost language COMMIT acknowledgement');
              }
              return result;
            };
            const value = Reflect.get(c, k); return typeof value === 'function' ? value.bind(c) : value;
          } });
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const restorePreferences = overrideLanguagePreferences(createLanguagePreference({
        sessions: sessions.sessions, store: new PostgresSafeWriteStore({ pool: languageFaultPool }), secret,
      }));
      return { evidence: faultEvidence, restore() { armed = false; restorePreferences(); } };
    },
    useLanguageExpiredTokens() {
      // Language safe-write's unchanged production default is five minutes.
      // This fixture backdates just the first issuance clock read so the authentic
      // token is already expired. Verification immediately returns to real time;
      // no waiting, changed lifetime, fabricated token or signature is involved.
      const languageLifetimeMs = 5 * 60 * 1000;
      const expiryEvidence = { issuances: 0 };
      const clock = { now() {
        const now = new Date();
        if (expiryEvidence.issuances === 0) {
          expiryEvidence.issuances++;
          return new Date(now.getTime() - languageLifetimeMs - 1000);
        }
        return now;
      } };
      const restore = overrideLanguagePreferences(createLanguagePreference({
        sessions: sessions.sessions, store: new PostgresSafeWriteStore({ pool }), secret, clock,
      }));
      return { evidence: expiryEvidence, restore };
    },
    useDocuments({ configured = true, failStore = false } = {}) {
      documentStoreFailure = failStore;
      gateway = createGatewayServer(undefined, undefined, undefined, application, sourceRevision ?? null, undefined, configured ? documents : undefined);
      return () => {
        documentStoreFailure = false;
        gateway = createGatewayServer(undefined, undefined, undefined, application, sourceRevision ?? null);
      };
    },
    documentStoreCalls() { return documentStoreCalls; },
    async finalizeSyntheticPhoto(actor) {
      assert(actors.has(actor.id), 'Unknown synthetic actor');
      const session = actors.get(actor.id).session, bytes = png();
      const authorized = await documents.authorizeUpload(session, createIdempotencyKey(new Date()), {
        type: 'personal-photo', mime: 'image/png', size: bytes.length, expectedVersion: null,
      });
      assert.equal(authorized.status, 201, 'Real synthetic upload authorized');
      const ticket = authorized.body;
      const uploaded = await documents.put(session, createIdempotencyKey(new Date()), ticket.uploadId, ticket.objectKey, ticket.credential, bytes);
      assert.equal(uploaded.status, 204, 'Real synthetic bytes validated');
      const finalized = await documents.finalize(session, createIdempotencyKey(new Date()), { uploadId: ticket.uploadId });
      assert.equal(finalized.status, 200, 'Real synthetic document finalized');
      return { ...finalized.body.metadata };
    },
    async seedActor({ language = 'en', sparse = false, nationality = 'KW', longValues = false } = {}) {
      assert(['en', 'ar'].includes(language)); assert(nationality === null || ['KW', 'BH'].includes(nationality));
      const id = `acceptance-${randomUUID()}`, candidateRef = `synthetic-${randomUUID()}`, session = randomBytes(32).toString('base64url');
      await authz.registerPrincipal(createPrincipal({ id, email: `${id}@example.invalid`, pbuuids: [candidateRef] }));
      const row = { ...(sparse ? SYNTHETIC_PROFILE_FIXTURES.unavailable : SYNTHETIC_PROFILE_FIXTURES.populated), candidate_language_pref: language };
      if (longValues) { row.candidate_intro = `Synthetic ${'LongUnbrokenWord'.repeat(120)}`; row.candidate_name = `Noor ${'Longname'.repeat(20)}`; }
      if (sparse) { row.candidate_name = 'Synthetic Sparse'; row.candidate_name_ar = null; }
      actorAdapters.set(id, new InMemoryApprovedProfileAdapter({ links: [{ principalId: id, candidateRef }], rows: new Map([[candidateRef, row]]) }));
      await pool.query('INSERT INTO person_preferences(principal_id,language) VALUES($1,$2)', [id, language]);
      if (nationality !== null && !sparse) await pool.query('INSERT INTO person_profiles(principal_id,nationality_id,nationality_id_written_at) VALUES($1,$2,clock_timestamp())', [id, countries[nationality]]);
      await sessions.sessions.put({ id: session, personId: id });
      const baselineWrites = Number((await pool.query('SELECT count(*) AS n FROM acceptance_profile_writes WHERE principal_id=$1', [id])).rows[0].n);
      const actor = { id, language, cookie: { name: '__Host-studenthub_session', value: session, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' } };
      const baselineLanguageWrites = Number((await pool.query('SELECT count(*) AS n FROM acceptance_language_writes WHERE principal_id=$1', [id])).rows[0].n);
      actors.set(id, { session, baselineWrites, baselineLanguageWrites }); return actor;
    },
    async inspect(actor) {
      assert(actors.has(actor.id), 'Unknown synthetic actor');
      const row = (await pool.query('SELECT * FROM person_profiles WHERE principal_id=$1', [actor.id])).rows[0] ?? {};
      const receiptCount = Number((await pool.query("SELECT count(*) AS n FROM authorization_mutation_audit WHERE operation='profile.safe_write' AND target_principal_ref=$1", [safeWritePrincipalRef(actor.id)])).rows[0].n);
      const writeCount = Number((await pool.query('SELECT count(*) AS n FROM acceptance_profile_writes WHERE principal_id=$1', [actor.id])).rows[0].n) - actors.get(actor.id).baselineWrites;
      return { receiptCount, writeCount, values: { displayName: row.display_name ?? null, arabicName: row.arabic_name ?? null, objective: row.objective ?? null,
        intro: row.introduction ?? null, preferredTime: row.preferred_time ?? null, gender: row.gender ?? null, birthDate: row.birth_date ?? null,
        drivingLicence: row.driving_licence ?? null, jobSearchStatus: row.job_search_status ?? null, phone: row.phone ?? null,
        handle: row.profile_handle ?? null, nationality: row.nationality_id ?? null, university: row.university_id ?? null, kuwaitiMother: row.kuwaiti_mother ?? null } };
    },
    async capturePhoneReceipt(actor) {
      assert(actors.has(actor.id), 'Unknown synthetic actor');
      const principalRef = safeWritePrincipalRef(actor.id);
      const readReceipts = async () => (await pool.query(`SELECT request_ref, after_summary
        FROM authorization_mutation_audit WHERE operation='profile.safe_write' AND target_principal_ref=$1
        AND after_summary->'fields'='["phone"]'::jsonb`, [principalRef])).rows;
      const original = await readReceipts();
      assert.equal(original.length, 1, 'Exactly one original phone receipt is required');
      // Identity and content stay inside this closure. Only equality may enter
      // evidence; no receipt references, tokens or payload digests are exposed.
      const snapshot = JSON.stringify(original[0]);
      return async () => {
        const current = await readReceipts();
        return current.length === 1 && JSON.stringify(current[0]) === snapshot;
      };
    },
    async inspectLanguage(actor) {
      assert(actors.has(actor.id), 'Unknown synthetic actor');
      const row = (await pool.query('SELECT language, updated_at FROM person_preferences WHERE principal_id=$1', [actor.id])).rows[0];
      const receipts = (await pool.query(`SELECT after_summary->'fields' AS fields,
        after_summary->>'contractVersion' AS contract_version, after_summary->>'committedAt' AS committed_at
        FROM authorization_mutation_audit WHERE operation='profile.safe_write' AND target_principal_ref=$1
        AND after_summary->'fields'='["language"]'::jsonb ORDER BY after_summary->>'committedAt' DESC`,
      [safeWritePrincipalRef(actor.id)])).rows;
      const writeCount = Number((await pool.query('SELECT count(*) AS n FROM acceptance_language_writes WHERE principal_id=$1', [actor.id])).rows[0].n) - actors.get(actor.id).baselineLanguageWrites;
      const latest = receipts[0];
      // Deliberately omit all principal, token, record and receipt references.
      return { language: row?.language ?? null, updatedAt: row?.updated_at?.toISOString() ?? null,
        writeCount, receiptCount: receipts.length,
        lastReceipt: latest ? { fields: latest.fields, contractVersion: latest.contract_version, committedAt: latest.committed_at } : null };
    },
    async revoke(actor) {
      assert(actors.has(actor.id), 'Unknown synthetic actor');
      const session = actors.get(actor.id).session;
      assert.equal(await readLiveLoginSessionPerson(pool, session), actor.id, 'Session must be live before revocation');
      await sessions.sessions.delete(session);
      const hash = createHash('sha256').update(session).digest('base64url');
      assert.equal((await pool.query('SELECT 1 FROM login_sessions WHERE id=$1', [hash])).rowCount, 0, 'Session row must be absent after revocation');
    },
    async expire(actor) {
      assert(actors.has(actor.id), 'Unknown synthetic actor');
      const session = actors.get(actor.id).session;
      assert.equal(await readLiveLoginSessionPerson(pool, session), actor.id, 'Session must be live before expiration');
      const hash = createHash('sha256').update(session).digest('base64url');
      const result = await pool.query("UPDATE login_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [hash]);
      assert.equal(result.rowCount, 1, 'Expiration must affect exactly one session');
      assert.equal(await readLiveLoginSessionPerson(pool, session), undefined, 'Expired session must fail live-session read');
    },
    armTransportLoss({ untilRestored = false } = {}) {
      assert(!dropResponse, 'Transport fault already armed');
      assert.equal(typeof untilRestored, 'boolean');
      const fault = { untilRestored };
      dropResponse = fault;
      return () => { if (dropResponse === fault) dropResponse = null; };
    },
    useCommitBoundaryFault() { faultArmed = true; application.browserEdit = composeEditor(); return () => { faultArmed = false; application.browserEdit = normalEditor; }; },
    useNearExpiryTokens({ remainingMs = 1000 } = {}) { assert(remainingMs > 0 && remainingMs < BROWSER_WRITE_LIFETIME_MS); application.browserEdit = composeEditor({ nearExpiryMs: remainingMs }); return { remainingMs, restore() { application.browserEdit = normalEditor; } }; },
    close,
  };
  } catch (error) {
    // Setup failures never strand a pool/server and leave the runner hanging.
    await close().catch(() => undefined);
    throw error;
  }
}
export default createFixture;
