import test from "node:test";
import assert from "node:assert/strict";
import { validateUploadRequest } from "./gcs.js";

test("accepts a safe upload request for a supported image", () => {
  const result = validateUploadRequest({
    fileName: "photo.png",
    contentType: "image/png",
    size: 1024,
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("expected request to be valid");
  }
  assert.equal(result.safeFileName, "photo.png");
  assert.equal(result.extension, ".png");
});

test("rejects unsupported MIME types", () => {
  const result = validateUploadRequest({
    fileName: "malware.exe",
    contentType: "application/x-msdownload",
    size: 1024,
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected request to be rejected");
  }
  assert.match(result.message, /unsupported/i);
});

test("rejects oversized payloads", () => {
  const result = validateUploadRequest({
    fileName: "big.pdf",
    contentType: "application/pdf",
    size: 11 * 1024 * 1024,
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected request to be rejected");
  }
  assert.match(result.message, /size/i);
});
