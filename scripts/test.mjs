import { mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = resolve(root, "test-results/tmp");
mkdirSync(temp, { recursive: true });
const scriptTests = readdirSync(resolve(root, "scripts"))
  .filter((name) => name.endsWith(".test.mjs"))
  .map((name) => `scripts/${name}`);
const tests = [
  ...scriptTests,
  "src/lib/app-data/app-data.test.ts",
  "src/lib/app-data/readiness-schedule.test.ts",
  "src/lib/auth/gate-identity.test.ts",
  "src/lib/auth/sign-in-gate.test.ts",
  "src/lib/preview-path-prefix.test.ts",
  "tests/navigation.test.ts",
];
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...tests], {
  cwd: root,
  env: { ...process.env, TMP: temp, TEMP: temp, TMPDIR: temp },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
