import type { NavEntry } from "./index.js";

// A person's own reports and pay: their statistics (legacy candidate `Statistic` list), their
// pay history, their bank details, their experience certificates and their ID card. Each link
// shows only where the route that serves it is wired: the reports routes through the comms wiring
// (`staffMessages`, set by login-runtime), pay history through the billing area, bank details
// through the profile wiring.
interface PersonRoutes {
  readonly payHistory?: unknown;
  readonly bankDetails?: unknown;
  readonly staffMessages?: { readonly idCards?: { readonly candidateStatistics?: unknown; readonly certificates?: unknown } };
}
const routes = (login: unknown) => login as PersonRoutes;

export const PERSON_CONTRIBUTION = {
  navigation: [
    { key: "statistics", order: 320, href: "/profile/statistics", labelKey: "nav.statistics", visible: (login) => Boolean(routes(login).staffMessages?.idCards?.candidateStatistics) },
    { key: "pay", order: 325, href: "/pay", labelKey: "nav.pay", visible: (login) => Boolean(routes(login).payHistory) },
    { key: "bank", order: 327, href: "/profile/bank", labelKey: "nav.bank", visible: (login) => Boolean(routes(login).bankDetails) },
    { key: "certificates", order: 330, href: "/profile/certificates", labelKey: "nav.certificates", visible: (login) => Boolean(routes(login).staffMessages?.idCards?.certificates) },
    { key: "idCard", order: 335, href: "/profile/id-card", labelKey: "nav.idCard", visible: (login) => Boolean(routes(login).staffMessages?.idCards) },
  ],
  profileRows: [],
} satisfies { readonly navigation: readonly NavEntry[]; readonly profileRows: readonly [] };
