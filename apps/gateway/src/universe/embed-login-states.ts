import type { LoginState, LoginStateStore } from "@studenthub/login-contract";
import type { UniverseEmbedStore } from "@studenthub/db/universe";

/**
 * Request-scoped state store for one connect. It carries the exact handoff id
 * it was built for (no shared "current handoff"). `put` first attaches the new
 * OIDC state to that handoff with one conditional update, and refuses (so
 * `start` fails and no authorization request is issued) when the handoff was
 * superseded, expired, completed or already bound to a state meanwhile.
 */
export function handoffBoundStates(base: LoginStateStore, store: UniverseEmbedStore, handoffId: string): LoginStateStore {
  let used = false;
  return {
    async put(record: LoginState) {
      if (used) throw new Error("handoff state store is single-use");
      used = true;
      if (!await store.attachState(handoffId, record.state)) throw new Error("handoff is no longer current");
      await base.put(record);
      // A newer connect may have superseded this handoff while the state was written.
      if (!await store.handoffCurrent(handoffId)) throw new Error("handoff is no longer current");
    },
    consume: (state) => base.consume(state),
  };
}
