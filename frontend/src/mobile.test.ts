import { describe, expect, it } from "vitest";
import { pairingCodeFromHash } from "./mobile";

describe("pairing QR fragments", () => {
  it("accepts only six-digit pairing codes", () => {
    expect(pairingCodeFromHash("#pair=123456")).toBe("123456");
    for (const fragment of [
      "",
      "#pair=12345",
      "#pair=1234567",
      "#pair=abcdef",
      "#workspace=trading",
    ])
      expect(pairingCodeFromHash(fragment)).toBe("");
  });
});
