// @vitest-environment node
/**
 * Maintained documentation contracts: source entry points, warning policy,
 * report navigation, generator commands and ignored output directories.
 * Reads configuration only; full generators are verified by the docs command.
 * @packageDocumentation
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
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

  /**
   * The README is the docs site's home page. TypeDoc copies linked files but fails on
   * directory links, so folders must link to the repository instead.
   */
  it("uses the README as the docs home page without relative directory links", () => {
    expect(JSON.parse(readFileSync("typedoc.json", "utf8")).readme).toBe("README.md");
    const targets = [...readFileSync("README.md", "utf8").matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]);
    const local = targets.filter(target => !/^(https?:|mailto:|#)/.test(target)).map(target => target.split("#")[0]);
    expect(local.length).toBeGreaterThan(0);
    for (const target of local) {
      expect(statSync(target).isFile(), target).toBe(true);
    }
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
    expect(scripts["docs:rust"]).toBe("bun scripts/rust-docs.ts");
    const ignored = readFileSync(".gitignore", "utf8").split("\n");
    expect(ignored).toContain("docs/typedoc/");
    expect(ignored).toContain("src-tauri/target");
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("docs/typedoc/index.html");
    expect(readme).toContain("docs/typedoc/rust/omarkd_lib/index.html");
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

  /**
   * Plain `#[test]` items are removed outside the test harness, hiding them from Rustdoc.
   * Every Rust test must stay documentable while still running under `cargo test`.
   */
  it("keeps every Rust unit test visible in Rustdoc", () => {
    for (const file of ["tests/backend.rs", "tests/edit.rs", "tests/render.rs"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/#\[test\]/);
      for (const [, docs] of source.matchAll(/((?:^\/\/\/.*\n)*)#\[cfg_attr\(not\(doc\), test\)\]\nfn /gm)) {
        expect(docs, file).not.toBe("");
      }
      expect(source.match(/#\[cfg_attr\(not\(doc\), test\)\]\nfn /g)?.length, file).toBe(source.match(/cfg_attr\(not\(doc\), test\)/g)?.length);
    }
  });

  /** One "Omarkd" site links the Rust API and both report sections from every TypeDoc page. */
  it("links the Rust API and the two full test report sections from the docs navigation", () => {
    const config = JSON.parse(readFileSync("typedoc.json", "utf8"));
    expect(config.name).toBe("Omarkd");
    expect(config.navigationLinks).toEqual({
      "Rust API": "./rust/omarkd_lib/index.html",
      "Unit tests & coverage": "./reports/unit/index.html",
      "Playwright E2E results": "./reports/e2e/index.html",
    });
  });
});
