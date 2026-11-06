import type { NavEntry } from "./index.js";

export const PROFILE_CONTRIBUTION = {
  navigation: [
    { key: "profile", order: 100, href: "/profile", labelKey: "nav.profile", current: true, visible: () => true },
    { key: "background", order: 200, href: "/profile/background", labelKey: "nav.background", visible: () => true },
  ],
  profileRows: [],
} satisfies { readonly navigation: readonly NavEntry[]; readonly profileRows: readonly [] };
