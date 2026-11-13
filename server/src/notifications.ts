import webpush from "web-push";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { store, US, type Row } from "./shared/storage.js";
export interface TradingNotice {
  id: string;
  title: string;
  body: string;
  created_at: string;
}
export function permittedPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === "fcm.googleapis.com" ||
        url.hostname === "updates.push.services.mozilla.com" ||
        url.hostname === "web.push.apple.com" ||
        url.hostname.endsWith(".push.apple.com"))
    );
  } catch {
    return false;
  }
}
export class Notifications {
  private path = join(US, "web_push.json");
  private state: Row;
  private queue = Promise.resolve();
  constructor() {
    this.state = store.json<Row>(this.path, {
      subscriptions: [],
      events: [],
      outbox: [],
    });
    this.state.outbox ??= [];
  }
  private save() {
    store.save(this.path, this.state);
  }
  publicKey() {
    if (!this.state.keys) {
      this.state.keys = webpush.generateVAPIDKeys();
      this.save();
    }
    return this.state.keys.publicKey as string;
  }
  status() {
    return {
      public_key: this.publicKey(),
      devices: this.state.subscriptions.length,
      events: this.state.events.slice(-30).reverse(),
      delivery_error: this.state.delivery_error ?? null,
    };
  }
  subscribe(subscription: webpush.PushSubscription, owner: string) {
    if (
      !/^[A-Za-z0-9_=-]+$/.test(subscription.keys.p256dh) ||
      !/^[A-Za-z0-9_=-]+$/.test(subscription.keys.auth) ||
      Buffer.from(subscription.keys.p256dh, "base64url").length !== 65 ||
      Buffer.from(subscription.keys.auth, "base64url").length !== 16
    )
      throw new Error("The browser returned invalid push subscription keys.");
    if (!permittedPushEndpoint(subscription.endpoint))
      throw new Error("This browser’s push endpoint is unsupported.");
    this.publicKey();
    this.state.subscriptions = this.state.subscriptions.filter(
      (s: Row) => s.subscription.endpoint !== subscription.endpoint,
    );
    if (this.state.subscriptions.length >= 20)
      throw new Error(
        "Remove an old notification device before adding another.",
      );
    this.state.subscriptions.push({ subscription, owner });
    this.save();
  }
  unsubscribe(endpoint: string, owner: string) {
    this.state.subscriptions = this.state.subscriptions.filter(
      (s: Row) => !(s.owner === owner && s.subscription.endpoint === endpoint),
    );
    this.save();
  }
  removeOwner(owner: string) {
    this.state.subscriptions = this.state.subscriptions.filter(
      (s: Row) => s.owner !== owner,
    );
    this.save();
  }
  retainOwners(owners: string[]) {
    const retained = this.state.subscriptions.filter((s: Row) =>
      owners.includes(s.owner),
    );
    if (retained.length !== this.state.subscriptions.length) {
      this.state.subscriptions = retained;
      this.save();
    }
  }
  publish(id: string, title: string, body: string) {
    if (this.state.events.some((event: Row) => event.id === id)) return;
    const event: TradingNotice = {
      id,
      title,
      body,
      created_at: new Date().toISOString(),
    };
    this.state.events = [...this.state.events, event].slice(-200);
    this.state.outbox.push({
      event,
      endpoints: this.state.subscriptions.map(
        (s: Row) => s.subscription.endpoint,
      ),
    });
    this.save();
    this.drain();
  }
  test(owner: string) {
    if (!this.state.subscriptions.some((s: Row) => s.owner === owner))
      throw new Error(
        "Enable notifications on this device before sending a test.",
      );
    this.publicKey();
    const event = {
      id: randomUUID(),
      title: "Varshan notifications are ready",
      body: "Trading alerts can arrive even when the app is closed.",
      created_at: new Date().toISOString(),
    };
    this.state.outbox.push({
      event,
      endpoints: this.state.subscriptions
        .filter((s: Row) => s.owner === owner)
        .map((s: Row) => s.subscription.endpoint),
    });
    this.save();
    this.drain();
    return { queued: true };
  }
  start() {
    this.drain();
  }
  private drain() {
    this.queue = this.queue
      .then(async () => {
        if (!this.state.outbox.length) return;
        this.publicKey();
        for (const entry of [...this.state.outbox]) {
          if (Date.now() - Date.parse(entry.event.created_at) > 3600000) {
            this.state.outbox = this.state.outbox.filter(
              (e: Row) => e !== entry,
            );
            this.save();
            continue;
          }
          for (const endpoint of [...entry.endpoints]) {
            const saved = this.state.subscriptions.find(
              (s: Row) => s.subscription.endpoint === endpoint,
            );
            if (!saved) {
              entry.endpoints = entry.endpoints.filter(
                (e: string) => e !== endpoint,
              );
              continue;
            }
            try {
              await webpush.sendNotification(
                saved.subscription,
                JSON.stringify(entry.event),
                {
                  vapidDetails: {
                    subject: "https://varshan.local",
                    publicKey: this.state.keys.publicKey,
                    privateKey: this.state.keys.privateKey,
                  },
                  TTL: 3600,
                  timeout: 10000,
                },
              );
              entry.endpoints = entry.endpoints.filter(
                (e: string) => e !== endpoint,
              );
              this.state.delivery_error = null;
            } catch (error) {
              const status = (error as { statusCode?: number }).statusCode;
              if (status === 404 || status === 410) {
                this.state.subscriptions = this.state.subscriptions.filter(
                  (s: Row) => s.subscription.endpoint !== endpoint,
                );
                entry.endpoints = entry.endpoints.filter(
                  (e: string) => e !== endpoint,
                );
              } else {
                this.state.delivery_error =
                  "A push service could not be reached. Alerts remain in Varshan; delivery will retry.";
              }
            }
            this.save();
          }
          if (
            !entry.endpoints.length ||
            Date.now() - Date.parse(entry.event.created_at) > 3600000
          )
            this.state.outbox = this.state.outbox.filter(
              (e: Row) => e !== entry,
            );
          this.save();
        }
      })
      .catch(() => {
        /* Notification failures never interrupt trading. */
      });
  }
  retry() {
    this.drain();
  }
  async close() {
    await this.queue;
  }
}
