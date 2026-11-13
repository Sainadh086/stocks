import type { Theme } from "./themes";
export type Row = Record<string, unknown>;
export type Role = "India" | "long_term" | "trading";
export type Strategy = "momentum" | "weekend_style" | "naked_style";
export interface Job<T = unknown> {
  id: string;
  kind: string;
  status: "queued" | "running" | "completed" | "failed";
  result: T;
  error: string | null;
}
export interface Accounts {
  error?: string;
  roles: Record<
    "long_term" | "trading",
    { selected: boolean; ending: string | null; scope?: string }
  >;
  kite_connected: boolean;
  live_settings: { budget: number | null; reserve_pct: number | null };
}
export interface AccountOption {
  id: string;
  label: string;
  agentic_allowed: boolean;
  long_term: boolean;
  trading: boolean;
}
export interface Region {
  scope?: string;
  holdings: Row[];
  error?: string;
  as_of?: string;
  ranked?: Row[];
  replacements?: Row[];
  plan?: Row[];
  history?: Row[];
  weekly?: string;
  report?: Row[];
  report_current?: boolean;
  review?: Row[];
  picks?: Row[];
  gems?: Row[];
}
export interface Portfolios {
  india: Region;
  us: Region;
}
export interface Market {
  code: string;
  name: string;
  benchmark: string;
  theme: string;
  phase: string;
  pending: boolean;
  error?: string;
  report: {
    price?: number;
    change_pct?: number;
    distance_pct?: number;
    date?: string;
    source?: string;
    generated_at?: string;
  };
  history: Row[];
  education_url: string;
  reflection: { opening: string; closing: string };
}
export interface Comparison {
  scope?: string;
  benchmark: string;
  benchmarks?: string[];
  insights?: {
    portfolio: Row;
    comparisons: Row[];
    stocks: Row[];
    candidates?: Row[];
    effective_positions: number;
    top_three_weight_pct: number;
    weighted_stock_volatility_pct: number | null;
    diversification_reduction_pct: number | null;
    start_date: string;
    end_date: string;
    methodology: string;
  };
  role: Role;
  period: string;
  updated_at: string;
  curve: Row[];
  sources: Row[];
  holdings_changed?: boolean;
}
export interface Batch extends Row {
  id: string;
  automatic?: boolean;
  status: string;
  ticket_ids?: string[];
  orders?: Row[];
  results?: Row[];
  error?: string;
  progress?: string;
}
export interface Live {
  monitor?: {
    stage: string;
    message: string;
    last_check: string | null;
    signal_time: string | null;
    signal_fresh: boolean;
    candidates: number;
    watchlist?: Row[];
    scan: { phase: string; completed: number; total: number } | null;
    rl: string;
    orders: Row[];
    total: number;
    filled: number;
    pending: number;
    unsent: number;
    batch_status: string | null;
  };
  equity_history?: Row[];
  decision_history?: Row[];
  scope?: string;
  snapshot: {
    positions: Row[];
    portfolio: Row;
    orders: Row[];
    quotes: Record<string, Row>;
    updated_at: string;
  } | null;
  model: {
    actions: Row[];
    message?: string;
    shortlist?: Row[];
    buying_power?: number;
    target_usd?: number;
    allocation_slots?: number;
    sizing_mode?: string;
    deployable_budget?: number;
  } | null;
  error?: string;
  auto: {
    enabled: boolean;
    error?: string;
    background?: boolean;
    remembered?: boolean;
    expires_at?: string | null;
  };
  batch: Batch | null;
  tickets: Row[];
}
export interface Paper {
  shortlist?: Row[];
  decisions?: Row[];
  status: "Running" | "Paused" | "Ended";
  budget: number;
  reserve_pct: number;
  cash: number;
  realized_pnl: number;
  positions: Record<string, Row>;
  fills: Row[];
  equity_history?: Row[];
  closed_trades?: Row[];
  message: string;
  last_check: string | null;
}
export interface IndiaPlan {
  view: Row[];
  choices: Row[];
  selected: string[];
  exits: string[];
  holdings: Row[];
  assessment: {
    decision: string;
    reasons: string[];
    next_review: string | null;
  };
}
export interface KiteDraft {
  id: string;
  rows: Row[];
}

export interface Preferences {
  privacy_mode?: boolean;
  chart_provider?: "yahoo" | "tradingview";
  chart_view?: "external" | "embedded";
  theme?: Theme;
  supported_themes?: Theme[];
  top_benchmarks: string[];
  catalog: { name: string; ticker: string; region: "India" | "US" }[];
}
export interface Headline {
  title: string;
  url: string;
  publisher: string;
  published_at: string;
  symbol?: string | null;
}
export interface WeeklyEvents {
  scope?: string;
  role: Role;
  from: string;
  to: string;
  generated_at: string;
  holdings_changed?: boolean;
  summary: string;
  markets: {
    region: string;
    summary: string;
    price_source: string | null;
    headlines: Headline[];
    error?: string | null;
  }[];
  holdings: {
    symbol: string;
    weekly_price_change_pct: number | null;
    news_summary?: string;
    start_date: string | null;
    end_date: string | null;
    source: string | null;
    headlines: Headline[];
    error?: string | null;
  }[];
}
