// @vitest-environment node
//
// Additional unit tests for the pure, testable core of app.js, covering the
// pricing/cart math, CSV + HTML escaping helpers, phone normalization, receipt
// settings, low-stock logic, Code 39 barcode generation, till summaries,
// cashier identity resolution, and the product form validation.
//
// Same sandbox technique as app.test.js: app.js is a browser script without
// module exports, so we slice out dependency-free regions and evaluate them in
// a `vm` context with a minimal DOM stub.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { beforeAll, describe, expect, it } = await import("vitest");

const SOURCE_PATH = path.join(__dirname, "app.js");
const source = fs.readFileSync(SOURCE_PATH, "utf8");

function sliceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  expect(start, `marker ${startMarker} not found`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start);
  expect(
    end,
    `end marker ${endMarker} not found after ${startMarker}`,
  ).toBeGreaterThan(start);
  return source.slice(start, end);
}

// Regions of pure logic (each slice stops before the next DOM-coupled section).
const loadProductsFn = source.slice(
  source.indexOf("function loadProducts"),
  source.indexOf("let users = []"),
);
const productCsvParserFn = sliceBetween(
  "function parseProductCsv",
  "function loadProducts",
);
const syncCurrentBranchStockFn = sliceBetween(
  "function syncCurrentBranchStock",
  "function activateStoreStock",
);
const saveStateFn = sliceBetween("function saveState()", "function queueCloudStateSave");
const moneyFn = source.slice(
  source.indexOf("const money ="),
  source.indexOf("function showToast"),
);
const csvAndModalFn = source.slice(
  source.indexOf("function downloadTextFile"),
  source.indexOf("function showStaffLogin"),
);
const cartMathFn = source.slice(
  source.indexOf("function getEffectivePrice"),
  source.indexOf("function renderCart"),
);
const phoneFn = sliceBetween(
  "function normalizeKenyanPhone",
  "function darajaApiBase",
);
const escapeAndLowStockFn =
  "const DEFAULT_LOW_STOCK_LEVEL = 5;\n" +
  source.slice(
    source.indexOf("function escapeHtml"),
    source.indexOf("function renderInventoryPanel"),
  );
const barcodeFn = sliceBetween(
  "const CODE39_PATTERNS = {",
  "function printBarcodeLabels",
);
const tillSummaryFn = sliceBetween(
  "function getTodayTillSummary",
  "function isCashierWorkspace",
);
const cashierIdFn = sliceBetween(
  "function getCashierId",
  "function isCashierWorkspace",
);
const pinLoginFn = sliceBetween("function loginWithPin", "function getStoreNames");

const SANDBOX_GLOBALS = {
  document: {
    // app.js assigns const cartItems/search/toast/etc from querySelector; the
    // money slice declares `const search = document.querySelector(...)`, so the
    // stub element must expose `value` for addProduct.
    querySelector: () => ({
      value: "",
      textContent: "",
      style: {},
      hidden: false,
      innerHTML: "",
    }),
    createElement: () => ({ click() {}, remove() {}     }),
    body: { append() {} },
  },
  localStorage: { setItem() {} },
  users: [],
  customers: [],
  salesLog: [],
  expenses: [],
  purchaseOrders: [],
  pendingMpesa: [],
  loyaltyBalance: 0,
  cashBook: [],
  shifts: [],
  branchStock: {},
  stockTransfers: [],
  deliveries: [],
  offlineMode: false,
  showToast() {},
  window: {
    location: { origin: "http://127.0.0.1:3000", protocol: "http:" },
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout,
    open: () => null,
  },
  console,
  URL,
  Blob: class Blob {},
  setTimeout,
  clearTimeout,
  Math,
  Number,
  String,
  Date,
  JSON,
};

function createContext(extra = {}) {
  const ctx = {
    ...SANDBOX_GLOBALS,
    products: [],
    cart: [],
    discount: 0,
    salePointsDiscount: 0,
    currentSaleType: "retail",
    saleTypes: {
      retail: { label: "Retail", multiplier: 1 },
      wholesale: { label: "Wholesale", multiplier: 0.8 },
      special: { label: "Special sale", multiplier: 0.9 },
    },
    settings: { fx: { KES: 1 }, currency: "KES", taxRate: 0, serviceCharge: 0 },
    search: { value: "" },
    ...extra,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return ctx;
}

function evalIn(ctx, code) {
  return vm.runInContext(code, ctx, { timeout: 5000 });
}

let ctx;

beforeAll(() => {
  ctx = createContext();
  evalIn(
    ctx,
    `${productCsvParserFn}\n${loadProductsFn}\nconst products = loadProducts();\n${syncCurrentBranchStockFn}\n${saveStateFn}\n${moneyFn}\n${csvAndModalFn}\n${cartMathFn}\n${phoneFn}\n${escapeAndLowStockFn}\n${barcodeFn}\n${tillSummaryFn}\n${cashierIdFn}\n
    this.__api = {
      money, toCsv, escapeHtml, getEffectivePrice, getProductPrice,
      parseProductCsv,
      currentSubtotal, currentTaxable, currentVat, currentServiceCharge, currentTotal,
      addProduct, normalizeKenyanPhone, receiptLogoMarkup, getReceiptFontSize,
      getLowStockThreshold, getLowStockProducts, code39Svg,
      getTodayTillSummary, getCashierId, saveState,
    };`,
  );
  ctx.__api.settings = ctx.settings;
  ctx.__api.setCart = (items) => {
    ctx.cart = items;
  };
  ctx.__api.setSettings = (patch) => Object.assign(ctx.settings, patch);
  ctx.__api.setSaleType = (type) => {
    ctx.currentSaleType = type;
  };
  ctx.__api.products = evalIn(ctx, "products");
});

const api = () => ctx.__api;

/* ---------- money ---------- */
describe("product CSV import", () => {
  it("parses the shop catalogue columns and preserves prices, stock and reorder levels", () => {
    const imported = api().parseProductCsv(
      "\uFEFFSKU,ProductName,Category,BuyPriceKES,SellPriceKES,StockQty,ReorderLevel\r\n" +
        "GS0001,Maize Flour,Staples,457.17,510.68,124,44\r\n",
    );
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      code: "GS0001",
      name: "Maize Flour",
      category: "Staples",
      cost: 457.17,
      price: 510.68,
      stock: 124,
      reorderLevel: 44,
      aliases: ["Maize Flour", "GS0001", "SKU GS0001"],
    });
  });

  it("supports quoted commas and escaped quotes in product names", () => {
    const imported = api().parseProductCsv(
      "SKU,ProductName,Category,BuyPriceKES,SellPriceKES,StockQty,ReorderLevel\n" +
        'GS0001,"Flour, Premium ""Grade A""",Staples,12.5,15,4,5\n',
    );
    expect(imported[0].name).toBe('Flour, Premium "Grade A"');
  });

  it.each([
    [
      "duplicate SKUs",
      "SKU,ProductName,Category,BuyPriceKES,SellPriceKES,StockQty,ReorderLevel\nGS0001,Flour,Staples,2,3,4,5\nGS0001,Rice,Staples,2,3,4,5",
      /repeats SKU GS0001/,
    ],
    [
      "missing required columns",
      "SKU,ProductName,Category\nGS0001,Flour,Staples",
      /Missing required CSV columns/,
    ],
    [
      "non-numeric values",
      "SKU,ProductName,Category,BuyPriceKES,SellPriceKES,StockQty,ReorderLevel\nGS0001,Flour,Staples,free,3,4,5",
      /invalid buy price/,
    ],
    [
      "fractional stock quantities",
      "SKU,ProductName,Category,BuyPriceKES,SellPriceKES,StockQty,ReorderLevel\nGS0001,Flour,Staples,2,3,4.5,5",
      /whole numbers/,
    ],
    [
      "unclosed quoted fields",
      'SKU,ProductName,Category,BuyPriceKES,SellPriceKES,StockQty,ReorderLevel\nGS0001,"Flour,Staples,2,3,4,5',
      /unclosed quoted field/,
    ],
  ])("rejects %s", (_name, csv, error) => {
    expect(() => api().parseProductCsv(csv)).toThrow(error);
  });
});

describe("POS state persistence", () => {
  it("saves when IndexedDB exposes the offline-cache API", () => {
    const calls = [];
    ctx.window.TajiriIdb = Object.fromEntries(
      ["cacheCatalog", "saveSales", "saveCustomers", "saveStaff", "saveSettings"].map(
        (method) => [
          method,
          () => {
            calls.push(method);
            return Promise.resolve();
          },
        ],
      ),
    );

    expect(api().saveState()).toBe(true);
    expect(calls).toEqual([
      "cacheCatalog",
      "saveSales",
      "saveCustomers",
      "saveStaff",
      "saveSettings",
    ]);
  });
});

describe("money", () => {
  it("formats a number with two decimals at the default KES rate", () => {
    expect(api().money(10)).toBe("10.00");
    expect(api().money(10.5)).toBe("10.50");
    expect(api().money(0)).toBe("0.00");
  });

  it("coerces null/undefined input to 0.00", () => {
    expect(api().money(null)).toBe("0.00");
    expect(api().money(undefined)).toBe("0.00");
  });

  it("does not guard against non-numeric strings (documents NaN passthrough)", () => {
    expect(api().money("abc")).toBe("NaN");
  });

  it("applies the currency exchange rate", () => {
    api().setSettings({ currency: "USD" });
    evalIn(ctx, "settings.fx.USD = 0.5;");
    expect(api().money(10)).toBe("5.00");
    api().setSettings({ currency: "KES" });
    evalIn(ctx, "settings.fx.USD = undefined;");
  });

  it("negatives keep their sign", () => {
    expect(api().money(-3)).toBe("-3.00");
  });
});

/* ---------- toCsv (spreadsheet injection safe) ---------- */
describe("toCsv", () => {
  it("joins rows with CRLF and quotes every cell", () => {
    expect(
      api().toCsv([
        ["a", "b"],
        ["c", "d"],
      ]),
    ).toBe('"a","b"\r\n"c","d"');
  });

  it("wraps values containing commas in quotes", () => {
    expect(api().toCsv([["hello, world"]])).toBe('"hello, world"');
  });

  it("escapes embedded double quotes by doubling them", () => {
    expect(api().toCsv([['say "hi"']])).toBe('"say ""hi"""');
  });

  it("prefixes formula-like cells with an apostrophe to prevent CSV injection", () => {
    for (const dangerous of ["=SUM(A1)", "+1", "-1", "@cmd"]) {
      const csv = api().toCsv([[dangerous]]);
      expect(csv).toBe(`"'${dangerous}"`);
    }
  });

  it("does not add special guarding for safe values", () => {
    expect(api().toCsv([["plain"]])).toBe('"plain"');
    expect(api().toCsv([["2026-10-17"]])).toBe('"2026-10-17"');
  });

  it("coerces null and undefined to empty strings (still quoted)", () => {
    expect(api().toCsv([[null, undefined, 5]])).toBe('"","","5"');
  });

  it("returns an empty string for no rows", () => {
    expect(api().toCsv([])).toBe("");
  });
});

/* ---------- escapeHtml ---------- */
describe("escapeHtml", () => {
  it("escapes all dangerous characters", () => {
    expect(api().escapeHtml(`<a href="x">&'`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;",
    );
  });

  it("leaves plain text untouched", () => {
    expect(api().escapeHtml("hello world 123")).toBe("hello world 123");
  });

  it("coerces non-strings and nullish values", () => {
    expect(api().escapeHtml(null)).toBe("");
    expect(api().escapeHtml(undefined)).toBe("");
    expect(api().escapeHtml(42)).toBe("42");
  });
});

/* ---------- pricing / sale-type math ---------- */
describe("getEffectivePrice / getProductPrice", () => {
  it("uses basePrice over price when present", () => {
    expect(api().getEffectivePrice({ basePrice: 100, price: 999 })).toBe(100);
  });

  it("falls back to price; null item throws (documents missing null guard)", () => {
    expect(api().getEffectivePrice({ price: 50 })).toBe(50);
    expect(api().getEffectivePrice({})).toBe(0);
    expect(() => api().getEffectivePrice(null)).toThrow();
  });

  it("applies the wholesale multiplier (0.8)", () => {
    api().setSaleType("wholesale");
    expect(api().getProductPrice({ price: 100 })).toBe(80);
    api().setSaleType("retail");
  });

  it("applies the special-sale multiplier (0.9)", () => {
    api().setSaleType("special");
    expect(api().getProductPrice({ price: 100 })).toBe(90);
    api().setSaleType("retail");
  });
});

describe("cart totals", () => {
  it("computes the subtotal from quantity * effective price", () => {
    api().setCart([
      { basePrice: 100, quantity: 2 },
      { basePrice: 50, quantity: 1 },
    ]);
    expect(api().currentSubtotal()).toBe(250);
    expect(api().currentTaxable()).toBe(250);
    expect(api().currentVat()).toBe(0);
    expect(api().currentServiceCharge()).toBe(0);
    expect(api().currentTotal()).toBe(250);
  });

  it("returns 0 for an empty cart", () => {
    api().setCart([]);
    expect(api().currentSubtotal()).toBe(0);
    expect(api().currentTotal()).toBe(0);
  });

  it("respects the sale-type multiplier in the subtotal", () => {
    api().setSaleType("wholesale");
    api().setCart([{ basePrice: 100, quantity: 2 }]);
    expect(api().currentSubtotal()).toBe(160);
    api().setSaleType("retail");
    api().setCart([]);
  });

  it("subtracts discounts and points, but never goes negative", () => {
    api().setCart([{ basePrice: 100, quantity: 1 }]);
    evalIn(ctx, "discount = 150; salePointsDiscount = 0;");
    expect(api().currentTaxable()).toBe(0);
    expect(api().currentTotal()).toBe(0);
    evalIn(ctx, "discount = 30; salePointsDiscount = 20;");
    expect(api().currentTaxable()).toBe(50);
    evalIn(ctx, "discount = 0; salePointsDiscount = 0;");
  });

  it("adds VAT and service charge on the taxable amount", () => {
    api().setCart([{ basePrice: 100, quantity: 1 }]);
    api().setSettings({ taxRate: 0.16, serviceCharge: 0.1 });
    expect(api().currentVat()).toBeCloseTo(16, 10);
    expect(api().currentServiceCharge()).toBeCloseTo(10, 10);
    expect(api().currentTotal()).toBeCloseTo(126, 10);
    api().setSettings({ taxRate: 0, serviceCharge: 0 });
    api().setCart([]);
  });

  it("handles fractional quantities", () => {
    api().setCart([{ basePrice: 10.5, quantity: 3 }]);
    expect(api().currentSubtotal()).toBeCloseTo(31.5, 10);
    api().setCart([]);
  });
});

/* ---------- addProduct ---------- */
describe("addProduct", () => {
  beforeAll(() => {
    // addProduct calls renderCart/renderProducts/showToast; provide stubs.
    // Note: cartItems/search/toast consts already exist from the money slice.
    evalIn(
      ctx,
      `function renderCart() {} function renderProducts() {} function showToast(message) {} if (typeof search === "undefined" || search === null) globalThis.search = { value: "" };`,
    );
  });
  it("adds a new product to the cart with quantity 1 and a basePrice snapshot", () => {
    api().setCart([]);
    const product = { id: 1, name: "Milk", price: 75, stock: 10 };
    evalIn(ctx, `addProduct(${JSON.stringify(product)});`);
    expect(ctx.cart).toHaveLength(1);
    expect(ctx.cart[0]).toMatchObject({ id: 1, quantity: 1, basePrice: 75 });
  });

  it("increments quantity for an existing product", () => {
    evalIn(ctx, "addProduct({ id: 1, name: 'Milk', price: 75, stock: 10 });");
    expect(ctx.cart[0].quantity).toBe(2);
    api().setCart([]);
  });

  it("refuses to add beyond available stock", () => {
    api().setCart([
      { id: 2, name: "Eggs", price: 450, basePrice: 450, quantity: 5 },
    ]);
    evalIn(ctx, "addProduct({ id: 2, name: 'Eggs', price: 450, stock: 5 });");
    expect(ctx.cart).toHaveLength(1);
    expect(ctx.cart[0].quantity).toBe(5);
    api().setCart([]);
  });

  it("refuses a product already fully out of stock", () => {
    api().setCart([]);
    evalIn(ctx, "addProduct({ id: 3, name: 'Ghost', price: 10, stock: 0 });");
    expect(ctx.cart).toHaveLength(0);
  });

  it("ignores null/undefined products", () => {
    api().setCart([]);
    evalIn(ctx, "addProduct(null); addProduct(undefined);");
    expect(ctx.cart).toHaveLength(0);
  });

  it("treats missing stock as zero, but a non-numeric string stock passes through (documented behavior)", () => {
    api().setCart([]);
    // addProduct computes Number(product.stock || 0): a MISSING stock value
    // becomes 0 and the item is rejected as out of stock. A non-numeric string
    // like 'x' is truthy, so Number('x') = NaN, and NaN < 1 is false, so the
    // item is incorrectly added — a latent bug we document rather than hide.
    evalIn(ctx, "addProduct({ id: 4, name: 'NoStock', price: 5 });");
    expect(ctx.cart).toHaveLength(0);
    evalIn(
      ctx,
      "addProduct({ id: 5, name: 'NaNStock', price: 5, stock: 'x' });",
    );
    expect(ctx.cart).toHaveLength(1);
    expect(ctx.cart[0]).toMatchObject({ id: 5, quantity: 1, basePrice: 5 });
  });

  it("adds more when stock covers cart quantity plus one more", () => {
    api().setCart([
      { id: 6, name: "Bread", price: 75, basePrice: 75, quantity: 4 },
    ]);
    evalIn(ctx, "addProduct({ id: 6, name: 'Bread', price: 75, stock: 6 });");
    expect(ctx.cart[0].quantity).toBe(5);
    api().setCart([]);
  });
});

/* ---------- normalizeKenyanPhone ---------- */
describe("normalizeKenyanPhone", () => {
  it("converts 07XX/01XX local format to 254 format", () => {
    expect(api().normalizeKenyanPhone("0712345678")).toBe("254712345678");
    expect(api().normalizeKenyanPhone("0112345678")).toBe("254112345678");
  });

  it("strips spaces, dashes and other separators", () => {
    expect(api().normalizeKenyanPhone("0712 345 678")).toBe("254712345678");
    expect(api().normalizeKenyanPhone("0712-345-678")).toBe("254712345678");
    expect(api().normalizeKenyanPhone("+254712345678")).toBe("254712345678");
  });

  it("normalizes a 254-prefixed number that still carries a leading 0", () => {
    expect(api().normalizeKenyanPhone("2540712345678")).toBe("254712345678");
  });

  it("passes through a valid 254 number unchanged", () => {
    expect(api().normalizeKenyanPhone("254712345678")).toBe("254712345678");
  });

  it("returns null for invalid numbers", () => {
    expect(api().normalizeKenyanPhone("12345")).toBe(null);
    expect(api().normalizeKenyanPhone("0812345678")).toBe(null); // must start 0[17]
    expect(api().normalizeKenyanPhone("071234567")).toBe(null); // too short
    expect(api().normalizeKenyanPhone("07123456789")).toBe(null); // too long
    expect(api().normalizeKenyanPhone("")).toBe(null);
    expect(api().normalizeKenyanPhone(null)).toBe(null);
    expect(api().normalizeKenyanPhone(undefined)).toBe(null);
    expect(api().normalizeKenyanPhone("abcdef")).toBe(null);
  });
});

/* ---------- receipt logo + font size ---------- */
describe("receiptLogoMarkup", () => {
  it("returns an empty string when no logo URL is set", () => {
    api().setSettings({ receiptLogoUrl: "" });
    expect(api().receiptLogoMarkup()).toBe("");
    api().setSettings({ receiptLogoUrl: "   " });
    expect(api().receiptLogoMarkup()).toBe("");
  });

  it("renders an img tag for a valid https URL", () => {
    api().setSettings({
      receiptLogoUrl: "https://example.com/logo.png",
      receiptShopName: "DanLiz Shop",
    });
    const markup = api().receiptLogoMarkup();
    expect(markup).toContain('<img class="receipt-logo"');
    expect(markup).toContain('src="https://example.com/logo.png"');
    expect(markup).toContain('alt="DanLiz Shop logo"');
  });

  it("skips relative URLs (base defaults to about:blank in the sandbox)", () => {
    api().setSettings({ receiptLogoUrl: "icons/logo.svg" });
    api().setSettings({ receiptLogoUrl: "icons/logo.svg" });
    expect(api().receiptLogoMarkup()).toBe("");
  });

  it("rejects non-http protocols (javascript:, data:)", () => {
    for (const evil of ["javascript:alert(1)", "data:text/html;base64,xxx"]) {
      api().setSettings({ receiptLogoUrl: evil });
      expect(api().receiptLogoMarkup()).toBe("");
    }
  });

  it("escapes quotes in URLs and shop name", () => {
    api().setSettings({
      receiptLogoUrl: `https://example.com/a"b.png`,
      receiptShopName: `Shop "X"`,
    });
    const markup = api().receiptLogoMarkup();
    expect(markup).not.toContain('src="https://example.com/a"b.png"');
    expect(markup).toContain("&quot;");
  });
});

describe("getReceiptFontSize", () => {
  it("returns the configured size when within bounds", () => {
    api().setSettings({ receiptFontSize: 12 });
    expect(api().getReceiptFontSize()).toBe(12);
  });

  it("clamps to the minimum of 8", () => {
    api().setSettings({ receiptFontSize: 2 });
    expect(api().getReceiptFontSize()).toBe(8);
    api().setSettings({ receiptFontSize: -5 });
    expect(api().getReceiptFontSize()).toBe(8);
  });

  it("clamps to the maximum of 18", () => {
    api().setSettings({ receiptFontSize: 99 });
    expect(api().getReceiptFontSize()).toBe(18);
  });

  it("falls back to 10 for non-numeric or zero values", () => {
    api().setSettings({ receiptFontSize: 0 });
    expect(api().getReceiptFontSize()).toBe(10);
    api().setSettings({ receiptFontSize: "abc" });
    expect(api().getReceiptFontSize()).toBe(10);
  });
});

/* ---------- low stock ---------- */
describe("getLowStockThreshold", () => {
  it("returns the configured threshold when valid", () => {
    api().setSettings({ lowStockThreshold: 7 });
    expect(api().getLowStockThreshold()).toBe(7);
  });

  it("falls back to the default (5) for negative and non-integer values", () => {
    for (const bad of [-1, 2.5, "abc", undefined]) {
      api().setSettings({ lowStockThreshold: bad });
      expect(api().getLowStockThreshold()).toBe(5);
    }
  });

  it("treats null as zero (a valid threshold)", () => {
    api().setSettings({ lowStockThreshold: null });
    expect(api().getLowStockThreshold()).toBe(0);
  });
});

describe("getLowStockProducts", () => {
  it("includes only items at or below the threshold (some products have stock <= 10)", () => {
    api().setSettings({ lowStockThreshold: 0 });
    const none = api().getLowStockProducts();
    expect(none.every((p) => Number(p.stock) <= 0)).toBe(true);
    api().setSettings({ lowStockThreshold: 10 });
    const low = api().getLowStockProducts();
    expect(low.every((p) => Number(p.stock) <= 10)).toBe(true);
    expect(low.length).toBeGreaterThan(none.length);
  });

  it("sorts matching products by stock ascending then name", () => {
    const low = api().getLowStockProducts();
    expect(low.length).toBeGreaterThan(0);
    for (let i = 1; i < low.length; i += 1) {
      const prev = low[i - 1];
      const curr = low[i];
      expect(Number(prev.stock)).toBeLessThanOrEqual(Number(curr.stock));
      if (Number(prev.stock) === Number(curr.stock)) {
        expect(prev.name.localeCompare(curr.name)).toBeLessThanOrEqual(0);
      }
    }
    expect(low.every((p) => Number(p.stock) <= 10)).toBe(true);
  });

  it("respects a zero threshold (only out-of-stock items)", () => {
    api().setSettings({ lowStockThreshold: 0 });
    const low = api().getLowStockProducts();
    expect(low.every((p) => Number(p.stock) <= 0)).toBe(true);
  });

  it("includes every product when the threshold is very high", () => {
    api().setSettings({ lowStockThreshold: 100000 });
    expect(api().getLowStockProducts()).toHaveLength(ctx.__api.products.length);
  });

  it("restores the default threshold afterwards", () => {
    api().setSettings({ lowStockThreshold: 5 });
    expect(api().getLowStockThreshold()).toBe(5);
  });
});

/* ---------- Code 39 barcode ---------- */
describe("code39Svg", () => {
  it("wraps the encoded value in * start/stop characters", () => {
    const svg = api().code39Svg("F001");
    expect(svg).toContain('aria-label="Code 39 barcode F001"');
    // '*' = nwnnwnwnn = 2 wide + 7 narrow = 16; encoded len 6, gaps between
    // chars (5) counted before each character except the last => width 95.
    expect(svg).toContain('viewBox="0 0 95 40"');
  });

  it("renders only rect elements (bars) with width 1 or 3", () => {
    const svg = api().code39Svg("F001");
    expect(svg).toContain("<svg");
    const widths = [...svg.matchAll(/width="(\d+)"/g)].map((m) => m[1]);
    expect(widths.every((w) => w === "1" || w === "3")).toBe(true);
    expect(widths.length).toBeGreaterThan(0);
  });

  it("uppercases the code for encoding but keeps the original in the label", () => {
    const lower = api().code39Svg("f001");
    expect(lower).toContain('aria-label="Code 39 barcode f001"');
    expect(lower).toBe(
      api().code39Svg("F001").replace("barcode F001", "barcode f001"),
    );
  });

  it("replaces characters outside the Code 39 charset with dashes", () => {
    const svg = api().code39Svg("F0@01");
    expect(svg).toContain('aria-label="Code 39 barcode F0@01"'); // label keeps original
    const viewbox = svg.match(/viewBox="0 0 (\d+) 40"/);
    // "*F0-01*" = 7 chars, each 16 units wide minus trailing gap handling
    // => 7*16 - 1 = 111.
    expect(Number(viewbox[1])).toBe(111);
  });

  it("escapes the code in the aria-label to prevent attribute injection", () => {
    const svg = api().code39Svg(`F" onclick="x`);
    expect(svg).toContain("&quot;");
    expect(svg).not.toMatch(/aria-label="Code 39 barcode F" /);
  });

  it("produces deterministic output for the same input", () => {
    expect(api().code39Svg("F002")).toBe(api().code39Svg("F002"));
  });

  it("handles an empty code (encodes only the start/stop asterisks)", () => {
    const svg = api().code39Svg("");
    expect(svg).toContain('viewBox="0 0 31 40"'); // "*":16 + gap(1) + "*":16 - 2
  });
});

/* ---------- getTodayTillSummary ---------- */
describe("getTodayTillSummary", () => {
  const today = "17/10/2026";

  it("groups today's orders and totals by Till 1–4", () => {
    const summary = api().getTodayTillSummary(
      [
        { date: today, tillNumber: 1, total: 100 },
        { date: today, tillNumber: 1, total: 50 },
        { date: today, tillNumber: 4, total: 25 },
        { date: "16/10/2026", tillNumber: 2, total: 500 },
      ],
      today,
    );
    expect(summary.tills).toEqual([
      { tillNumber: 1, orders: 2, total: 150 },
      { tillNumber: 2, orders: 0, total: 0 },
      { tillNumber: 3, orders: 0, total: 0 },
      { tillNumber: 4, orders: 1, total: 25 },
    ]);
    expect(summary.total).toEqual({ orders: 3, total: 175 });
  });

  it("keeps sales without a valid till visible as unassigned", () => {
    const summary = api().getTodayTillSummary(
      [
        { date: today, total: 20 },
        { date: today, tillNumber: 5, total: 30 },
        { date: today, tillNumber: "x", total: 5 },
      ],
      today,
    );
    expect(summary.unassigned).toEqual({ orders: 3, total: 55 });
    expect(summary.total).toEqual({ orders: 3, total: 55 });
  });

  it("returns an all-zero summary for an empty sales list", () => {
    const summary = api().getTodayTillSummary([], today);
    expect(summary.total).toEqual({ orders: 0, total: 0 });
    expect(summary.unassigned).toEqual({ orders: 0, total: 0 });
    expect(summary.tills.every((t) => t.orders === 0 && t.total === 0)).toBe(
      true,
    );
  });

  it("ignores sales from other days entirely", () => {
    const summary = api().getTodayTillSummary(
      [{ date: "31/12/1999", tillNumber: 1, total: 9999 }],
      today,
    );
    expect(summary.total).toEqual({ orders: 0, total: 0 });
  });

  it("treats missing or non-numeric totals as zero but still counts the order", () => {
    const summary = api().getTodayTillSummary(
      [
        { date: today, tillNumber: 2, total: undefined },
        { date: today, tillNumber: 2, total: "x" },
      ],
      today,
    );
    expect(summary.tills[1]).toEqual({ tillNumber: 2, orders: 2, total: 0 });
  });

  it("coerces string till numbers to integers", () => {
    const summary = api().getTodayTillSummary(
      [{ date: today, tillNumber: "3", total: 10 }],
      today,
    );
    expect(summary.tills[2]).toEqual({ tillNumber: 3, orders: 1, total: 10 });
  });
});

/* ---------- getCashierId ---------- */
describe("getCashierId", () => {
  it("prefers username over email over name", () => {
    expect(
      api().getCashierId({
        username: "jdoe",
        email: "j@x.com",
        name: "John Doe",
      }),
    ).toBe("jdoe");
    expect(api().getCashierId({ email: "j@x.com", name: "John Doe" })).toBe(
      "j@x.com",
    );
    expect(api().getCashierId({ name: "John Doe" })).toBe("john doe");
  });

  it("trims and lowercases", () => {
    expect(api().getCashierId({ name: "  Amina  " })).toBe("amina");
    expect(api().getCashierId({ email: "  A@X.COM " })).toBe("a@x.com");
  });

  it("returns an empty string for nullish users or empty fields", () => {
    expect(api().getCashierId(null)).toBe("");
    evalIn(ctx, "currentUser = null;");
    expect(api().getCashierId(undefined)).toBe("");
    evalIn(ctx, "delete currentUser;");
    expect(api().getCashierId({})).toBe("");
    expect(api().getCashierId({ name: "" })).toBe("");
  });
});

describe("PIN account access", () => {
  function createPinContext(authenticatedUser) {
    const pinContext = createContext({
      users: [
        {
          uid: "staff-1",
          name: "Ada",
          username: "ada",
          email: "ada@example.com",
          role: "cashier",
          pin: "1234",
        },
      ],
      currentUser: null,
      normalizeIdentity: (value) => String(value || "").trim().toLowerCase(),
      window: { firebaseAuth: { currentUser: authenticatedUser } },
    });
    evalIn(
      pinContext,
      `${pinLoginFn}
      this.__loginWithPin = loginWithPin;`,
    );
    return pinContext;
  }

  it("rejects PIN access without an authenticated cloud user", () => {
    const pinContext = createPinContext(null);
    expect(pinContext.__loginWithPin("ada@example.com", "1234")).toBe(false);
    expect(pinContext.currentUser).toBeNull();
  });

  it("rejects PIN access when the authenticated UID does not match", () => {
    const pinContext = createPinContext({
      uid: "other-user",
      emailVerified: true,
    });
    expect(pinContext.__loginWithPin("ada@example.com", "1234")).toBe(false);
    expect(pinContext.currentUser).toBeNull();
  });
});
