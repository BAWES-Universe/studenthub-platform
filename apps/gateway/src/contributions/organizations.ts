import type { NavEntry } from "./index.js";

export const ORGANIZATIONS_CONTRIBUTION = {
  navigation: [
    { key: "workspaces", order: 300, href: "/workspace", labelKey: "nav.workspaces", visible: (login) => Boolean(login.navigation) },
  ],
  profileRows: [],
} satisfies { readonly navigation: readonly NavEntry[]; readonly profileRows: readonly [] };
