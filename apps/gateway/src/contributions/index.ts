import type { ProfileCopyKey, ProfileLanguage } from "../ui/profile-copy.js";
import type { BrowserLoginApplication } from "../web-ui.js";
import { ORGANIZATIONS_CONTRIBUTION } from "./organizations.js";
import { PROFILE_CONTRIBUTION } from "./profile.js";

export interface NavEntry {
  readonly key: string;
  readonly order: number;
  readonly href: string;
  readonly labelKey: ProfileCopyKey;
  readonly current?: boolean;
  visible(login: Partial<BrowserLoginApplication>): boolean;
}

export interface ProfileRowContribution {
  readonly key: string;
  readonly section: "work" | "personal" | "background" | "details";
  readonly order: number;
  render(language: ProfileLanguage, copy: (key: ProfileCopyKey) => string): string;
}

export interface Contributions {
  readonly navigation: readonly NavEntry[];
  readonly profileRows: readonly ProfileRowContribution[];
}

export function mergeContributions(inputs: readonly Contributions[]): Contributions {
  const sort = <T extends { readonly key: string; readonly order: number }>(values: readonly T[]): readonly T[] =>
    [...values].sort((left, right) => left.order - right.order || left.key.localeCompare(right.key));
  const navigation = sort(inputs.flatMap(input => input.navigation));
  const profileRows = sort(inputs.flatMap(input => input.profileRows));
  const keys = [...navigation, ...profileRows].map(value => value.key);
  if (new Set(keys).size !== keys.length) throw new Error("duplicate contribution key");
  return { navigation, profileRows };
}

export const CONTRIBUTIONS = mergeContributions([PROFILE_CONTRIBUTION, ORGANIZATIONS_CONTRIBUTION]);
