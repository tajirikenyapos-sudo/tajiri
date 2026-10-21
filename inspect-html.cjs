const fs = require("fs");
const c = fs.readFileSync("index.html", "utf8");
const i = c.indexOf("app.js");
console.log(JSON.stringify(c.substring(i - 300, i + 60)));
