import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { request } from "./api";
export async function verifyOnPhone() {
  if (
    !window.isSecureContext ||
    !window.PublicKeyCredential ||
    !(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
  )
    throw new Error(
      "Enable Face ID, fingerprint or screen lock on this phone and use the trusted hostname address from the updated QR.",
    );
  const challenge = await request<{
    id: string;
    kind: string;
    options:
      | PublicKeyCredentialCreationOptionsJSON
      | PublicKeyCredentialRequestOptionsJSON;
  }>("/phone-verification/options", {});
  const response =
    challenge.kind === "registration"
      ? await startRegistration({
          optionsJSON:
            challenge.options as PublicKeyCredentialCreationOptionsJSON,
        })
      : await startAuthentication({
          optionsJSON:
            challenge.options as PublicKeyCredentialRequestOptionsJSON,
        });
  return (
    await request<{ proof: string }>("/phone-verification/verify", {
      id: challenge.id,
      response,
    })
  ).proof;
}
