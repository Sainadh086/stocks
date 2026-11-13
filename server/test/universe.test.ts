import test from "node:test";
import assert from "node:assert/strict";
import { nasdaqConstituents } from "../src/analysis.js";

test("Nasdaq constituents skip headers and unrelated tables without losing the first stock", () => {
  const html = `<table><tr><td>WRONG</td></tr></table>
    <table class="wikitable sortable" id="constituents">
    <tbody><tr><th>Ticker</th><th>Company</th></tr>
    <tr><td>ADBE</td><td>Adobe</td></tr>
    <tr><td><a>AAPL</a></td><td>Apple</td></tr>
    <tr><td>BRK.B</td><td>Example share class</td></tr>
    <tr><td>AAPL</td><td>Duplicate</td></tr></tbody></table>`;
  assert.deepEqual(nasdaqConstituents(html), ["ADBE", "AAPL", "BRK-B"]);
});

test("Nasdaq constituents fail closed when the table is absent or empty", () => {
  assert.throws(
    () => nasdaqConstituents("<table></table>"),
    /constituent table/,
  );
  assert.throws(
    () =>
      nasdaqConstituents(
        `<table id='constituents'><tr><th>Ticker</th></tr></table>`,
      ),
    /no usable symbols/,
  );
});
