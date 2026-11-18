import type { LoginStateStore, SessionStore } from "@studenthub/login-contract";
import type { UniverseEmbedStore } from "@studenthub/db/universe";

/**
 * Durable callback-to-handoff proof for the embed login instance only.
 *
 * Built per callback request. `consume` records which OIDC state this callback
 * consumed; `sessions.put` is the login application's last step, after the
 * state consume, browser binding, token exchange, ID token, subject policy and
 * stable-id checks. Only after the session is stored does it mark the handoff
 * that owns that state `completed` (one conditional update). If that refuses or
 * throws, the new session is deleted and the callback answers rejected, so the
 * embed stays unbound. The login application turns every throw into a plain
 * rejection, so a store failure (as opposed to a refusal) is also kept in
 * `failure`; the embed callback rethrows it, and the person gets a 503, not a
 * misleading "start again". The main origin's login never
 * sees these wrappers. This gives the contract's `LoginCompletion` behaviour
 * without editing the login contract or application (held by SHU-457).
 */
export function completingStores(states: LoginStateStore, sessions: SessionStore, store: UniverseEmbedStore): {
  readonly states: LoginStateStore; readonly sessions: SessionStore; readonly failure: () => unknown;
} {
  let consumed: string | undefined;
  let completed = false;
  let failure: unknown;
  return {
    failure: () => failure,
    states: {
      put: () => Promise.reject(new Error("callback cannot start a login")),
      async consume(state) {
        if (consumed !== undefined) throw new Error("callback consumes once");
        consumed = state;
        return states.consume(state);
      },
    },
    sessions: {
      get: (id) => sessions.get(id),
      delete: (id) => sessions.delete(id),
      async put(record) {
        if (consumed === undefined || completed) throw new Error("no consumed embed state");
        completed = true;
        try {
          await sessions.put(record);
        } catch (error) {
          failure = error;
          throw error;
        }
        let ok = false;
        try {
          ok = await store.completeHandoff(consumed, record.id, record.personId);
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          // The orphaned session was never sent to any browser, so even a failed
          // cleanup leaves nothing usable; the failure is still reported.
          if (!ok) await sessions.delete(record.id).catch((error: unknown) => { failure ??= error; throw error; });
        }
        if (!ok) throw new Error("handoff refused completion");
      },
    },
  };
}
