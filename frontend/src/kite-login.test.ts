import { beforeEach, describe, expect, it } from "vitest";
import {
  readKiteReturn,
  clearKiteReturn,
  validWorkspacePage,
} from "./kite-login";
import { applyTheme, themes } from "./themes";
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});
describe("Kite returns", () => {
  it("restores a valid workspace and removes credentials without removing unrelated URL state", () => {
    window.history.replaceState(
      null,
      "",
      "/?request_token=fixture-token&varshan_kite_state=fixture-state&varshan_return_page=weekly&status=success&view=compact#workspace",
    );
    expect(readKiteReturn()).toEqual({
      page: "weekly",
      token: "fixture-token",
      state: "fixture-state",
      success: true,
    });
    clearKiteReturn();
    expect(window.location.search).toBe("?view=compact");
    expect(window.location.hash).toBe("#workspace");
    expect(readKiteReturn()).toBeNull();
    expect(localStorage.length).toBe(0);
  });
  it("recognizes a denied login even when Kite returns no token", () => {
    window.history.replaceState(
      null,
      "",
      "/?varshan_kite_state=fixture-state&varshan_return_page=weekly&status=error",
    );
    expect(readKiteReturn()).toEqual({
      page: "weekly",
      token: "",
      state: "fixture-state",
      success: false,
    });
    clearKiteReturn();
    expect(window.location.search).toBe("");
  });
  it("supports the manual fallback and rejects arbitrary return URLs", () => {
    window.history.replaceState(
      null,
      "",
      "/?request_token=fixture&varshan_return_page=https://evil.example",
    );
    expect(readKiteReturn()?.page).toBe("holdings");
    expect(readKiteReturn()?.state).toBeNull();
    expect(validWorkspacePage("weekly")).toBe(true);
    expect(validWorkspacePage("//evil.example")).toBe(false);
  });
});
describe("theme catalog", () => {
  it("applies every palette with the correct light or dark surface mode", () => {
    for (const theme of themes) {
      applyTheme(theme.id);
      expect(document.documentElement.dataset.theme).toBe(theme.id);
      expect(document.documentElement.dataset.colorMode).toBe(theme.mode);
    }
    applyTheme("unsupported");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
