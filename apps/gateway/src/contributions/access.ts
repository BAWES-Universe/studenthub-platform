import type { NavEntry } from "./index.js";

/** Access lane A1: "Your access", the person's own read-only list of roles. */
export const ACCESS_CONTRIBUTION = {
  navigation: [
    { key: "access", order: 250, href: "/profile/access", labelKey: "nav.access", visible: (login) => Boolean(login.access) },
  ],
  profileRows: [],
} satisfies { readonly navigation: readonly NavEntry[]; readonly profileRows: readonly [] };
