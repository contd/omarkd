/**
 * Generates native Rustdoc, including private items and the Rust unit tests, and
 * publishes it at `docs/typedoc/rust/` so the TypeDoc site is the single Omarkd
 * documentation site. Run after TypeDoc, which replaces its whole output folder.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { wireReportLinks } from "./test-reports";

/**
 * Cargo arguments for the library's Rustdoc. `--cfg test` includes the
 * `#[cfg(test)]` modules loaded from `tests/`; their test functions use
 * `#[cfg_attr(not(doc), test)]`, so Rustdoc documents them as ordinary functions.
 */
export function rustdocArgs(root: string): string[] {
  return ["rustdoc", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--",
    "--cfg", "test", "--document-private-items", "--html-in-header", resolve(root, "docs/rustdoc-header.html")];
}

/**
 * Builds Rustdoc into a clean `target/doc`, then replaces `docs/typedoc/rust`.
 * Returns the Cargo exit status; a failed build never publishes partial docs.
 */
export function publishRustDocs(root: string): number {
  const site = resolve(root, "docs/typedoc");
  if (!existsSync(resolve(site, "index.html"))) {
    console.error("Run TypeDoc (bun run docs:ts) before publishing Rustdoc into the docs site.");
    return 1;
  }
  const output = resolve(root, "src-tauri/target/doc");
  // A clean doc directory keeps unrelated dependency docs out of the published site.
  rmSync(output, { recursive: true, force: true });
  const result = spawnSync("cargo", rustdocArgs(root), { cwd: root, stdio: "inherit" });
  if (result.error) console.error(`Could not run cargo: ${result.error.message}`);
  const status = result.status ?? 1;
  if (status !== 0) return status;
  const destination = resolve(site, "rust");
  rmSync(destination, { recursive: true, force: true });
  cpSync(output, destination, { recursive: true });
  wireReportLinks(site);
  console.log(`Rust API documentation published at ${resolve(destination, "omarkd_lib/index.html")}`);
  return 0;
}

// The path check keeps importing helpers in unit tests from running Cargo.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = publishRustDocs(resolve(import.meta.dirname, ".."));
}
