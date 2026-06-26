// Parity check: re-run all sample inputs and diff against the committed
// expected .response.json files. Catches regressions in investigator logic.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { investigate } from "../src/investigator";

const dir = join(import.meta.dir, "..", "sample_output");
const files = readdirSync(dir).filter((f) => f.endsWith(".request.json")).sort();

let mismatches = 0;
for (const f of files) {
  const req = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const wantPath = join(dir, f.replace(".request.json", ".response.json"));
  const want = JSON.parse(readFileSync(wantPath, "utf8"));
  const got = investigate(req);
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (!same) {
    mismatches++;
    console.log("MISMATCH", f);
    const a = JSON.stringify(got, null, 2).split("\n");
    const b = JSON.stringify(want, null, 2).split("\n");
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        console.log("  at line", i, "got:", a[i], "want:", b[i]);
        break;
      }
    }
  } else {
    console.log("OK", f);
  }
}
console.log("---");
console.log(mismatches === 0 ? "ALL PARITY OK" : `${mismatches} mismatches`);
process.exit(mismatches === 0 ? 0 : 1);