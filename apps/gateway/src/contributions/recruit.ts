import type { NavEntry } from "./index.js";

// Recruit R4 and R7: a signed-in person reaches the job board and their invitations
// from the main navigation whenever the recruit area is wired.
export const RECRUIT_CONTRIBUTION = {
  navigation: [
    { key: "jobs", order: 245, href: "/recruit/jobs", labelKey: "nav.jobs", visible: (login) => Boolean((login as { readonly recruitJobs?: unknown }).recruitJobs) },
    { key: "invitations", order: 250, href: "/recruit/invitations", labelKey: "nav.invitations", visible: (login) => Boolean((login as { readonly recruitInvitations?: unknown }).recruitInvitations) },
  ],
  profileRows: [],
} satisfies { readonly navigation: readonly NavEntry[]; readonly profileRows: readonly [] };
