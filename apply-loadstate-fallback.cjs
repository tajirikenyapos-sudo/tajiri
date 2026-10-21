const fs = require("fs");
const file = "app.js";
let content = fs.readFileSync(file, "utf8");

const oldText = [
  "    const raw = localStorage.getItem(stateKey);",
  "    if (!raw) {",
  "      restoreCurrentUser();",
  "      return;",
  "    }",
].join("\r\n");

const newText = [
  "    const raw = localStorage.getItem(stateKey);",
  "    if (!raw) {",
  "      restoreCurrentUser();",
  "      if (window.TajiriIdb) {",
  "        Promise.all([",
  "          window.TajiriIdb.loadCatalog(),",
  "          window.TajiriIdb.loadSales(),",
  "          window.TajiriIdb.loadCustomers(),",
  "          window.TajiriIdb.loadStaff(),",
  "          window.TajiriIdb.loadSettings(),",
  "        ])",
  "          .then(([catalog, sales, savedCustomers, staff, savedSettings]) => {",
  "            if (catalog.length) {",
  "              products.splice(0, products.length, ...catalog);",
  "            }",
  "            if (sales.length) salesLog = sales;",
  "            if (savedCustomers.length)",
  "              customers.splice(0, customers.length, ...savedCustomers);",
  "            if (staff.length) users = staff;",
  "            if (savedSettings) Object.assign(settings, savedSettings);",
  "            if (catalog.length || sales.length) {",
  "              offlineMode = true;",
  "              renderAllPanels();",
  '              showToast("Offline mode: loaded locally cached data");',
  "            }",
  "          })",
  "          .catch((error) =>",
  '            console.warn("Could not read the offline cache:", error),',
  "          );",
  "      }",
  "      return;",
  "    }",
].join("\r\n");

if (!content.includes(oldText)) {
  console.error("LOADSTATE FALLBACK NOT FOUND");
  process.exit(1);
}
content = content.replace(oldText, newText);
fs.writeFileSync(file, content, "utf8");
console.log("EDIT OK");
