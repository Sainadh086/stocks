import { useQuery } from "@tanstack/react-query";

export function ApiHealth() {
  const health = useQuery({
    queryKey: ["api-health"],
    queryFn: async () => {
      const response = await fetch("/api/health", {
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      });
      const data = await response.json();
      if (!response.ok || data?.status !== "ok" || data?.app !== "varshan")
        throw new Error("API is not reporting healthy.");
      return Date.now();
    },
    retry: false,
    staleTime: 0,
    refetchInterval: 5000,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    // The local API can remain available without an internet connection.
    networkMode: "always",
  });
  const state = health.isError
    ? "offline"
    : health.data !== undefined
      ? "online"
      : "checking";
  const checked =
    health.data === undefined
      ? ""
      : ` Last successful response: ${new Date(health.data).toLocaleTimeString()}.`;
  return (
    <span
      className={`api-health ${state}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={`API health: ${state}`}
      title={`Application API ${state}. Checks every 5 seconds with a 3-second timeout.${checked} Broker connections are checked separately.`}
    >
      <span className="status-dot" aria-hidden="true" />
      API {state === "checking" ? "checking…" : state}
    </span>
  );
}
