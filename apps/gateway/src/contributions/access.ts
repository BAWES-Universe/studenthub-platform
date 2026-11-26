import type { NavEntry } from "./index.js";

/**
 * Access lane A1: "Your access", the person's own read-only list of roles.
 * U-03: "Account", the person's own sign-in sessions and sign out everywhere.
 */
export const ACCESS_CONTRIBUTION = {
  navigation: [
    { key: "access", order: 250, href: "/profile/access", labelKey: "nav.access", visible: (login) => Boolean(login.access) },
    { key: "account", order: 310, href: "/account", labelKey: "nav.account", visible: (login) => Boolean(login.access?.account) },
  ],
  profileRows: [],
} satisfies { readonly navigation: readonly NavEntry[]; readonly profileRows: readonly [] };
