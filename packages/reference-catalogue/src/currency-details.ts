import type { Role } from "@studenthub/contracts";
import { CatalogueError } from "./catalogue.js";

export interface CurrencyDetails {
  readonly currencyId: string;
  readonly symbol: string;
  readonly decimalPlaces: number;
  readonly updatedAt: string;
}

export function normalizeCurrencyDetails(value: unknown): Omit<CurrencyDetails, "currencyId" | "updatedAt"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CatalogueError("invalid_currency_details", 400);
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort();
  if (keys.join(",") !== "decimalPlaces,symbol") throw new CatalogueError("invalid_currency_details", 400);
  if (typeof raw.symbol !== "string") throw new CatalogueError("invalid_currency_symbol", 400);
  const symbol = raw.symbol.normalize("NFKC").trim();
  if ([...symbol].length < 1 || [...symbol].length > 8 || /[\p{Cc}\p{Cf}]/u.test(symbol)) throw new CatalogueError("invalid_currency_symbol", 400);
  const decimalPlaces = raw.decimalPlaces;
  if (!Number.isInteger(decimalPlaces) || (decimalPlaces as number) < 0 || (decimalPlaces as number) > 4) throw new CatalogueError("invalid_currency_decimal_places", 400);
  return Object.freeze({ symbol, decimalPlaces: decimalPlaces as number });
}

export function canWriteCurrencyDetails(role: Role): boolean {
  return role === "admin";
}
