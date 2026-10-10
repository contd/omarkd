// @vitest-environment node
/**
 * Rustdoc publication tests with a mocked Cargo runner and real temporary sites.
 * They verify the Rustdoc arguments that include test modules, clean replacement of
 * the published `rust/` section, navigation wiring and that failures publish nothing.
 * @packageDocumentation
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const runner = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: runner }));
import { publishRustDocs, rustdocArgs } from "../scripts/rust-docs";

/** Owned temporary projects; removed after each test even if an assertion fails. */
const roots: string[] = [];

/** Creates a project with a TypeDoc index, a nested page, stale Rust docs and stale Cargo output. */
function project(): string {
  const root = mkdtempSync(resolve(tmpdir(), "omarkd-rustdoc-test-"));
  roots.push(root);
  mkdirSync(resolve(root, "docs/typedoc/modules"), { recursive: true });
  mkdirSync(resolve(root, "docs/typedoc/rust"), { recursive: true });
  mkdirSync(resolve(root, "src-tauri/target/doc/stale_dependency"), { recursive: true });
  writeFileSync(resolve(root, "docs/typedoc/index.html"), "Omarkd");
  writeFileSync(resolve(root, "docs/typedoc/modules/reader.html"), '<a href="./rust/omarkd_lib/index.html">Rust API</a>');
  writeFileSync(resolve(root, "docs/typedoc/rust/stale.html"), "stale");
  return root;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Simulates Cargo writing fresh docs, proving the earlier output directory was cleaned.
  runner.mockImplementation((_command: string, _args: string[], options: { cwd: string }) => {
    expect(existsSync(resolve(options.cwd, "src-tauri/target/doc/stale_dependency"))).toBe(false);
    mkdirSync(resolve(options.cwd, "src-tauri/target/doc/omarkd_lib/tests"), { recursive: true });
    writeFileSync(resolve(options.cwd, "src-tauri/target/doc/omarkd_lib/index.html"), "crate");
    writeFileSync(resolve(options.cwd, "src-tauri/target/doc/omarkd_lib/tests/fn.case.html"), "test");
    return { status: 0 };
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Rust test modules and private helpers are documented, with the site navigation header. */
it("documents the library, private items and cfg(test) modules with the site header", () => {
  expect(rustdocArgs("/project")).toEqual(["rustdoc", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--",
    "--cfg", "test", "--document-private-items", "--html-in-header", resolve("/project", "docs/rustdoc-header.html")]);
  const header = readFileSync("docs/rustdoc-header.html", "utf8");
  expect(header).toContain("dataset.rootPath");
  for (const link of ["index.html", "reports/unit/index.html", "reports/e2e/index.html", "assets/favicon.svg"]) {
    expect(header).toContain(`\${site}${link}`);
  }
});

/** A successful build replaces the published section and fixes nested TypeDoc links. */
it("replaces published Rustdoc with fresh output and wires navigation", () => {
  const root = project();
  expect(publishRustDocs(root)).toBe(0);
  expect(runner).toHaveBeenCalledWith("cargo", rustdocArgs(root), { cwd: root, stdio: "inherit" });
  const site = resolve(root, "docs/typedoc");
  expect(existsSync(resolve(site, "rust/stale.html"))).toBe(false);
  expect(readFileSync(resolve(site, "rust/omarkd_lib/tests/fn.case.html"), "utf8")).toBe("test");
  expect(readFileSync(resolve(site, "modules/reader.html"), "utf8")).toContain('href="../rust/omarkd_lib/index.html"');
});

/** Cargo failures and launch errors return nonzero and keep the previous site intact. */
it("publishes nothing when Cargo fails or cannot start", () => {
  const root = project();
  runner.mockReturnValueOnce({ status: 101 });
  expect(publishRustDocs(root)).toBe(101);
  runner.mockReturnValueOnce({ status: null, error: new Error("spawn cargo ENOENT") });
  expect(publishRustDocs(root)).toBe(1);
  expect(console.error).toHaveBeenCalledWith("Could not run cargo: spawn cargo ENOENT");
  expect(readFileSync(resolve(root, "docs/typedoc/rust/stale.html"), "utf8")).toBe("stale");
});

/** Rustdoc must follow TypeDoc, which would otherwise delete the published Rust section. */
it("requires the TypeDoc site before publishing", () => {
  const root = project();
  rmSync(resolve(root, "docs/typedoc/index.html"));
  expect(publishRustDocs(root)).toBe(1);
  expect(runner).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("bun run docs:ts"));
});
