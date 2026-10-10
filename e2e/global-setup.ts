import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** Runs the fixture example from repository root and streams native compiler diagnostics. */
export default function globalSetup() {
  execFileSync("cargo", ["run", "--quiet", "--manifest-path", "src-tauri/Cargo.toml", "--example", "render-fixtures"], {
    cwd: resolve(import.meta.dirname, ".."),
    stdio: "inherit",
  });
}
/**
 * Builds browser fixtures with the production Rust renderer before Playwright runs.
 * Cargo failures stop setup; stale/generated HTML is never a fallback for a failed build.
 * @packageDocumentation
 */
