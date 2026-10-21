const fs = require("fs");
const vm = require("vm");
const s = fs.readFileSync("app.js", "utf8");
const money = s.slice(
  s.indexOf("const money ="),
  s.indexOf("function showToast"),
);
const ctx = {
  window: { setTimeout: () => {} },
  console,
  document: { querySelector: () => null },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(money, ctx, { timeout: 3000 });
console.log("typeof search:", vm.runInContext("typeof search", ctx));
