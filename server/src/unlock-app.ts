import Fastify from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Vault } from "./vault.js";
import { errorMessage } from "./shared/storage.js";

export function createUnlockApp(vault: Vault, unlocked: () => void) {
  const app = Fastify({ logger: false, bodyLimit: 8192 });
  const token = randomBytes(32).toString("hex");
  let busy = false,
    failures = 0,
    retryAt = 0,
    complete = false;
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host ?? "";
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(host.replace(/:\d+$/, ""))
    )
      return reply.code(400).send({ detail: "Use the local Varshan address." });
    if (
      request.headers["sec-fetch-site"] === "cross-site" ||
      (request.headers.origin && request.headers.origin !== `http://${host}`)
    )
      return reply.code(403).send({ detail: "Open Varshan on this computer." });
    if (
      request.method === "POST" &&
      request.headers["x-varshan-token"] !== token
    )
      return reply.code(403).send({ detail: "Reload Varshan and try again." });
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'nonce-${token}'; style-src 'nonce-${token}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      );
    return payload;
  });
  app.setErrorHandler((error, _request, reply) => {
    reply.code(400).send({
      detail:
        error instanceof z.ZodError
          ? error.issues.map((issue) => issue.message).join(" ")
          : errorMessage(error),
    });
  });
  app.get("/api/health", () => ({
    status: "ok",
    app: "varshan",
    locked: true,
  }));
  app.get("/api/vault/status", () => ({
    configured: vault.configured(),
    token,
  }));
  app.post("/api/vault/open", async (request, reply) => {
    if (busy || Date.now() < retryAt)
      return reply
        .code(429)
        .send({ detail: "Wait a moment before trying again." });
    if (complete)
      return reply
        .code(409)
        .send({ detail: "Varshan is starting. Reload shortly." });
    const value = z
      .strictObject({
        password: z.string().max(1024),
        confirmation: z.string().max(1024).optional(),
      })
      .parse(request.body);
    busy = true;
    try {
      if (vault.configured()) await vault.unlock(value.password);
      else await vault.setup(value.password, value.confirmation ?? "");
      complete = true;
      // Hand over the port only after the success response has reached the browser.
      reply.raw.once("finish", unlocked);
      return { unlocked: true };
    } catch (error) {
      failures++;
      retryAt =
        Date.now() + Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5));
      throw error;
    } finally {
      busy = false;
    }
  });
  app.get("/", (_request, reply) =>
    reply.type("text/html").send(unlockPage(vault.configured(), token)),
  );
  app.setNotFoundHandler((_request, reply) =>
    reply.code(423).send({
      detail: "Unlock Varshan on the desktop before opening the workspace.",
    }),
  );
  return app;
}

function unlockPage(configured: boolean, token: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unlock Varshan</title>
<style nonce="${token}">*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f4f1;color:#252b3c;font:16px/1.6 system-ui,sans-serif;padding:24px}main{width:100%;max-width:460px;padding:40px;background:white;border:1px solid #e7e3dd;border-radius:24px;box-shadow:0 20px 70px #252b3c0c}.logo{display:grid;place-items:center;width:52px;height:52px;background:#f8791d;border-radius:15px;color:white;font-size:32px;font-weight:800}h1{font-size:28px;line-height:1.2;margin:24px 0 12px}p{color:#626878}label{display:block;margin-top:18px;font-weight:600}input{width:100%;border:1px solid #b8bbc4;border-radius:10px;padding:12px;font:inherit;margin-top:6px}input:focus{outline:3px solid #ffcc9d;border-color:#ed761a}button{width:100%;margin-top:24px;padding:13px;border:0;border-radius:10px;background:#ed761a;color:white;font:600 16px system-ui;cursor:pointer}button:disabled{opacity:.6;cursor:wait}.note{font-size:13px;margin-bottom:0}#error{color:#a72627}#error:empty{display:none}</style></head><body><main><div class="logo" aria-hidden="true">V</div>
<h1>${configured ? "Welcome back" : "Protect your workspace"}</h1><p>${configured ? "Enter your encryption password once to restore access. This Mac will remember the encryption key." : "Choose your encryption password once. This Mac remembers the key securely so future launches open automatically."}</p>
<form id="form"><label for="password">${configured ? "Password" : "Choose a password"}</label><input id="password" name="password" type="password" autocomplete="${configured ? "current-password" : "new-password"}" minlength="12" maxlength="1024" required autofocus>
${configured ? "" : '<label for="confirmation">Confirm password</label><input id="confirmation" name="confirmation" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required><p class="note">Use at least 12 characters. Save it in your password manager. Keep a backup of your data and .varshan-vault.json; there is no password reset in the app.</p>'}
<p id="error" role="alert"></p><button id="submit" type="submit">${configured ? "Unlock Varshan" : "Save password & open Varshan"}</button></form><p class="note">Your password is never saved. macOS Keychain securely remembers the encryption key for future launches.</p></main>
<script nonce="${token}">const form=document.getElementById('form'),button=document.getElementById('submit'),error=document.getElementById('error');form.addEventListener('submit',async event=>{event.preventDefault();error.textContent='';const password=form.elements.password.value,confirmation=form.elements.confirmation?.value;if(confirmation!==undefined&&password!==confirmation){error.textContent='Passwords do not match.';return}button.disabled=true;try{const response=await fetch('/api/vault/open',{method:'POST',headers:{'Content-Type':'application/json','X-Varshan-Token':'${token}'},body:JSON.stringify({password,confirmation})});const data=await response.json();if(!response.ok)throw new Error(data.detail||'Could not unlock Varshan.');form.reset();button.textContent='Opening your workspace…';for(let i=0;i<60;i++){await new Promise(resolve=>setTimeout(resolve,500));try{const health=await fetch('/api/health',{cache:'no-store'});if(health.ok&&!(await health.json()).locked){location.replace('/');return}}catch{}}throw new Error('Varshan is taking longer to start. Reload this page to check.')}catch(cause){error.textContent=cause.message;button.disabled=false;button.textContent='Try again'}});</script></body></html>`;
}
