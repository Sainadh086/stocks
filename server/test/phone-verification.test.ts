import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { PhoneVerification } from "../src/phone-verification.js";
import { store } from "../src/shared/storage.js";

test("phone passkeys verify signatures, user verification, owner, origin and single-use privacy proofs", async () => {
  const saved = new Map<string, any>();
  mock.method(store, "json", (path: string, fallback: any) =>
    structuredClone(saved.get(path) ?? fallback),
  );
  mock.method(store, "save", (path: string, value: any) =>
    saved.set(path, structuredClone(value)),
  );
  const phone = new PhoneVerification(),
    owner = "a".repeat(64),
    origin = "https://varshan.local:8443";
  const rp = createHash("sha256").update("varshan.local").digest();
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = keys.publicKey.export({ format: "jwk" });
  const credential = randomBytes(16),
    id = credential.toString("base64url");
  const cose = isoCBOR.encode(
    new Map<any, any>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
    ]),
  );
  const clientData = (challenge: string, type: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin }));
  try {
    await assert.rejects(
      phone.options(owner, "https://10.1.2.3:8443"),
      /hostname/,
    );
    const registration = await phone.options(owner, origin);
    assert.equal(registration.kind, "registration");
    const creation = registration.options as any;
    assert.equal(creation.authenticatorSelection.userVerification, "required");
    assert.equal(
      creation.authenticatorSelection.authenticatorAttachment,
      "platform",
    );
    const length = Buffer.alloc(2);
    length.writeUInt16BE(credential.length);
    const authData = Buffer.concat([
      rp,
      Buffer.from([0x45]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      length,
      credential,
      Buffer.from(cose),
    ]);
    const response = {
      id,
      rawId: id,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientData(
          creation.challenge,
          "webauthn.create",
        ).toString("base64url"),
        attestationObject: Buffer.from(
          isoCBOR.encode(
            new Map<any, any>([
              ["fmt", "none"],
              ["attStmt", new Map()],
              ["authData", new Uint8Array(authData)],
            ]),
          ),
        ).toString("base64url"),
        transports: ["internal"],
      },
    };
    const approval = await phone.verify(
      owner,
      origin,
      registration.id,
      response,
    );
    phone.consume(owner, origin, approval.proof);
    assert.throws(() => phone.consume(owner, origin, approval.proof), /Verify/);
    await assert.rejects(
      phone.verify(owner, origin, registration.id, response),
      /expired/,
    );
    async function authenticate(flags = 0x05) {
      const challenge = await phone.options(owner, origin);
      assert.equal(challenge.kind, "authentication");
      const client = clientData(challenge.options.challenge, "webauthn.get");
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(1);
      const authenticator = Buffer.concat([rp, Buffer.from([flags]), counter]);
      const signature = sign(
        "sha256",
        Buffer.concat([
          authenticator,
          createHash("sha256").update(client).digest(),
        ]),
        keys.privateKey,
      );
      return phone.verify(owner, origin, challenge.id, {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: client.toString("base64url"),
          authenticatorData: authenticator.toString("base64url"),
          signature: signature.toString("base64url"),
        },
      });
    }
    await assert.rejects(authenticate(0x01));
    const assertion = await authenticate();
    assert.throws(
      () => phone.consume("b".repeat(64), origin, assertion.proof),
      /Verify/,
    );
    const challenge = await phone.options(owner, origin);
    await assert.rejects(
      phone.verify(owner, "https://other.local:8443", challenge.id, {}),
      /expired/,
    );
    const expired = await phone.options(owner, origin);
    const now = Date.now();
    mock.method(Date, "now", () => now + 120001);
    await assert.rejects(
      phone.verify(owner, origin, expired.id, {}),
      /expired/,
    );
  } finally {
    mock.restoreAll();
  }
});
