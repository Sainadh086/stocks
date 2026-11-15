import { join } from "node:path";
import { INDIA, store, type Row } from "../shared/storage.js";
import { scope } from "./accounts.js";

export const brokerIds = ["kite", "upstox", "groww"] as const;
export type IndiaBroker = (typeof brokerIds)[number];
export const indiaTradingFile = join(INDIA, "live_intraday_trading.json");
export function selectedBroker(): IndiaBroker | null {
  const saved = store.json<Row>(indiaTradingFile, {});
  return saved.broker_selected === true && brokerIds.includes(saved.broker)
    ? saved.broker
    : null;
}
export function requireBroker(): IndiaBroker {
  const broker = selectedBroker();
  if (!broker)
    throw new Error(
      "Choose your India broker account in Account settings first. This account is used for trading and long-term investments.",
    );
  return broker;
}
export function investmentScope(
  broker: IndiaBroker | null = selectedBroker(),
): string | null {
  if (!broker) return null;
  const user =
    broker === "kite"
      ? store.json<Row>(join(INDIA, "kite_access_token.json"), {}).user
      : store.json<Row>(join(INDIA, "trading_broker_sessions.json"), {})[broker]
          ?.user;
  return user ? scope(broker + ":" + user) : null;
}
export const investmentDir = () =>
  join(INDIA, "accounts", investmentScope() ?? "unselected");
