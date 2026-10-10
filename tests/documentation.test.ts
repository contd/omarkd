// @vitest-environment node
/**
 * Maintained documentation contracts: source entry points, warning policy,
 * report navigation, generator commands and ignored output directories.
 * Reads configuration only; full generators are verified by the docs command.
 * @packageDocumentation
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("source documentation configuration", () => {
  /** TypeDoc copies the original SVG for both the browser icon and CSS toolbar logo. */
  it("uses the app icon for the favicon and the logo beside the site title", () => {
    const config = JSON.parse(readFileSync("typedoc.json", "utf8"));
    expect(config.favicon).toBe("icon.svg");
    expect(config.customCss).toBe("docs/branding.css");
    expect(readFileSync(config.favicon, "utf8")).toContain("<svg");
    const css = readFileSync(config.customCss, "utf8");
    expect(css).toContain(".tsd-page-toolbar a.title::before");
    expect(css).toContain('url("./favicon.svg")');
  });

  /** Directory expansion includes future application/tests, but excludes ambient/generated declarations. */
  it("automatically includes application and test modules in TypeDoc without generated entry points", () => {
    const config = JSON.parse(readFileSync("typedoc.json", "utf8"));
    expect(config.entryPoints).toEqual(["src", "tests", "e2e"]);
    expect(config.entryPointStrategy).toBe("expand");
    expect(config.exclude).toEqual(["**/*.d.ts"]);
    expect(config.tsconfig).toBe("tsconfig.tests.json");
    expect(config.out).toBe("docs/typedoc");
    expect(config.treatWarningsAsErrors).toBe(true);
    expect(config.validation).toMatchObject({ invalidLink: true, notExported: true });
    for (const file of readdirSync("src").filter(file => file.endsWith(".ts") && !file.endsWith(".d.ts"))) {
      const source = readFileSync(`src/${file}`, "utf8");
      expect(source, file).toMatch(/^\/\*\*[\s\S]*?@packageDocumentation[\s\S]*?\*\//);
    }
  });

  /** A complete docs build runs both language generators and publishes fresh test artifacts. */
  it("provides separate TypeDoc and private-item Rustdoc commands with ignored outputs", () => {
    const { scripts, devDependencies } = JSON.parse(readFileSync("package.json", "utf8"));
    expect(devDependencies.typedoc).toBeDefined();
    expect(scripts.docs).toBe("bun run docs:ts && bun run docs:rust && bun run docs:reports");
    expect(scripts["docs:reports"]).toBe("bun scripts/test-reports.ts");
    expect(scripts["docs:ts"]).toBe("typedoc");
    expect(scripts["docs:rust"]).toBe("cargo doc --manifest-path src-tauri/Cargo.toml --lib --no-deps --document-private-items");
    const ignored = readFileSync(".gitignore", "utf8").split("\n");
    expect(ignored).toContain("docs/typedoc/");
    expect(ignored).toContain("src-tauri/target");
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("docs/typedoc/index.html");
    expect(readme).toContain("src-tauri/target/doc/omarkd_lib/index.html");
  });

  /** Suite descriptions remain available in TypeDoc; native tests use Rust module documentation. */
  it("documents every unit and browser suite with its own module-level explanation", () => {
    for (const directory of ["tests", "e2e"]) {
      for (const file of readdirSync(directory).filter(file => file.endsWith(".ts"))) {
        expect(readFileSync(`${directory}/${file}`, "utf8"), `${directory}/${file}`).toContain("@packageDocumentation");
      }
    }
    for (const file of ["tests/backend.rs", "tests/edit.rs", "tests/render.rs", "e2e/support/render-fixtures.rs"]) {
      expect(readFileSync(file, "utf8"), file).toMatch(/^\/\/!/);
    }
  });

  /** Both report links remain part of TypeDoc navigation rather than standalone artifacts. */
  it("links the two full test report sections from the docs navigation", () => {
    const config = JSON.parse(readFileSync("typedoc.json", "utf8"));
    expect(config.navigationLinks).toEqual({
      "Unit tests & coverage": "./reports/unit/index.html",
      "Playwright E2E results": "./reports/e2e/index.html",
    });
  });
});
