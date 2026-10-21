const fs = require("fs");
const vm = require("vm");
let src = fs.readFileSync("c:/Users/konya/OneDrive/Desktop/POS/app.js", "utf8");
src = src.slice(0, src.indexOf("function getPopularProducts"));
const ctx = { document: { querySelector: () => null }, window: {} };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(
  src + "\n;this.__out = { products, productSearchMatches };\n",
  ctx,
  { timeout: 5000 },
);
const { products, productSearchMatches } = ctx.__out;
const tests = [
  ["pishori", true],
  ["basmati", true],
  ["milk", true],
  ["biscuits", true],
  ["biscut", true],
  ["sugar", true],
  ["F003", true],
  ["tomato", true],
  ["sukuma", true],
  ["rice 2kg", true],
  ["water", true],
  ["eggs", true],
  ["tooth", true],
  ["xyzzy", false],
  ["F005", false],
  ["F006", false],
];
let pass = 0;
for (const [q, expect] of tests) {
  const got = products.some((p) => productSearchMatches(p, q));
  if (got === expect) pass++;
  else console.log("FAIL:", q, got);
}
console.log(pass + "/" + tests.length + " passed");
