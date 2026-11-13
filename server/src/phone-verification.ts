import {
  generateRegistrationOptions,
  generateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { join } from "node:path";
import { store, US, type Row } from "./shared/storage.js";

export class PhoneVerification {
  private path = join(US, "phone_passkeys.json");
  private challenges = new Map<
    string,
    {
      owner: string;
      origin: string;
      challenge: string;
      expires: number;
      registration: boolean;
    }
  >();
  private proofs = new Map<
    string,
    { owner: string; origin: string; expires: number }
  >();
  async options(owner: string, origin: string) {
    const rpID = new URL(origin).hostname;
    if (!origin.startsWith("https:") || isIP(rpID))
      throw new Error(
        "Open the hostname address from the updated desktop QR and trust its certificate to use your phone’s biometrics.",
      );
    const registered = store.json<Row>(this.path, {})[owner];
    for (const [id, challenge] of this.challenges)
      if (challenge.owner === owner || challenge.expires < Date.now())
        this.challenges.delete(id);
    const options = registered
      ? await generateAuthenticationOptions({
          rpID,
          userVerification: "required",
          allowCredentials: [{ id: registered.id }],
          timeout: 60000,
        })
      : await generateRegistrationOptions({
          rpName: "Varshan",
          rpID,
          userName: "Varshan phone",
          userID: new Uint8Array(Buffer.from(owner, "hex")),
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            residentKey: "required",
            userVerification: "required",
          },
          attestationType: "none",
          timeout: 60000,
        });
    const id = randomBytes(24).toString("base64url");
    this.challenges.set(id, {
      owner,
      origin,
      challenge: options.challenge,
      expires: Date.now() + 120000,
      registration: !registered,
    });
    return {
      id,
      kind: registered ? "authentication" : "registration",
      options,
    };
  }
  async verify(owner: string, origin: string, id: string, response: unknown) {
    const pending = this.challenges.get(id);
    this.challenges.delete(id);
    if (
      !pending ||
      pending.owner !== owner ||
      pending.origin !== origin ||
      pending.expires <= Date.now()
    )
      throw new Error("Phone verification expired. Try again on this phone.");
    const expected = {
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: new URL(origin).hostname,
      requireUserVerification: true,
    };
    const credentials = store.json<Row>(this.path, {});
    if (pending.registration) {
      const result = await verifyRegistrationResponse({
        ...expected,
        response: response as RegistrationResponseJSON,
      });
      if (!result.verified || !result.registrationInfo)
        throw new Error("Phone verification failed. Values remain hidden.");
      const credential = result.registrationInfo.credential;
      store.save(this.path, {
        [owner]: {
          id: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString("base64url"),
          counter: credential.counter,
        },
      });
    } else {
      const credential = credentials[owner];
      if (!credential)
        throw new Error("Set up verification on this phone again.");
      const result = await verifyAuthenticationResponse({
        ...expected,
        response: response as AuthenticationResponseJSON,
        credential: {
          ...credential,
          publicKey: new Uint8Array(
            Buffer.from(credential.publicKey, "base64url"),
          ),
        },
      });
      if (!result.verified)
        throw new Error("Phone verification failed. Values remain hidden.");
      credential.counter = result.authenticationInfo.newCounter;
      store.save(this.path, credentials);
    }
    for (const [key, proof] of this.proofs)
      if (proof.expires < Date.now()) this.proofs.delete(key);
    const proof = randomBytes(32).toString("base64url");
    this.proofs.set(proof, { owner, origin, expires: Date.now() + 60000 });
    return { proof };
  }
  consume(owner: string, origin: string, proof?: string) {
    const approval = proof ? this.proofs.get(proof) : null;
    if (proof) this.proofs.delete(proof);
    if (
      !approval ||
      approval.owner !== owner ||
      approval.origin !== origin ||
      approval.expires <= Date.now()
    )
      throw new Error(
        "Verify with this phone’s Face ID, fingerprint or device lock before revealing private values.",
      );
  }
}
