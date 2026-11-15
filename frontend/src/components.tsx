import { usePreferences, StockLink } from "./preferences";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Download,
  Leaf,
  Sprout,
  Search,
  X,
} from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Row } from "./types";

const columnLabels: Record<string, string> = {
  market_value_inr: "Value (₹)",
  market_value: "Market value",
  portfolio_plan: "Plan",
  plan_reason: "Rationale",
  long_term_action: "Long-term action",
  long_term_reasons: "Business review",
  return_6m_pct: "6M return (%)",
};
export const label = (value: string) =>
  columnLabels[value] ||
  value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\b(Usd|Inr|Pct)\b/g, (word) =>
      word === "Pct" ? "(%)" : word.toUpperCase(),
    );
export const num = (value: unknown) =>
  typeof value === "number"
    ? value
    : typeof value === "string" &&
        value.trim() &&
        Number.isFinite(Number(value))
      ? Number(value)
      : undefined;
export function money(value: unknown, currency = "USD") {
  const number = num(value);
  return number === undefined
    ? "—"
    : new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency,
        maximumFractionDigits: 2,
      }).format(number);
}
export function display(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number")
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(
      value,
    );
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      role={error ? "alert" : "status"}
      className={`notice ${error ? "error" : ""}`}
    >
      {children}
    </div>
  );
}
export function Failure({ error }: { error?: Error | string | null }) {
  return error ? (
    <Notice error>{typeof error === "string" ? error : error.message}</Notice>
  ) : null;
}
export function Card({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <div className="card-heading">
          <div>
            <h2>
              <Leaf
                className="forest-detail-icon"
                size={18}
                aria-hidden="true"
              />
              {title}
            </h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
export function Metric({
  title,
  value,
  detail,
  tone = "",
  privateData = true,
}: {
  privateData?: boolean;
  title: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: string;
}) {
  const { privacy } = usePreferences();
  return (
    <div className={`metric ${tone}`}>
      <span>
        <Sprout className="forest-detail-icon" size={17} aria-hidden="true" />
        {title}
      </span>
      <strong>{privacy && privateData ? "••••" : value}</strong>
      {detail && (
        <small>
          {privacy && privateData ? "Hidden in privacy mode" : detail}
        </small>
      )}
    </div>
  );
}
export function Empty({
  title = "Your workspace is ready",
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-mark">
        <ArrowUpRight size={28} />
      </div>
      <h3>{title}</h3>
      <p>
        {children ||
          "Connect an account and refresh the analysis to see your data here."}
      </p>
    </div>
  );
}
export function Table({
  rows = [],
  columns,
  name = "Holdings",
  rowActions,
}: {
  rows?: Row[];
  columns?: string[];
  name?: string;
  rowActions?: (row: Row) => ReactNode;
}) {
  const { privacy } = usePreferences();
  const safeDisplay = (value: unknown, key: string) =>
    privacy &&
    ![
      "symbol",
      "stock",
      "buy",
      "exchange",
      "action",
      "status",
      "signal",
      "portfolio_plan",
      "long_term_action",
    ].includes(key)
      ? "••••"
      : display(value);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(null);
  const [page, setPage] = useState(0);
  if (!rows.length) return <Empty title="No saved data yet" />;
  const keys =
    columns ||
    [...new Set(rows.flatMap((row) => Object.keys(row)))]
      .filter((k) => !["holdings_source", "account_number", "bars"].includes(k))
      .slice(0, 12);
  const columnClasses = Object.fromEntries(
    keys.map((key) => {
      if (
        /reason|description|strategies|message|notes|summary|quality_review|review_priority/i.test(
          key,
        )
      )
        return [key, "description"];
      const values = rows
        .map((row) => row[key])
        .filter((v) => v !== null && v !== undefined && v !== "");
      return [
        key,
        values.length && values.every((v) => num(v) !== undefined)
          ? "numeric"
          : undefined,
      ];
    }),
  );
  const filtered = rows.filter((row) =>
    keys.some((key) =>
      safeDisplay(row[key], key).toLowerCase().includes(search.toLowerCase()),
    ),
  );
  if (sort)
    filtered.sort((a, b) => {
      const x = num(a[sort.key]),
        y = num(b[sort.key]);
      const compared =
        x !== undefined && y !== undefined
          ? x - y
          : display(a[sort.key]).localeCompare(display(b[sort.key]));
      return sort.desc ? -compared : compared;
    });
  const lastPage = Math.max(0, Math.ceil(filtered.length / 25) - 1);
  const current = Math.min(page, lastPage);
  function download() {
    // Prefix formula-like cells so spreadsheet programs treat them as literal text.
    const csv = [
      keys,
      ...filtered.map((row) => keys.map((k) => display(row[k]))),
    ]
      .map((row) =>
        row
          .map((value) => {
            const safe = /^[=+@-]/.test(value) ? `'${value}` : value;
            return `"${safe.replaceAll('"', '""')}"`;
          })
          .join(","),
      )
      .join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8;" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `varshan-${name.toLowerCase().replaceAll(" ", "-")}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="table-wrap">
      <div className="table-tools">
        <label className="search">
          <Search size={16} />
          <input
            aria-label={`Search ${name}`}
            value={search}
            placeholder="Search stocks or signals"
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <span>{filtered.length} records</span>
        <button
          className="icon-button"
          disabled={privacy}
          aria-label={`Download ${name}`}
          onClick={download}
        >
          <Download size={17} />
        </button>
      </div>
      <div className="table-scroll">
        <table aria-label={name}>
          <thead>
            <tr>
              {rowActions && <th scope="col">Trade</th>}
              {keys.map((key) => (
                <th
                  key={key}
                  className={columnClasses[key]}
                  aria-sort={
                    sort?.key === key
                      ? sort.desc
                        ? "descending"
                        : "ascending"
                      : "none"
                  }
                >
                  <button
                    onClick={() =>
                      setSort({
                        key,
                        desc: sort?.key === key ? !sort.desc : false,
                      })
                    }
                  >
                    {label(key)}
                    {sort?.key === key &&
                      (sort.desc ? (
                        <ArrowDown size={12} />
                      ) : (
                        <ArrowUp size={12} />
                      ))}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(current * 25, (current + 1) * 25).map((row, i) => (
              <tr key={`${String(row.symbol || row.stock || i)}-${i}`}>
                {rowActions && <td>{rowActions(row)}</td>}
                {keys.map((key) => (
                  <td key={key} className={columnClasses[key]}>
                    {[
                      "action",
                      "long_term_action",
                      "status",
                      "signal",
                      "portfolio_plan",
                    ].includes(key) ? (
                      <Badge
                        tone={
                          /BUY|HOLD|Keep|COMPLETE|Running/.test(
                            String(row[key]),
                          )
                            ? "bullish"
                            : /EXIT|SELL|REPLACE|REJECTED/.test(
                                  String(row[key]),
                                )
                              ? "bearish"
                              : ""
                        }
                      >
                        {display(row[key])}
                      </Badge>
                    ) : ["symbol", "stock", "buy"].includes(key) && row[key] ? (
                      <StockLink
                        symbol={String(row[key])}
                        exchange={
                          row.exchange ? String(row.exchange) : undefined
                        }
                      />
                    ) : (
                      safeDisplay(row[key], key)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-footer">
        <span>
          {filtered.length ? current * 25 + 1 : 0}–
          {Math.min((current + 1) * 25, filtered.length)} of {filtered.length}
        </span>
        {lastPage > 0 && (
          <div>
            <button disabled={!current} onClick={() => setPage(current - 1)}>
              Previous
            </button>
            <button
              disabled={current === lastPage}
              onClick={() => setPage(current + 1)}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
export function Chart({
  rows,
  lines,
  title,
  privateData = true,
  timeAxis = false,
}: {
  privateData?: boolean;
  timeAxis?: boolean;
  rows: Row[];
  lines: string[];
  title: string;
}) {
  const { privacy } = usePreferences();
  if (privacy && privateData)
    return <Notice>Portfolio graph hidden in privacy mode.</Notice>;
  return (
    <div className="chart" role="img" aria-label={title}>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart
          data={rows}
          margin={{ top: 16, right: 20, bottom: 4, left: 4 }}
        >
          <CartesianGrid
            strokeDasharray="3 6"
            vertical={false}
            stroke="var(--border)"
          />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 12, fill: "var(--muted)" }}
            minTickGap={40}
            tickFormatter={(v) =>
              timeAxis
                ? new Date(String(v)).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : String(v).slice(0, 10)
            }
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            domain={["auto", "auto"]}
            tick={{ fontSize: 12, fill: "var(--muted)" }}
            axisLine={false}
            tickLine={false}
            width={45}
            tickFormatter={(value) =>
              new Intl.NumberFormat("en-US", {
                notation: "compact",
                maximumFractionDigits: 1,
              }).format(Number(value))
            }
          />
          <Tooltip />
          <Legend />
          {lines.map((key, i) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={
                [
                  "var(--accent)",
                  "#b85409",
                  "#5365b5",
                  "#a43b75",
                  "#576572",
                  "#7e6810",
                  "#1778a6",
                ][i % 7]
              }
              strokeWidth={2.4}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
export function Modal({
  className,
  title,
  children,
  onClose,
}: {
  title: string;
  className?: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      className={className}
      ref={ref}
      aria-labelledby="dialog-title"
      onCancel={onClose}
    >
      <div className="dialog-heading">
        <h2 id="dialog-title">{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
export function ConfirmDialog({
  title,
  children,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  pending: boolean;
  error?: Error | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      {children}
      <label className="check confirmation">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
        />
        I confirm that this places real orders in the displayed account.
      </label>
      <Failure error={error} />
      <div className="actions">
        <button onClick={onClose} disabled={pending}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={!acknowledged || pending}
          onClick={onConfirm}
        >
          {pending ? "Submitting…" : "Confirm real orders"}
        </button>
      </div>
    </Modal>
  );
}
