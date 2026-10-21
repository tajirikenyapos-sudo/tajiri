// @vitest-environment node
//
// Unit tests for the pure, testable core of app.js (search, normalization,
// Levenshtein distance, suggestions, popular products).
//
// app.js is a browser script with no module exports and a large DOM-coupled
// bottom half, so we evaluate only the dependency-free top portion in a `vm`
// sandbox (same technique used by the project's own scratch harness) and pull
// the functions we need out of that context. This keeps the unit tests fast,
// deterministic, and free of any DOM/Firebase/network coupling.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { beforeAll, describe, expect, it } = await import("vitest");

const SOURCE_PATH = path.join(__dirname, "app.js");
const source = fs.readFileSync(SOURCE_PATH, "utf8");

// Slice: everything from the top of the file through getSearchSuggestions,
// plus loadProducts (declared later, needed by line 1 of the module).
const searchCore = source.slice(0, source.indexOf("function loadProducts"));
const loadProductsFn = source.slice(
  source.indexOf("function loadProducts"),
  source.indexOf("let users = []"),
);

let products;
let api;
let pishori;

beforeAll(() => {
  const ctx = {
    document: { querySelector: () => null },
    window: {},
    console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // Function declarations are hoisted, so `const products = loadProducts()`
  // on line 1 resolves even though loadProducts is appended below the slice.
  vm.runInContext(
    `${loadProductsFn}\n${searchCore}\n;this.__api = { normalizeSearchText, normalizeIdentity, levenshteinDistance, productSearchMatches, getPopularProducts, getSearchSuggestions, products };\n`,
    ctx,
    { timeout: 5000 },
  );
  api = ctx.__api;
  products = api?.products;
  if (!Array.isArray(products) || !products.length) {
    throw new Error(
      `Failed to extract products from app.js sandbox (api keys: ${Object.keys(api || {})})`,
    );
  }
  pishori = products.find((product) => product.name.includes("Pishori"));
});

describe("normalizeSearchText", () => {
  it("lowercases input", () => {
    expect(api.normalizeSearchText("Maize FLOUR")).toBe("maize flour");
  });

  it("strips diacritics via NFD decomposition", () => {
    expect(api.normalizeSearchText("Café OLÉ")).toBe("cafe ole");
  });

  it("replaces punctuation with spaces", () => {
    expect(api.normalizeSearchText("rice, (pishori)!")).toBe("rice pishori");
  });

  it("collapses runs of whitespace to a single space and trims", () => {
    expect(api.normalizeSearchText("  milk\t \n 500ml  ")).toBe("milk 500ml");
  });

  it("keeps digits and letters only", () => {
    expect(api.normalizeSearchText("F-001_x")).toBe("f 001 x");
  });

  it("returns an empty string for empty input", () => {
    expect(api.normalizeSearchText("")).toBe("");
  });

  it("coerces non-string values via String()", () => {
    expect(api.normalizeSearchText(123)).toBe("123");
    expect(api.normalizeSearchText(null)).toBe("");
    expect(api.normalizeSearchText(undefined)).toBe("");
  });
});

describe("normalizeIdentity", () => {
  it("lowercases and trims", () => {
    expect(api.normalizeIdentity("  James Ochieng  ")).toBe("james ochieng");
  });

  it("applies NFKC compatibility folding (e.g. fullwidth digits)", () => {
    expect(api.normalizeIdentity("ＡＢＣ１２３")).toBe("abc123");
  });

  it("converts non-breaking spaces to regular spaces", () => {
    expect(api.normalizeIdentity("a\u00a0b")).toBe("a b");
  });

  it("maps various bullet characters to the middot separator", () => {
    expect(api.normalizeIdentity("Cash\u2022Mpesa")).toBe("cash·mpesa");
    expect(api.normalizeIdentity("Cash\u25e6Mpesa")).toBe("cash·mpesa");
  });

  it("normalizes spacing around middots", () => {
    expect(api.normalizeIdentity("cash   ·    mpesa")).toBe("cash · mpesa");
  });

  it("handles empty input", () => {
    expect(api.normalizeIdentity("")).toBe("");
  });
});

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(api.levenshteinDistance("milk", "milk")).toBe(0);
  });

  it("returns the length of the other string when one is empty", () => {
    expect(api.levenshteinDistance("abc", "")).toBe(3);
    expect(api.levenshteinDistance("", "abc")).toBe(3);
    expect(api.levenshteinDistance("", "")).toBe(0);
  });

  it("counts single substitutions as 1", () => {
    expect(api.levenshteinDistance("biscut", "biscuit")).toBe(1);
  });

  it("counts insertions and deletions", () => {
    expect(api.levenshteinDistance("cat", "cart")).toBe(1); // insertion
    expect(api.levenshteinDistance("cart", "cat")).toBe(1); // deletion
  });

  it("is symmetric", () => {
    expect(api.levenshteinDistance("kitten", "sitting")).toBe(
      api.levenshteinDistance("sitting", "kitten"),
    );
    expect(api.levenshteinDistance("kitten", "sitting")).toBe(3);
  });

  it("handles unicode input deterministically", () => {
    expect(api.levenshteinDistance("café", "cafe")).toBe(1);
  });
});

describe("product catalog fixtures", () => {
  it("exposes a non-empty catalog with required fields", () => {
    expect(Array.isArray(products)).toBe(true);
    expect(products.length).toBeGreaterThan(0);
    for (const product of products) {
      expect(product).toEqual(
        expect.objectContaining({
          id: expect.any(Number),
          name: expect.any(String),
          code: expect.any(String),
          category: expect.any(String),
          price: expect.any(Number),
        }),
      );
    }
  });

  it("gives every product a unique id and code", () => {
    const ids = products.map((p) => p.id);
    const codes = products.map((p) => p.code);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("finds a product by a known code", () => {
    expect(products.some((p) => p.code === "F003")).toBe(true);
    expect(products.some((p) => p.code === "NOT-A-CODE")).toBe(false);
  });
});

describe("productSearchMatches", () => {
  describe("positive cases", () => {
    const cases = [
      ["pishori", "exact name token"],
      ["rice", "name token"],
      ["Rice (Pishori)", "full display name"],
      ["rice 2kg", "name plus unit"],
      ["basmati", "second rice variant"],
      ["F003", "product code"],
      ["f003", "lowercased code"],
      ["sku f003", "SKU-prefixed code query"],
      ["sugar", "product name"],
      ["premium sugar", "multi-word name"],
      ["tomato", "fresh produce"],
      ["sukuma", "partial fresh produce name"],
      ["water", "bottled water"],
      ["eggs", "fresh item"],
      ["tooth", "prefix of toothpaste/toothbrush"],
      ["milk", "simple product"],
      ["biscuits", "snacks"],
      ["biscut", "single-character typo (edit distance 1)"],
      ["stationery", "category match"],
      ["kibera fresh mart", "supplier match"],
      ["pembe", "supplier partial"],
    ];

    it.each(cases)("matches %j (%s)", (query) => {
      expect(products.some((p) => api.productSearchMatches(p, query))).toBe(
        true,
      );
    });

    it("matches the rice product by its code prefix", () => {
      expect(api.productSearchMatches(pishori, "f00")).toBe(true);
    });

    it("matches with mixed case and extra whitespace", () => {
      expect(api.productSearchMatches(pishori, "  RiCe   PiShOrI  ")).toBe(
        true,
      );
    });

    it("matches multi-token queries across name and unit", () => {
      expect(api.productSearchMatches(pishori, "rice pishori")).toBe(true);
    });
  });

  describe("negative cases", () => {
    const cases = [
      ["xyzzy", "gibberish"],
      ["F005", "code belonging to a different product"],
      ["F006", "code belonging to a different product"],
      ["zzz", "nonexistent letters"],
    ];

    it.each(cases)("does not match any product for %j (%s)", (query) => {
      expect(products.some((p) => api.productSearchMatches(p, query))).toBe(
        false,
      );
    });

    it("does not cross-match products with similar names", () => {
      // "basmati" must not hit the Pishori rice product.
      expect(api.productSearchMatches(pishori, "basmati")).toBe(false);
    });

    it("rejects short queries that are not meaningful text (single character)", () => {
      // A single character is not a meaningful text token.
      expect(api.productSearchMatches(pishori, "x")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("returns true for an empty query (no filter)", () => {
      expect(api.productSearchMatches(pishori, "")).toBe(true);
      expect(api.productSearchMatches(pishori, "   ")).toBe(true);
    });

    it("returns true for null/undefined query (coerced to empty)", () => {
      expect(api.productSearchMatches(pishori, null)).toBe(true);
      expect(api.productSearchMatches(pishori, undefined)).toBe(true);
    });

    it("returns false for a query made only of punctuation (normalizes to nothing)", () => {
      expect(api.productSearchMatches(pishori, "!!!")).toBe(false);
    });

    it("handles missing optional fields (no aliases, no supplier)", () => {
      const bare = { name: "Widget", code: "W001", category: "Misc" };
      expect(api.productSearchMatches(bare, "widget")).toBe(true);
      expect(api.productSearchMatches(bare, "gadget")).toBe(false);
    });

    it("handles an empty aliases array", () => {
      const bare = {
        name: "Widget",
        code: "W001",
        category: "Misc",
        aliases: [],
      };
      expect(api.productSearchMatches(bare, "wid")).toBe(true);
    });

    it("is resilient to a null query with a bare product", () => {
      const bare = { name: "Widget", code: "W001", category: "Misc" };
      expect(api.productSearchMatches(bare, null)).toBe(true);
    });

    it("matches numeric-looking codes only in code-aware lookups", () => {
      // "003" alone looks like a code fragment but is a numeric token, not
      // code-aware, so it should not match on code alone.
      expect(api.productSearchMatches(pishori, "003")).toBe(false);
    });

    it("matches queries of two characters via token startsWith on names", () => {
      // "su" (2 chars) is a meaningful-length token per the >=2 rule.
      const sugar = products.find((p) => p.name.toLowerCase() === "sugar 1kg");
      expect(api.productSearchMatches(sugar, "sug")).toBe(true);
    });

    it("tolerates moderate typos in longer words", () => {
      expect(
        products.some((p) => api.productSearchMatches(p, "tomotoes")),
      ).toBe(true);
    });

    it("does not typo-match very short tokens (under 3 characters)", () => {
      expect(products.some((p) => api.productSearchMatches(p, "xy"))).toBe(
        false,
      );
    });
  });
});

describe("getPopularProducts", () => {
  it("returns all products even with no sales", () => {
    const ctxLocal = { salesLog: [] };
    const ranking = vm.runInNewContext(
      "getPopularProducts()",
      createContext(ctxLocal),
    );
    expect(ranking).toHaveLength(products.length);
    expect(ranking.every((e) => e.sales === 0)).toBe(true);
  });

  it("ranks products by accumulated sale quantity", () => {
    const ranking = withSalesLog(
      [
        {
          items: [
            { name: "Sugar 1kg", quantity: 5 },
            { name: "Milk 500ml", quantity: 2 },
          ],
        },
        { items: [{ name: "Sugar 1kg", quantity: 3 }] },
      ],
      "getPopularProducts()",
    );
    const top = ranking[0];
    expect(top.product.name).toBe("Sugar 1kg");
    expect(top.sales).toBe(8);
    expect(ranking[1].product.name).toBe("Milk 500ml");
    expect(ranking[1].sales).toBe(2);
  });

  it("breaks ties alphabetically by product name", () => {
    const ranking = withSalesLog(
      [
        {
          items: [
            { name: "Bread 400g", quantity: 4 },
            { name: "Salt 500g", quantity: 4 },
          ],
        },
      ],
      "getPopularProducts()",
    );
    expect(ranking[0].product.name).toBe("Bread 400g");
    expect(ranking[1].product.name).toBe("Salt 500g");
  });

  it("ignores unknown product names in sales (they never enter the ranking)", () => {
    const ranking = withSalesLog(
      [{ items: [{ name: "Ghost item", quantity: 99 }] }],
      "getPopularProducts()",
    );
    expect(ranking.some((e) => e.product.name === "Ghost item")).toBe(false);
    expect(ranking.every((e) => e.sales === 0)).toBe(true);
  });

  it("treats a sale with a missing items array as zero sales", () => {
    const ranking = withSalesLog(
      [{} /* no items */, { items: null }],
      "getPopularProducts()",
    );
    expect(ranking).toHaveLength(products.length);
    expect(ranking.every((e) => e.sales === 0)).toBe(true);
  });

  it("accumulates across multiple sales of the same item", () => {
    const ranking = withSalesLog(
      [
        { items: [{ name: "Eggs Tray", quantity: 1 }] },
        { items: [{ name: "Eggs Tray", quantity: 1 }] },
        { items: [{ name: "Eggs Tray", quantity: 1 }] },
      ],
      "getPopularProducts().filter((e) => e.product.name === 'Eggs Tray')",
    );
    expect(ranking[0].sales).toBe(3);
  });
});

describe("getSearchSuggestions", () => {
  it("returns at most 6 suggestions", () => {
    // "s" alone would match nothing (too short), so use a broad real query.
    const results = api.getSearchSuggestions("rice");
    expect(results.length).toBeLessThanOrEqual(6);
    expect(results.length).toBeGreaterThan(0);
  });

  it("ranks an exact code query first", () => {
    const results = api.getSearchSuggestions("F003");
    expect(results[0].name).toContain("Pishori");
  });

  it("ranks an exact name query first", () => {
    const results = api.getSearchSuggestions("Milk");
    const names = results.map((p) => p.name.toLowerCase());
    expect(names[0]).toMatch(/milk/);
    // Fresh Milk (exact multi-word name) should outrank partial matches.
    expect(results[0].name.toLowerCase()).toBe("fresh milk 1 litre");
  });

  it("returns suggestions for every product when the query is blank", () => {
    const results = api.getSearchSuggestions("");
    expect(results).toHaveLength(Math.min(6, products.length));
  });

  it("returns suggestions for whitespace-only queries", () => {
    expect(api.getSearchSuggestions("   ")).toHaveLength(
      Math.min(6, products.length),
    );
  });

  it("returns nothing for gibberish", () => {
    expect(api.getSearchSuggestions("xyzzyqqq")).toEqual([]);
  });

  it("handles null/undefined queries like an empty query", () => {
    expect(api.getSearchSuggestions(null)).toHaveLength(
      Math.min(6, products.length),
    );
    expect(api.getSearchSuggestions(undefined)).toHaveLength(
      Math.min(6, products.length),
    );
  });

  it("never returns duplicates", () => {
    const results = api.getSearchSuggestions("sugar");
    const ids = results.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns consistent suggestions regardless of query casing", () => {
    const lower = api.getSearchSuggestions("sugar").map((p) => p.id);
    const upper = api.getSearchSuggestions("SUGAR").map((p) => p.id);
    expect(lower).toEqual(upper);
  });

  it("keeps only products that actually match the query", () => {
    const results = api.getSearchSuggestions("toothpaste");
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.every(
        (p) =>
          p.name.toLowerCase().includes("tooth") ||
          p.category.toLowerCase().includes("personal"),
      ),
    ).toBe(true);
  });

  it("blanks ranking uses sales popularity (popular product first)", () => {
    const results = withSalesLog(
      [{ items: [{ name: "Salt 500g", quantity: 100 }] }],
      "getSearchSuggestions('')",
    );
    expect(results[0].name).toBe("Salt 500g");
  });

  it("typo queries still surface the intended product", () => {
    const results = api.getSearchSuggestions("biscut");
    expect(results.some((p) => p.name.includes("biscuits"))).toBe(true);
  });
});

/* ---------- helpers ---------- */

// Builds a fresh vm context sharing the app.js code but with a custom
// `salesLog` binding, so getPopularProducts / getSearchSuggestions can be
// exercised against arbitrary sale history without mutating module state.
function createContext(extra) {
  const ctx = {
    document: { querySelector: () => null },
    window: {},
    console,
    salesLog: extra.salesLog ?? [],
    ...extra,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${loadProductsFn}\n${searchCore}\n`, ctx, { timeout: 5000 });
  return ctx;
}

function withSalesLog(salesLog, expression) {
  return vm.runInContext(expression, createContext({ salesLog }));
}

describe("getTodayTillSummary", () => {
  const functionStart = source.indexOf("function getTodayTillSummary");
  const functionEnd = source.indexOf("function getCashierId", functionStart);
  const tillSummarySource = source.slice(functionStart, functionEnd);

  function summarize(sales, today = "17/10/2026") {
    const context = vm.createContext({ sales });
    return JSON.parse(
      JSON.stringify(
        vm.runInContext(
          `${tillSummarySource}\ngetTodayTillSummary(sales, ${JSON.stringify(today)})`,
          context,
        ),
      ),
    );
  }

  it("groups today's order counts and sales totals by Till 1–4", () => {
    const summary = summarize([
      { date: "17/10/2026", tillNumber: 1, total: 100 },
      { date: "17/10/2026", tillNumber: 1, total: 50 },
      { date: "17/10/2026", tillNumber: 4, total: 25 },
      { date: "16/10/2026", tillNumber: 2, total: 500 },
    ]);

    expect(summary.tills).toEqual([
      { tillNumber: 1, orders: 2, total: 150 },
      { tillNumber: 2, orders: 0, total: 0 },
      { tillNumber: 3, orders: 0, total: 0 },
      { tillNumber: 4, orders: 1, total: 25 },
    ]);
    expect(summary.total).toEqual({ orders: 3, total: 175 });
  });

  it("keeps sales without a valid till visible as unassigned", () => {
    const summary = summarize([
      { date: "17/10/2026", total: 20 },
      { date: "17/10/2026", tillNumber: 5, total: 30 },
    ]);

    expect(summary.unassigned).toEqual({ orders: 2, total: 50 });
    expect(summary.total).toEqual({ orders: 2, total: 50 });
  });
});
