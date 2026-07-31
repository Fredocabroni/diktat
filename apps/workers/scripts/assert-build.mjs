// Postbuild assertion — fails the build LOUDLY if the workers entrypoint is
// missing or its dependency graph can't resolve, instead of surfacing as a
// Railway crash-loop. Runs via the `postbuild` npm lifecycle after `tsc -b`.
//
// The entrypoint's main()/process handlers are gated behind an
// `import.meta.url === argv[1]` check (see src/index.ts), so import()-ing it
// here loads + resolves the whole module graph WITHOUT executing loadEnv(),
// constructing clients, or opening handles. A timeout + explicit exit(0) guard
// against a future regression that reintroduces a module-scope open handle.
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENTRY = new URL('../dist/index.js', import.meta.url);
const entryPath = fileURLToPath(ENTRY);
const TIMEOUT_MS = 15_000;

function fail(msg) {
  console.error(`✗ workers build assertion FAILED: ${msg}`);
  process.exit(1);
}

if (!existsSync(ENTRY)) {
  fail(`entrypoint not emitted at ${entryPath} (expected dist/index.js from tsc -b)`);
}
if (statSync(ENTRY).size === 0) {
  fail(`entrypoint is empty: ${entryPath}`);
}

const timeout = new Promise((_, reject) => {
  const t = setTimeout(
    () =>
      reject(
        new Error(
          `import() did not settle in ${TIMEOUT_MS}ms — module scope may hold an open handle`,
        ),
      ),
    TIMEOUT_MS,
  );
  t.unref();
});

try {
  await Promise.race([import(ENTRY.href), timeout]);
  console.log(`✓ workers build assertion: ${entryPath} exists and its import graph resolves`);
  process.exit(0);
} catch (err) {
  fail(`entrypoint failed to load: ${err instanceof Error ? err.message : String(err)}`);
}
