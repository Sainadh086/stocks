import { createHash } from "node:crypto";
import { join } from "node:path";
import { store, US, type Row } from "../shared/storage.js";
export type AccountRole = "long_term" | "trading";
export const scope = (number?: string | null) =>
  createHash("sha256")
    .update(number || "local")
    .digest("hex")
    .slice(0, 20);
export const rolesFile = join(US, "account_roles.json");
export function roles(): Record<AccountRole, string | null> {
  const r = store.json<Record<AccountRole, string | null>>(rolesFile, {
    long_term: null,
    trading: null,
  });
  if (
    !r ||
    ["long_term", "trading"].some(
      (k) =>
        r[k as AccountRole] != null &&
        (typeof r[k as AccountRole] !== "string" || !r[k as AccountRole]),
    ) ||
    (r.long_term && r.long_term === r.trading)
  )
    throw new Error(
      "Saved account roles are invalid. Review Account settings.",
    );
  return { long_term: r.long_term ?? null, trading: r.trading ?? null };
}
export const eligible = (a: Row) =>
  !!a.account_number &&
  !a.deactivated &&
  !a.permanently_deactivated &&
  (a.state ?? "active") === "active";
export function saveRoles(
  long_term: string,
  trading: string,
  available: Row[],
): void {
  if (!long_term || !trading || long_term === trading)
    throw new Error("Choose different accounts for investing and trading.");
  const choices = available.filter(eligible);
  if (
    !choices.some((a) => a.account_number === long_term) ||
    !choices.some(
      (a) => a.account_number === trading && a.agentic_allowed === true,
    )
  )
    throw new Error(
      "Selected accounts are unavailable or the trading account is not Agentic eligible.",
    );
  store.save(rolesFile, {
    long_term,
    trading,
    updated_at: new Date().toISOString(),
  });
}
export function requireTrading(number: string): void {
  const r = roles();
  if (r.trading !== number || r.long_term === number)
    throw new Error(
      "Use only the saved daily trading account for intraday orders.",
    );
}
export const holdingsPath = () => {
  const number = roles().long_term;
  return number
    ? join(US, `long_term_holdings_${scope(number)}.csv`)
    : join(US, "us_holdings.csv");
};
const settingsPath = (number: string) =>
  join(US, `live_trading_settings_${scope(number)}.json`);
export function validateBudget(budget: number, reserve: number): void {
  if (
    !Number.isFinite(budget) ||
    budget <= 0 ||
    !Number.isFinite(reserve) ||
    reserve < 0 ||
    reserve > 100
  )
    throw new Error("Budget must be positive and reserve between 0% and 100%.");
}
export function settings(number?: string | null): {
  budget: number | null;
  reserve_pct: number | null;
} {
  if (!number) return { budget: null, reserve_pct: null };
  const r = store.json<Row | null>(settingsPath(number), null);
  if (!r) return { budget: null, reserve_pct: null };
  if (r.version !== 1 || r.account_number !== number)
    throw new Error("Saved live settings are invalid for this account.");
  validateBudget(r.budget, r.reserve_pct);
  return { budget: r.budget, reserve_pct: r.reserve_pct };
}
export function saveSettings(
  number: string,
  budget: number,
  reserve_pct: number,
): void {
  requireTrading(number);
  validateBudget(budget, reserve_pct);
  store.save(settingsPath(number), {
    version: 1,
    account_number: number,
    budget,
    reserve_pct,
    updated_at: new Date().toISOString(),
  });
}
export function mask(value: any, account?: string | null): any {
  if (Array.isArray(value)) return value.map((v) => mask(v, account));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        k.includes("account_number") && v
          ? "••••" + String(v).slice(-4)
          : mask(v, account),
      ]),
    );
  return typeof value === "string" && account
    ? value.replaceAll(account, "••••" + account.slice(-4))
    : value;
}
