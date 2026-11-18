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
 * throws, the new session is deleted and the error propagates, so the callback
 * answers rejected and the embed stays unbound. The main origin's login never
 * sees these wrappers. This gives the contract's `LoginCompletion` behaviour
 * without editing the login contract or application (held by SHU-457).
 */
export function completingStores(states: LoginStateStore, sessions: SessionStore, store: UniverseEmbedStore): {
  readonly states: LoginStateStore; readonly sessions: SessionStore;
} {
  let consumed: string | undefined;
  let completed = false;
  return {
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
        await sessions.put(record);
        let ok = false;
        try {
          ok = await store.completeHandoff(consumed, record.id, record.personId);
        } finally {
          // A failed cleanup is not hidden: it propagates (logged as a 5xx), and the
          // orphaned session was never sent to any browser, so it cannot be used.
          if (!ok) await sessions.delete(record.id);
        }
        if (!ok) throw new Error("handoff refused completion");
      },
    },
  };
}
