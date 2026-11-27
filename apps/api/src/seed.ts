import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, createDocument } from "@lomi/db";

/**
 * Seeds version 1 of every fixture document. Idempotent (fixed ids), so it is
 * safe on every `docker compose up`. It only writes to Postgres: the worker's
 * reconciler notices the `queued` versions and enqueues them.
 */
const fixturesDir =
  process.env.FIXTURES_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

interface ManifestEntry {
  id: string;
  type: string;
  title: string;
  versions: { version: number; file: string }[];
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(fixturesDir, "documents.json"), "utf8")) as ManifestEntry[];
  const { db, close } = createDb();
  try {
    for (const doc of manifest) {
      const v1 = doc.versions.find((v) => v.version === 1);
      if (!v1) continue;
      const pdf = await readFile(path.join(fixturesDir, v1.file));
      const { created } = await createDocument(db, {
        id: doc.id,
        type: doc.type,
        title: doc.title,
        fileName: path.basename(v1.file),
        pdf,
      });
      console.log(`${created ? "seeded" : "exists"}: ${doc.id} v1`);
    }
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
