import type { NavEntry } from "./index.js";

// Work and hours W-1 to W-7: a signed-in person reaches their hours from the main
// navigation whenever the work lane is switched on (WORK_LANE_ENABLED and a signing key).
export const WORK_CONTRIBUTION = {
  navigation: [
    { key: "work", order: 260, href: "/work/track", labelKey: "nav.work", visible: (login) => Boolean((login as { readonly work?: unknown }).work) },
  ],
  profileRows: [],
} satisfies { readonly navigation: readonly NavEntry[]; readonly profileRows: readonly [] };
