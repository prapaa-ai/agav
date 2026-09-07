#!/usr/bin/env node
/**
 * Mirror a GitHub release's assets to the Cloudflare R2 bucket that backs
 * releases.agav.dev, under the immutable key layout `<tag>/<asset>`.
 *
 *   node scripts/mirror-release-to-r2.mjs <tag> <dir>
 *   e.g. node scripts/mirror-release-to-r2.mjs v0.2.1 release
 *
 * R2 speaks the S3 API. Credentials come from the environment:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *
 * Runs after the GitHub Release is created so GitHub (the fallback) is never
 * empty while R2 is populated. Every object is written with a one-year
 * immutable Cache-Control since release paths never change per version. After
 * uploading, every key is re-checked (HEAD) as a parity gate — the script
 * fails if any object is missing or has the wrong size.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const [, , tag, dir] = process.argv;

if (!tag || !dir) {
  console.error("usage: mirror-release-to-r2.mjs <tag> <dir>");
  process.exit(2);
}

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
} = process.env;

for (const [name, val] of Object.entries({
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
})) {
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

const CACHE_CONTROL = "public, max-age=31536000, immutable";

// Minimal content-type map; everything else is a generic binary stream.
const CONTENT_TYPES = {
  ".gz": "application/gzip",
  ".sha256": "text/plain",
  ".sig": "application/octet-stream",
  ".exe": "application/vnd.microsoft.portable-executable",
};

function contentTypeFor(name) {
  if (name === "SHA256SUMS") return "text/plain";
  for (const [ext, type] of Object.entries(CONTENT_TYPES)) {
    if (name.endsWith(ext)) return type;
  }
  return "application/octet-stream";
}

// Imported lazily, after arg + env validation, so the script fails fast with a
// clear message rather than a module-resolution error when the SDK is absent.
const { S3Client, PutObjectCommand, HeadObjectCommand } = await import(
  "@aws-sdk/client-s3"
);

const client = new S3Client({
  region: "auto",
  // R2_ENDPOINT overrides the default account endpoint (used for testing
  // against a local S3-compatible mock; unset in production).
  endpoint:
    process.env.R2_ENDPOINT ||
    `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: !!process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// Collect the files to mirror: every regular file directly in <dir>.
const files = readdirSync(dir)
  .map((name) => ({ name, path: join(dir, name) }))
  .filter(({ path }) => statSync(path).isFile());

if (files.length === 0) {
  console.error(`No files found in ${dir} to mirror.`);
  process.exit(1);
}

console.log(`Mirroring ${files.length} asset(s) to r2://${R2_BUCKET}/${tag}/`);

// --- Upload ---
const uploaded = [];
for (const { name, path } of files) {
  const key = `${tag}/${name}`;
  const bytes = readFileSync(path);
  await client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: bytes,
      ContentType: contentTypeFor(name),
      CacheControl: CACHE_CONTROL,
    }),
  );
  console.log(`  + ${key} (${bytes.length} bytes)`);
  uploaded.push({ key, size: bytes.length });
}

// --- Parity check: re-HEAD every key and confirm size matches ---
console.log("Verifying uploaded objects...");
let failures = 0;
for (const { key, size } of uploaded) {
  try {
    const head = await client.send(
      new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }),
    );
    if (Number(head.ContentLength) !== size) {
      console.error(
        `  ! ${key}: size mismatch (local ${size}, remote ${head.ContentLength})`,
      );
      failures++;
    } else {
      console.log(`  ok ${key}`);
    }
  } catch (err) {
    console.error(`  ! ${key}: not found after upload (${err?.name || err})`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`R2 mirror parity check failed for ${failures} object(s).`);
  process.exit(1);
}

console.log(
  `R2 mirror complete: ${uploaded.length} object(s) under ${tag}/ verified.`,
);
