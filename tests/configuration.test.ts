// @vitest-environment node
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readJson = (path: string) => JSON.parse(readFileSync(resolve(path), "utf8"));

describe("desktop integration configuration", () => {
  it("registers Markdown document associations and valid generated icons", () => {
    const config = readJson("src-tauri/tauri.conf.json");
    expect(config.productName).toBe("Omarkd");
    expect(config.bundle.fileAssociations[0]).toMatchObject({
      ext: ["md", "markdown", "mdown", "mkd", "mkdn"],
      role: "Viewer",
      mimeType: "text/markdown",
    });
    for (const path of config.bundle.icon) expect(existsSync(resolve("src-tauri", path))).toBe(true);
  });

  it("grants the reader's native commands only to document windows", () => {
    const capability = readJson("src-tauri/capabilities/default.json");
    expect(capability.windows).toEqual(["doc-*"]);
    for (const permission of [
      "core:default", "core:window:allow-show", "core:window:allow-set-focus",
      "core:window:allow-set-title", "core:window:allow-set-theme", "dialog:allow-open",
      "opener:allow-open-url", "opener:allow-reveal-item-in-dir",
    ]) expect(capability.permissions).toContain(permission);
    expect(capability.permissions).toContainEqual({ identifier: "opener:allow-open-path", allow: [{ path: "**" }] });
  });

  it("keeps the content security policy restrictive while allowing local renderers and images", () => {
    const { csp, assetProtocol } = readJson("src-tauri/tauri.conf.json").app.security;
    expect(csp["script-src"]).toBe("'self'");
    for (const name of ["frame-src", "object-src"]) expect(csp[name]).toBe("'none'");
    expect(csp["img-src"]).toContain("asset:");
    expect(csp["style-src"]).toContain("'unsafe-inline'");
    expect(assetProtocol.enable).toBe(true);
  });

  it("uses every persistent feature screenshot in the README without broken image links", () => {
    const readme = readFileSync("README.md", "utf8");
    const paths = [...readme.matchAll(/\]\((assets\/screenshots\/[^)]+)\)/g)].map(match => match[1]);
    expect(paths.length).toBeGreaterThanOrEqual(21);
    for (const path of paths) {
      const png = readFileSync(path);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(420);
      expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(640);
    }
    for (const file of readdirSync("assets/screenshots").filter(file => file.endsWith(".png"))) {
      expect(paths).toContain(`assets/screenshots/${file}`);
    }
  });
});
