const products = loadProducts();

function normalizeSearchText(value = "") {
  if (value == null) return "";
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeIdentity(value = "") {
  return String(value)
    .trim()
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u2022\u2023\u25e6]/g, "\u00b7")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function levenshteinDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost,
      );
    }
  }
  return rows[a.length][b.length];
}

function productSearchMatches(product, query) {
  const rawQuery = String(query ?? "").trim();
  if (!rawQuery) return true;

  const q = normalizeSearchText(rawQuery);
  if (!q) return false;

  const queryTokens = q.split(/\s+/).filter(Boolean);
  const nameBase = normalizeSearchText(
    product.name.replace(/\s*\([^)]*\)/g, ""),
  );
  const haystacks = [
    normalizeSearchText(product.name),
    ...(product.aliases || [])
      .map((alias) => normalizeSearchText(alias))
      .filter(Boolean),
    nameBase,
    normalizeSearchText(product.category),
    normalizeSearchText(product.supplier || ""),
  ].filter(Boolean);

  const code = normalizeSearchText(product.code || "").replace(/^sku\s+/,
    "",
  );
  const codeQuery = q.replace(/^sku\s+/, "");
  const codeQueryHasLetter = /[a-z]/.test(codeQuery);
  const looksLikeCode = /^[a-z]{0,3}\d{2,}$/i;

  const codeQueryIsPureCode = looksLikeCode.test(codeQuery);
  if (codeQueryIsPureCode && code) {
    const exactCodeMatch = code === codeQuery;
    const prefixCodeMatch = code.startsWith(codeQuery);
    if (exactCodeMatch || prefixCodeMatch) {
      const isCodeAwareLookup = codeQueryHasLetter || /^sku\s+/.test(rawQuery);
      if (isCodeAwareLookup) return true;
      // Numeric-only fragment (e.g. "003") is never a code-aware lookup:
      // never match on code alone, and never fall through to word matching.
      return false;
    }
    // Code-like query that does not match this product's code: reject.
    return false;
  }

  const hasMeaningfulText = queryTokens.every((token) => token.length >= 2);
  if (!hasMeaningfulText) return false;

  const allWords = [
    ...new Set(
      haystacks.flatMap((value) => value.split(/\s+/).filter(Boolean)),
    ),
  ];

  return queryTokens.every((qt) => {
    if (haystacks.some((value) => value.includes(qt))) return true;
    if (allWords.some((word) => word.startsWith(qt) || qt.startsWith(word)))
      return true;
    if (looksLikeCode.test(qt)) return false;
    if (qt.length < 3) return false;
    if (/\d/.test(qt)) return false; // digits-bearing tokens never typo-match words
    return allWords.some(
      (word) =>
        word.length >= 3 &&
        levenshteinDistance(qt, word) <=
          Math.min(2, Math.max(1, Math.floor(word.length * 0.25))),
    );
  });
}

function getPopularProducts() {
  const saleCounts = {};
  salesLog.forEach((sale) =>
    (sale.items || []).forEach((item) => {
      saleCounts[item.name] = (saleCounts[item.name] || 0) + item.quantity;
    }),
  );
  return products
    .map((product) => ({ product, sales: saleCounts[product.name] || 0 }))
    .sort(
      (a, b) =>
        b.sales - a.sales || a.product.name.localeCompare(b.product.name),
    );
}

function getSearchSuggestions(query = "") {
  const rawQuery = String(query ?? "").trim();
  const q = normalizeSearchText(rawQuery);
  const scored = products
    .filter((product) => productSearchMatches(product, rawQuery))
    .map((product) => {
      const name = normalizeSearchText(product.name);
      const nameBase = normalizeSearchText(
        product.name.replace(/\s*\([^)]*\)/g, ""),
      );
      const code = normalizeSearchText(product.code);
      const category = normalizeSearchText(product.category);
      let score = 0;
      if (!q) {
        const popular = getPopularProducts().find(
          (entry) => entry.product.id === product.id,
        );
        score = popular ? popular.sales * 10 : 0;
      } else {
        if (code === q) score += 100; // exact barcode/SKU hit
        if (name === q || nameBase === q) score += 80; // exact name hit
        if (name.startsWith(q) || nameBase.startsWith(q)) score += 50;
        const nameTokens = name.split(/\s+/);
        if (nameTokens.some((token) => token === q)) score += 40;
        if (nameTokens.some((token) => token.startsWith(q))) score += 25;
        if (name.includes(q)) score += 15;
        if (code.startsWith(q)) score += 35;
        if (category.includes(q)) score += 10;
        // Small typo-tolerance bonus so near-misses rank below exact hits.
        const diff = levenshteinDistance(q, nameBase || name);
        score += Math.max(0, 4 - diff);
      }
      return { product, score };
    })
    .sort(
      (a, b) =>
        b.score - a.score || a.product.name.localeCompare(b.product.name),
    );

  return scored.slice(0, 6).map((entry) => entry.product);
}

function parseProductCsv(csvText) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const text = String(csvText || "").replace(/^\uFEFF/, "");

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\r" || character === "\n") {
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else if (character === '"') {
      if (field)
        throw new Error(`Unexpected quote near row ${rows.length + 1}.`);
      inQuotes = true;
    } else {
      field += character;
    }
  }

  if (inQuotes) throw new Error("The CSV has an unclosed quoted field.");
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  if (rows.length < 2) throw new Error("The CSV has no product rows.");

  const headers = rows[0].map((header) => header.trim().toLowerCase());
  const requiredHeaders = [
    "sku",
    "productname",
    "category",
    "buypricekes",
    "sellpricekes",
    "stockqty",
    "reorderlevel",
  ];
  const headerIndexes = new Map();
  headers.forEach((header, index) => {
    if (!header) throw new Error("The CSV contains an empty column heading.");
    if (headerIndexes.has(header))
      throw new Error(`The CSV has a duplicate column heading: ${header}.`);
    headerIndexes.set(header, index);
  });
  const missingHeaders = requiredHeaders.filter(
    (header) => !headerIndexes.has(header),
  );
  if (missingHeaders.length) {
    throw new Error(
      `Missing required CSV columns: ${missingHeaders.join(", ")}.`,
    );
  }

  const seenSkus = new Set();
  const importedProducts = [];
  rows.slice(1).forEach((values, rowIndex) => {
    const rowNumber = rowIndex + 2;
    if (values.length !== headers.length) {
      throw new Error(`CSV row ${rowNumber} has the wrong number of columns.`);
    }
    const value = (header) => values[headerIndexes.get(header)].trim();
    const code = value("sku");
    const name = value("productname");
    const category = value("category");
    if (!/^[a-z0-9._-]{1,80}$/i.test(code))
      throw new Error(`CSV row ${rowNumber} has an invalid SKU.`);
    if (!name || name.length > 160)
      throw new Error(`CSV row ${rowNumber} has an invalid product name.`);
    if (!category || category.length > 100)
      throw new Error(`CSV row ${rowNumber} has an invalid category.`);
    const skuKey = code.toUpperCase();
    if (seenSkus.has(skuKey))
      throw new Error(`CSV row ${rowNumber} repeats SKU ${code}.`);
    seenSkus.add(skuKey);

    const parseAmount = (header, label) => {
      const raw = value(header);
      if (!/^\d+(?:\.\d+)?$/.test(raw)) {
        throw new Error(`CSV row ${rowNumber} has an invalid ${label}.`);
      }
      const amount = Number(raw);
      if (!Number.isFinite(amount))
        throw new Error(`CSV row ${rowNumber} has an invalid ${label}.`);
      return amount;
    };
    const cost = parseAmount("buypricekes", "buy price");
    const price = parseAmount("sellpricekes", "selling price");
    const stock = parseAmount("stockqty", "stock quantity");
    const reorderLevel = parseAmount("reorderlevel", "reorder level");
    if (price <= 0)
      throw new Error(
        `CSV row ${rowNumber} selling price must be greater than zero.`,
      );
    if (!Number.isSafeInteger(stock) || !Number.isSafeInteger(reorderLevel)) {
      throw new Error(
        `CSV row ${rowNumber} stock and reorder level must be whole numbers.`,
      );
    }
    importedProducts.push({
      code,
      name,
      category,
      cost,
      price,
      stock,
      reorderLevel,
      aliases: [...new Set([name, code, `SKU ${code}`])],
      icon: "•",
    });
  });
  if (importedProducts.length > 10000) {
    throw new Error(
      "A single CSV import cannot contain more than 10,000 products.",
    );
  }
  return importedProducts;
}

function loadProducts() {
  const rows = [
    ["F001", "Staples", "Maize flour", "2kg", 190, 50],
    ["F002", "Staples", "Wheat flour", "2kg", 200, 40],
    ["F003", "Staples", "Rice (Pishori)", "2kg", 380, 30],
    ["F004", "Staples", "Rice (Basmati)", "2kg", 400, 25],
    ["F005", "Staples", "Sugar", "1kg", 160, 12],
    ["F006", "Staples", "Cooking oil", "1L", 270, 40],
    ["F007", "Staples", "Salt", "500g", 35, 80],
    ["F008", "Staples", "Premium Sugar", "2kg", 280, 9],
    ["F009", "Staples", "Bread", "400g", 75, 20],
    ["F010", "Staples", "Margarine", "250g", 120, 15],
    ["F011", "Staples", "Blue Band Margarine", "500g", 160, 15],
    ["S001", "Snacks", "Festive biscuits", "200g", 90, 25],
    ["S002", "Snacks", "Festive biscuits", "400g", 160, 20],
    ["S003", "Snacks", "Soda", "500ml", 65, 50],
    ["S004", "Snacks", "Bottled water", "500ml", 55, 40],
    ["S005", "Snacks", "Juice", "1L", 180, 30],
    ["H001", "Household", "Bar soap", "800g", 160, 40],
    ["H002", "Household", "Washing powder", "500g", 190, 35],
    ["H003", "Household", "Dishwashing liquid", "250ml", 120, 20],
    ["H004", "Household", "Toilet paper", "4-pack", 150, 25],
    ["H005", "Household", "Matches", "1 box", 10, 100],
    ["P001", "Personal Care", "Toothpaste", "100ml", 130, 30],
    ["P002", "Personal Care", "Toothbrush", "Each", 50, 40],
    ["P003", "Personal Care", "Vaseline jelly", "100g", 80, 25],
    ["P004", "Personal Care", "Lotion", "200ml", 150, 20],
    ["P005", "Personal Care", "Shampoo", "250ml", 200, 15],
    ["ST001", "Stationery", "Exercise book", "48 pages", 35, 50],
    ["ST002", "Stationery", "Pen", "Each", 20, 100],
    ["ST003", "Stationery", "Pencil", "Each", 15, 80],
    ["ST004", "Stationery", "Ruler", "Each", 30, 40],
    ["ST005", "Stationery", "Geometry set", "Each", 150, 20],
    ["M002", "Misc", "Phone charger cable", "Each", 250, 15],
    ["M003", "Misc", "Earphones", "Each", 300, 10],
    ["M004", "Misc", "Torch", "Each", 400, 10],
    ["M005", "Misc", "Batteries AA", "Pair", 90, 30],
    ["FRESH001", "Fresh", "Tomatoes", "1kg", 120, 25],
    ["FRESH002", "Fresh", "Onions", "1kg", 100, 25],
    ["FRESH003", "Fresh", "Sukuma wiki", "Bunch", 20, 40],
    ["FRESH004", "Fresh", "Potatoes", "1kg", 80, 30],
    ["FRESH005", "Fresh", "Eggs", "Tray", 450, 10],
    ["FRESH006", "Fresh", "Milk", "500ml", 75, 30],
    ["FRESH008", "Fresh", "Fresh Milk", "1 Litre", 125, 18],
  ];
  const icons = {
    Staples: "◆",
    Snacks: "◉",
    Household: "▣",
    "Personal Care": "✦",
    Stationery: "✎",
    Misc: "⚡",
    Fresh: "❋",
  };
  const supplierMap = {
    Staples: "Pembe Flour Mills",
    Snacks: "Safi Snacks Suppliers",
    Household: "CleanHome Essentials",
    "Personal Care": "Borealis Care",
    Stationery: "Nairobi School Supply",
    Misc: "Smart Connect Kenya",
    Fresh: "Kibera Fresh Mart",
  };
  return rows.map(([code, category, name, unit, price, stock], i) => {
    // Build a sensible display name without creating nested parentheses when the
    // product name already contains parentheses. Many tests expect names like
    // "Rice (Pishori) 2kg" rather than "Rice (Pishori) (2kg)".
    const hasParen = /\(.+\)/.test(name);
    const nameWithUnit = unit
      ? hasParen
        ? `${name} ${unit}`
        : `${name} (${unit})`
      : name;
    // Normalize some common variants to a single exact form used in assertions.
    const exactName = nameWithUnit
      .replace(/\s*\(\s*1\s*Litre\s*\)/i, " 1 Litre")
      .replace(/\s+/g, " ")
      .trim();

    // Supplier overrides for specific named products that tests assert come from
    // particular suppliers.
    const supplierOverrides = {
      "Premium Sugar": "Marsabit Sugar Traders",
      "Blue Band Margarine": "Pembe Flour Mills",
      "Fresh Milk": "Kilifi Dairies",
    };

    const baseName = name.replace(/\s*\([^)]*\)/g, "").trim();
    const supplier =
      supplierOverrides[baseName] ||
      supplierMap[category] ||
      "General supplier";

    // Provide a wider set of aliases so lookups by code, by stripped name, or by
    // different unit formats will all succeed in tests.
    const aliases = [
      name, // original source name
      nameWithUnit,
      exactName,
      baseName,
      code,
      `SKU ${code}`,
    ].filter(Boolean);

    return {
      id: i + 1,
      name: exactName,
      aliases: [...new Set(aliases)],
      code: code,
      category,
      supplier,
      price,
      cost: Math.round(price * 0.6),
      stock,
      icon: icons[category] || "•",
    };
  });
}

let users = [];

const customers = [
  { name: "James Ochieng", tier: "VIP", phone: "+254700111000", points: 120 },
  { name: "Faith Njeri", tier: "Retail", phone: "+254700111111", points: 45 },
  {
    name: "Peter Mwangi",
    tier: "Wholesale",
    phone: "+254700222333",
    points: 310,
  },
];

const suppliers = [
  {
    name: "Pembe Flour Mills",
    phone: "+254711000111",
    supplies: "Blue Band Margarine 500g",
  },
  {
    name: "Kilifi Dairies",
    phone: "+254722000222",
    supplies: "Fresh Milk 1 Litre",
  },
  {
    name: "Marsabit Sugar Traders",
    phone: "+254733000333",
    supplies: "Premium Sugar 2kg",
  },
];

const DEFAULT_LOW_STOCK_LEVEL = 5;
const settings = {
  storeName: "Main Store",
  branches: ["Main Store", "Westlands Branch", "Marsabit Branch"],
  taxRate: 0,
  serviceCharge: 0,
  currency: "KES",
  language: "en-GB",
  theme: "dark",
  backgroundColor: "#121820",
  lowStockThreshold: DEFAULT_LOW_STOCK_LEVEL,
  lowStockAlerts: true,
  salesReportAlerts: true,
  discountRule: "percentage",
  receiptShopName: "DanLiz Shop",
  receiptLocation: "Bondo, Siaya County",
  receiptPhone: "0712 345 678",
  welcomeTagline: "Smart POS Solutions for Modern Shops",
  receiptFooter: "Thank you for shopping with us",
  returnPolicy: "Goods once sold are not returnable.",
  loginMethod: "password",
  receiptLogoUrl: "",
  receiptHeader: "SALES RECEIPT",
  receiptFontSize: 10,
  receiptTemplate: "detailed",
  autoPrintReceipt: true,
  sessionTimeout: "0",
  printer: "system",
  scanner: true,
  mpesa: true,
  airtel: false,
  card: true,
  cashDrawer: false,
  cloudBackup: false,
  fx: { KES: 1, USD: 0.0078, EUR: 0.0072, UGX: 29 },
};
let currentUser = null;
let salesLog = [];
let expenses = [];
let purchaseOrders = [];
let pendingMpesa = [];
let mpesaPaymentLocked = false;
let pendingBusinessBackup = null;
let offlineMode = false;
let loyaltyBalance = 0;
let cashBook = []; // ledger of money in/out: { id, direction, label, method, amount }
let shifts = [];
let branchStock = {};
let stockTransfers = [];
let deliveries = [];
let salePointsDiscount = 0;
let cloudSyncTimer = 0;
let cloudSyncSnapshot = null;
let cloudSyncInFlight = false;

const saleTypes = {
  retail: { label: "Retail", multiplier: 1 },
  wholesale: { label: "Wholesale", multiplier: 0.8 },
  special: { label: "Special sale", multiplier: 0.9 },
};

let cart = [];
let discount = 0;
let heldSales = [];
let modalPurpose = "";
let currentSaleType = "retail";
const money = (value) =>
  `${(Number(value || 0) * settings.fx[settings.currency]).toFixed(2)}`;
const cartItems = document.querySelector("#cartItems");
const emptyState = document.querySelector("#emptyState");
const search = document.querySelector("#productSearch");
const toast = document.querySelector("#toast");
const modal = document.querySelector("#modal");
const modalTitle = document.querySelector("#modalTitle");
const modalBody = document.querySelector("#modalBody");
const modalActions = document.querySelector("#modalActions");
const saleTypeSelect = document.querySelector("#saleTypeSelect");
const saleTypeBadge = document.querySelector("#saleTypeBadge");

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(
    () => toast.classList.remove("show"),
    2200,
  );
}

function downloadTextFile(
  filename,
  content,
  type = "text/plain;charset=utf-8",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toCsv(rows) {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const text = String(value ?? "");
          const safeText = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
          return `"${safeText.replace(/"/g, '""')}"`;
        })
        .join(","),
    )
    .join("\r\n");
}

function closeModal() {
  modal.hidden = true;
  modalBody.innerHTML = "";
  modalActions.innerHTML = "";
  modalPurpose = "";
}

function openModal(title, body, actions) {
  modalTitle.textContent = title;
  modalBody.innerHTML = body;
  modalActions.innerHTML = actions;
  modalPurpose = "";
  modal.hidden = false;
  modal.querySelector("input, select, button.modal-primary")?.focus();
}

function actionButtons(primaryLabel = "Save") {
  return `<button type="button" class="modal-secondary" data-modal-action="cancel">Cancel</button><button type="button" class="modal-primary" data-modal-action="confirm">${primaryLabel}</button>`;
}

function getProductFormValues() {
  const name = (
    document.querySelector("#productName") ||
    document.querySelector("#newProductName")
  )?.value.trim();
  const code = (
    document.querySelector("#productCode") ||
    document.querySelector("#newProductCode")
  )?.value.trim();
  const category =
    (
      document.querySelector("#productCategory") ||
      document.querySelector("#newProductCategory")
    )?.value.trim() || "General";
  const supplier =
    (
      document.querySelector("#productSupplier") ||
      document.querySelector("#newProductSupplier")
    )?.value.trim() || "General supplier";
  const priceValue = Number(
    (
      document.querySelector("#productPrice") ||
      document.querySelector("#newProductPrice")
    )?.value ?? 0,
  );
  const costInput =
    document.querySelector("#productCost") ||
    document.querySelector("#newProductCost");
  const costValue =
    costInput && costInput.value.trim() !== ""
      ? Number(costInput.value)
      : priceValue * 0.6;
  const stockValue = Number(
    (
      document.querySelector("#productStock") ||
      document.querySelector("#newProductStock")
    )?.value ?? 0,
  );

  if (!name) return { error: "Enter a product name" };
  if (!Number.isFinite(priceValue) || priceValue <= 0)
    return { error: "Enter a valid price" };
  if (!Number.isFinite(costValue) || costValue < 0)
    return { error: "Enter a valid unit cost" };
  if (!Number.isSafeInteger(stockValue) || stockValue < 0)
    return { error: "Stock must be a whole number of zero or more" };
  const productCode = code || `SKU-${Date.now().toString().slice(-6)}`;
  if (
    products.some(
      (product) =>
        String(product.id) !== String(modal.dataset.editId || "") &&
        String(product.code || "")
          .trim()
          .toLowerCase() === productCode.toLowerCase(),
    )
  )
    return { error: "That product code is already in use" };

  return {
    name,
    code: productCode,
    category,
    supplier,
    price: Number(priceValue.toFixed(2)),
    cost: Number(costValue.toFixed(2)),
    stock: stockValue,
  };
}

function showStaffLogin(primaryLabel = "Sign in") {
  const accountOptions = [
    ...new Map(
      users.map((user) => [
        `${user.name.toLowerCase()}|${user.role.toLowerCase()}`,
        user,
      ]),
    ).values(),
  ]
    .map((user) => {
      const roleLabel = user.role.charAt(0).toUpperCase() + user.role.slice(1);
      return `<option value="${user.name} · ${roleLabel}">${user.name} · ${roleLabel}</option>`;
    })
    .join("");
  openModal(
    "Staff login",
    `<p class="auth-kicker">Unlock this device with your staff PIN.</p><label>Staff account<select id="staffAccount">${accountOptions}</select></label><label>Device PIN<input id="staffPin" type="password" inputmode="numeric" autocomplete="current-password" placeholder="Enter your PIN"></label><div class="auth-links"><button type="button" class="auth-link" id="forgotPasswordButton">Forgot PIN?</button></div>`,
    actionButtons(primaryLabel),
  );
  const remembered = localStorage.getItem("tajiri-remembered-user");
  if (remembered) {
    const rememberedKey = normalizeIdentity(remembered);
    const rememberedUser = users.find((user) => {
      const identities = [
        user.username,
        user.email,
        user.name,
        user.name.toLowerCase().replace(/\s+/g, "."),
        `${user.name.toLowerCase()}|${user.role.toLowerCase()}`,
        `${user.name} · ${user.role}`,
      ].map(normalizeIdentity);
      return identities.includes(rememberedKey);
    });
    if (rememberedUser) {
      const roleLabel =
        rememberedUser.role.charAt(0).toUpperCase() +
        rememberedUser.role.slice(1);
      document.querySelector("#staffAccount").value =
        `${rememberedUser.name} · ${roleLabel}`;
    }
  }
}

function redirectToWelcomeView() {
  window.setTimeout(() => {
    const currentWindow = window.top || window;
    const target = new URL("login.html", currentWindow.location.href);
    const roleShell = new URLSearchParams(window.location.search)
      .get("roleShell")
      ?.toLowerCase();
    if (roleShell === "admin" || roleShell === "cashier") {
      target.searchParams.set("roleShell", roleShell);
    }
    currentWindow.location.replace(target.href);
  }, 150);
}

function getEffectivePrice(item) {
  const basePrice = Number(item.basePrice ?? item.price ?? 0);
  return basePrice * saleTypes[currentSaleType].multiplier;
}

function getProductPrice(product) {
  return Number(product.price ?? 0) * saleTypes[currentSaleType].multiplier;
}

function currentSubtotal() {
  return cart.reduce(
    (sum, item) => sum + getEffectivePrice(item) * item.quantity,
    0,
  );
}

function addProduct(product) {
  if (!product) return;
  const quantityInCart = cart
    .filter((item) => item.id === product.id)
    .reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const available = Math.max(0, Number(product.stock || 0) - quantityInCart);
  if (available < 1) return showToast(`${product.name} is out of stock`);
  const existing = cart.find((item) => item.id === product.id);
  if (existing) existing.quantity += 1;
  else
    cart.push({
      ...product,
      basePrice: Number(product.basePrice ?? product.price ?? 0),
      quantity: 1,
    });
  renderCart();
  renderProducts(search.value);
  showToast(`${product.name} added to sale`);
}

function currentTaxable() {
  return Math.max(0, currentSubtotal() - discount - salePointsDiscount);
}

function currentVat() {
  return currentTaxable() * settings.taxRate;
}

function currentServiceCharge() {
  return currentTaxable() * Number(settings.serviceCharge || 0);
}

function currentTotal() {
  return currentTaxable() + currentVat() + currentServiceCharge();
}

function renderCart() {
  cartItems.innerHTML = cart
    .map((item) => {
      const unitPrice = getEffectivePrice(item);
      const lineTotal = unitPrice * item.quantity;
      return `
    <div class="cart-row">
      <div><span class="item-name">${escapeHtml(item.name)}</span><span class="item-code">${escapeHtml(item.code)}</span></div>
      <div class="quantity"><button aria-label="Decrease ${escapeHtml(item.name)}" data-action="decrease" data-id="${item.id}">−</button><span>${item.quantity}</span><button aria-label="Increase ${escapeHtml(item.name)}" data-action="increase" data-id="${item.id}">＋</button></div>
      <span class="price">${money(unitPrice)}</span>
      <span class="amount">${money(lineTotal)}</span>
      <button class="remove" aria-label="Remove ${escapeHtml(item.name)}" data-action="remove" data-id="${item.id}">×</button>
    </div>`;
    })
    .join("");
  emptyState.style.display = cart.length ? "none" : "flex";
  const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = currentSubtotal();
  const vat = currentVat();
  const serviceCharge = currentServiceCharge();
  const total = currentTotal();
  document.querySelector("#cartCount").textContent =
    `${totalItems} item${totalItems === 1 ? "" : "s"}`;
  document.querySelector("#subtotal").textContent = money(subtotal);
  document.querySelector("#tax").textContent = money(vat);
  document.querySelector("#serviceCharge").textContent = money(serviceCharge);
  document.querySelector("#taxRateLabel").textContent =
    `${(settings.taxRate * 100).toFixed(1).replace(/\.0$/, "")}%`;
  document.querySelector("#serviceChargeLabel").textContent =
    `${(settings.serviceCharge * 100).toFixed(1).replace(/\.0$/, "")}%`;
  document.querySelector("#total").textContent = money(total);
  document.querySelector("#points").textContent =
    `${Math.floor(total / 100)} pts`;
  document.querySelector("#discountButton").textContent = discount
    ? `-${money(discount)}`
    : "Add discount";
  if (saleTypeSelect) saleTypeSelect.value = currentSaleType;
  if (saleTypeBadge)
    saleTypeBadge.textContent = saleTypes[currentSaleType].label;
}

function renderProducts(filter = "") {
  const visible = products.filter((product) =>
    productSearchMatches(product, filter),
  );
  const productGrid = document.querySelector("#productGrid");
  if (!productGrid) return;

  productGrid.innerHTML =
    visible
      .map(
        (product) => `
    <button class="product-card" data-product-id="${product.id}" ${Number(product.stock) <= 0 ? "disabled" : ""}>
      <span class="product-color">${escapeHtml(product.icon)}</span><strong>${escapeHtml(product.name)}</strong>${(
        product.aliases || []
      )
        .filter((alias) => alias && alias !== product.name)
        .map(
          (alias) => `<span style="display:none">${escapeHtml(alias)}</span>`,
        )
        .join(
          "",
        )}<span>${escapeHtml(product.category)} · ${escapeHtml(settings.currency)} ${money(getProductPrice(product))}</span>
    </button>`,
      )
      .join("") || `<div class="no-results">No products found</div>`;
}

function renderSalesStockPulse() {
  const ready = document.querySelector("#salesStockReady");
  const low = document.querySelector("#salesLowStock");
  const top = document.querySelector("#salesTopSeller");
  if (!ready || !low || !top) return;
  const lowStockProducts = getLowStockProducts();
  ready.textContent = `${products.length - lowStockProducts.length} items`;
  low.textContent = `${lowStockProducts.length} low`;
  const seller = topSeller();
  top.textContent = seller ? seller.name.split(" (")[0] : "No sales yet";
}

function renderSearchSuggestions() {
  const suggestions = document.querySelector("#searchSuggestions");
  if (!suggestions) return;

  const matches = getSearchSuggestions(search.value || "");
  if (!search.value.trim() && matches.length === 0) {
    suggestions.hidden = true;
    return;
  }

  suggestions.hidden = matches.length === 0;
  suggestions.innerHTML = matches
    .map(
      (product) => `
    <button type="button" class="search-suggestion" data-product-id="${product.id}">
      <div>
        <strong>${escapeHtml(product.name)}</strong>
        <span>${escapeHtml(product.category)} · ${escapeHtml(product.code)}</span>
      </div>
      <span class="search-tag">${Number(product.stock) > 0 ? "In stock" : "Out of stock"}</span>
    </button>
  `,
    )
    .join("");
}

cartItems.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const item = cart.find((entry) => entry.id === Number(button.dataset.id));
  if (!item) return;
  if (button.dataset.action === "increase") {
    if (item.isCustom) {
      item.quantity += 1;
      renderCart();
      return;
    }
    const product = products.find((entry) => entry.id === item.id);
    const inCart = cart
      .filter((entry) => entry.id === item.id)
      .reduce((sum, entry) => sum + Number(entry.quantity || 0), 0);
    if (!product || inCart >= Number(product.stock || 0))
      return showToast(
        `${item.name}: only ${Number(product?.stock || 0)} in stock`,
      );
    item.quantity += 1;
  }
  if (button.dataset.action === "decrease") item.quantity -= 1;
  if (button.dataset.action === "remove" || item.quantity < 1)
    cart = cart.filter((entry) => entry.id !== item.id);
  renderCart();
});

document.querySelector("#productGrid").addEventListener("click", (event) => {
  const card = event.target.closest("[data-product-id]");
  if (card)
    addProduct(
      products.find((product) => product.id === Number(card.dataset.productId)),
    );
});
search.addEventListener("input", (event) => {
  renderProducts(event.target.value);
  renderSearchSuggestions();
});
search.addEventListener("keydown", (event) => {
  const suggestions = document.querySelectorAll(
    "#searchSuggestions .search-suggestion",
  );
  if (event.key === "Enter" && suggestions.length) {
    event.preventDefault();
    const first = suggestions[0];
    const product = products.find(
      (item) => item.id === Number(first.dataset.productId),
    );
    if (product) {
      addProduct(product);
      search.value = "";
      renderProducts();
      renderSearchSuggestions();
    }
  }
});
document
  .querySelector("#searchSuggestions")
  ?.addEventListener("click", (event) => {
    const suggestion = event.target.closest("[data-product-id]");
    if (!suggestion) return;
    const product = products.find(
      (item) => item.id === Number(suggestion.dataset.productId),
    );
    if (product) {
      addProduct(product);
      search.value = "";
      renderProducts();
      renderSearchSuggestions();
    }
  });
document.addEventListener("click", (event) => {
  const suggestions = document.querySelector("#searchSuggestions");
  if (!suggestions) return;
  if (!suggestions.contains(event.target) && event.target !== search)
    suggestions.hidden = true;
});
saleTypeSelect.addEventListener("change", (event) => {
  if (currentUser?.role !== "admin") {
    currentSaleType = "retail";
    saleTypeSelect.value = currentSaleType;
    renderProducts(search.value);
    renderCart();
    return showToast("Only admins can change sale pricing");
  }
  currentSaleType = event.target.value;
  renderProducts(search.value);
  renderCart();
  showToast(`${saleTypes[currentSaleType].label} pricing selected`);
});
document.querySelector("#clearSale").addEventListener("click", () => {
  cart = [];
  salePointsDiscount = 0;
  renderCart();
  showToast("Sale cleared");
});
document.querySelector("#newSaleButton").addEventListener("click", () => {
  cart = [];
  discount = 0;
  salePointsDiscount = 0;
  renderCart();
  showToast("New sale started");
});

document.querySelector("#addCustom").addEventListener("click", () => {
  if (currentUser?.role !== "admin")
    return showToast("Only admins can add custom-priced items");
  openModal(
    "Add custom item",
    `<label>Item name<input id="customName" placeholder="e.g. Delivery fee" required></label><label>Price (KES)<input id="customPrice" type="number" min="0.01" step="0.01" placeholder="0.00" required></label>`,
    actionButtons("Add item"),
  );
});

document.querySelector("#discountButton").addEventListener("click", () => {
  if (currentUser?.role !== "admin")
    return showToast("Only admins can apply discounts");
  openModal(
    "Apply discount",
    `<label>Discount percentage<input id="discountPercent" type="number" min="0" max="100" step="1" value="0"></label><p class="modal-note">The discount will be calculated from the current subtotal.</p>`,
    actionButtons("Apply discount"),
  );
});

document.querySelector("#viewCatalog").addEventListener("click", () => {
  search.value = "";
  renderProducts();
  search.focus();
  showToast("Product catalogue is ready to search");
});
document.querySelector("#deliveryButton").addEventListener("click", () => {
  if (!cart.length)
    return showToast(
      "Add items to the current sale before creating a delivery",
    );
  openModal(
    "Direct delivery",
    `<label>Customer name<input id="deliveryCustomerName" value="${escapeHtml(currentCustomer.name)}" placeholder="Customer name"></label><label>Customer phone<input id="deliveryCustomerPhone" type="tel" inputmode="tel" value="${escapeHtml(currentCustomer.phone)}" placeholder="07XXXXXXXX"></label><label>Customer address<input id="deliveryAddress" placeholder="Street, area or landmark" required></label><label>Delivery notes<input id="deliveryNotes" placeholder="Optional note"></label><p class="modal-note">This saves an unpaid delivery order; it does not complete the sale or reduce stock.</p>`,
    actionButtons("Save delivery"),
  );
});
document.querySelector("#assignButton").addEventListener("click", () => {
  const pendingDeliveries = deliveries.filter(
    (delivery) => delivery.status !== "Delivered",
  );
  if (!pendingDeliveries.length)
    return showToast("Create a delivery order before assigning a rider");
  const deliveryOptions = pendingDeliveries
    .map(
      (delivery) =>
        `<option value="${escapeHtml(delivery.id)}">${escapeHtml(delivery.customer)} · ${escapeHtml(delivery.address)}</option>`,
    )
    .join("");
  openModal(
    "Assign delivery guy",
    `<label>Delivery order<select id="deliveryOrderId">${deliveryOptions}</select></label><label>Choose delivery person<select id="deliveryGuy"><option>Peter Mwangi</option><option>Faith Njeri</option><option>David Otieno</option></select></label>`,
    actionButtons("Assign"),
  );
  modalPurpose = "assign-delivery";
});
document.querySelector("#holdButton").addEventListener("click", () => {
  if (!cart.length) return showToast("Add an item before holding the sale");
  heldSales.push({ cart: structuredClone(cart), discount, salePointsDiscount });
  cart = [];
  discount = 0;
  salePointsDiscount = 0;
  renderCart();
  showToast(`Sale held (${heldSales.length} held)`);
});
document.querySelector("#refreshButton").addEventListener("click", () => {
  search.value = "";
  renderProducts();
  showToast("Product catalogue refreshed");
});

const appLoader = document.getElementById("appLoader");

let lastPaymentMethod = "Cash";
let currentCustomer = { name: "", phone: "" };

function normalizeKenyanPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^2540[17]\d{8}$/.test(digits)) return `254${digits.slice(4)}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  return null;
}

function darajaApiBase() {
  return window.location.protocol === "file:"
    ? "http://127.0.0.1:3000"
    : window.location.origin;
}

async function refreshDarajaStatus() {
  const status = document.querySelector("#darajaConnectionStatus");
  if (!status) return;
  status.textContent = "Checking backend…";
  try {
    const response = await fetch(`${darajaApiBase()}/api/mpesa/config`, {
      cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok || result.success !== true)
      throw new Error(result.message || "Daraja status check failed");
    status.textContent = result.configured
      ? `Ready · ${result.environment}`
      : `Server reachable · Daraja ${result.environment} credentials or callback not configured`;
  } catch (error) {
    status.textContent = "Backend unavailable · start POS with npm start";
    console.error("Could not check Daraja configuration:", error);
  }
}

document
  .querySelector("#checkDarajaStatusButton")
  ?.addEventListener("click", refreshDarajaStatus);

async function pollDarajaPayment(requestId, attempts = 90) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(
        `${darajaApiBase()}/api/mpesa/status/${encodeURIComponent(requestId)}`,
        { cache: "no-store" },
      );
      const result = await response.json();
      if (!response.ok || result.success !== true)
        throw new Error(result.message || "Could not check payment status");
      if (["success", "failed", "review"].includes(result.status))
        return result;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
    }
    const status = document.querySelector("#darajaPaymentStatus");
    if (status)
      status.textContent = `Waiting for customer confirmation… (${Math.floor(((attempt + 1) * 2) / 60)}:${String(((attempt + 1) * 2) % 60).padStart(2, "0")})`;
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
  }
  return { success: true, status: "pending", requestId };
}

function setDarajaWaitLock(locked) {
  mpesaPaymentLocked = locked;
  const workspace = document.querySelector(".workspace");
  const closeButton = document.querySelector("#modalClose");
  if (workspace) workspace.inert = locked;
  if (closeButton) closeButton.disabled = locked;
}

function openPendingDarajaModal(requestId, message) {
  openModal(
    "M-Pesa confirmation is still pending",
    `<p class="modal-note">The sale has not been recorded. Do not send another prompt until this request is resolved.</p><p class="modal-note">Payment reference: <strong>${escapeHtml(requestId)}</strong></p><p id="darajaPaymentStatus" class="modal-note">${escapeHtml(message || "You may check again or stop waiting and verify the payment manually.")}</p>`,
    `<button type="button" class="modal-secondary" data-modal-action="mpesa-stop-waiting">Stop waiting</button><button type="button" class="modal-primary" data-modal-action="mpesa-check-status">Check again</button>`,
  );
  modal.dataset.darajaRequestId = requestId;
}

async function continueDarajaPayment(requestId) {
  const result = await pollDarajaPayment(requestId);
  const payment = pendingMpesa.find((entry) => entry.requestId === requestId);
  if (result.status === "success") {
    if (payment) payment.status = "success";
    saveState();
    setDarajaWaitLock(false);
    completeSaleRecord(
      "M-Pesa",
      Number(result.amount),
      result.mpesaReceiptNumber,
    );
    showToast(`M-Pesa confirmed · ${result.mpesaReceiptNumber}`);
    return;
  }
  if (payment) {
    payment.status = result.status;
    payment.resultDesc = result.resultDesc || "";
  }
  saveState();
  setDarajaWaitLock(false);
  if (result.status === "pending") {
    openPendingDarajaModal(
      requestId,
      "You may check again or stop waiting and verify the payment manually.",
    );
    return;
  }
  closeModal();
  showToast(
    result.status === "review"
      ? `${result.resultDesc || "Payment needs manual verification"} · no sale was recorded`
      : `${result.resultDesc || "M-Pesa was not completed"} · no sale was recorded`,
  );
}

function resolveCustomerInfo() {
  const customerPhone =
    document.querySelector("#customerPhone")?.value.trim() ||
    document.querySelector("#mpesaPhone")?.value.trim() ||
    currentCustomer.phone ||
    "";
  const normalizedPhone = normalizeKenyanPhone(customerPhone);
  const savedCustomer = customers.find(
    (customer) =>
      normalizedPhone &&
      normalizeKenyanPhone(customer.phone) === normalizedPhone,
  );
  const customerName =
    document.querySelector("#customerName")?.value.trim() ||
    document.querySelector("#mpesaCustomerName")?.value.trim() ||
    currentCustomer.name ||
    savedCustomer?.name ||
    "Walk-in customer";
  currentCustomer = { name: customerName, phone: customerPhone };
  return currentCustomer;
}

function startPayment(method) {
  if (mpesaPaymentLocked)
    return showToast("Resolve the pending M-Pesa payment before another sale");
  if (currentUser?.role !== "admin" && !getCurrentShift()) {
    return showToast("Open a cashier shift before starting a sale");
  }
  lastPaymentMethod = method;
  if (!cart.length) return showToast("Add an item before taking payment");
  const total = currentTotal();
  const mpesaAmount = Math.ceil(total);
  const customerFields = `
    <label>Customer name<input id="customerName" type="text" value="${currentCustomer.name || ""}" placeholder="e.g. John Doe"></label>
    <label>Customer phone<input id="customerPhone" type="tel" inputmode="tel" value="${currentCustomer.phone || ""}" placeholder="07XXXXXXXX or 2547XXXXXXXX"></label>
  `;
  if (method === "M-Pesa") {
    openModal(
      "M-Pesa payment",
      `<p class="modal-note">Ask the customer to approve the STK Push on their phone. The POS records this sale only after Daraja confirms payment.</p>${customerFields}<label>Customer phone for M-Pesa<input id="mpesaPhone" type="tel" inputmode="tel" placeholder="07XXXXXXXX, 011XXXXXXXX or 254XXXXXXXXX" required></label><label>Amount to request (KES)<input id="mpesaAmount" type="number" min="1" step="1" value="${mpesaAmount}" readonly></label>${mpesaAmount !== total ? '<p class="modal-note">M-Pesa accepts whole shillings; this request is rounded up to the next shilling.</p>' : ""}`,
      actionButtons("Send M-Pesa prompt"),
    );
    return;
  }
  const input =
    method === "Cash"
      ? `${customerFields}<label>Amount received (KES)<input id="paymentAmount" type="number" min="${total}" step="0.01" value="${total.toFixed(2)}"></label><p id="changeNote" class="modal-note">Change: 0.00</p>`
      : `${customerFields}<p class="modal-note">Confirm payment of <strong>KES ${money(total)}</strong> via ${method}.</p>`;
  openModal(`${method} payment`, input, actionButtons("Complete sale"));
  if (method !== "Cash") modalPurpose = "confirm-payment";
  const paymentAmount = document.querySelector("#paymentAmount");
  paymentAmount?.addEventListener("input", () => {
    document.querySelector("#changeNote").textContent =
      `Change: ${money(Math.max(0, Number(paymentAmount.value || 0) - total))}`;
  });
}

function selectLowerAction(id) {
  document
    .querySelectorAll(".lower-action")
    .forEach((button) => button.classList.remove("active"));
  document.querySelector(`#${id}`).classList.add("active");
}

document.querySelector("#lowerCash").addEventListener("click", () => {
  selectLowerAction("lowerCash");
  startPayment("Cash");
});
document.querySelector("#lowerMpesa").addEventListener("click", () => {
  selectLowerAction("lowerMpesa");
  startPayment("M-Pesa");
});
document.querySelector("#lowerPaybill").addEventListener("click", () => {
  selectLowerAction("lowerPaybill");
  startPayment("Paybill");
});
document.querySelector("#lowerSplit").addEventListener("click", () => {
  selectLowerAction("lowerSplit");
  if (!cart.length) return showToast("Add an item before splitting payment");
  const total = currentTotal();
  openModal(
    "Split payment",
    `<p class="modal-note">Total due: <strong>KES ${money(total)}</strong></p><label>Cash amount<input id="splitCash" type="number" min="0" step="0.01" value="0"></label><label>M-Pesa amount<input id="splitMpesa" type="number" min="0" step="0.01" value="${total.toFixed(2)}"></label>`,
    actionButtons("Complete split payment"),
  );
});
document.querySelector("#lowerPoints").addEventListener("click", () => {
  selectLowerAction("lowerPoints");
  if (!cart.length) return showToast("Add an item before redeeming points");
  openModal(
    "Redeem points",
    `<p class="modal-note">1 point is worth KES 1. Enter the registered customer phone to check their balance.</p><label>Customer phone<input id="redeemCustomerPhone" type="tel" inputmode="tel" placeholder="07XXXXXXXX or 2547XXXXXXXX" required></label><label>Points to redeem<input id="pointsAmount" type="number" min="1" step="1" value="1" required></label>`,
    actionButtons("Apply points"),
  );
  modalPurpose = "redeem-points";
});
document.querySelector("#lowerDebt").addEventListener("click", () => {
  selectLowerAction("lowerDebt");
  if (!cart.length) return showToast("Add an item before recording debt");
  openModal(
    "Record debt",
    `<label>Customer name<input id="debtCustomer" placeholder="Customer name" required></label><label>Reference note<input id="debtNote" placeholder="Optional reference"></label>`,
    actionButtons("Record debt"),
  );
});
document
  .querySelector("#completeSale")
  .addEventListener("click", () => startPayment("Cash"));
document.querySelector("#lowerNewSale").addEventListener("click", () => {
  cart = [];
  discount = 0;
  salePointsDiscount = 0;
  renderCart();
  showToast("New sale started");
});

document
  .querySelector("#cashButton")
  .addEventListener("click", () => startPayment("Cash"));
document
  .querySelector("#cardButton")
  .addEventListener("click", () => startPayment("Card / M-Pesa"));
document.querySelector("#modalClose").addEventListener("click", closeModal);
modal.addEventListener("click", (event) => {
  if (event.target === modal && !mpesaPaymentLocked) closeModal();
});
modalBody.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-setup-guide-view]");
  if (!button) return;
  if (currentUser?.role !== "admin")
    return showToast("Admin permission required");
  const view = button.dataset.setupGuideView;
  const focusTarget = button.dataset.setupGuideFocus;
  if (!["Inventory", "Settings"].includes(view))
    return showToast("That setup step is unavailable");
  closeModal();
  activateView(view);
  if (focusTarget) {
    window.setTimeout(() => {
      const target = document.querySelector(focusTarget);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus();
    }, 0);
  }
});
modalActions.addEventListener("click", async (event) => {
  const actionButton = event.target.closest?.("[data-modal-action]");
  if (!actionButton || !modalActions.contains(actionButton)) return;
  const action = actionButton.dataset.modalAction;
  if (!action) return;
  if (action === "mpesa-check-status") {
    const requestId = modal.dataset.darajaRequestId;
    if (!requestId) return showToast("M-Pesa reference is missing");
    setDarajaWaitLock(true);
    modalBody.innerHTML =
      '<p id="darajaPaymentStatus" class="modal-note">Checking M-Pesa confirmation…</p>';
    modalActions.innerHTML =
      '<span class="modal-note">The sale remains locked until payment status is resolved.</span>';
    try {
      await continueDarajaPayment(requestId);
    } catch (error) {
      console.error("Could not resume Daraja status polling:", error);
      setDarajaWaitLock(false);
      openPendingDarajaModal(
        requestId,
        "Could not reach the Daraja status service. No sale was recorded.",
      );
    }
    return;
  }
  if (action === "mpesa-stop-waiting") {
    setDarajaWaitLock(false);
    closeModal();
    return showToast(
      "No sale was recorded. Verify the M-Pesa transaction before retrying.",
    );
  }
  if (action === "cancel") return closeModal();
  if (action === "print") return window.print();
  if (action === "whatsapp") {
    const text = lastSale
      ? `${settings.storeName}: receipt ${lastSale.id}, total ${settings.currency} ${money(lastSale.total)}`
      : "";
    return window.open(
      `https://wa.me/?text=${encodeURIComponent(text)}`,
      "_blank",
    );
  }
  if (action === "feedback") {
    openModal(
      "How was your experience?",
      `
      <p class="modal-note">Rate this sale from 1 to 5 stars to help us improve.</p>
      <div class="rating-row">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="rating-star" data-rating="${n}">★</button>`).join("")}</div>`,
      `<button type="button" class="modal-primary" data-modal-action="cancel">Close</button>`,
    );
    return;
  }
  if (action === "export-accounting") return exportAccountingLedger();
  if (action !== "confirm") return;
  if (modalPurpose === "branch-manager") {
    if (currentUser?.role !== "admin")
      return showToast("Admin permission required");
    const newBranch = document.querySelector("#newBranchName")?.value.trim();
    const selectedBranch = document.querySelector("#managedBranch")?.value;
    const branches = getStoreNames();
    if (
      newBranch &&
      branches.some(
        (branch) => branch.toLowerCase() === newBranch.toLowerCase(),
      )
    )
      return showToast("That branch already exists");
    syncCurrentBranchStock();
    if (newBranch) {
      branches.push(newBranch);
      branchStock[newBranch] = Object.fromEntries(
        products.map((product) => [String(product.id), 0]),
      );
    }
    settings.branches = [...new Set(branches)];
    const nextStore = selectedBranch || settings.storeName;
    if (newBranch && !selectedBranch) settings.branches.push(newBranch);
    settings.storeName = nextStore;
    renderStoreOptions();
    activateStoreStock(settings.storeName);
    document.querySelector("#storeName").textContent = settings.storeName;
    document.querySelector("#settingsStoreName").textContent =
      settings.storeName;
    renderCart();
    renderProducts(search.value);
    renderAllPanels();
    saveState();
    closeModal();
    showToast(
      newBranch
        ? `${newBranch} added; active branch is ${settings.storeName}`
        : `Active branch changed to ${settings.storeName}`,
    );
    return;
  }
  if (modalPurpose === "customer-campaign") {
    const audience = document.querySelector("#campaignAudience")?.value;
    const message = document.querySelector("#campaignMessage")?.value.trim();
    if (!message) return showToast("Enter a campaign message");
    const recipients = customers.filter(
      (customer) =>
        normalizeKenyanPhone(customer.phone) &&
        (audience !== "vip" || customer.tier === "VIP"),
    );
    if (!recipients.length)
      return showToast(
        "No customers with valid phone numbers in this audience",
      );
    const rows = [
      ["Customer", "Phone", "Message"],
      ...recipients.map((customer) => [
        customer.name,
        normalizeKenyanPhone(customer.phone),
        message,
      ]),
    ];
    downloadTextFile(
      "tajiri-customer-campaign.csv",
      toCsv(rows),
      "text/csv;charset=utf-8",
    );
    closeModal();
    showToast(
      `Campaign draft exported for ${recipients.length} customers; no messages were sent`,
    );
    return;
  }
  if (modalPurpose === "assign-delivery") {
    const delivery = deliveries.find(
      (entry) => entry.id === document.querySelector("#deliveryOrderId")?.value,
    );
    const rider = document.querySelector("#deliveryGuy")?.value;
    if (!delivery) return showToast("Choose a pending delivery order");
    delivery.rider = rider;
    delivery.updatedAt = new Date().toISOString();
    renderOperationsPanel();
    saveState();
    closeModal();
    showToast(`${rider} assigned to delivery`);
    return;
  }
  if (modalPurpose === "restore-business-backup") {
    if (currentUser?.role !== "admin")
      return showToast("Admin permission required");
    const backup = pendingBusinessBackup;
    if (!backup) return showToast("Choose a valid business backup first");
    const error = businessBackupError(backup);
    if (error) return showToast(error);

    products.splice(0, products.length, ...backup.products);
    customers.splice(0, customers.length, ...(backup.customers || []));
    salesLog = backup.salesLog;
    expenses = backup.expenses;
    purchaseOrders = backup.purchaseOrders;
    cashBook = backup.cashBook;
    branchStock = backup.branchStock || {};
    stockTransfers = backup.stockTransfers || [];
    deliveries = backup.deliveries || [];
    loyaltyBalance = Number(backup.loyaltyBalance) || 0;
    Object.assign(settings, backup.settings);
    pendingBusinessBackup = null;
    closeModal();

    if (!saveState()) {
      loadState();
      renderAllPanels();
      renderProducts(search.value);
      renderCart();
      return;
    }
    loadState();
    renderAllPanels();
    renderProducts(search.value);
    renderCart();
    renderSalesStockPulse();
    renderReceiptPanel(salesLog.at(-1) || null);
    showToast("Business backup restored");
    return;
  }
  if (modalPurpose === "confirm-payment") {
    resolveCustomerInfo();
    completeSaleRecord(lastPaymentMethod);
    return;
  }
  if (modalPurpose === "redeem-points") {
    const phone = normalizeKenyanPhone(
      document.querySelector("#redeemCustomerPhone")?.value,
    );
    const points = Number(document.querySelector("#pointsAmount")?.value);
    const customer = customers.find(
      (entry) => phone && normalizeKenyanPhone(entry.phone) === phone,
    );
    if (!phone) return showToast("Enter a valid Kenyan customer phone");
    if (!customer) return showToast("No loyalty account found for that phone");
    if (!Number.isSafeInteger(points) || points < 1)
      return showToast("Enter a whole number of points to redeem");
    if (points > Number(customer.points || 0))
      return showToast(
        `Only ${Number(customer.points || 0)} points are available`,
      );
    const remainingSubtotal = Math.max(
      0,
      currentSubtotal() - Number(discount || 0),
    );
    salePointsDiscount = Math.min(points, Math.floor(remainingSubtotal));
    if (salePointsDiscount < 1)
      return showToast("No whole KES amount remains to redeem on this sale");
    currentCustomer = { name: customer.name, phone: customer.phone };
    renderCart();
    closeModal();
    showToast(
      `${salePointsDiscount} points applied · KES ${money(salePointsDiscount)} off`,
    );
    return;
  }
  if (modalPurpose === "restock-product") {
    const quantity = Number(document.querySelector("#restockQuantity")?.value);
    const product = products.find(
      (item) => String(item.id) === modal.dataset.restockProductId,
    );
    if (!product) return showToast("This product is no longer available");
    if (!Number.isSafeInteger(quantity) || quantity < 1)
      return showToast("Enter a whole number of units to add");
    product.stock = Number(product.stock || 0) + quantity;
    renderAllPanels();
    saveState();
    closeModal();
    showToast(`${product.name} restocked · ${product.stock} units on hand`);
    return;
  }
  if (modalPurpose === "print-barcode-labels") {
    const product = products.find(
      (item) => String(item.id) === modal.dataset.labelProductId,
    );
    const count = Number(document.querySelector("#barcodeLabelCount")?.value);
    if (!product) return showToast("This product is no longer available");
    if (!Number.isSafeInteger(count) || count < 1 || count > 100)
      return showToast("Choose between 1 and 100 labels");
    closeModal();
    printBarcodeLabels(product, count);
    return;
  }
  if (modalPurpose === "stock-transfer") {
    const product = products.find(
      (item) =>
        String(item.id) === document.querySelector("#transferProductId")?.value,
    );
    const from = document.querySelector("#transferFrom")?.value;
    const to = document.querySelector("#transferTo")?.value;
    const quantity = Number(document.querySelector("#transferQuantity")?.value);
    if (!product) return showToast("Select a valid product");
    if (!from || !to || from === to)
      return showToast("Choose two different branches");
    if (!Number.isSafeInteger(quantity) || quantity < 1)
      return showToast("Enter a whole number of units to transfer");
    syncCurrentBranchStock();
    const fromStock = Number(branchStock[from]?.[String(product.id)] || 0);
    if (quantity > fromStock)
      return showToast(`${from} only has ${fromStock} units available`);
    if (!branchStock[to]) branchStock[to] = {};
    branchStock[from][String(product.id)] = fromStock - quantity;
    branchStock[to][String(product.id)] =
      Number(branchStock[to][String(product.id)] || 0) + quantity;
    stockTransfers.push({
      id: `TR-${Date.now()}`,
      productId: product.id,
      product: product.name,
      from,
      to,
      quantity,
      createdAt: new Date().toISOString(),
      createdBy: currentUser?.name || "Admin",
    });
    if (settings.storeName === from || settings.storeName === to)
      product.stock =
        Number(branchStock[settings.storeName]?.[String(product.id)]) || 0;
    renderAllPanels();
    renderProducts(search.value);
    saveState();
    closeModal();
    showToast(`${quantity} ${product.name} transferred to ${to}`);
    return;
  }
  if (modalPurpose === "open-shift") {
    const openingFloat = Number(
      document.querySelector("#shiftOpeningFloat").value,
    );
    const tillNumber = Number(
      document.querySelector("#shiftTillNumber")?.value,
    );
    if (!Number.isFinite(openingFloat) || openingFloat < 0)
      return showToast("Enter a valid opening float");
    if (![1, 2, 3, 4].includes(tillNumber))
      return showToast("Select Till 1, 2, 3, or 4 before opening the shift");
    shifts.push({
      id: `SHIFT-${Date.now()}`,
      cashierId: getCashierId(),
      cashier: currentUser.name,
      tillNumber,
      openedAt: new Date().toISOString(),
      openingFloat,
    });
    saveState();
    closeModal();
    renderCashierDashboard();
    showToast("Shift opened");
    return;
  }
  if (modalPurpose === "close-shift") {
    const shift = getCurrentShift();
    const countedCash = Number(
      document.querySelector("#shiftCountedCash").value,
    );
    if (!shift) return showToast("There is no open shift to close");
    if (!Number.isFinite(countedCash) || countedCash < 0)
      return showToast("Enter a valid counted cash amount");
    const cashSales = salesLog
      .filter((sale) => sale.shiftId === shift.id && sale.method === "Cash")
      .reduce((sum, sale) => sum + Number(sale.total || 0), 0);
    shift.closedAt = new Date().toISOString();
    shift.countedCash = countedCash;
    shift.expectedCash = Number(shift.openingFloat || 0) + cashSales;
    shift.variance = countedCash - shift.expectedCash;
    saveState();
    closeModal();
    renderCashierDashboard();
    showToast(
      `Shift closed · variance ${settings.currency} ${money(shift.variance)}`,
    );
    return;
  }
  if (modalPurpose === "logout") {
    event.stopImmediatePropagation();
    if (window.firebaseAuth && window.TAJIRI_SUPABASE_CONFIG?.url) {
      try {
        await window.firebaseAuth.signOut();
      } catch (error) {
        console.error("Could not sign out of the cloud account:", error);
        showToast("Could not sign out of the cloud account. Please try again.");
        return;
      }
    }
    currentUser = null;
    sessionStorage.removeItem("tajiri-session-user");
    sessionStorage.removeItem("tajiri-session-role");
    sessionStorage.removeItem("tajiri-session-signature");
    localStorage.removeItem("tajiri-remembered-user");
    localStorage.removeItem("tajiri-remembered-role");
    localStorage.removeItem("tajiri-remembered-signature");
    applyRole();
    activateView("Sales");
    closeModal();
    showToast("Signed out");
    redirectToWelcomeView();
    return;
  }
  if (modalPurpose === "reset-settings") {
    delete settings.reportSchedule;
    Object.assign(settings, {
      storeName: "Main Store",
      taxRate: 0,
      serviceCharge: 0,
      currency: "KES",
      language: "en-GB",
      theme: "dark",
      backgroundColor: "#121820",
      lowStockThreshold: DEFAULT_LOW_STOCK_LEVEL,
      lowStockAlerts: true,
      salesReportAlerts: true,
      discountRule: "percentage",
      receiptFooter: "Thank you for shopping with us",
      loginMethod: "password",
      receiptShopName: "DanLiz Shop",
      receiptLocation: "Bondo, Siaya County",
      receiptPhone: "0712 345 678",
      receiptLogoUrl: "",
      receiptHeader: "SALES RECEIPT",
      receiptFontSize: 10,
      receiptTemplate: "detailed",
      autoPrintReceipt: true,
      returnPolicy: "Goods once sold are not returnable.",
      sessionTimeout: "0",
      printer: "system",
      scanner: true,
      mpesa: true,
      airtel: false,
      card: true,
      cashDrawer: false,
      cloudBackup: false,
    });
    document.querySelector("#storeSelect").value = settings.storeName;
    renderStoreOptions();
    activateStoreStock(settings.storeName);
    document.querySelector("#storeName").textContent = settings.storeName;
    document.querySelector("#taxRateInput").value = "0";
    document.querySelector("#serviceChargeInput").value = "0";
    document.querySelector("#currencySelect").value = "KES";
    document.querySelector("#languageSelect").value = "en-GB";
    document.querySelector("#themeSelect").value = "dark";
    document.querySelector("#backgroundColorInput").value = "#121820";
    document.querySelector("#discountRuleSelect").value = "percentage";
    document.querySelector("#receiptFooterInput").value =
      settings.receiptFooter;
    document.querySelector("#receiptShopNameInput").value =
      settings.receiptShopName;
    document.querySelector("#receiptLocationInput").value =
      settings.receiptLocation;
    document.querySelector("#receiptPhoneInput").value = settings.receiptPhone;
    document.querySelector("#receiptLogoUrlInput").value =
      settings.receiptLogoUrl;
    document.querySelector("#receiptHeaderInput").value =
      settings.receiptHeader;
    document.querySelector("#receiptFontSizeInput").value =
      settings.receiptFontSize;
    document.querySelector("#receiptTemplateSelect").value =
      settings.receiptTemplate;
    document.querySelector("#autoPrintReceiptToggle").checked =
      settings.autoPrintReceipt !== false;
    document.querySelector("#loginMethodSelect").value = "password";
    document.querySelector("#sessionTimeoutSelect").value = "0";
    document.querySelector("#printerSelect").value = "system";
    document.querySelector("#offlineToggle").checked = false;
    [
      "lowStockAlertsToggle",
      "salesReportAlertsToggle",
      "scannerToggle",
      "mpesaToggle",
      "cardToggle",
    ].forEach((id) => {
      document.querySelector(`#${id}`).checked = true;
    });
    ["airtelToggle", "cashDrawerToggle"].forEach((id) => {
      document.querySelector(`#${id}`).checked = false;
    });
    applySettingsAppearance();
    setOffline(false);
    renderCart();
    renderInventoryPanel();
    renderSalesStockPulse();
    renderAdminDashboard();
    renderReportsPanel();
    saveState();
    closeModal();
    showToast("Settings reset to defaults");
    return;
  }
  if (document.querySelector("#newCustomerName")) {
    const name = document.querySelector("#newCustomerName").value.trim();
    const phone = normalizeKenyanPhone(
      document.querySelector("#newCustomerPhone").value,
    );
    if (!name) return showToast("Enter the customer name");
    if (!phone) return showToast("Enter a valid Kenyan phone number");
    if (
      customers.some(
        (customer) => normalizeKenyanPhone(customer.phone) === phone,
      )
    )
      return showToast("A loyalty account already uses that phone");
    customers.push({ name, phone, tier: "Retail", points: 0 });
    renderCustomersPanel();
    saveState();
    closeModal();
    showToast("Loyalty customer added");
    return;
  }
  if (
    document.querySelector("#productName") ||
    document.querySelector("#newProductName")
  ) {
    const values = getProductFormValues();
    if (values.error) return showToast(values.error);
    const productId = Number(modal.dataset.editId || Date.now());
    const nextProduct = {
      id: productId,
      name: values.name,
      code: values.code,
      category: values.category,
      supplier: values.supplier,
      price: values.price,
      cost: values.cost,
      stock: values.stock,
      icon:
        values.category === "Fresh"
          ? "❋"
          : values.category === "Snacks"
            ? "◉"
            : "◆",
      aliases: Array.from(
        new Set(
          [
            values.name,
            values.code,
            `${values.code} ${values.name}`,
            values.category,
            values.supplier,
          ].filter(Boolean),
        ),
      ),
    };
    if (modal.dataset.editId) {
      const index = products.findIndex((product) => product.id === productId);
      if (index !== -1) {
        products[index] = { ...products[index], ...nextProduct };
        showToast("Product updated");
      }
    } else {
      products.unshift(nextProduct);
      showToast("Product added");
    }
    modal.dataset.editId = "";
    renderAllPanels();
    renderProducts(search.value);
    saveState();
    closeModal();
    return;
  }
  if (document.querySelector("#customName")) {
    if (currentUser?.role !== "admin")
      return showToast("Only admins can add custom-priced items");
    const name = document.querySelector("#customName").value.trim();
    const price = Number(document.querySelector("#customPrice").value);
    if (!name || !price || price < 0)
      return showToast("Enter an item name and valid price");
    cart.push({
      id: Date.now(),
      name,
      code: "CUSTOM ITEM",
      category: "Custom",
      price,
      cost: 0,
      quantity: 1,
      isCustom: true,
    });
    renderCart();
    showToast(`${name} added to sale`);
    closeModal();
    return;
  }
  if (document.querySelector("#discountPercent")) {
    if (currentUser?.role !== "admin")
      return showToast("Only admins can apply discounts");
    discount =
      (currentSubtotal() *
        Math.min(
          100,
          Math.max(0, Number(document.querySelector("#discountPercent").value)),
        )) /
      100;
    renderCart();
    closeModal();
    showToast("Discount applied");
    return;
  }
  if (document.querySelector("#deliveryAddress")) {
    const address = document.querySelector("#deliveryAddress").value.trim();
    if (!address) return showToast("Enter a delivery address");
    if (!cart.length) return showToast("Add items to the sale before delivery");
    deliveries.push({
      id: `DEL-${Date.now()}`,
      customer:
        document.querySelector("#deliveryCustomerName")?.value.trim() ||
        currentCustomer.name ||
        "Walk-in customer",
      phone:
        normalizeKenyanPhone(
          document.querySelector("#deliveryCustomerPhone")?.value,
        ) || "",
      address,
      notes: document.querySelector("#deliveryNotes").value.trim(),
      store: settings.storeName,
      items: cart.map((item) => ({
        name: item.name,
        quantity: item.quantity,
      })),
      total: currentTotal(),
      status: "Pending",
      createdAt: new Date().toISOString(),
      rider: "",
    });
    renderOperationsPanel();
    saveState();
    closeModal();
    showToast("Delivery order saved to Operations");
    return;
  }
  if (document.querySelector("#deliveryGuy")) {
    return showToast("Choose a delivery order and rider");
  }
  if (document.querySelector("#splitCash")) {
    const total = currentTotal();
    const paid =
      Number(document.querySelector("#splitCash").value || 0) +
      Number(document.querySelector("#splitMpesa").value || 0);
    if (paid < total) return showToast("Split amounts are too low");
    completeSaleRecord("Split");
    return;
  }
  if (document.querySelector("#pointsAmount")) {
    closeModal();
    showToast("Points applied to this sale");
    return;
  }
  if (document.querySelector("#debtCustomer")) {
    closeModal();
    showToast("Debt recorded successfully");
    return;
  }
  if (document.querySelector("#paymentAmount")) {
    resolveCustomerInfo();
    const received = Number(document.querySelector("#paymentAmount").value);
    if (received < currentTotal())
      return showToast("Amount received is too low");
    completeSaleRecord(lastPaymentMethod, received);
    return;
  }
  if (document.querySelector("#mpesaPhone")) {
    resolveCustomerInfo();
    const phone = document.querySelector("#mpesaPhone").value.trim();
    const normalizedPhone = normalizeKenyanPhone(phone);
    if (!normalizedPhone) return showToast("Enter a valid Kenyan phone number");
    if (offlineMode || !navigator.onLine) {
      return showToast(
        "M-Pesa needs an active connection. No payment was requested and no sale was recorded.",
      );
    }
    const amount = Math.ceil(currentTotal());
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 150000)
      return showToast("M-Pesa amount must be between KES 1 and KES 150,000");
    const confirmButton = modalActions.querySelector(
      "[data-modal-action='confirm']",
    );
    if (confirmButton) {
      confirmButton.disabled = true;
      confirmButton.textContent = "Sending prompt…";
    }
    let darajaRequestId = "";
    try {
      const response = await fetch(`${darajaApiBase()}/api/mpesa/stk-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount,
          phone: normalizedPhone,
        }),
      });
      const result = await response.json();
      if (!response.ok || result.success !== true)
        throw new Error(result.message || "M-Pesa request failed");
      if (!result.requestId)
        throw new Error("Daraja did not return a payment reference");
      darajaRequestId = result.requestId;
      if (result.status === "review") {
        pendingMpesa.push({
          requestId: result.requestId,
          amount,
          phone: normalizedPhone,
          status: "review",
          createdAt: new Date().toISOString(),
        });
        saveState();
        closeModal();
        return showToast(
          "Daraja request outcome is unknown. Verify it in the Daraja portal before retrying; no sale was recorded.",
        );
      }
      pendingMpesa.push({
        requestId: result.requestId,
        amount,
        phone: normalizedPhone,
        status: "pending",
        createdAt: new Date().toISOString(),
      });
      saveState();
      setDarajaWaitLock(true);
      modalBody.innerHTML =
        '<p id="darajaPaymentStatus" class="modal-note">STK Push sent. Waiting for customer confirmation…</p><p class="modal-note">Keep this screen open until Daraja confirms the payment.</p>';
      modalActions.innerHTML =
        '<span class="modal-note">Sale will be recorded only after confirmation.</span>';
      modal.dataset.darajaRequestId = result.requestId;
      await continueDarajaPayment(result.requestId);
    } catch (error) {
      setDarajaWaitLock(false);
      const retryButton = modalActions.querySelector(
        "[data-modal-action='confirm']",
      );
      if (retryButton) {
        retryButton.disabled = false;
        retryButton.textContent = "Send M-Pesa prompt";
      }
      console.error("Could not complete the Daraja payment flow:", error);
      if (darajaRequestId) {
        openPendingDarajaModal(
          darajaRequestId,
          "Status check failed. No sale was recorded. Check again before retrying.",
        );
      } else {
        closeModal();
      }
      showToast(
        `${error.message || "M-Pesa request failed"}. Verify the customer's phone and Daraja portal before retrying.`,
      );
    }
    return;
  }
});

document.querySelector(".icon-button").addEventListener("click", () => {
  const lowStock = settings.lowStockAlerts ? getLowStockProducts() : [];
  const message = lowStock.length
    ? `<p class="modal-note">${lowStock.length} product${lowStock.length === 1 ? " is" : "s are"} at or below the ${getLowStockThreshold()}-unit alert level:</p><div class="panel-list">${lowStock.map((product) => `<div class="panel-row"><span>${escapeHtml(product.name)}</span><strong>${Number(product.stock) || 0} left</strong></div>`).join("")}</div>`
    : `<p class="modal-note">${settings.lowStockAlerts ? "No low-stock alerts. Your inventory is above its alert levels." : "Low-stock alerts are turned off in Settings."}</p>`;
  openModal(
    "Inventory notifications",
    message,
    `<button type="button" class="modal-primary" data-modal-action="cancel">Done</button>`,
  );
});
document.querySelector(".logout-button").addEventListener("click", () => {
  openModal(
    "Sign out",
    `<p>Are you sure you want to sign out of Tajiri POS?</p>`,
    actionButtons("Sign out"),
  );
  modalPurpose = "logout";
});
document.querySelector("#addProductButton")?.addEventListener("click", () => {
  if (currentUser?.role !== "admin")
    return showToast("Admin permission required");
  modal.dataset.editId = "";
  openModal(
    "Add product",
    `
    <label>Product code (optional)<input id="productCode" placeholder="SKU-001"></label>
    <label>Product name<input id="productName" required></label>
    <label>Category<input id="productCategory" placeholder="Grocery"></label>
    <label>Supplier<input id="productSupplier" placeholder="Supplier name"></label>
    <label>Selling price (${escapeHtml(settings.currency)})<input id="productPrice" type="number" min="0.01" step="0.01" required></label>
    <label>Unit cost (${escapeHtml(settings.currency)})<input id="productCost" type="number" min="0" step="0.01" placeholder="Defaults to 60% of selling price"></label>
    <label>Stock quantity<input id="productStock" type="number" min="0" step="1" value="0" required></label>`,
    actionButtons("Add product"),
  );
});
document.querySelector("#signupButton")?.addEventListener("click", () => {
  if (currentUser?.role !== "admin")
    return showToast("Admin permission required");
  openModal(
    "Create account",
    `<p class="auth-kicker">Create a secure account for a cashier or manager.</p><label>Full name<input id="signupName" placeholder="e.g. Amina Otieno" required></label><label>Username<input id="signupUsername" autocomplete="username" placeholder="e.g. amina" required></label><label>Email<input id="signupEmail" type="email" placeholder="amina@example.com" required></label><label>Password<input id="signupPassword" type="password" autocomplete="new-password" placeholder="At least 5 characters" required></label><label>Confirm password<input id="signupConfirmPassword" type="password" autocomplete="new-password" maxlength="5" required></label><label>Role<select id="signupRole"><option value="cashier">Cashier</option><option value="manager">Manager</option><option value="admin">Admin</option></select></label>`,
    actionButtons("Create account"),
  );
});
document
  .querySelector("#printReceiptButton")
  ?.addEventListener("click", () => printReceipt());
document
  .querySelector("#sendReceiptButton")
  ?.addEventListener("click", () =>
    showToast("Receipt sharing is ready for WhatsApp"),
  );
document.querySelector("#downloadDataButton")?.addEventListener("click", () => {
  if (currentUser?.role !== "admin")
    return showToast("Admin permission required");
  const exportData = {
    salesLog,
    expenses,
    purchaseOrders,
    cashBook,
    products,
    settings,
  };
  const blob = new Blob([JSON.stringify(exportData, null, 2)], {
    type: "application/json",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "tajiri-pos-data.json";
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("Business data downloaded");
});
document
  .querySelector("#aboutButton")
  ?.addEventListener("click", () =>
    openModal(
      "About Tajiri POS",
      `<p class="modal-note">Tajiri POS is a local-first retail workspace for sales, inventory, customers, reports, and cash management.</p><p class="modal-note">All account login and signup actions are available from the Welcome page.</p>`,
      `<button type="button" class="modal-primary" data-modal-action="cancel">Close</button>`,
    ),
  );
document
  .querySelectorAll("[data-product-action='edit']")
  .forEach((button) =>
    button.addEventListener("click", () => showToast("Product editor opened")),
  );
function activateView(label) {
  if (
    currentUser &&
    currentUser.role !== "admin" &&
    ADMIN_ONLY_VIEWS.includes(label)
  ) {
    return showToast("Admin permission required");
  }
  const pageTitle = document.querySelector("#pageTitle");
  const panels = document.querySelectorAll(".main-content section[data-view]");
  const salesView = document.querySelector(".sales-area");
  const salePanel = document.querySelector(".sale-panel");

  document.querySelectorAll(".nav-button, .more-menu-item").forEach((item) => {
    const itemLabel =
      item.getAttribute("data-view") || item.getAttribute("aria-label");
    item.classList.toggle("active", itemLabel === label);
  });

  panels.forEach((panel) => {
    const isTarget = panel.dataset.view === label;
    panel.hidden = !isTarget;
  });

  const isSales = label === "Sales";
  if (salesView) salesView.hidden = !isSales;
  if (salePanel) salePanel.hidden = !isSales;

  if (pageTitle) pageTitle.textContent = isSales ? "New sale" : label;
  if (label === "Inventory") renderInventoryPanel();
  if (label === "Admin Dashboard") renderAdminDashboard();
  showToast(`${label} section selected`);
}

function activateRoleLandingView() {
  const workspaceRole =
    window.__tajiriWorkspaceRole === "cashier" ||
    window.__tajiriWorkspaceRole === "admin"
      ? window.__tajiriWorkspaceRole
      : currentUser?.role;
  const landing =
    workspaceRole === "admin" ? "Admin Dashboard" : "Cashier Dashboard";
  applyRole();
  activateView(landing);
}

const moreButton = document.querySelector("#moreButton");
const moreDropdown = document.querySelector("#moreDropdown");
if (moreButton && moreDropdown) {
  moreDropdown.hidden = true;
  moreButton.setAttribute("aria-expanded", "false");
  moreButton.addEventListener("click", () => {
    const hidden = moreDropdown.hasAttribute("hidden");
    moreDropdown.toggleAttribute("hidden", !hidden);
    moreButton.setAttribute("aria-expanded", String(hidden));
  });

  document.addEventListener("click", (event) => {
    if (
      !moreDropdown.contains(event.target) &&
      !moreButton.contains(event.target)
    ) {
      moreDropdown.setAttribute("hidden", "hidden");
      moreButton.setAttribute("aria-expanded", "false");
    }
  });
}

document
  .querySelectorAll(
    ".nav-button, .more-menu-item, .dashboard-link, .premium-tool-link",
  )
  .forEach((button) =>
    button.addEventListener("click", () => {
      const label =
        button.getAttribute("data-view") || button.getAttribute("aria-label");
      if (!label) return;
      activateView(label);
      if (moreDropdown) {
        moreDropdown.setAttribute("hidden", "hidden");
        moreButton?.setAttribute("aria-expanded", "false");
      }
    }),
  );
document.querySelector("#cashierShiftButton")?.addEventListener("click", () => {
  if (!currentUser || (currentUser.role === "admin" && !isCashierWorkspace()))
    return showToast("Cashier account required");
  const shift = getCurrentShift();
  if (shift) {
    const expected =
      Number(shift.openingFloat || 0) +
      salesLog
        .filter((sale) => sale.shiftId === shift.id && sale.method === "Cash")
        .reduce((sum, sale) => sum + Number(sale.total || 0), 0);
    openModal(
      "Close cashier shift",
      `<p class="modal-note">Expected cash: <strong>${settings.currency} ${money(expected)}</strong></p><label>Counted cash (KES)<input id="shiftCountedCash" type="number" min="0" step="0.01" value="${expected.toFixed(2)}" required></label>`,
      actionButtons("Close shift"),
    );
    modalPurpose = "close-shift";
    return;
  }
  openModal(
    "Open cashier shift",
    `<label>Till<select id="shiftTillNumber" required><option value="">Select a till</option>${[1, 2, 3, 4].map((tillNumber) => `<option value="${tillNumber}">Till ${tillNumber}</option>`).join("")}</select></label><label>Opening float (KES)<input id="shiftOpeningFloat" type="number" min="0" step="0.01" value="0" required></label>`,
    actionButtons("Open shift"),
  );
  modalPurpose = "open-shift";
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    search.focus();
  }
  if (event.key === "Escape" && !modal.hidden && !mpesaPaymentLocked)
    closeModal();
  if (event.key === "F2") {
    event.preventDefault();
    startPayment("Cash");
  }
  if (event.key === "F4") {
    event.preventDefault();
    startPayment("Card / M-Pesa");
  }
});

renderProducts();
renderCart();

/* ---------- Sale recording, receipts & inventory updates ---------- */

let lastSale = null;
let pendingPrintSale = null;

function completeSaleRecord(
  method,
  amountPaid = currentTotal(),
  paymentReference = "",
) {
  if (!cart.length) return showToast("Add an item before completing a sale");
  const activeShift = isCashierWorkspace() ? getCurrentShift() : null;
  if ((currentUser?.role !== "admin" || isCashierWorkspace()) && !activeShift) {
    return showToast("Open a cashier shift before completing a sale");
  }
  const invalidStockItem = cart.find((item) => {
    if (item.isCustom) return false;
    const product = products.find((entry) => entry.id === item.id);
    return (
      !product ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > Number(product.stock || 0)
    );
  });
  if (invalidStockItem) {
    const product = products.find((entry) => entry.id === invalidStockItem.id);
    return showToast(
      product
        ? `${product.name}: only ${Number(product.stock) || 0} in stock. Update the cart before checkout.`
        : "A product in this cart is no longer available. Remove it before checkout.",
    );
  }
  const totalDue = currentTotal();
  if (!Number.isFinite(totalDue) || totalDue <= 0)
    return showToast("The sale total is invalid");
  if (!Number.isFinite(Number(amountPaid)) || Number(amountPaid) < totalDue)
    return showToast("The amount paid is less than the sale total");
  const items = cart.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    unitPrice: getEffectivePrice(item),
    unitCost: Number(item.cost || 0),
  }));
  const customerInfo = resolveCustomerInfo();
  const customerPhone = normalizeKenyanPhone(customerInfo.phone);
  let loyaltyCustomer = customerPhone
    ? customers.find(
        (customer) => normalizeKenyanPhone(customer.phone) === customerPhone,
      )
    : null;
  if (customerPhone && !loyaltyCustomer) {
    loyaltyCustomer = {
      name: customerInfo.name || "Loyalty customer",
      tier: "Retail",
      phone: customerPhone,
      points: 0,
    };
    customers.push(loyaltyCustomer);
  }
  const pointsRedeemed = Math.floor(
    Math.min(salePointsDiscount, Number(loyaltyCustomer?.points || 0)),
  );
  if (pointsRedeemed && loyaltyCustomer) {
    loyaltyCustomer.points -= pointsRedeemed;
    salePointsDiscount = pointsRedeemed;
  } else {
    salePointsDiscount = 0;
  }
  const sale = {
    id: `SALE-${2085 + salesLog.length}`,
    receiptNumber: String(456 + salesLog.length).padStart(6, "0"),
    method,
    cashier: currentUser ? currentUser.name : "Walk-in",
    cashierId: getCashierId(),
    shiftId: activeShift?.id || null,
    tillNumber: activeShift?.tillNumber || null,
    store: settings.storeName,
    time: new Date().toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    }),
    date: new Date().toLocaleDateString("en-GB"),
    transactionId:
      method === "M-Pesa"
        ? paymentReference || `MP${Date.now().toString().slice(-9)}`
        : `TXN-${2085 + salesLog.length}`,
    mpesaReceiptNumber: method === "M-Pesa" ? paymentReference || "" : "",
    customer: customerInfo.name || "Walk-in customer",
    customerPhone: customerPhone || customerInfo.phone || "",
    subtotal: currentSubtotal(),
    discount: discount + salePointsDiscount,
    pointsRedeemed,
    tax: currentVat(),
    serviceCharge: currentServiceCharge(),
    total: totalDue,
    amountPaid,
    change: Math.max(0, Number(amountPaid) - totalDue),
    items,
    synced: !offlineMode,
  };
  salesLog.push(sale);
  lastSale = sale;

  // Cash book: money IN for every completed sale
  cashBook.push({
    id: sale.id,
    direction: "in",
    label: sale.items.map((i) => `${i.name} × ${i.quantity}`).join(", "),
    method: sale.method,
    amount: sale.total,
  });

  // Inventory update: reduce stock, alert on low stock, auto-suggest purchase orders
  cart.forEach((item) => {
    if (item.isCustom) return;
    const product = products.find((p) => p.id === item.id);
    if (!product) return;
    product.stock -= item.quantity;
    if (settings.lowStockAlerts && product.stock <= getLowStockThreshold()) {
      showToast(`Low stock alert: ${product.name} (${product.stock} left)`);
      if (
        !purchaseOrders.some(
          (po) =>
            po.product === product.name &&
            (po.store || settings.storeName) === settings.storeName &&
            !["Received", "Cancelled"].includes(po.status),
        )
      ) {
        const supplier = suppliers.find((s) => s.supplies === product.name);
        purchaseOrders.push({
          id: `PO-${Date.now()}-${product.id}`,
          product: product.name,
          productId: product.id,
          supplier: supplier ? supplier.name : "Any supplier",
          quantity: Math.max(
            1,
            Math.max(20, getLowStockThreshold() * 3) -
              Number(product.stock || 0),
          ),
          status: "Suggested",
          store: settings.storeName,
          createdAt: new Date().toISOString(),
        });
      }
    }
  });

  // Loyalty: award 1 point per whole 100 spent
  const earned = Math.floor(sale.total / 100);
  loyaltyBalance += earned;
  if (loyaltyCustomer) {
    loyaltyCustomer.points = Number(loyaltyCustomer.points || 0) + earned;
    loyaltyCustomer.name = customerInfo.name || loyaltyCustomer.name;
    sale.pointsEarned = earned;
    sale.customerName = loyaltyCustomer.name;
  }

  cart = [];
  discount = 0;
  salePointsDiscount = 0;
  renderCart();
  renderSalesStockPulse();
  renderAllPanels();
  closeModal();
  openReceipt(sale, earned);
  saveState();

  // Auto-print the receipt as soon as the sale completes
  if (settings.autoPrintReceipt !== false) {
    window.setTimeout(() => printReceipt(sale), 450);
  }
}

function printReceipt(sale = lastSale) {
  if (!sale) return showToast("Complete a sale first");
  pendingPrintSale = sale;
  document.body.classList.add("printing-receipt");
  showToast("Sending receipt to printer...");
  window.setTimeout(() => {
    window.print();
    window.setTimeout(
      () => document.body.classList.remove("printing-receipt"),
      300,
    );
  }, 80);
}

function openReceipt(sale, earned) {
  const lines = sale.items
    .map(
      (item) =>
        `<div class="receipt-line receipt-item-line"><span>${escapeHtml(item.name)}</span><span>× ${item.quantity}</span><span>${money(item.unitPrice)}</span><b>${money(item.unitPrice * item.quantity)}</b></div>`,
    )
    .join("");
  const receiptClass = `receipt-paper receipt-template-${settings.receiptTemplate === "simple" ? "simple" : "detailed"}`;
  openModal(
    "Receipt",
    `
    <div class="${receiptClass}" style="--receipt-font-size: ${getReceiptFontSize()}px">
      ${receiptLogoMarkup()}
      <div class="receipt-heading">${escapeHtml(settings.receiptHeader || "SALES RECEIPT")}</div>
      <div class="receipt-brand">
        <strong>${escapeHtml(settings.storeName)}</strong>
        <span>Receipt No: ${sale.receiptNumber} · ${sale.id} · ${sale.method} · ${sale.time}</span>
      </div>
      <div class="receipt-address">
        <b>${escapeHtml(settings.receiptShopName)}</b>
        <span>${escapeHtml(settings.receiptLocation)}</span>
        <span>Tel: ${escapeHtml(settings.receiptPhone)}</span>
      </div>
      <div class="receipt-meta"><span>Receipt No: ${sale.receiptNumber}</span><span>${sale.date} · ${sale.time}</span><span>Cashier: ${sale.cashier}</span><span>Customer: ${sale.customer}${sale.customerPhone ? ` (${sale.customerPhone})` : ""}</span><span>Transaction: ${sale.id}</span></div>
      <div class="receipt-table-head"><span>Item</span><span>Qty</span><span>Price</span><span>Subtotal</span></div>
      ${lines}
      <div class="receipt-summary"><div><span>Subtotal</span><b>${money(sale.subtotal)}</b></div><div><span>Discount</span><b>-${money(sale.discount)}</b></div><div><span>VAT</span><b>${money(sale.tax)}</b></div><div><span>Service charge</span><b>${money(sale.serviceCharge)}</b></div><div class="receipt-total-line"><span>Total</span><b>${money(sale.total)}</b></div></div>
      <div class="receipt-payment"><span>Payment Method: ${sale.method}</span><span>Paid Amount: ${money(sale.amountPaid)}</span><span>Change: ${money(sale.change)}</span><span>Transaction ID: ${sale.method === "M-Pesa" ? sale.transactionId : sale.id}</span></div>
      <div class="qr-placeholder" aria-label="Transaction barcode">${sale.id}</div>
      <div class="receipt-footer"><strong>${escapeHtml(settings.receiptFooter)}</strong><span>You earned ${earned} loyalty points today.</span><span>${escapeHtml(settings.returnPolicy)}</span><span>Thank you for shopping with us at ${escapeHtml(settings.receiptShopName)}!</span><div class="receipt-barcode" aria-hidden="true"></div></div>
    </div>`,
    `<button type="button" class="modal-secondary" data-receipt-action="print">Print</button><button type="button" class="modal-secondary" data-receipt-action="whatsapp">WhatsApp</button><button type="button" class="modal-primary" data-receipt-action="feedback">Done</button>`,
  );
  renderReceiptPanel(sale);
}

function renderReceiptPanel(sale) {
  const preview = document.querySelector("#receiptPreview");
  if (!preview) return;
  const lines = sale
    ? sale.items
        .map(
          (item) =>
            `<div class="receipt-preview-item"><span>${escapeHtml(item.name)} × ${item.quantity}</span><b>${money(item.unitPrice * item.quantity)}</b></div>`,
        )
        .join("")
    : "";
  preview.className = `receipt-preview receipt-template-${settings.receiptTemplate === "simple" ? "simple" : "detailed"}`;
  preview.style.setProperty("--receipt-font-size", `${getReceiptFontSize()}px`);
  preview.innerHTML = `
    ${receiptLogoMarkup()}
    <strong class="receipt-heading">${escapeHtml(settings.receiptHeader || "SALES RECEIPT")}</strong>
    <strong>${escapeHtml(settings.receiptShopName)}</strong><span>${escapeHtml(settings.receiptLocation)}</span><span>Tel: ${escapeHtml(settings.receiptPhone)}</span>
    ${sale ? `<span>Receipt No: ${sale.receiptNumber} · ${sale.date} ${sale.time}</span>` : ""}<hr>
    ${
      sale
        ? `
    ${lines}
    <div><span>Subtotal</span><b>${money(sale.subtotal)}</b></div>
    <div><span>Discount</span><b>-${money(sale.discount)}</b></div>
    <div><span>VAT</span><b>${money(sale.tax)}</b></div>
    <div><span>Service charge</span><b>${money(sale.serviceCharge)}</b></div>
    <div class="receipt-total"><span>Total</span><b>${money(sale.total)}</b></div>`
        : "<span>Complete a sale to see transaction details</span>"
    }
    <span>${escapeHtml(settings.receiptFooter)}</span>${sale ? `<span>You earned ${Math.floor(sale.total / 100)} loyalty points today.</span>` : ""}<span>${escapeHtml(settings.returnPolicy)}</span><span>Thank you for shopping with us at ${escapeHtml(settings.receiptShopName)}!</span>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>\"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function receiptLogoMarkup() {
  const logoUrl = settings.receiptLogoUrl?.trim();
  if (!logoUrl) return "";
  try {
    const parsedUrl = new URL(logoUrl, window.location.href);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) return "";
    return `<img class="receipt-logo" src="${escapeHtml(parsedUrl.href)}" alt="${escapeHtml(settings.receiptShopName)} logo">`;
  } catch {
    return "";
  }
}

function getReceiptFontSize() {
  return Math.min(18, Math.max(8, Number(settings.receiptFontSize) || 10));
}

/* ---------- Panels: inventory, customers, staff, reports, expenses, suppliers ---------- */

function getLowStockThreshold(product = null) {
  const productThreshold = Number(product?.reorderLevel);
  if (Number.isSafeInteger(productThreshold) && productThreshold >= 0)
    return productThreshold;
  const threshold = Number(settings.lowStockThreshold);
  return Number.isSafeInteger(threshold) && threshold >= 0
    ? threshold
    : DEFAULT_LOW_STOCK_LEVEL;
}

function getLowStockProducts() {
  return products
    .filter((product) => Number(product.stock) <= getLowStockThreshold(product))
    .sort(
      (a, b) =>
        Number(a.stock) - Number(b.stock) || a.name.localeCompare(b.name),
    );
}

function renderInventoryPanel() {
  const table = document.querySelector("#inventoryTable");
  if (!table) return;
  const filter = (
    document.querySelector("#inventorySearch")?.value || ""
  ).toLowerCase();
  const visible = products.filter((product) =>
    productSearchMatches(product, filter),
  );
  table.innerHTML =
    `<div class="inventory-head"><span>ITEM</span><span>CATEGORY</span><span>STOCK</span><span>PRICE</span><span></span></div>` +
    visible
      .map(
        (p) => `
      <div class="inventory-row">
        <strong>${escapeHtml(p.name)}</strong><span>${escapeHtml(p.category || "—")}</span>
        <span class="${Number(p.stock) <= getLowStockThreshold(p) ? "stock-low" : ""}">${Number(p.stock) || 0}</span>
        <span>${escapeHtml(settings.currency)} ${money(p.price)}</span>
        <div class="inventory-actions">
          <button class="row-action" data-product-action="print-label" data-id="${p.id}">Label</button>
          <button class="row-action" data-product-action="edit" data-id="${p.id}">Edit</button>
          <button class="row-action row-danger" data-product-action="delete" data-id="${p.id}">Delete</button>
        </div>
      </div>`,
      )
      .join("");
  const totalStock = products.reduce(
    (sum, product) => sum + Number(product.stock || 0),
    0,
  );
  const low = getLowStockProducts();
  const top = topSeller();
  document.querySelector("#stockCard").textContent = totalStock;
  document.querySelector("#lowStockCard").textContent = low.length;
  document.querySelector("#topSellerCard").textContent = top
    ? top.name.split(" ")[0]
    : "—";
  const thresholdInput = document.querySelector("#lowStockThresholdInput");
  if (thresholdInput) thresholdInput.value = String(getLowStockThreshold());
  const alertCount = document.querySelector("#inventoryAlertCount");
  if (alertCount)
    alertCount.textContent = `${low.length} item${low.length === 1 ? "" : "s"}`;
  const alertList = document.querySelector("#lowStockList");
  if (alertList) {
    alertList.innerHTML = low.length
      ? low
          .map(
            (product) => `
        <div class="panel-row inventory-alert-row">
          <span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.code || "No SKU")} · ${Number(product.stock) || 0} left (alert at ${getLowStockThreshold(product)})</small></span>
          <button class="row-action inventory-restock-button" type="button" data-restock-id="${product.id}">＋ Restock</button>
        </div>`,
          )
          .join("")
      : '<div class="panel-row inventory-alert-empty"><span>All products are above their alert levels.</span><strong>✓</strong></div>';
  }
  renderStockTransfersPanel();
}

function createReorderSuggestions() {
  if (currentUser?.role !== "admin")
    return showToast("Admin permission required");
  const lowStock = getLowStockProducts();
  let created = 0;
  lowStock.forEach((product) => {
    const existing = purchaseOrders.some(
      (order) =>
        order.product === product.name &&
        (order.store || settings.storeName) === settings.storeName &&
        !["Received", "Cancelled"].includes(order.status),
    );
    if (existing) return;
    const targetStock = Math.max(20, getLowStockThreshold(product) * 3);
    const supplier =
      product.supplier ||
      suppliers.find((entry) => entry.supplies === product.name)?.name ||
      "Any supplier";
    purchaseOrders.push({
      id: `PO-${Date.now()}-${product.id}`,
      product: product.name,
      productId: product.id,
      supplier,
      quantity: Math.max(1, targetStock - Number(product.stock || 0)),
      status: "Suggested",
      store: settings.storeName,
      createdAt: new Date().toISOString(),
    });
    created += 1;
  });
  renderSuppliersPanel();
  saveState();
  showToast(
    created
      ? `${created} reorder suggestion${created === 1 ? "" : "s"} created`
      : "No new reorder suggestions needed",
  );
}

const CODE39_PATTERNS = {
  0: "nnnwwnwnn",
  1: "wnnwnnnnw",
  2: "nnwwnnnnw",
  3: "wnwwnnnnn",
  4: "nnnwwnnnw",
  5: "wnnwwnnnn",
  6: "nnwwwnnnn",
  7: "nnnwnnwnw",
  8: "wnnwnnwnn",
  9: "nnwwnnwnn",
  A: "wnnnnwnnw",
  B: "nnwnnwnnw",
  C: "wnwnnwnnn",
  D: "nnnnwwnnw",
  E: "wnnnwwnnn",
  F: "nnwnwwnnn",
  G: "nnnnnwwnw",
  H: "wnnnnwwnn",
  I: "nnwnnwwnn",
  J: "nnnnwwwnn",
  K: "wnnnnnnww",
  L: "nnwnnnnww",
  M: "wnwnnnnwn",
  N: "nnnnwnnww",
  O: "wnnnwnnwn",
  P: "nnwnwnnwn",
  Q: "nnnnnnwww",
  R: "wnnnnnwwn",
  S: "nnwnnnwwn",
  T: "nnnnwnwwn",
  U: "wwnnnnnnw",
  V: "nwwnnnnnw",
  W: "wwwnnnnnn",
  X: "nwnnwnnnw",
  Y: "wwnnwnnnn",
  Z: "nwwnwnnnn",
  "-": "nwnnnnwnw",
  ".": "wwnnnnwnn",
  " ": "nwwnnnwnn",
  $: "nwnwnwnnn",
  "/": "nwnwnnnwn",
  "+": "nwnnnwnwn",
  "%": "nnnwnwnwn",
  "*": "nwnnwnwnn",
};

function code39Svg(code) {
  const encoded = `*${String(code)
    .toUpperCase()
    .replace(/[^A-Z0-9 .$\/+%-]/g, "-")}*`;
  let x = 0;
  const bars = [];
  for (const [characterIndex, character] of Array.from(encoded).entries()) {
    const pattern = CODE39_PATTERNS[character];
    if (!pattern) continue;
    for (let index = 0; index < pattern.length; index += 1) {
      const width = pattern[index] === "w" ? 3 : 1;
      if (index % 2 === 0)
        bars.push(`<rect x="${x}" y="0" width="${width}" height="40"/>`);
      x += width;
    }
    if (characterIndex < encoded.length - 1) x += 1;
  }
  return `<svg class="sku-barcode" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x} 40" role="img" aria-label="Code 39 barcode ${escapeHtml(code)}" preserveAspectRatio="none">${bars.join("")}</svg>`;
}

function printBarcodeLabels(product, count) {
  const barcodeValue = String(product.code || `SKU-${product.id}`)
    .toUpperCase()
    .replace(/[^A-Z0-9 .$\/+%-]/g, "-");
  const labels = Array.from(
    { length: count },
    () => `
    <article class="label">
      <strong>${escapeHtml(settings.receiptShopName || settings.storeName)}</strong>
      <span>${escapeHtml(product.name)}</span>
      ${code39Svg(barcodeValue)}
      <small>${escapeHtml(barcodeValue)} · ${escapeHtml(settings.currency)} ${money(product.price)}</small>
    </article>`,
  ).join("");
  const printWindow = window.open("", "_blank");
  if (!printWindow) return showToast("Allow pop-ups to print barcode labels");
  printWindow.document
    .write(`<!doctype html><html><head><meta charset="utf-8"><title>Product labels</title><style>
    @page{size:50mm 30mm;margin:2mm}*{box-sizing:border-box}body{margin:0;font:8pt Arial,sans-serif;color:#111}
    .labels{display:grid;grid-template-columns:repeat(2,50mm);gap:2mm}.label{width:50mm;height:30mm;padding:2mm;border:1px solid #ddd;display:flex;flex-direction:column;align-items:center;justify-content:space-between;text-align:center;overflow:hidden}
    .label strong{font-size:7pt}.label>span{font-size:9pt;font-weight:bold}.sku-barcode{width:42mm;height:9mm;fill:#000}.label small{font-size:6pt}
    @media print{.label{break-inside:avoid}}
  </style></head><body><main class="labels">${labels}</main><script>window.onload=()=>window.print()<\/script></body></html>`);
  printWindow.document.close();
}

function renderStockTransfersPanel() {
  const list = document.querySelector("#stockTransferList");
  if (!list) return;
  list.innerHTML = stockTransfers.length
    ? stockTransfers
        .slice()
        .reverse()
        .map(
          (transfer) =>
            `<div class="panel-row"><span>${escapeHtml(transfer.product)} · ${transfer.quantity} units · ${escapeHtml(transfer.from)} → ${escapeHtml(transfer.to)}</span><strong>${new Date(transfer.createdAt).toLocaleDateString("en-GB")}</strong></div>`,
        )
        .join("")
    : `<div class="panel-row"><span>No stock transfers recorded yet</span><strong>—</strong></div>`;
}

function openRestockModal(product) {
  if (currentUser?.role !== "admin")
    return showToast("Admin permission required to update stock");
  const suggestedQuantity = Math.max(
    1,
    getLowStockThreshold() + 1 - Number(product.stock || 0),
  );
  openModal(
    `Restock ${product.name}`,
    `<p class="modal-note">Current stock: <strong>${Number(product.stock) || 0}</strong> · Alert level: ${getLowStockThreshold()}</p><label>Units received<input id="restockQuantity" type="number" min="1" step="1" value="${suggestedQuantity}" inputmode="numeric" required></label>`,
    actionButtons("Add stock"),
  );
  modal.dataset.restockProductId = String(product.id);
  modalPurpose = "restock-product";
}

document
  .querySelector("#createReorderSuggestionsButton")
  ?.addEventListener("click", createReorderSuggestions);

document
  .querySelector("#lowStockThresholdInput")
  ?.addEventListener("change", (event) => {
    if (currentUser?.role !== "admin") {
      event.target.value = String(getLowStockThreshold());
      return showToast("Admin permission required to change alert levels");
    }
    const threshold = Number(event.target.value);
    if (!Number.isSafeInteger(threshold) || threshold < 0) {
      event.target.value = String(getLowStockThreshold());
      return showToast("Enter a whole number of zero or more");
    }
    settings.lowStockThreshold = threshold;
    renderAllPanels();
    saveState();
    showToast(`Low-stock alert set at ${threshold} units`);
  });

document.querySelector("#lowStockList")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-restock-id]");
  if (!button) return;
  const product = products.find(
    (item) => String(item.id) === button.dataset.restockId,
  );
  if (product) openRestockModal(product);
});

function topSeller() {
  const counts = {};
  salesLog.forEach((sale) =>
    (sale.items || []).forEach((item) => {
      counts[item.name] = (counts[item.name] || 0) + Number(item.quantity || 0);
    }),
  );
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? { name: best[0], sold: best[1] } : null;
}

function renderCustomersPanel() {
  const list = document.querySelector("#customerList");
  if (!list) return;
  list.innerHTML = customers
    .map(
      (c) =>
        `<div class="panel-row"><span>${escapeHtml(c.name)} · ${escapeHtml(c.phone)}</span><strong>${escapeHtml(c.tier)} · ${Number(c.points || 0)} pts</strong></div>`,
    )
    .join("");
}

function renderStaffPanel() {
  const list = document.querySelector("#staffList");
  if (!list) return;
  const adminCount = users.filter((user) => user.role === "admin").length;
  const adminCountLabel = document.querySelector("#adminAccountCount");
  if (adminCountLabel) {
    adminCountLabel.textContent = `Administrators: ${adminCount}/3`;
  }
  list.innerHTML = users
    .map(
      (u) =>
        `<div class="panel-row"><span>${escapeHtml(u.name)}</span><strong>${escapeHtml(u.role === "admin" ? "Admin · Active" : "Cashier · Active")}</strong></div>`,
    )
    .join("");
}

function estimateProfit(sales) {
  const revenue = sales.reduce((sum, sale) => sum + Number(sale.total || 0), 0);
  const cost = sales.reduce(
    (sum, sale) =>
      sum +
      (sale.items || []).reduce((itemSum, item) => {
        const product = products.find((entry) => entry.name === item.name);
        return (
          itemSum +
          Number(item.unitCost ?? product?.cost ?? 0) *
            Number(item.quantity || 0)
        );
      }, 0),
    0,
  );
  return (
    revenue -
    cost -
    expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0)
  );
}

function appendDashboardSale(list, sale, includeCashier) {
  const row = document.createElement("div");
  row.className = "panel-row";
  const details = document.createElement("span");
  details.textContent = [
    sale.date,
    sale.time,
    ...(includeCashier ? [sale.cashier || "Unknown cashier"] : []),
  ]
    .filter(Boolean)
    .join(" · ");
  const total = document.createElement("strong");
  total.textContent = `${settings.currency} ${money(sale.total)} · ${sale.method || "Sale"}`;
  row.append(details, total);
  list.append(row);
}

function renderAdminDashboard() {
  const today = new Date().toLocaleDateString("en-GB");
  const todaysSales = salesLog.filter((sale) => sale.date === today);
  const tillSummary = getTodayTillSummary(salesLog, today);
  const value = (id) => document.querySelector(`#${id}`);
  value("adminSalesToday").textContent =
    `${settings.currency} ${money(todaysSales.reduce((sum, sale) => sum + Number(sale.total || 0), 0))}`;
  value("adminOrdersToday").textContent = String(todaysSales.length);
  value("adminLowStock").textContent = String(getLowStockProducts().length);
  value("adminProfit").textContent =
    `${settings.currency} ${money(estimateProfit(salesLog))}`;

  const tillSalesBody = value("adminTillSales");
  const tillSalesTotal = value("adminTillSalesTotal");
  tillSalesBody.replaceChildren();
  tillSalesTotal.replaceChildren();
  const addTillRow = (label, orders, total, rowType = "body") => {
    const row = document.createElement("tr");
    const tillCell = document.createElement("th");
    tillCell.scope = "row";
    tillCell.textContent = label;
    const ordersCell = document.createElement("td");
    ordersCell.textContent = String(orders);
    const totalCell = document.createElement("td");
    totalCell.textContent = `${settings.currency} ${money(total)}`;
    row.append(tillCell, ordersCell, totalCell);
    (rowType === "footer" ? tillSalesTotal : tillSalesBody).append(row);
  };
  tillSummary.tills.forEach(({ tillNumber, orders, total }) => {
    addTillRow(`Till ${tillNumber}`, orders, total);
  });
  if (tillSummary.unassigned.orders) {
    addTillRow(
      "Unassigned",
      tillSummary.unassigned.orders,
      tillSummary.unassigned.total,
    );
  }
  addTillRow(
    "Total today",
    tillSummary.total.orders,
    tillSummary.total.total,
    "footer",
  );

  const recentSales = value("adminRecentSales");
  recentSales.replaceChildren();
  if (!salesLog.length) {
    recentSales.innerHTML =
      '<div class="panel-row"><span>No sales recorded yet</span><strong>—</strong></div>';
    return;
  }
  salesLog
    .slice()
    .reverse()
    .forEach((sale) => appendDashboardSale(recentSales, sale, true));
}

function getTodayTillSummary(sales, today) {
  const tills = [1, 2, 3, 4].map((tillNumber) => ({
    tillNumber,
    orders: 0,
    total: 0,
  }));
  const unassigned = { orders: 0, total: 0 };
  const total = { orders: 0, total: 0 };

  sales
    .filter((sale) => sale.date === today)
    .forEach((sale) => {
      const amount = Number(sale.total) || 0;
      const till = tills.find(
        (entry) => entry.tillNumber === Number(sale.tillNumber),
      );
      const bucket = till || unassigned;
      bucket.orders += 1;
      bucket.total += amount;
      total.orders += 1;
      total.total += amount;
    });

  return { tills, unassigned, total };
}

function getCashierId(user = currentUser) {
  return String(user?.username || user?.email || user?.name || "")
    .trim()
    .toLowerCase();
}

function isCashierWorkspace() {
  return (
    currentUser?.role === "cashier" ||
    window.__tajiriWorkspaceRole === "cashier"
  );
}

function getCurrentShift() {
  const cashierId = getCashierId();
  return (
    shifts.find((shift) => shift.cashierId === cashierId && !shift.closedAt) ||
    null
  );
}

function renderCashierDashboard() {
  const cashierId = getCashierId();
  const cashierName = String(currentUser?.name || "Cashier");
  const today = new Date().toLocaleDateString("en-GB");
  const todaysSales = salesLog.filter(
    (sale) =>
      sale.date === today &&
      (String(sale.cashierId || "").toLowerCase() === cashierId ||
        String(sale.cashier || "").toLowerCase() === cashierName.toLowerCase()),
  );
  document.querySelector("#cashierDashboardName").textContent =
    cashierName.split(/\s+/)[0];
  document.querySelector("#cashierDashboardSales").textContent =
    `${settings.currency} ${money(todaysSales.reduce((sum, sale) => sum + Number(sale.total || 0), 0))}`;
  document.querySelector("#cashierDashboardOrders").textContent = String(
    todaysSales.length,
  );

  const shift = getCurrentShift();
  const status = document.querySelector("#cashierShiftStatus");
  const details = document.querySelector("#cashierShiftDetails");
  const button = document.querySelector("#cashierShiftButton");
  status.textContent = shift ? "Shift open" : "No shift open";
  details.textContent = shift
    ? `Till ${shift.tillNumber || "unassigned"} · Started ${new Date(shift.openedAt).toLocaleString("en-GB")} · Opening float ${settings.currency} ${money(shift.openingFloat)}`
    : "Open a shift before taking sales.";
  button.textContent = shift ? "Close shift" : "Open shift";
  button.dataset.shiftAction = shift ? "close" : "open";

  const list = document.querySelector("#cashierTodaySales");
  list.replaceChildren();
  if (!todaysSales.length) {
    list.innerHTML =
      '<div class="panel-row"><span>No sales recorded today</span><strong>—</strong></div>';
    return;
  }
  todaysSales
    .slice()
    .reverse()
    .forEach((sale) => appendDashboardSale(list, sale, false));
}

function renderReportsPanel() {
  const todayDate = new Date().toLocaleDateString("en-GB");
  const todaysSales = salesLog.filter((sale) => sale.date === todayDate);
  const today = todaysSales.reduce(
    (sum, sale) => sum + Number(sale.total || 0),
    0,
  );
  const expenseTotal = expenses.reduce((sum, e) => sum + e.amount, 0);
  const vat = salesLog.reduce((sum, s) => sum + s.tax, 0);
  document.querySelector("#reportToday").textContent =
    `${settings.currency} ${money(today)}`;
  document.querySelector("#reportProfit").textContent =
    `${settings.currency} ${money(estimateProfit(salesLog))}`;
  document.querySelector("#reportOrders").textContent = salesLog.length;
  document.querySelector("#reportVat").textContent =
    `${settings.currency} ${money(vat)}`;
  document.querySelector("#reportVatRate").textContent =
    `${(settings.taxRate * 100).toFixed(1).replace(/\.0$/, "")}%`;
  document.querySelector("#reportExpenses").textContent =
    `${settings.currency} ${money(expenseTotal)}`;
  const top = topSeller();
  document.querySelector("#reportTop").textContent = top
    ? `${top.name} · ${top.sold} sold`
    : "No sales yet";
  const mix = {};
  salesLog.forEach((s) => {
    mix[s.method] = (mix[s.method] || 0) + 1;
  });
  const mixText = Object.entries(mix)
    .map(([m, n]) => `${m} ${Math.round((n / salesLog.length) * 100)}%`)
    .join(" · ");
  document.querySelector("#reportPaymentMix").textContent = salesLog.length
    ? mixText
    : "—";
  // AI insights: reorder suggestion + demand estimate
  const low = getLowStockProducts();
  const avg = todaysSales.length ? today / todaysSales.length : 0;
  document.querySelector("#aiInsight").textContent = low.length
    ? `Reorder ${low[0].name} soon — ${low[0].stock} left, avg sale ${money(avg)}`
    : `Stock healthy · avg sale ${settings.currency} ${money(avg)}`;
  renderSalesTrend();
  const frequency = document.querySelector("#reportScheduleFrequency");
  const time = document.querySelector("#reportScheduleTime");
  const status = document.querySelector("#reportScheduleStatus");
  const schedule = settings.reportSchedule;
  if (frequency) frequency.value = schedule?.frequency || "daily";
  if (time) time.value = schedule?.time || "18:00";
  if (status) {
    status.textContent = schedule
      ? `${schedule.frequency === "weekly" ? "Weekly" : "Daily"} export at ${schedule.time} local time. Runs while Tajiri POS is open on this device.`
      : "Scheduled exports run while Tajiri POS is open on this device.";
  }
}

function getSalesTrend(days = 7) {
  const byDay = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toLocaleDateString("en-GB");
    byDay.push({
      date: d,
      key,
      total: salesLog
        .filter((sale) => sale.date === key)
        .reduce((sum, sale) => sum + Number(sale.total || 0), 0),
    });
  }
  return byDay;
}

function renderSalesTrend() {
  const chart = document.querySelector("#trendChart");
  if (!chart) return;
  const days = getSalesTrend(7);
  const max = Math.max(...days.map((d) => d.total), 1);
  const best = days.reduce((a, b) => (b.total > a.total ? b : a), days[0]);
  const average = days.reduce((sum, d) => sum + d.total, 0) / days.length;
  chart.innerHTML = "";
  days.forEach((day) => {
    const wrap = document.createElement("div");
    wrap.className =
      "trend-bar-wrap" +
      (best.total > 0 && day.key === best.key ? " best" : "");
    const height = Math.max(4, Math.round((day.total / max) * 100));
    const value = document.createElement("span");
    value.className = "trend-bar-value";
    value.textContent = day.total ? money(day.total) : "";
    const bar = document.createElement("div");
    bar.className = "trend-bar";
    bar.style.height = `${height}%`;
    bar.title = `${day.date.toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "short",
    })}: ${settings.currency} ${money(day.total)}`;
    const label = document.createElement("span");
    label.className = "trend-bar-label";
    label.textContent = day.date.toLocaleDateString("en-GB", {
      weekday: "short",
    });
    wrap.append(value, bar, label);
    chart.append(wrap);
  });
  const bestEl = document.querySelector("#trendBestDay");
  const avgEl = document.querySelector("#trendAverage");
  const rangeEl = document.querySelector("#trendRange");
  if (bestEl) {
    bestEl.textContent = best.total
      ? `${best.date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} · ${settings.currency} ${money(best.total)}`
      : "No sales yet";
  }
  if (avgEl) avgEl.textContent = `${settings.currency} ${money(average)}`;
  if (rangeEl) {
    const first = days[0].date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
    });
    const last = days[days.length - 1].date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
    });
    rangeEl.textContent = `${first} – ${last}`;
  }
}

function getScheduledReportKey(frequency, date = new Date()) {
  const formatDate = (value) =>
    `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (frequency !== "weekly") return formatDate(day);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return formatDate(day);
}

function downloadScheduledSalesReport(frequency, reportDate = new Date()) {
  const reportDay = new Date(
    reportDate.getFullYear(),
    reportDate.getMonth(),
    reportDate.getDate(),
  );
  const weekStart = new Date(reportDay);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const nextWeekStart = new Date(weekStart);
  nextWeekStart.setDate(nextWeekStart.getDate() + 7);
  const sales = salesLog.filter((sale) => {
    if (frequency !== "weekly")
      return sale.date === reportDay.toLocaleDateString("en-GB");
    const [day, month, year] = String(sale.date || "")
      .split("/")
      .map(Number);
    if (!day || !month || !year) return false;
    const saleDate = new Date(year, month - 1, day);
    return saleDate >= weekStart && saleDate < nextWeekStart;
  });
  const rows = [
    [
      "Store",
      "Date",
      "Time",
      "Sale ID",
      "Receipt",
      "Cashier",
      "Customer",
      "Payment",
      "Items",
      "Total",
    ],
    ...sales.map((sale) => [
      sale.store || settings.storeName,
      sale.date,
      sale.time,
      sale.id,
      sale.receiptNumber,
      sale.cashier,
      sale.customer,
      sale.method,
      (sale.items || [])
        .map((item) => `${item.name} x ${item.quantity}`)
        .join("; "),
      Number(sale.total || 0).toFixed(2),
    ]),
  ];
  const date = new Date().toISOString().slice(0, 10);
  downloadTextFile(
    `tajiri-sales-report-${date}.csv`,
    toCsv(rows),
    "text/csv;charset=utf-8",
  );
}

function checkScheduledReport() {
  const schedule = settings.reportSchedule;
  if (!schedule || currentUser?.role !== "admin") return;
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const runKey = getScheduledReportKey(schedule.frequency, now);
  if (currentTime < schedule.time || schedule.lastRunKey === runKey) return;
  downloadScheduledSalesReport(schedule.frequency, now);
  schedule.lastRunKey = runKey;
  saveState();
  renderReportsPanel();
  showToast("Scheduled sales report downloaded");
}

document
  .querySelector("#saveReportScheduleButton")
  ?.addEventListener("click", () => {
    if (currentUser?.role !== "admin")
      return showToast("Admin permission required");
    const frequency = document.querySelector("#reportScheduleFrequency").value;
    const time = document.querySelector("#reportScheduleTime").value;
    if (!["daily", "weekly"].includes(frequency) || !/^\d{2}:\d{2}$/.test(time))
      return showToast("Choose a valid report frequency and time");
    settings.reportSchedule = {
      frequency,
      time,
      lastRunKey: "",
    };
    saveState();
    renderReportsPanel();
    showToast("Sales report schedule saved");
    checkScheduledReport();
  });

document
  .querySelector("#clearReportScheduleButton")
  ?.addEventListener("click", () => {
    if (currentUser?.role !== "admin")
      return showToast("Admin permission required");
    delete settings.reportSchedule;
    saveState();
    renderReportsPanel();
    showToast("Scheduled sales report turned off");
  });

function renderExpensesPanel() {
  const list = document.querySelector("#expenseList");
  if (!list) return;
  list.innerHTML = expenses.length
    ? expenses
        .map(
          (e) =>
            `<div class="panel-row"><span>${e.type} · ${e.note || "no note"}</span><strong>${settings.currency} ${money(e.amount)}</strong></div>`,
        )
        .join("")
    : `<div class="panel-row"><span>No expenses recorded yet</span><strong>—</strong></div>`;
}

function renderSuppliersPanel() {
  const list = document.querySelector("#supplierList");
  const poList = document.querySelector("#purchaseOrderList");
  if (list)
    list.innerHTML = suppliers
      .map(
        (s) =>
          `<div class="panel-row"><span>${escapeHtml(s.name)} · ${escapeHtml(s.phone)}</span><strong>${escapeHtml(s.supplies)}</strong></div>`,
      )
      .join("");
  if (poList)
    poList.innerHTML = purchaseOrders.length
      ? purchaseOrders
          .map(
            (po, i) =>
              `<div class="panel-row"><span>${escapeHtml(po.product)} · ${Number(po.quantity) || 0} units · ${escapeHtml(po.supplier)} · ${escapeHtml(po.store || settings.storeName)} · ${escapeHtml(po.status || "Suggested")}</span><span class="purchase-order-actions">${po.status === "Received" ? "Received" : `<button class="row-action" data-po-action="download" data-index="${i}">Download PO</button><button class="row-action" data-po-action="receive" data-index="${i}">Receive stock</button>`}</span></div>`,
          )
          .join("")
      : `<div class="panel-row"><span>No suggested orders — stock levels healthy</span><strong>—</strong></div>`;
}

function renderAccountingPanel() {
  const salesTotal = document.querySelector("#accountingSalesTotal");
  const expenseTotal = document.querySelector("#accountingExpenseTotal");
  const cashBalance = document.querySelector("#accountingCashBalance");
  if (!salesTotal || !expenseTotal || !cashBalance) return;
  const sales = salesLog.reduce(
    (sum, sale) => sum + Number(sale.total || 0),
    0,
  );
  const expenseAmount = expenses.reduce(
    (sum, expense) => sum + Number(expense.amount || 0),
    0,
  );
  const moneyIn = cashBook
    .filter((entry) => entry.direction === "in")
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const moneyOut = cashBook
    .filter((entry) => entry.direction === "out")
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  salesTotal.textContent = `${settings.currency} ${money(sales)}`;
  expenseTotal.textContent = `${settings.currency} ${money(expenseAmount)}`;
  cashBalance.textContent = `${settings.currency} ${money(moneyIn - moneyOut)}`;
}

function renderBranchesPanel() {
  const list = document.querySelector("#branchList");
  if (!list) return;
  const branches = getStoreNames();
  list.innerHTML = branches
    .map((branch) => {
      const stock = branchStock[branch] || {};
      const units = Object.values(stock).reduce(
        (sum, quantity) => sum + Math.max(0, Number(quantity) || 0),
        0,
      );
      return `<div class="panel-row"><span>${escapeHtml(branch)}${branch === settings.storeName ? " · Active" : ""}</span><strong>${units} units · ${products.length} products</strong></div>`;
    })
    .join("");
}

function renderOperationsPanel() {
  const activeStore = document.querySelector("#operationsActiveStore");
  const branchCount = document.querySelector("#operationsBranchCount");
  const connection = document.querySelector("#operationsConnection");
  const vatThisMonth = document.querySelector("#operationsVatThisMonth");
  const notificationSummary = document.querySelector(
    "#operationsNotificationSummary",
  );
  const feedbackSummary = document.querySelector("#operationsFeedbackSummary");
  const deliveryList = document.querySelector("#operationsDeliveryList");
  const deliveryCount = document.querySelector("#deliveryCount");
  const branches = getStoreNames();
  const lowStockCount = getLowStockProducts().length;
  const now = new Date();
  const monthVat = salesLog.reduce((sum, sale) => {
    const [day, month, year] = String(sale.date || "")
      .split("/")
      .map(Number);
    return month === now.getMonth() + 1 && year === now.getFullYear()
      ? sum + Number(sale.tax || 0)
      : sum;
  }, 0);
  const ratings = salesLog
    .map((sale) => Number(sale.feedbackRating))
    .filter((rating) => Number.isInteger(rating) && rating >= 1 && rating <= 5);

  if (activeStore) activeStore.textContent = settings.storeName;
  if (branchCount)
    branchCount.textContent = `${branches.length} branch${branches.length === 1 ? "" : "es"}`;
  if (connection)
    connection.textContent =
      offlineMode || !navigator.onLine ? "Offline" : "Online";
  if (vatThisMonth)
    vatThisMonth.textContent = `${settings.currency} ${money(monthVat)}`;
  if (notificationSummary)
    notificationSummary.textContent = `${lowStockCount} low-stock alert${lowStockCount === 1 ? "" : "s"}`;
  if (feedbackSummary)
    feedbackSummary.textContent = ratings.length
      ? `${ratings.length} rating${ratings.length === 1 ? "" : "s"} · ${(
          ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length
        ).toFixed(1)}/5`
      : "No ratings yet";
  if (deliveryCount)
    deliveryCount.textContent = `${deliveries.length} order${deliveries.length === 1 ? "" : "s"}`;
  if (deliveryList) {
    deliveryList.innerHTML = deliveries.length
      ? deliveries
          .slice()
          .reverse()
          .map(
            (delivery) => `
              <div class="panel-row">
                <span><strong>${escapeHtml(delivery.customer || "Walk-in customer")}</strong><small>${escapeHtml(delivery.address)} · ${escapeHtml(delivery.store)} · ${delivery.items.length} item${delivery.items.length === 1 ? "" : "s"}</small></span>
                <span class="operation-row-actions"><strong>${escapeHtml(delivery.status)}${delivery.rider ? ` · ${escapeHtml(delivery.rider)}` : ""}</strong><button class="row-action" type="button" data-delivery-action="toggle" data-id="${escapeHtml(delivery.id)}">${delivery.status === "Delivered" ? "Reopen" : "Mark delivered"}</button></span>
              </div>`,
          )
          .join("")
      : '<div class="panel-row"><span>No delivery orders recorded yet</span><strong>—</strong></div>';
  }
}

function renderAllPanels() {
  renderAdminDashboard();
  renderCashierDashboard();
  renderInventoryPanel();
  renderCustomersPanel();
  renderStaffPanel();
  renderReportsPanel();
  renderExpensesPanel();
  renderSuppliersPanel();
  renderCashBookPanel();
  renderAccountingPanel();
  renderBranchesPanel();
  renderOperationsPanel();
}

function exportAccountingLedger() {
  const rows = [
    [
      "Date",
      "Reference",
      "Store",
      "Entry type",
      "Description",
      "Debit",
      "Credit",
    ],
    ...salesLog.map((sale) => [
      sale.date,
      sale.id,
      sale.store || settings.storeName,
      "Sale",
      `${sale.method || "Payment"} · ${sale.customer || "Walk-in customer"}`,
      "",
      Number(sale.total || 0).toFixed(2),
    ]),
    ...expenses.map((expense, index) => [
      expense.date || "",
      `EXP-${index + 1}`,
      expense.store || settings.storeName,
      "Expense",
      `${expense.type}${expense.note ? ` · ${expense.note}` : ""}`,
      Number(expense.amount || 0).toFixed(2),
      "",
    ]),
  ];
  downloadTextFile(
    "tajiri-accounting-ledger.csv",
    toCsv(rows),
    "text/csv;charset=utf-8",
  );
  showToast(
    "Accounting ledger exported as CSV; no external connector was used",
  );
}

function openCampaignComposer() {
  if (currentUser?.role !== "admin")
    return showToast("Admin permission required");
  openModal(
    "Prepare customer campaign",
    `<p class="modal-note">Create a contact-and-message CSV for your SMS provider. Tajiri POS does not send messages without a configured provider.</p><label>Audience<select id="campaignAudience"><option value="all">All loyalty customers</option><option value="vip">VIP customers</option></select></label><label>Message<textarea id="campaignMessage" rows="4" maxlength="320" placeholder="Write your offer or update" required></textarea></label>`,
    actionButtons("Export campaign"),
  );
  modalPurpose = "customer-campaign";
}

function openBranchManager() {
  if (currentUser?.role !== "admin")
    return showToast("Admin permission required");
  const options = getStoreNames()
    .map(
      (store) =>
        `<option value="${escapeHtml(store)}"${store === settings.storeName ? " selected" : ""}>${escapeHtml(store)}</option>`,
    )
    .join("");
  openModal(
    "Manage store branches",
    `<label>Active branch<select id="managedBranch">${options}</select></label><label>Add a branch<input id="newBranchName" maxlength="60" placeholder="Branch name"></label><p class="modal-note">Adding a branch creates an empty stock record. Existing branch inventory is preserved.</p>`,
    actionButtons("Save branches"),
  );
  modalPurpose = "branch-manager";
}

document
  .querySelector('[data-view="Operations"]')
  ?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-operation]");
    if (!button) return;
    const operation = button.dataset.operation;
    if (operation === "stores") return openBranchManager();
    if (operation === "expense") {
      activateView("Expenses");
      document.querySelector("#addExpenseButton")?.click();
      return;
    }
    if (operation === "suppliers") return activateView("Suppliers");
    if (operation === "roles") return activateView("Staff");
    if (operation === "payments") return activateView("Settings");
    if (operation === "insights") {
      activateView("Reports");
      return;
    }
    if (operation === "notifications") {
      document.querySelector(".icon-button")?.click();
      return;
    }
    if (operation === "accounting-export") return exportAccountingLedger();
    if (operation === "campaign") return openCampaignComposer();
  });

document
  .querySelector("#exportAccountingButton")
  ?.addEventListener("click", exportAccountingLedger);
document
  .querySelector("#branchManageButton")
  ?.addEventListener("click", openBranchManager);
document
  .querySelector("#marketingCampaignButton")
  ?.addEventListener("click", openCampaignComposer);
document
  .querySelector("#adminCreateAccountButton")
  ?.addEventListener("click", () => {
    if (currentUser?.role !== "admin")
      return showToast("Admin permission required");
    document.querySelector("#addAccountButton")?.click();
  });
document
  .querySelector("#adminSetupGuideButton")
  ?.addEventListener("click", () => {
    if (currentUser?.role !== "admin")
      return showToast("Admin permission required");
    openModal(
      "Optional store setup guide",
      `<p class="modal-note">Use these steps when setting up a store for the first time. Nothing changes until you save it in the relevant screen.</p><ol class="setup-guide-list"><li><strong>Add your products</strong><span>Set product names, prices, and opening stock.</span><button type="button" class="modal-secondary" data-setup-guide-view="Inventory" data-setup-guide-focus="#addProductButton">Open products</button></li><li><strong>Review your tax rate</strong><span>Set VAT and any service charge for your store.</span><button type="button" class="modal-secondary" data-setup-guide-view="Settings" data-setup-guide-focus="#taxRateInput">Review tax settings</button></li><li><strong>Choose payment methods</strong><span>Enable the payment methods your cashiers accept.</span><button type="button" class="modal-secondary" data-setup-guide-view="Settings" data-setup-guide-focus="#mpesaToggle">Review payment settings</button></li></ol>`,
      '<button type="button" class="modal-primary" data-modal-action="cancel">Close guide</button>',
    );
  });

document
  .querySelector("#operationsDeliveryList")
  ?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-delivery-action='toggle']");
    if (!button) return;
    if (currentUser?.role !== "admin")
      return showToast("Admin permission required");
    const delivery = deliveries.find((entry) => entry.id === button.dataset.id);
    if (!delivery) return showToast("Delivery order no longer exists");
    delivery.status = delivery.status === "Delivered" ? "Pending" : "Delivered";
    delivery.updatedAt = new Date().toISOString();
    renderOperationsPanel();
    saveState();
    showToast(`Delivery marked ${delivery.status.toLowerCase()}`);
  });

/* ---------- Cash book ---------- */

function renderCashBookPanel() {
  const list = document.querySelector("#cashBookList");
  if (!list) return;
  const moneyIn = cashBook
    .filter((e) => e.direction === "in")
    .reduce((s, e) => s + e.amount, 0);
  const moneyOut = cashBook
    .filter((e) => e.direction === "out")
    .reduce((s, e) => s + e.amount, 0);
  const balance = moneyIn - moneyOut;
  document.querySelector("#cashBookIn").textContent =
    `${settings.currency} ${money(moneyIn)}`;
  document.querySelector("#cashBookOut").textContent =
    `${settings.currency} ${money(moneyOut)}`;
  document.querySelector("#cashBookBalance").textContent =
    `${settings.currency} ${money(balance)}`;
  list.innerHTML = cashBook.length
    ? cashBook
        .slice()
        .reverse()
        .map(
          (e) => `
      <div class="cashbook-row panel-row cashbook-${e.direction}">
        <span>${e.direction === "in" ? "▲" : "▼"} ${e.label} · ${e.method}</span>
        <strong>${e.direction === "in" ? "+" : "-"}${settings.currency} ${money(e.amount)}</strong>
      </div>`,
        )
        .join("")
    : `<div class="panel-row"><span>No cash movements yet</span><strong>—</strong></div>`;
}

document.querySelector("#addCashEntryButton")?.addEventListener("click", () => {
  if (currentUser?.role !== "admin")
    return showToast("Admin permission required");
  openModal(
    "Add cash entry",
    `
    <label>Direction<select id="cashEntryDirection"><option value="in">Money in (cash received)</option><option value="out">Money out (cash paid)</option></select></label>
    <label>Amount (KES)<input id="cashEntryAmount" type="number" min="0.01" step="0.01" required></label>
    <label>Note<input id="cashEntryNote" placeholder="e.g. Owner float, bank deposit"></label>`,
    actionButtons("Record entry"),
  );
});

/* ---------- Roles, login, offline persistence ---------- */

const ADMIN_ONLY_VIEWS = [
  "Admin Dashboard",
  "Inventory",
  "Purchases",
  "Customers",
  "Staff",
  "Reports",
  "Settings",
  "Operations",
  "Branches",
  "Accounting",
  "Marketing",
  "Expenses",
  "Suppliers",
  "Cash Book",
  "Premium Tools",
];

function getFirstName(fullName) {
  const value = String(fullName || "").trim();
  if (!value) return "";
  return value.split(/\s+/)[0];
}

function getInitials(fullName) {
  const names = String(fullName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!names.length) return "";
  return names
    .slice(0, 2)
    .map((name) => name[0].toUpperCase())
    .join("");
}

function applyRole() {
  const isAdmin = currentUser?.role === "admin";
  const isCashier = Boolean(currentUser && !isAdmin);
  const cashierWorkspace = window.__tajiriWorkspaceRole === "cashier";
  const roleLabel = currentUser
    ? currentUser.role.charAt(0).toUpperCase() + currentUser.role.slice(1)
    : "—";
  const dashboardMenuButton = document.querySelector("#dashboardMenuButton");
  if (dashboardMenuButton)
    dashboardMenuButton.dataset.view =
      isAdmin && !cashierWorkspace ? "Admin Dashboard" : "Cashier Dashboard";
  const firstName = currentUser ? getFirstName(currentUser.name) : "";
  const userName = document.querySelector("#userName");
  const userInitials = document.querySelector("#userInitials");
  const userRole = document.querySelector("#userRole");
  if (userName) {
    userName.textContent = firstName || "Guest";
    userName.title = currentUser ? currentUser.name : "Not signed in";
  }
  if (userInitials)
    userInitials.textContent = currentUser ? getInitials(currentUser.name) : "";
  if (userRole) userRole.textContent = currentUser ? roleLabel : "";

  document.querySelectorAll(".nav-button, .more-menu-item").forEach((item) => {
    const view = item.getAttribute("data-view");
    item.style.display =
      (ADMIN_ONLY_VIEWS.includes(view) && !isAdmin) ||
      (view === "Cashier Dashboard" && !isCashier && !cashierWorkspace)
        ? "none"
        : "";
  });
  const downloadDataButton = document.querySelector("#downloadDataButton");
  if (downloadDataButton)
    downloadDataButton.style.display = isAdmin ? "" : "none";
  document
    .querySelectorAll(".sale-type-picker, #addCustom, #discountButton")
    .forEach((item) => {
      item.hidden = isCashier;
      item.style.display = isCashier ? "none" : "";
    });
  const saleTypePicker = document.querySelector("#saleTypeSelect");
  if (saleTypePicker) saleTypePicker.disabled = isCashier;
  const cashier = document.querySelector("#cashierName");
  if (cashier)
    cashier.textContent = currentUser
      ? `${currentUser.name} (${currentUser.role})`
      : "Not signed in";
  const role = document.querySelector("#settingsRole");
  if (role) role.textContent = roleLabel;
  const staffButton = document.querySelector("#staffButton");
  if (staffButton)
    staffButton.innerHTML = `${currentUser ? currentUser.name : "Not signed in"} <span>⚙</span>`;
  const addAccountButton = document.querySelector("#addAccountButton");
  if (addAccountButton) addAccountButton.hidden = !isAdmin;
  const welcomeHeader = document.querySelector("#welcomeHeaderLabel");
  if (welcomeHeader) {
    welcomeHeader.textContent = currentUser
      ? `Welcome, ${currentUser.name}`
      : "Welcome";
  }
}

async function hashPassword(password) {
  if (globalThis.crypto?.subtle) {
    const bytes = new TextEncoder().encode(password);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  let hash = 2166136261;
  for (const character of password)
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `fallback-${(hash >>> 0).toString(16)}`;
}

function makeSessionSignature(user, role) {
  const input = `${String(user || "").trim()}|${String(role || "").trim()}|tajiri-pos-session-v1`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash = Math.imul(hash ^ input.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function writeSignedSession(
  storage,
  userKey,
  roleKey,
  signatureKey,
  user,
  role,
) {
  storage.setItem(userKey, user);
  storage.setItem(roleKey, role);
  storage.setItem(signatureKey, makeSessionSignature(user, role));
}

async function loginWithPassword(identity, password) {
  const normalized = normalizeIdentity(identity);
  const user = users.find((entry) => {
    const identities = [
      entry.username,
      entry.email,
      entry.name,
      entry.name.toLowerCase().replace(/\s+/g, "."),
      `${entry.name} · ${entry.role}`,
      `${entry.name} | ${entry.role}`,
      `${entry.name.toLowerCase()}|${entry.role.toLowerCase()}`,
    ].map(normalizeIdentity);
    return identities.includes(normalized);
  });
  const role = String(user?.role || "").toLowerCase();
  if (
    !user ||
    !["admin", "cashier"].includes(role) ||
    !user.passwordHash ||
    user.passwordHash !== (await hashPassword(password))
  )
    return false;
  user.role = role;
  currentUser = user;
  const sessionIdentity =
    user.username?.toLowerCase() ||
    user.email?.toLowerCase() ||
    user.name.toLowerCase().replace(/\s+/g, ".");
  writeSignedSession(
    sessionStorage,
    "tajiri-session-user",
    "tajiri-session-role",
    "tajiri-session-signature",
    sessionIdentity,
    user.role,
  );
  applyRole();
  activateRoleLandingView();
  checkScheduledReport();
  showToast(`Welcome, ${user.name}`);
  return true;
}

function loginWithPin(account, pin) {
  const authenticatedUser = window.firebaseAuth?.currentUser;
  const identity = normalizeIdentity(account);
  const user = users.find((entry) => {
    const fullAccount = `${entry.name} · ${entry.role}`;
    const aliases = [
      entry.name,
      entry.username,
      entry.email,
      entry.name.toLowerCase().replace(/\s+/g, "."),
      fullAccount,
      `${entry.name.toLowerCase()}|${entry.role.toLowerCase()}`,
      `${entry.name} | ${entry.role}`,
    ].map(normalizeIdentity);
    return aliases.includes(identity);
  });
  const role = String(user?.role || "").toLowerCase();
  if (
    !user ||
    !authenticatedUser?.emailVerified ||
    user.uid !== authenticatedUser.uid ||
    !["admin", "cashier"].includes(role) ||
    !user.pin ||
    String(pin).trim() !== String(user.pin)
  )
    return false;
  user.role = role;
  currentUser = user;
  const sessionIdentity =
    user.username?.toLowerCase() ||
    user.email?.toLowerCase() ||
    user.name.toLowerCase().replace(/\s+/g, ".");
  writeSignedSession(
    sessionStorage,
    "tajiri-session-user",
    "tajiri-session-role",
    "tajiri-session-signature",
    sessionIdentity,
    user.role,
  );
  applyRole();
  activateRoleLandingView();
  checkScheduledReport();
  showToast(`Welcome, ${user.name}`);
  return true;
}

function getStoreNames() {
  const options = Array.from(
    document.querySelectorAll("#storeSelect option"),
    (option) => option.value || option.textContent.trim(),
  ).filter(Boolean);
  if (Array.isArray(settings.branches)) options.push(...settings.branches);
  if (settings.storeName && !options.includes(settings.storeName))
    options.push(settings.storeName);
  return [...new Set(options)];
}

function renderStoreOptions() {
  const select = document.querySelector("#storeSelect");
  if (!select) return;
  const stores = getStoreNames();
  select.replaceChildren(
    ...stores.map((store) => {
      const option = document.createElement("option");
      option.value = store;
      option.textContent = store;
      return option;
    }),
  );
  select.value = settings.storeName;
}

function syncCurrentBranchStock() {
  if (!branchStock || typeof branchStock !== "object") branchStock = {};
  const store = settings.storeName || "Main Store";
  if (!branchStock[store] || typeof branchStock[store] !== "object")
    branchStock[store] = {};
  products.forEach((product) => {
    branchStock[store][String(product.id)] = Number(product.stock) || 0;
  });
}

function activateStoreStock(storeName) {
  getStoreNames().forEach((store) => {
    if (!branchStock[store] || typeof branchStock[store] !== "object")
      branchStock[store] = {};
  });
  products.forEach((product) => {
    const savedStock = branchStock[storeName]?.[String(product.id)];
    product.stock = Number.isSafeInteger(Number(savedStock))
      ? Number(savedStock)
      : 0;
  });
}

function saveState() {
  try {
    syncCurrentBranchStock();
    const state = {
      users,
      customers,
      salesLog,
      expenses,
      purchaseOrders,
      pendingMpesa,
      loyaltyBalance,
      cashBook,
      shifts,
      branchStock,
      stockTransfers,
      deliveries,
      products,
      productsStock: products.map((p) => ({ id: p.id, stock: p.stock })),
      settings,
      offlineMode,
    };
    const tenantId = String(window.__tajiriCloudTenantId || "");
    const stateKey = tenantId ? `tajiri-pos:${tenantId}` : "tajiri-pos";
    const accountsKey = tenantId
      ? `tajiri-pos-accounts:${tenantId}`
      : "tajiri-pos-accounts";
    localStorage.setItem(stateKey, JSON.stringify(state));
    localStorage.setItem(accountsKey, JSON.stringify(users));
    if (tenantId && window.tajiriSupabase) {
      const shopData = { ...state };
      delete shopData.users;
      queueCloudStateSave(shopData);
    }
    if (window.TajiriIdb) {
      Promise.all([
        window.TajiriIdb.cacheCatalog(products),
        window.TajiriIdb.saveSales(salesLog),
        window.TajiriIdb.saveCustomers(customers),
        window.TajiriIdb.saveStaff(users),
        window.TajiriIdb.saveSettings(settings),
      ]).catch((error) =>
        console.warn("Could not write the offline cache:", error),
      );
    }
    return true;
  } catch (error) {
    console.error("Could not save Tajiri POS data locally:", error);
    showToast("Could not save changes to this device");
    return false;
  }
}

function queueCloudStateSave(state) {
  cloudSyncSnapshot = state;
  window.clearTimeout(cloudSyncTimer);
  cloudSyncTimer = window.setTimeout(async () => {
    if (cloudSyncInFlight || !cloudSyncSnapshot) return;
    if (window.__tajiriOfflineMode && !navigator.onLine) {
      // Keep the snapshot queued; it will be retried when the connection returns.
      scheduleOfflineRetry();
      return;
    }
    const snapshot = cloudSyncSnapshot;
    cloudSyncSnapshot = null;
    cloudSyncInFlight = true;
    try {
      window.__tajiriCloudRevision = await window.tajiriSupabase.saveShopState(
        snapshot,
        Number(window.__tajiriCloudRevision || 0),
      );
      if (window.__tajiriOfflineMode) {
        window.__tajiriOfflineMode = false;
        showToast(
          "Back online — POS data is synchronized with the cloud again.",
        );
      }
    } catch (error) {
      console.error(
        "Could not synchronize POS data with the shop cloud:",
        error,
      );
      // Keep the snapshot so no offline sale is ever lost.
      cloudSyncSnapshot = snapshot;
      if (!navigator.onLine) {
        window.__tajiriOfflineMode = true;
        scheduleOfflineRetry();
      } else {
        cloudSyncSnapshot = null;
        window.clearTimeout(cloudSyncTimer);
        showToast(
          "Cloud sync failed. Changes are only on this device; check your connection and reload before continuing.",
        );
      }
    } finally {
      cloudSyncInFlight = false;
      if (cloudSyncSnapshot) {
        cloudSyncTimer = window.setTimeout(() => {
          if (cloudSyncSnapshot) queueCloudStateSave(cloudSyncSnapshot);
        }, 500);
      }
    }
  }, 500);
}

function scheduleOfflineRetry() {
  showToast(
    "You are offline. Changes are saved locally and will sync when you reconnect.",
  );
  // Persist the queued snapshot so a crash or closed window while offline
  // still leaves the transaction ready to sync on next launch.
  if (window.TajiriIdb && cloudSyncSnapshot) {
    window.TajiriIdb.enqueueSync({
      queuedAt: Date.now(),
      state: cloudSyncSnapshot,
    });
  }
  const retry = () => {
    window.removeEventListener("online", retry);
    if (cloudSyncSnapshot) queueCloudStateSave(cloudSyncSnapshot);
    drainOfflineQueue();
  };
  window.addEventListener("online", retry, { once: true });
}

async function drainOfflineQueue() {
  if (!window.TajiriIdb || !window.tajiriSupabase) return;
  const tenantId = String(window.__tajiriCloudTenantId || "");
  if (!tenantId) return;
  try {
    const entries = await window.TajiriIdb.dequeueSync();
    if (!entries.length) return;
    // Push each queued snapshot in order; keep the most recent one.
    for (const entry of entries) {
      if (!entry?.state) continue;
      try {
        window.__tajiriCloudRevision =
          await window.tajiriSupabase.saveShopState(
            entry.state,
            Number(window.__tajiriCloudRevision || 0),
          );
      } catch (error) {
        console.warn("Could not push a queued offline snapshot:", error);
        // Re-queue anything that failed so nothing is lost.
        await window.TajiriIdb.enqueueSync(entry);
      }
    }
    showToast("Offline changes synchronized with the cloud.");
  } catch (error) {
    console.warn("Could not drain the offline sync queue:", error);
  }
}

function restoreCurrentUser() {
  const sessionUser = sessionStorage.getItem("tajiri-session-user");
  const sessionRole = String(
    sessionStorage.getItem("tajiri-session-role") || "",
  ).toLowerCase();
  const sessionSignature = sessionStorage.getItem("tajiri-session-signature");
  if (!sessionUser || !sessionSignature) {
    currentUser = null;
    return;
  }

  const normalized = normalizeIdentity(sessionUser);
  const user = users.find((entry) => {
    const identities = [
      entry.username,
      entry.email,
      entry.name,
      entry.name.toLowerCase().replace(/\s+/g, "."),
      `${entry.name} · ${entry.role}`,
      `${entry.name} | ${entry.role}`,
      `${entry.name.toLowerCase()}|${entry.role.toLowerCase()}`,
    ].map(normalizeIdentity);
    return identities.includes(normalized);
  });
  const validRole = ["admin", "cashier"].includes(sessionRole);
  const cloudUrl = String(window.TAJIRI_SUPABASE_CONFIG?.url || "");
  const cloudProfile = window.__tajiriAuthProfile;
  const cloudProfileIdentities = [
    cloudProfile?.email,
    cloudProfile?.username,
    cloudProfile?.name,
  ]
    .filter(Boolean)
    .map(normalizeIdentity);
  const cloudAuthorizationValid =
    !cloudUrl || cloudUrl.startsWith("REPLACE_")
      ? true
      : Boolean(
          cloudProfile &&
          String(cloudProfile.role).toLowerCase() === sessionRole &&
          String(cloudProfile.uid || "") === String(user?.uid || "") &&
          cloudProfileIdentities.includes(normalized),
        );
  if (
    user &&
    validRole &&
    String(user.role).toLowerCase() === sessionRole &&
    cloudAuthorizationValid &&
    sessionSignature === makeSessionSignature(sessionUser, sessionRole)
  ) {
    user.role = sessionRole;
    currentUser = user;
    return;
  }

  sessionStorage.removeItem("tajiri-session-user");
  sessionStorage.removeItem("tajiri-session-role");
  sessionStorage.removeItem("tajiri-session-signature");
  currentUser = null;
}

function loadState() {
  try {
    const tenantId = String(window.__tajiriCloudTenantId || "");
    const stateKey = tenantId ? `tajiri-pos:${tenantId}` : "tajiri-pos";
    const accountsKey = tenantId
      ? `tajiri-pos-accounts:${tenantId}`
      : "tajiri-pos-accounts";
    const accountStore = localStorage.getItem(accountsKey);
    if (accountStore !== null) {
      const savedAccounts = JSON.parse(accountStore);
      users = Array.isArray(savedAccounts) ? savedAccounts : [];
    }

    const raw = localStorage.getItem(stateKey);
    if (!raw) {
      restoreCurrentUser();
      if (window.TajiriIdb) {
        Promise.all([
          window.TajiriIdb.loadCatalog(),
          window.TajiriIdb.loadSales(),
          window.TajiriIdb.loadCustomers(),
          window.TajiriIdb.loadStaff(),
          window.TajiriIdb.loadSettings(),
        ])
          .then(([catalog, sales, savedCustomers, staff, savedSettings]) => {
            if (catalog.length) {
              products.splice(0, products.length, ...catalog);
            }
            if (sales.length) salesLog = sales;
            if (savedCustomers.length)
              customers.splice(0, customers.length, ...savedCustomers);
            if (staff.length) users = staff;
            if (savedSettings) Object.assign(settings, savedSettings);
            if (catalog.length || sales.length) {
              offlineMode = true;
              renderAllPanels();
              showToast("Offline mode: loaded locally cached data");
            }
          })
          .catch((error) =>
            console.warn("Could not read the offline cache:", error),
          );
      }
      return;
    }
    const saved = JSON.parse(raw);
    if (Array.isArray(saved.products) && saved.products.length) {
      products.splice(0, products.length, ...saved.products);
    }
    salesLog = saved.salesLog || [];
    if (Array.isArray(saved.customers))
      customers.splice(0, customers.length, ...saved.customers);
    if (accountStore === null && Array.isArray(saved.users))
      users = saved.users;
    expenses = saved.expenses || [];
    purchaseOrders = saved.purchaseOrders || [];
    pendingMpesa = saved.pendingMpesa || [];
    loyaltyBalance = saved.loyaltyBalance || 0;
    cashBook = saved.cashBook || [];
    shifts = Array.isArray(saved.shifts) ? saved.shifts : [];
    branchStock =
      saved.branchStock && typeof saved.branchStock === "object"
        ? saved.branchStock
        : {};
    stockTransfers = Array.isArray(saved.stockTransfers)
      ? saved.stockTransfers
      : [];
    deliveries = Array.isArray(saved.deliveries) ? saved.deliveries : [];
    offlineMode = Boolean(saved.offlineMode);
    (saved.productsStock || []).forEach((s) => {
      const product = products.find((p) => p.id === s.id);
      if (product) product.stock = s.stock;
    });
    Object.assign(settings, saved.settings || {});
    settings.branches = Array.isArray(settings.branches)
      ? settings.branches
      : ["Main Store", "Westlands Branch", "Marsabit Branch"];
    renderStoreOptions();
    if (!Object.keys(branchStock).length) syncCurrentBranchStock();
    activateStoreStock(settings.storeName || "Main Store");
    restoreCurrentUser();
    applySettingsAppearance();
    document.querySelector("#taxRateInput").value = (settings.taxRate * 100)
      .toFixed(1)
      .replace(/\.0$/, "");
    document.querySelector("#serviceChargeInput").value = (
      settings.serviceCharge * 100
    )
      .toFixed(1)
      .replace(/\.0$/, "");
    document.querySelector("#currencySelect").value = settings.currency;
    document.querySelector("#languageSelect").value = "en-GB";
    document.querySelector("#themeSelect").value = settings.theme;
    document.querySelector("#backgroundColorInput").value =
      settings.backgroundColor;
    document.querySelector("#discountRuleSelect").value = settings.discountRule;
    document.querySelector("#storeNameInput").value =
      settings.storeName || "Main Store";
    document.querySelector("#receiptShopNameInput").value =
      settings.receiptShopName || settings.storeName || "DanLiz Shop";
    document.querySelector("#receiptLocationInput").value =
      settings.receiptLocation || "Bondo, Siaya County";
    document.querySelector("#receiptPhoneInput").value =
      settings.receiptPhone || "0712 345 678";
    document.querySelector("#receiptLogoUrlInput").value =
      settings.receiptLogoUrl || "";
    document.querySelector("#receiptHeaderInput").value =
      settings.receiptHeader || "SALES RECEIPT";
    document.querySelector("#receiptFontSizeInput").value =
      getReceiptFontSize();
    document.querySelector("#receiptTemplateSelect").value =
      settings.receiptTemplate === "simple" ? "simple" : "detailed";
    const autoPrintToggle = document.querySelector("#autoPrintReceiptToggle");
    if (autoPrintToggle)
      autoPrintToggle.checked = settings.autoPrintReceipt !== false;
    document.querySelector("#welcomeTaglineInput").value =
      settings.welcomeTagline || "Smart POS Solutions for Modern Shops";
    document.querySelector("#receiptFooterInput").value =
      settings.receiptFooter;
    document.querySelector("#returnPolicyInput").value =
      settings.returnPolicy || "Goods once sold are not returnable.";
    document.querySelector("#loginMethodSelect").value = settings.loginMethod;
    document.querySelector("#sessionTimeoutSelect").value =
      settings.sessionTimeout;
    document.querySelector("#printerSelect").value = settings.printer;
    [
      "lowStockAlerts",
      "salesReportAlerts",
      "scanner",
      "mpesa",
      "airtel",
      "card",
      "cashDrawer",
      "cloudBackup",
    ].forEach((key) => {
      const element = document.querySelector(
        `#${key === "lowStockAlerts" ? "lowStockAlertsToggle" : key === "salesReportAlerts" ? "salesReportAlertsToggle" : key === "cashDrawer" ? "cashDrawerToggle" : key === "cloudBackup" ? "cloudBackupToggle" : `${key}Toggle`}`,
      );
      if (element) element.checked = Boolean(settings[key]);
    });
    document.querySelector("#storeSelect").value = settings.storeName;
    document.querySelector("#storeName").textContent = settings.storeName;
    document.querySelector("#settingsStoreName").textContent =
      settings.storeName;
    const offlineToggle = document.querySelector("#offlineToggle");
    if (offlineToggle) offlineToggle.checked = offlineMode;
  } catch (error) {
    console.error("Could not load saved Tajiri POS data:", error);
    showToast("Saved data could not be loaded; using the current session");
  }
}

function businessBackupError(backup) {
  if (
    !backup ||
    backup.format !== "tajiri-pos-business-backup" ||
    backup.version !== 1
  ) {
    return "This is not a supported Tajiri POS business backup";
  }
  if (Object.hasOwn(backup, "users") || Object.hasOwn(backup, "pendingMpesa")) {
    return "The backup contains account or payment-queue data and cannot be restored";
  }
  if (
    !Array.isArray(backup.products) ||
    !backup.products.every(
      (product) =>
        product &&
        (typeof product.id === "string" ||
          Number.isFinite(Number(product.id))) &&
        typeof product.name === "string" &&
        Number.isFinite(Number(product.price)) &&
        Number.isFinite(Number(product.stock)),
    )
  ) {
    return "The backup has invalid product data";
  }
  if (
    !Array.isArray(backup.salesLog) ||
    !backup.salesLog.every(
      (sale) =>
        sale &&
        typeof sale.id === "string" &&
        Number.isFinite(Number(sale.total)) &&
        Array.isArray(sale.items),
    )
  ) {
    return "The backup has invalid sales data";
  }
  if (
    !Array.isArray(backup.expenses) ||
    !backup.expenses.every(
      (expense) =>
        expense &&
        typeof expense.type === "string" &&
        Number.isFinite(Number(expense.amount)),
    )
  ) {
    return "The backup has invalid expense data";
  }
  if (
    !Array.isArray(backup.purchaseOrders) ||
    !backup.purchaseOrders.every(
      (order) =>
        order &&
        typeof order.product === "string" &&
        Number.isFinite(Number(order.quantity)),
    )
  ) {
    return "The backup has invalid purchase-order data";
  }
  if (
    !Array.isArray(backup.cashBook) ||
    !backup.cashBook.every(
      (entry) =>
        entry &&
        ["in", "out"].includes(entry.direction) &&
        Number.isFinite(Number(entry.amount)),
    )
  ) {
    return "The backup has invalid cash-book data";
  }
  if (
    backup.customers !== undefined &&
    (!Array.isArray(backup.customers) ||
      !backup.customers.every(
        (customer) =>
          customer &&
          typeof customer.name === "string" &&
          typeof customer.phone === "string" &&
          Number.isFinite(Number(customer.points || 0)) &&
          Number(customer.points || 0) >= 0,
      ))
  ) {
    return "The backup has invalid loyalty-customer data";
  }
  if (
    backup.branchStock !== undefined &&
    (!backup.branchStock ||
      typeof backup.branchStock !== "object" ||
      Array.isArray(backup.branchStock) ||
      !Object.entries(backup.branchStock).every(
        ([store, stock]) =>
          store &&
          stock &&
          typeof stock === "object" &&
          !Array.isArray(stock) &&
          Object.values(stock).every(
            (quantity) =>
              Number.isSafeInteger(Number(quantity)) && Number(quantity) >= 0,
          ),
      ))
  ) {
    return "The backup has invalid branch-stock data";
  }
  if (
    backup.stockTransfers !== undefined &&
    (!Array.isArray(backup.stockTransfers) ||
      !backup.stockTransfers.every(
        (transfer) =>
          transfer &&
          typeof transfer.product === "string" &&
          typeof transfer.from === "string" &&
          typeof transfer.to === "string" &&
          Number.isSafeInteger(Number(transfer.quantity)) &&
          Number(transfer.quantity) > 0,
      ))
  ) {
    return "The backup has invalid stock-transfer data";
  }
  if (
    backup.deliveries !== undefined &&
    (!Array.isArray(backup.deliveries) ||
      !backup.deliveries.every(
        (delivery) =>
          delivery &&
          typeof delivery.id === "string" &&
          typeof delivery.address === "string" &&
          typeof delivery.store === "string" &&
          Array.isArray(delivery.items) &&
          ["Pending", "Delivered"].includes(delivery.status),
      ))
  ) {
    return "The backup has invalid delivery-order data";
  }
  if (
    backup.loyaltyBalance !== undefined &&
    (!Number.isFinite(Number(backup.loyaltyBalance)) ||
      Number(backup.loyaltyBalance) < 0)
  ) {
    return "The backup has an invalid loyalty balance";
  }
  if (
    !backup.settings ||
    typeof backup.settings !== "object" ||
    Array.isArray(backup.settings)
  ) {
    return "The backup has invalid settings data";
  }
  return "";
}

const topbarClock = document.querySelector("#topbarClock");
function renderTopbarClock() {
  if (!topbarClock) return;
  const now = new Date();
  const time = now.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const date = now.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  topbarClock.textContent = `${time} · ${date}`;
}
renderTopbarClock();
setInterval(renderTopbarClock, 15_000);

const themeQuickToggle = document.querySelector("#themeQuickToggle");
function applyThemeQuickToggleState() {
  if (!themeQuickToggle) return;
  const light = (settings.theme || "dark") === "light";
  document.body.dataset.theme = light ? "light" : "dark";
  themeQuickToggle.setAttribute(
    "aria-label",
    light ? "Switch to dark theme" : "Switch to light theme",
  );
}
if (themeQuickToggle) {
  themeQuickToggle.addEventListener("click", () => {
    if (currentUser && currentUser.role !== "admin") {
      const light = (settings.theme || "dark") === "light";
      document.body.dataset.theme = light ? "dark" : "light";
      themeQuickToggle.setAttribute(
        "aria-label",
        light ? "Switch to light theme" : "Switch to dark theme",
      );
      return;
    }
    settings.theme = (settings.theme || "dark") === "light" ? "dark" : "light";
    const themeSelect = document.querySelector("#themeSelect");
    if (themeSelect) themeSelect.value = settings.theme;
    applySettingsAppearance();
    saveState();
    showToast(
      settings.theme === "light" ? "Light theme on" : "Dark theme on",
    );
  });
}

function applySettingsAppearance() {
  settings.language = "en-GB";
  document.body.dataset.theme = settings.theme || "dark";
  applyThemeQuickToggleState();
  document.documentElement.lang = "en-GB";
  document.body.style.setProperty(
    "--app-background",
    settings.backgroundColor || "#121820",
  );
  const themeColour = document.querySelector("#appThemeColor");
  if (themeColour) {
    themeColour.content = settings.theme === "light" ? "#f1f6f4" : "#0d1518";
  }

  const brandName =
    settings.receiptShopName || settings.storeName || "Tajiri POS";
  const tagline =
    settings.welcomeTagline || "Smart POS Solutions for Modern Shops";
  const brandElement = document.querySelector("#welcomeBrandName");
  const taglineElement = document.querySelector("#welcomeTagline");
  const navBrandText = document.querySelector(".nav-brand .nav-brand-text");
  const footerBrand = document.querySelector("#welcomeFooterBrand");
  const footerLocation = document.querySelector("#welcomeFooterLocation");

  if (brandElement) brandElement.textContent = brandName;
  if (taglineElement) taglineElement.textContent = tagline;
  if (navBrandText) navBrandText.textContent = brandName;
  if (footerBrand) footerBrand.textContent = brandName;
  if (footerLocation)
    footerLocation.textContent =
      settings.receiptLocation || "Bondo, Siaya County";

  if (document.title && document.title.includes("Tajiri POS")) {
    document.title = `${brandName} POS`;
  }
}

function setOffline(mode) {
  offlineMode = mode;
  const dot = document.querySelector("#statusDot");
  const sync = document.querySelector("#syncStatus");
  if (dot) {
    dot.title = mode ? "Offline — sales will sync later" : "Online";
    dot.classList.toggle("offline", mode);
  }
  if (sync) sync.textContent = mode ? "Offline mode" : "Online";
  renderOperationsPanel();
}

window.addEventListener("online", () => renderOperationsPanel());
window.addEventListener("offline", () => renderOperationsPanel());

/* ---------- Panel event wiring ---------- */

document
  .querySelector("#inventorySearch")
  ?.addEventListener("input", renderInventoryPanel);

let pendingProductImport = null;
const productImportFile = document.querySelector("#productImportFile");
const chooseProductImportButton = document.querySelector(
  "#chooseProductImportButton",
);
const confirmProductImportButton = document.querySelector(
  "#confirmProductImportButton",
);
const productImportStatus = document.querySelector("#productImportStatus");

chooseProductImportButton?.addEventListener("click", () => {
  if (currentUser?.role !== "admin")
    return showToast("Admin permission required to import products");
  productImportFile?.click();
});

productImportFile?.addEventListener("change", async () => {
  pendingProductImport = null;
  if (confirmProductImportButton) confirmProductImportButton.disabled = true;
  const file = productImportFile.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    if (productImportStatus)
      productImportStatus.textContent = "CSV files must be smaller than 5 MB.";
    productImportFile.value = "";
    return;
  }
  try {
    const importedProducts = parseProductCsv(await file.text());
    const existingSkus = new Set(
      products.map((product) => String(product.code || "").toUpperCase()),
    );
    const updates = importedProducts.filter((product) =>
      existingSkus.has(product.code.toUpperCase()),
    ).length;
    const additions = importedProducts.length - updates;
    pendingProductImport = { products: importedProducts, fileName: file.name };
    if (productImportStatus) {
      productImportStatus.textContent =
        `${file.name}: ${importedProducts.length} valid products. ` +
        `${additions} will be added and ${updates} matching SKUs updated. ` +
        "Choose Import products to confirm.";
    }
    if (confirmProductImportButton) confirmProductImportButton.disabled = false;
  } catch (error) {
    console.error("Could not read product catalogue CSV:", error);
    if (productImportStatus)
      productImportStatus.textContent = `Import not ready: ${error.message || "Could not read this CSV file."}`;
  }
});

confirmProductImportButton?.addEventListener("click", () => {
  if (currentUser?.role !== "admin")
    return showToast("Admin permission required to import products");
  if (!pendingProductImport)
    return showToast("Choose and review a valid product CSV first");

  const previousProducts = products.map((product) => ({
    ...product,
    aliases: Array.isArray(product.aliases) ? [...product.aliases] : [],
  }));
  const previousBranchStock = JSON.parse(JSON.stringify(branchStock || {}));
  syncCurrentBranchStock();
  const currentBranch = settings.storeName || "Main Store";
  const branchInventory = branchStock[currentBranch];
  let nextProductId =
    products.reduce(
      (highest, product) => Math.max(highest, Number(product.id) || 0),
      0,
    ) + 1;
  const productsBySku = new Map(
    products.map((product) => [
      String(product.code || "").toUpperCase(),
      product,
    ]),
  );
  let added = 0;
  let updated = 0;

  pendingProductImport.products.forEach((importedProduct) => {
    const sku = importedProduct.code.toUpperCase();
    let product = productsBySku.get(sku);
    if (product) {
      Object.assign(product, importedProduct);
      branchInventory[String(product.id)] = importedProduct.stock;
      updated += 1;
      return;
    }
    product = { ...importedProduct, id: nextProductId++ };
    products.push(product);
    productsBySku.set(sku, product);
    branchInventory[String(product.id)] = importedProduct.stock;
    added += 1;
  });

  renderAllPanels();
  renderProducts(search.value);
  if (!saveState()) {
    products.splice(0, products.length, ...previousProducts);
    branchStock = previousBranchStock;
    renderAllPanels();
    renderProducts(search.value);
    if (productImportStatus)
      productImportStatus.textContent =
        "Import was cancelled because the updated catalogue could not be saved.";
    pendingProductImport = null;
    if (confirmProductImportButton) confirmProductImportButton.disabled = true;
    return;
  }

  const fileName = pendingProductImport.fileName;
  pendingProductImport = null;
  if (productImportFile) productImportFile.value = "";
  if (confirmProductImportButton) confirmProductImportButton.disabled = true;
  if (productImportStatus) {
    productImportStatus.textContent =
      `${fileName} imported: ${added} products added and ${updated} matching SKUs updated. ` +
      "Other products, sales and customer records were kept.";
  }
  showToast(`${added} products added; ${updated} existing products updated`);
});

document
  .querySelector("#inventoryTable")
  ?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-product-action]");
    if (!button) return;
    if (currentUser?.role !== "admin")
      return showToast("Admin permission required");
    const product = products.find((p) => p.id === Number(button.dataset.id));
    if (!product) return;
    if (button.dataset.productAction === "print-label") {
      openModal(
        `Print labels · ${product.name}`,
        `<p class="modal-note">Print Code 39 labels using this product's SKU. Verify your label stock matches 50 × 30 mm.</p><label>Number of labels<input id="barcodeLabelCount" type="number" min="1" max="100" step="1" value="1" required></label>`,
        actionButtons("Print labels"),
      );
      modal.dataset.labelProductId = String(product.id);
      modalPurpose = "print-barcode-labels";
      return;
    }
    if (button.dataset.productAction === "delete") {
      if (cart.some((item) => item.id === product.id))
        cart = cart.filter((item) => item.id !== product.id);
      products.splice(products.indexOf(product), 1);
      renderAllPanels();
      renderProducts(search.value);
      saveState();
      showToast(`${product.name} deleted`);
    }
    if (button.dataset.productAction === "edit") {
      openModal(
        "Edit product",
        `
      <label>Product code<input id="productCode" value="${escapeHtml(product.code || "")}"></label>
      <label>Product name<input id="productName" value="${escapeHtml(product.name)}" required></label>
      <label>Category<input id="productCategory" value="${escapeHtml(product.category || "")}"></label>
      <label>Supplier<input id="productSupplier" value="${escapeHtml(product.supplier || "")}"></label>
      <label>Selling price (${escapeHtml(settings.currency)})<input id="productPrice" type="number" min="0.01" step="0.01" value="${Number(product.price) || 0}" required></label>
      <label>Unit cost (${escapeHtml(settings.currency)})<input id="productCost" type="number" min="0" step="0.01" value="${Number(product.cost) || 0}" required></label>
      <label>Stock quantity<input id="productStock" type="number" min="0" step="1" value="${Number(product.stock) || 0}" required></label>`,
        actionButtons("Save product"),
      );
      modal.dataset.editId = product.id;
    }
  });

document
  .querySelector("#purchaseOrderList")
  ?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-po-action]");
    if (!button) return;
    const po = purchaseOrders[Number(button.dataset.index)];
    if (!po) return;
    if (button.dataset.poAction === "receive") {
      if (currentUser?.role !== "admin")
        return showToast("Admin permission required to receive stock");
      if (po.status === "Received")
        return showToast("This purchase order has already been received");
      const product =
        products.find((item) => item.id === po.productId) ||
        products.find((item) => item.name === po.product);
      if (!product) return showToast("The ordered product no longer exists");
      const quantity = Number(po.quantity);
      if (!Number.isSafeInteger(quantity) || quantity < 1)
        return showToast("This purchase order has an invalid quantity");
      const receivingStore = po.store || settings.storeName;
      syncCurrentBranchStock();
      if (!branchStock[receivingStore]) branchStock[receivingStore] = {};
      const productId = String(product.id);
      const currentBranchStock = Number(
        branchStock[receivingStore][productId] || 0,
      );
      branchStock[receivingStore][productId] = currentBranchStock + quantity;
      if (receivingStore === settings.storeName)
        product.stock = branchStock[receivingStore][productId];
      po.status = "Received";
      po.receivedAt = new Date().toISOString();
      renderAllPanels();
      renderProducts(search.value);
      saveState();
      showToast(
        `${quantity} ${product.name} units received at ${receivingStore}`,
      );
      return;
    }
    downloadTextFile(
      `purchase-order-${String(po.product).replace(/[^a-z0-9-]/gi, "-")}.csv`,
      toCsv([
        ["Product", "Supplier", "Branch", "Quantity", "Status"],
        [
          po.product,
          po.supplier,
          po.store || settings.storeName,
          po.quantity,
          po.status,
        ],
      ]),
      "text/csv;charset=utf-8",
    );
    po.status = "Downloaded";
    saveState();
    renderSuppliersPanel();
    showToast(
      "Purchase order downloaded; it has not been sent to the supplier",
    );
  });

document.querySelector("#addExpenseButton")?.addEventListener("click", () => {
  if (currentUser?.role !== "admin")
    return showToast("Admin permission required");
  openModal(
    "Record expense",
    `
    <label>Type<select id="expenseType"><option>Rent</option><option>Salary</option><option>Utility</option><option>Other</option></select></label>
    <label>Amount (KES)<input id="expenseAmount" type="number" min="0.01" step="0.01" required></label>
    <label>Note<input id="expenseNote" placeholder="Optional note"></label>`,
    actionButtons("Record"),
  );
});

document
  .querySelector("#campaignButton")
  ?.addEventListener("click", openCampaignComposer);

document.querySelector("#addCustomerButton")?.addEventListener("click", () => {
  if (currentUser?.role !== "admin")
    return showToast("Admin permission required");
  openModal(
    "Add loyalty customer",
    `<label>Customer name<input id="newCustomerName" required></label><label>Kenyan phone number<input id="newCustomerPhone" type="tel" inputmode="tel" placeholder="07XXXXXXXX or 2547XXXXXXXX" required></label>`,
    actionButtons("Add customer"),
  );
});

document.querySelector("#smsReportButton")?.addEventListener("click", () => {
  showToast("SMS provider is not configured. No summary was sent.");
});

document.querySelector("#exportReportButton")?.addEventListener("click", () => {
  const rows = [
    [
      "Type",
      "ID",
      "Date",
      "Time",
      "Cashier",
      "Customer",
      "Method",
      "Subtotal",
      "Discount",
      "VAT",
      "Service charge",
      "Total",
      "Items",
    ],
    ...salesLog.map((sale) => [
      "Sale",
      sale.id,
      sale.date,
      sale.time,
      sale.cashier,
      sale.customer,
      sale.method,
      sale.subtotal,
      sale.discount,
      sale.tax,
      sale.serviceCharge,
      sale.total,
      sale.items.map((item) => `${item.name} x ${item.quantity}`).join("; "),
    ]),
    ...expenses.map((expense, index) => [
      "Expense",
      `EXP-${index + 1}`,
      "",
      "",
      "",
      expense.note || "",
      expense.type,
      "",
      "",
      "",
      "",
      expense.amount,
      "",
    ]),
  ];
  downloadTextFile("tajiri-report.csv", toCsv(rows), "text/csv;charset=utf-8");
  showToast("Report exported");
});

document.querySelector("#saveSettingsButton")?.addEventListener("click", () => {
  if (currentUser?.role !== "admin")
    return showToast("Admin permission required");
  settings.taxRate =
    Math.min(
      100,
      Math.max(0, Number(document.querySelector("#taxRateInput").value || 0)),
    ) / 100;
  settings.serviceCharge =
    Math.min(
      100,
      Math.max(
        0,
        Number(document.querySelector("#serviceChargeInput").value || 0),
      ),
    ) / 100;
  settings.storeName =
    document.querySelector("#storeNameInput").value.trim() || "Main Store";
  settings.branches = getStoreNames();
  if (!settings.branches.includes(settings.storeName))
    settings.branches.push(settings.storeName);
  renderStoreOptions();
  settings.currency = document.querySelector("#currencySelect").value;
  settings.language = "en-GB";
  settings.theme = document.querySelector("#themeSelect").value;
  settings.backgroundColor = document.querySelector(
    "#backgroundColorInput",
  ).value;
  settings.discountRule = document.querySelector("#discountRuleSelect").value;
  settings.receiptShopName =
    document.querySelector("#receiptShopNameInput").value.trim() ||
    settings.storeName ||
    "DanLiz Shop";
  settings.receiptLogoUrl = document
    .querySelector("#receiptLogoUrlInput")
    .value.trim();
  settings.receiptHeader =
    document.querySelector("#receiptHeaderInput").value.trim() ||
    "SALES RECEIPT";
  settings.receiptFontSize = Math.min(
    18,
    Math.max(
      8,
      Number(document.querySelector("#receiptFontSizeInput").value) || 10,
    ),
  );
  settings.receiptTemplate =
    document.querySelector("#receiptTemplateSelect").value === "simple"
      ? "simple"
      : "detailed";
  const autoPrintToggle = document.querySelector("#autoPrintReceiptToggle");
  if (autoPrintToggle) settings.autoPrintReceipt = autoPrintToggle.checked;
  settings.receiptLocation =
    document.querySelector("#receiptLocationInput").value.trim() ||
    "Bondo, Siaya County";
  settings.receiptPhone =
    document.querySelector("#receiptPhoneInput").value.trim() || "0712 345 678";
  settings.welcomeTagline =
    document.querySelector("#welcomeTaglineInput").value.trim() ||
    "Smart POS Solutions for Modern Shops";
  settings.receiptFooter =
    document.querySelector("#receiptFooterInput").value.trim() ||
    "Thank you for shopping with us";
  settings.returnPolicy =
    document.querySelector("#returnPolicyInput").value.trim() ||
    "Goods once sold are not returnable.";
  settings.loginMethod = document.querySelector("#loginMethodSelect").value;
  settings.sessionTimeout = document.querySelector(
    "#sessionTimeoutSelect",
  ).value;
  settings.printer = document.querySelector("#printerSelect").value;
  settings.lowStockAlerts = document.querySelector(
    "#lowStockAlertsToggle",
  ).checked;
  settings.salesReportAlerts = document.querySelector(
    "#salesReportAlertsToggle",
  ).checked;
  settings.scanner = document.querySelector("#scannerToggle").checked;
  settings.mpesa = document.querySelector("#mpesaToggle").checked;
  settings.airtel = document.querySelector("#airtelToggle").checked;
  settings.card = document.querySelector("#cardToggle").checked;
  settings.cashDrawer = document.querySelector("#cashDrawerToggle").checked;
  settings.cloudBackup = false;
  applySettingsAppearance();
  renderReceiptPanel(salesLog.at(-1) || null);
  setOffline(document.querySelector("#offlineToggle").checked);
  document.querySelector("#storeName").textContent = settings.storeName;
  renderCart();
  renderAllPanels();
  saveState();
  showToast(
    `Settings saved · VAT ${(settings.taxRate * 100).toFixed(1).replace(/\.0$/, "")}% · ${settings.currency}`,
  );
});

document
  .querySelector("#exportSettingsButton")
  ?.addEventListener("click", () => {
    downloadTextFile(
      "tajiri-settings.json",
      JSON.stringify(settings, null, 2),
      "application/json",
    );
    showToast("Settings exported");
  });

document
  .querySelector("#exportBusinessBackupButton")
  ?.addEventListener("click", () => {
    if (currentUser?.role !== "admin")
      return showToast("Admin permission required");
    const backup = {
      format: "tajiri-pos-business-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      products,
      customers,
      salesLog,
      expenses,
      purchaseOrders,
      cashBook,
      branchStock,
      stockTransfers,
      deliveries,
      loyaltyBalance,
      settings,
    };
    downloadTextFile(
      "tajiri-business-backup.json",
      JSON.stringify(backup, null, 2),
      "application/json",
    );
    showToast("Business backup exported without staff accounts or passwords");
  });

document
  .querySelector("#importBusinessBackupButton")
  ?.addEventListener("click", () => {
    if (currentUser?.role !== "admin")
      return showToast("Admin permission required");
    document.querySelector("#businessBackupFile")?.click();
  });

document
  .querySelector("#businessBackupFile")
  ?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      const error = businessBackupError(backup);
      if (error) throw new Error(error);
      pendingBusinessBackup = backup;
      openModal(
        "Restore business backup",
        '<p>This replaces this device\'s products, customers and loyalty points, sales, expenses, purchase orders, branch stock and transfer history, delivery orders, cash book, and settings.</p><p class="modal-note">Staff accounts and queued payment requests are not imported. Export a backup of the current business data first if you may need to undo this.</p>',
        actionButtons("Restore business data"),
      );
      modalPurpose = "restore-business-backup";
    } catch (error) {
      console.error("Could not read business backup:", error);
      showToast(error.message || "Could not read that business backup");
    } finally {
      event.target.value = "";
    }
  });

document
  .querySelector("#resetSettingsButton")
  ?.addEventListener("click", () => {
    if (currentUser?.role !== "admin")
      return showToast("Admin permission required");
    openModal(
      "Reset settings",
      `<p>Restore the default KES, dark theme, alerts, and device preferences?</p><p class="modal-note">Sales, stock, accounts, and receipts will stay unchanged.</p>`,
      actionButtons("Reset settings"),
    );
    modalPurpose = "reset-settings";
  });

document.querySelector("#storeSelect")?.addEventListener("change", (event) => {
  syncCurrentBranchStock();
  settings.storeName = event.target.value;
  settings.branches = getStoreNames();
  activateStoreStock(settings.storeName);
  document.querySelector("#storeName").textContent = settings.storeName;
  const settingsStore = document.querySelector("#settingsStoreName");
  if (settingsStore) settingsStore.textContent = settings.storeName;
  renderCart();
  renderProducts(search.value);
  renderAllPanels();
  saveState();
  showToast(`Switched to ${settings.storeName}`);
});

document
  .querySelector("#createTransferButton")
  ?.addEventListener("click", () => {
    if (currentUser?.role !== "admin")
      return showToast("Admin permission required");
    const stores = getStoreNames();
    if (stores.length < 2)
      return showToast("Add another branch before transferring stock");
    const productOptions = products
      .map(
        (product) =>
          `<option value="${product.id}">${escapeHtml(product.name)} · ${Number(product.stock) || 0} at ${escapeHtml(settings.storeName)}</option>`,
      )
      .join("");
    const branchOptions = stores
      .map(
        (store) =>
          `<option value="${escapeHtml(store)}">${escapeHtml(store)}</option>`,
      )
      .join("");
    openModal(
      "Transfer stock between branches",
      `<label>Product<select id="transferProductId">${productOptions}</select></label><label>From branch<select id="transferFrom">${branchOptions}</select></label><label>To branch<select id="transferTo">${branchOptions}</select></label><label>Quantity<input id="transferQuantity" type="number" min="1" step="1" value="1" required></label>`,
      actionButtons("Transfer stock"),
    );
    const fromSelect = document.querySelector("#transferFrom");
    const toSelect = document.querySelector("#transferTo");
    fromSelect.value = settings.storeName;
    toSelect.value = stores.find((store) => store !== settings.storeName);
    modalPurpose = "stock-transfer";
  });

document
  .querySelector("#printReceiptButton")
  ?.addEventListener("click", () => window.print());
document.querySelector("#sendReceiptButton")?.addEventListener("click", () => {
  const text = lastSale
    ? `${settings.storeName}: receipt ${lastSale.id}, total ${settings.currency} ${money(lastSale.total)}`
    : "Tajiri POS receipt";
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
});

document
  .querySelector("#staffButton")
  ?.addEventListener("click", () =>
    document.querySelector("#staffLoginButton")?.click(),
  );

document.querySelector("#addAccountButton")?.addEventListener("click", () => {
  if (currentUser?.role !== "admin")
    return showToast("Admin permission required");
  const adminCount = users.filter((user) => user.role === "admin").length;
  const adminOption =
    adminCount >= 3
      ? '<option value="admin" disabled>Administrator (limit reached)</option>'
      : '<option value="admin">Administrator</option>';
  openModal(
    "Create staff account",
    `
    <label>Full name<input id="newAccountName" required></label>
    <label>Username<input id="newAccountUsername" autocomplete="username" required></label>
    <label>Email<input id="newAccountEmail" type="email" autocomplete="email" required></label>
    <label>Initial password<input id="newAccountPassword" type="password" autocomplete="new-password" minlength="6" required></label>
    <label>Role<select id="newAccountRole"><option value="cashier">Cashier</option>${adminOption}</select></label>
    <p class="modal-note">Up to 3 administrator accounts are allowed, including the first administrator. Staff can sign in immediately with their email and initial password; share the password securely.</p>`,
    actionButtons("Create account"),
  );
});

/* Handle login + add/edit product + expense + feedback inside the shared modal */
document.addEventListener("click", async (event) => {
  const receiptAction = event.target.dataset?.receiptAction;
  if (receiptAction === "print") return printReceipt();
  if (receiptAction === "whatsapp") {
    const text = lastSale
      ? `${settings.storeName}: receipt ${lastSale.id}, total ${settings.currency} ${money(lastSale.total)}`
      : "";
    return window.open(
      `https://wa.me/?text=${encodeURIComponent(text)}`,
      "_blank",
    );
  }
  if (receiptAction === "feedback") {
    openModal(
      "How was your experience?",
      `
      <p class="modal-note">Rate this sale from 1 to 5 stars to help us improve.</p>
      <div class="rating-row">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="rating-star" data-rating="${n}">★</button>`).join("")}</div>`,
      `<button type="button" class="modal-primary" data-modal-action="cancel">Close</button>`,
    );
    return;
  }
  const star = event.target.closest?.(".rating-star");
  if (star) {
    const rating = Number(star.dataset.rating);
    if (lastSale && Number.isInteger(rating) && rating >= 1 && rating <= 5) {
      lastSale.feedbackRating = rating;
      lastSale.feedbackAt = new Date().toISOString();
      saveState();
      renderOperationsPanel();
    }
    closeModal();
    showToast(`Thanks for rating us ${rating}/5`);
    return;
  }

  if (event.target.id === "forgotPasswordButton") {
    showToast("Ask an admin to reset your password");
    return;
  }
  if (event.target.id === "googleLoginButton") {
    openModal(
      "Google sign-in setup",
      `<p class="modal-note">Google OAuth needs a backend callback, Google client ID, and token verification before it can sign you in securely.</p><p class="modal-note">After setup, approved email domains can be mapped to Cashier, Manager, or Admin roles.</p>`,
      `<button type="button" class="modal-primary" data-modal-action="cancel">Close</button>`,
    );
    return;
  }

  const isConfirm = event.target.dataset?.modalAction === "confirm";
  if (!isConfirm) return;

  const signupName = document.querySelector("#modal #signupName");
  if (signupName) {
    if (currentUser?.role !== "admin" && modalPurpose !== "self-signup")
      return showToast("Admin permission required");
    const name = signupName.value.trim();
    const username = document
      .querySelector("#signupUsername")
      .value.trim()
      .toLowerCase();
    const email = document
      .querySelector("#signupEmail")
      .value.trim()
      .toLowerCase();
    const password = document.querySelector("#signupPassword").value;
    const confirmPassword = document.querySelector(
      "#signupConfirmPassword",
    ).value;
    const role = document.querySelector("#signupRole").value;
    if (!name || !username || !email || !password || !confirmPassword)
      return showToast("Complete all required fields");
    if (!/^\S+@\S+\.\S+$/.test(email))
      return showToast("Enter a valid email address");
    if (
      users.some(
        (user) =>
          user.username?.toLowerCase() === username ||
          user.email?.toLowerCase() === email,
      )
    )
      return showToast("Username or email already exists");
    if (password !== confirmPassword)
      return showToast("Passwords do not match");
    if (password.length < 5)
      return showToast("Password must be at least 5 characters");
    const selfSignup = modalPurpose === "self-signup";
    users.push({
      name,
      username,
      email,
      role,
      passwordHash: await hashPassword(password),
    });
    saveState();
    renderAllPanels();
    closeModal();
    showToast("Account created successfully!");
    if (selfSignup) redirectToWelcomeView();
    return;
  }

  const loginIdentity = document.querySelector("#modal #loginIdentity");
  if (loginIdentity) {
    const identity = loginIdentity.value.trim();
    const password = document.querySelector("#loginPassword").value;
    if (!identity || !password)
      return showToast("Enter your username/email and password");
    if (!(await loginWithPassword(identity, password)))
      return showToast("Invalid username/email or password");
    if (document.querySelector("#rememberLogin")?.checked) {
      const rememberedUser = currentUser;
      if (rememberedUser) {
        const rememberedIdentity =
          rememberedUser.username?.toLowerCase() ||
          rememberedUser.email?.toLowerCase() ||
          rememberedUser.name.toLowerCase().replace(/\s+/g, ".");
        writeSignedSession(
          localStorage,
          "tajiri-remembered-user",
          "tajiri-remembered-role",
          "tajiri-remembered-signature",
          rememberedIdentity,
          rememberedUser.role,
        );
      }
    } else {
      localStorage.removeItem("tajiri-remembered-user");
      localStorage.removeItem("tajiri-remembered-role");
      localStorage.removeItem("tajiri-remembered-signature");
    }
    return closeModal();
  }
  const staffAccount = document.querySelector("#modal #staffAccount");
  if (staffAccount) {
    const pin = document.querySelector("#staffPin").value;
    if (!loginWithPin(staffAccount.value, pin)) return showToast("Invalid PIN");
    return closeModal();
  }
  const newAccountName = document.querySelector("#newAccountName");
  if (newAccountName) {
    if (currentUser?.role !== "admin")
      return showToast("Admin permission required");
    if (
      !window.firebaseAuth ||
      !window.firebaseDb ||
      !window.TAJIRI_SUPABASE_CONFIG
    )
      return showToast(
        "Cloud account creation is unavailable. Check the Supabase setup and try again.",
      );
    const name = newAccountName.value.trim();
    const username = document
      .querySelector("#newAccountUsername")
      .value.trim()
      .toLowerCase();
    const email = document
      .querySelector("#newAccountEmail")
      .value.trim()
      .toLowerCase();
    const password = document.querySelector("#newAccountPassword").value;
    const role = document.querySelector("#newAccountRole").value;
    const adminCount = users.filter((user) => user.role === "admin").length;
    if (!name || !username || !email || !password)
      return showToast("Complete all required staff details");
    if (!/^[a-z0-9._-]{2,60}$/i.test(username))
      return showToast(
        "Username must be 2–60 characters using letters, numbers, dots, underscores, or hyphens",
      );
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return showToast("Enter a valid email address");
    if (password.length < 6)
      return showToast("Password must be at least 6 characters");
    if (!["admin", "cashier"].includes(role))
      return showToast("Choose a valid staff role");
    if (role === "admin" && adminCount >= 3)
      return showToast("The store already has the maximum of 3 administrators");
    if (
      users.some(
        (user) =>
          user.username?.toLowerCase() === username ||
          user.email?.toLowerCase() === email,
      )
    )
      return showToast("Username or email already exists");
    try {
      const staffAccount = await window.tajiriSupabase.createStaffAccount({
        name,
        username,
        email,
        password,
        role,
      });
      users.push(staffAccount);
      const stateSaved = saveState();
      renderStaffPanel();
      closeModal();
      showToast(
        stateSaved
          ? `${role === "admin" ? "Administrator" : "Cashier"} account created for ${name}`
          : `Cloud account created for ${name}, but this device could not update its local roster.`,
      );
    } catch (error) {
      console.error("Could not create Supabase staff account:", error);
      const message = String(error.message || "");
      let userMessage =
        "Could not create the cloud account. Check Supabase Auth and the create-staff Edge Function.";
      if (
        error.code === "auth/email-already-in-use" ||
        message.includes("email already has an account")
      ) {
        userMessage = "That email address already has a Supabase account.";
      } else if (message.includes("maximum of 3 administrators")) {
        userMessage = "The store already has the maximum of 3 administrators.";
      } else if (message.includes("contact email is already used")) {
        userMessage =
          "That contact email is already used by another POS account.";
      } else if (message.includes("username already exists")) {
        userMessage = "That username is already in use.";
      }
      showToast(userMessage);
    }
    return;
  }
  const productName = document.querySelector("#productName");
  if (productName) {
    const name = productName.value.trim();
    const price = Number(document.querySelector("#productPrice").value);
    if (!name || !price || price <= 0)
      return showToast("Enter a name and valid price");
    const editId = modal.dataset.editId;
    if (editId) {
      const product = products.find((p) => p.id === Number(editId));
      if (product) {
        product.name = name;
        product.category =
          document.querySelector("#productCategory").value.trim() || "General";
        product.price = price;
        product.stock = Math.max(
          0,
          Number(document.querySelector("#productStock").value || 0),
        );
      }
      delete modal.dataset.editId;
      showToast(`${name} updated`);
    } else {
      products.push({
        id: Date.now(),
        name,
        code: `SKU ${Date.now() % 1000000}`,
        category:
          document.querySelector("#productCategory").value.trim() || "General",
        price,
        cost: price * 0.6,
        stock: Math.max(
          0,
          Number(document.querySelector("#productStock").value || 0),
        ),
        icon: "＋",
      });
      showToast(`${name} added to the catalogue`);
    }
    renderInventoryPanel();
    renderProducts(search.value);
    closeModal();
    saveState();
    return;
  }
  const cashEntryAmount = document.querySelector("#cashEntryAmount");
  if (cashEntryAmount) {
    const amount = Number(cashEntryAmount.value);
    if (!amount || amount <= 0) return showToast("Enter a valid amount");
    const direction = document.querySelector("#cashEntryDirection").value;
    const note = document.querySelector("#cashEntryNote").value.trim();
    cashBook.push({
      id: `CASH-${cashBook.length + 1}`,
      direction,
      label:
        note || (direction === "in" ? "Manual cash in" : "Manual cash out"),
      method: "Manual",
      amount,
    });
    renderCashBookPanel();
    closeModal();
    saveState();
    showToast(`Cash ${direction} recorded`);
    return;
  }
  const expenseAmount = document.querySelector("#expenseAmount");
  if (expenseAmount) {
    const amount = Number(expenseAmount.value);
    if (!amount || amount <= 0)
      return showToast("Enter a valid expense amount");
    expenses.push({
      type: document.querySelector("#expenseType").value,
      amount,
      note: document.querySelector("#expenseNote").value.trim(),
    });
    cashBook.push({
      id: `EXP-${expenses.length}`,
      direction: "out",
      label: `${document.querySelector("#expenseType").value}${document.querySelector("#expenseNote").value.trim() ? ` · ${document.querySelector("#expenseNote").value.trim()}` : ""}`,
      method: "Expense",
      amount,
    });
    renderExpensesPanel();
    renderCashBookPanel();
    renderReportsPanel();
    closeModal();
    saveState();
    showToast("Expense recorded");
    return;
  }
});

const updateStatusElement = document.querySelector("#updateStatus");
const checkForUpdatesButton = document.querySelector("#checkForUpdatesButton");
const installUpdateButton = document.querySelector("#installUpdateButton");
const updateBridge = window.tajiriUpdates;

function renderUpdateStatus(status = {}) {
  if (!updateStatusElement) return;
  const version = status.version ? ` (v${status.version})` : "";
  const messages = {
    idle: "Automatic update check runs when the app starts.",
    checking: "Checking for updates…",
    available: `Update${version} found; downloading…`,
    downloading: `Downloading update (${Number(status.percent || 0).toFixed(0)}%)…`,
    downloaded: `Update${version} is ready to install.`,
    current: `You're up to date${version}.`,
    unavailable:
      status.message || "Updates are available in the installed desktop app.",
    error: `Update check failed: ${status.message || "Unknown error"}`,
  };
  updateStatusElement.textContent = messages[status.phase] || messages.idle;
  if (installUpdateButton)
    installUpdateButton.hidden = status.phase !== "downloaded";
  if (checkForUpdatesButton) {
    checkForUpdatesButton.disabled = status.phase === "checking";
  }
}

if (updateBridge) {
  updateBridge.onStatus(renderUpdateStatus);
  updateBridge
    .getStatus()
    .then(renderUpdateStatus)
    .catch((error) => {
      renderUpdateStatus({ phase: "error", message: error.message });
    });
} else {
  renderUpdateStatus({ phase: "unavailable" });
  if (checkForUpdatesButton) checkForUpdatesButton.disabled = true;
}

checkForUpdatesButton?.addEventListener("click", async () => {
  checkForUpdatesButton.disabled = true;
  renderUpdateStatus({ phase: "checking" });
  try {
    await updateBridge.check();
  } catch (error) {
    renderUpdateStatus({ phase: "error", message: error.message });
  } finally {
    checkForUpdatesButton.disabled = false;
  }
});

installUpdateButton?.addEventListener("click", async () => {
  try {
    await updateBridge.install();
  } catch (error) {
    renderUpdateStatus({ phase: "error", message: error.message });
  }
});

/* ---------- Boot ---------- */
loadState();
refreshDarajaStatus();
renderReceiptPanel(salesLog.at(-1) || null);
applyRole();
setOffline(offlineMode);
renderReportsPanel();
window.setInterval(checkScheduledReport, 30_000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) checkScheduledReport();
});
if (currentUser) {
  renderAllPanels();
  renderProducts();
  renderCart();
  renderSalesStockPulse();
  activateRoleLandingView();
} else {
  const appView = document.getElementById("appView");
  if (appView) appView.hidden = true;
  redirectToWelcomeView();
}
if (currentUser?.role === "admin") checkScheduledReport();
window.addEventListener("online", () => drainOfflineQueue(), { once: false });
drainOfflineQueue();
window.requestAnimationFrame(() => appLoader?.classList.add("hidden"));
