// @vitest-environment node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { describe, expect, it } = await import("vitest");

const root = __dirname;
const page = fs.readFileSync(path.join(root, "download-installer.html"), "utf8");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const parts = [
  {
    file: "downloads/TajiriPOSSetup-1.0.0.exe.part1",
    bytes: 90_000_000,
    sha256:
      "cba175b3330c7abb72ee3273c6300923d6056cb2f1f2f1c05fd16b977646306b",
  },
  {
    file: "downloads/TajiriPOSSetup-1.0.0.exe.part2",
    bytes: 12_843_536,
    sha256:
      "4b0db9f610064c4a6e816e0d251d7da5ef3fa9f7c79f88598db5b0efbded3b60",
  },
];

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

describe("Windows installer downloads", () => {
  it("routes the old hash and both download links to a real download page", () => {
    expect(indexHtml).toContain('window.location.hash === "#download-installer"');
    expect(indexHtml.match(/href="\.\/download-installer\.html"/g)).toHaveLength(2);
    expect(indexHtml).not.toContain('href="#download-installer"');
    expect(fs.existsSync(path.join(root, "download-installer.html"))).toBe(true);
  });

  it("contains both complete, verified installer parts", async () => {
    for (const part of parts) {
      const filePath = path.join(root, part.file);
      expect(fs.statSync(filePath).size).toBe(part.bytes);
      expect(await hashFile(filePath)).toBe(part.sha256);
      expect(page).toContain(part.file.replaceAll("\\", "/").split("/").at(-1));
    }
    expect(parts.reduce((total, part) => total + part.bytes, 0)).toBe(
      102_843_536,
    );
    const combinedHash = crypto.createHash("sha256");
    for (const part of parts) {
      for await (const chunk of fs.createReadStream(path.join(root, part.file))) {
        combinedHash.update(chunk);
      }
    }
    expect(combinedHash.digest("hex")).toBe(
      "fcb883ecfad43c87ce3d386abcfde09c142089a3450603acff0f8198b3f5e490",
    );
  });

  it("sets Vercel download cache and binary content headers", () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(root, "vercel.json"), "utf8"),
    );
    for (const part of parts) {
      const fileName = path.basename(part.file);
      const rule = config.headers.find(
        entry => entry.source === `/${part.file.replaceAll("\\", "/")}`,
      );
      expect(rule.headers).toContainEqual({
        key: "Content-Type",
        value: "application/octet-stream",
      });
      expect(rule.headers).toContainEqual({
        key: "Cache-Control",
        value: "public, max-age=31536000, immutable",
      });
      expect(page).toContain(fileName);
    }
  });
});
