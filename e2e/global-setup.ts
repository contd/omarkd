import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export default function globalSetup() {
  execFileSync("cargo", ["run", "--quiet", "--manifest-path", "src-tauri/Cargo.toml", "--example", "render-fixtures"], {
    cwd: resolve(import.meta.dirname, ".."),
    stdio: "inherit",
  });
}
