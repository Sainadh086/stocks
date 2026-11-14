import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Job } from "./types";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: Infinity,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
});
let token = "";
let bootstrap: Promise<void> | null = null;
export async function initialize() {
  bootstrap ??= fetch("/api/bootstrap")
    .then(async (response) => {
      if (!response.ok)
        throw new Error("Could not connect to the local backend.");
      token = ((await response.json()) as { token: string }).token;
    })
    .catch((error) => {
      bootstrap = null;
      throw error;
    });
  return bootstrap;
}
export async function request<T>(path: string, body?: unknown): Promise<T> {
  if (body !== undefined) await initialize();
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    headers:
      body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-Varshan-Token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const detail = (data as { detail?: unknown }).detail;
    throw new Error(
      typeof detail === "string"
        ? detail
        : "Check the entered values and try again.",
    );
  }
  return data as T;
}
export async function runJob<T>(path: string, body: unknown = {}): Promise<T> {
  let job = await request<Job<T>>(path, body);
  while (job.status === "queued" || job.status === "running") {
    await new Promise((resolve) => setTimeout(resolve, 700));
    job = await request<Job<T>>(`/jobs/${job.id}`);
  }
  if (job.status === "failed")
    throw new Error(job.error || "The operation could not complete.");
  return job.result;
}
export function useData<T>(
  key: string | string[],
  path: string,
  interval?: UseQueryOptions<T>["refetchInterval"],
  enabled = true,
) {
  return useQuery({
    queryKey: typeof key === "string" ? [key] : key,
    queryFn: () => request<T>(path),
    refetchInterval: interval,
    enabled,
  });
}
export function useAction<T, V = void>(
  operation: (variables: V) => Promise<T>,
  keys = [
    "portfolios",
    "accounts",
    "live",
    "india-trading",
    "paper",
    "comparisons",
    "weekly",
    "kite-batches",
    "gems-plan",
    "learning",
  ],
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: operation,
    onSuccess: () => {
      for (const key of keys)
        void client.invalidateQueries({ queryKey: [key] });
    },
  });
}
export function useStream(watchLive: boolean) {
  const [connection, setConnection] = useState("");
  const watch = useRef(watchLive);
  watch.current = watchLive;
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    async function connect() {
      try {
        await initialize();
        if (disposed) return;
        socket = new WebSocket(
          `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/stream`,
        );
        socket.onopen = () => {
          socket?.send(JSON.stringify({ token }));
          heartbeat = setInterval(() => {
            if (socket?.readyState === WebSocket.OPEN)
              socket.send(
                JSON.stringify({ type: "heartbeat", live: watch.current }),
              );
          }, 5000);
        };
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as {
            type: string;
            connection?: string;
            topics?: string[];
          };
          if (message.type === "connected")
            setConnection(message.connection || "");
          if (message.type === "update")
            for (const key of message.topics || [])
              void queryClient.invalidateQueries({ queryKey: [key] });
        };
        socket.onclose = () => {
          bootstrap = null;
          setConnection("");
          clearInterval(heartbeat);
          if (!disposed) timer = setTimeout(connect, 3000);
        };
        socket.onerror = () => socket?.close();
      } catch {
        if (!disposed) timer = setTimeout(connect, 3000);
      }
    }
    void connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      socket?.close();
    };
  }, []);
  return connection;
}
