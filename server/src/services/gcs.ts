import { randomUUID } from "node:crypto";
import { Storage } from "@google-cloud/storage";

export const MAX_FILE_SIZE = 10 * 1024 * 1024;

const MIME_TO_EXTENSIONS: Record<string, string[]> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "application/pdf": [".pdf"],
};

// Singleton — avoid re-resolving credentials on every call
const storage = new Storage({
  projectId: process.env.GCS_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
});

function getFileExtension(fileName: string) {
  const match = fileName.match(/(\.[a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : "";
}

function sanitizeFileName(fileName: string) {
  const baseName = fileName.replace(/[\\/]+/g, "").trim();
  const safeName = baseName
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "_");

  return safeName.length > 120 ? safeName.slice(0, 120) : safeName;
}

export function validateUploadRequest(input: {
  fileName?: unknown;
  contentType?: unknown;
  size?: unknown;
}) {
  if (typeof input.fileName !== "string" || input.fileName.trim().length === 0) {
    return {
      ok: false as const,
      message: "A valid file name is required",
    };
  }

  if (typeof input.contentType !== "string" || !MIME_TO_EXTENSIONS[input.contentType]) {
    return {
      ok: false as const,
      message: "Unsupported file type",
    };
  }

  if (typeof input.size !== "number" || !Number.isInteger(input.size) || input.size < 1) {
    return {
      ok: false as const,
      message: "File size must be a positive integer",
    };
  }

  if (input.size > MAX_FILE_SIZE) {
    return {
      ok: false as const,
      message: "File size must not exceed 10MB",
    };
  }

  const safeFileName = sanitizeFileName(input.fileName);
  const extension = getFileExtension(safeFileName);
  const allowedExtensions = MIME_TO_EXTENSIONS[input.contentType];

  if (!extension || !allowedExtensions.includes(extension)) {
    return {
      ok: false as const,
      message: "File extension does not match the provided MIME type",
    };
  }

  return {
    ok: true as const,
    safeFileName,
    extension,
    normalizedContentType: input.contentType,
    size: input.size,
    objectName: `uploads/${randomUUID()}-${safeFileName}`,
  };
}

export function buildPublicObjectUrl(bucketName: string, objectName: string) {
  return `https://storage.googleapis.com/${bucketName}/${encodeURIComponent(objectName)}`;
}

export async function createSignedUploadUrl(input: {
  fileName?: unknown;
  contentType?: unknown;
  size?: unknown;
}) {
  const validation = validateUploadRequest(input);
  if (!validation.ok) {
    return validation;
  }

  const bucketName = process.env.GCS_BUCKET_NAME;
  if (!bucketName) {
    return {
      ok: false as const,
      message: "Google Cloud Storage bucket is not configured",
    };
  }

  const bucket = storage.bucket(bucketName);

  const [uploadUrl] = await bucket.file(validation.objectName).getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + 15 * 60 * 1000,
    contentType: validation.normalizedContentType,
    // Client MUST send this exact header on the PUT, or GCS rejects the
    // upload. Without this, the claimed `size` is unenforced — a client
    // could sign for 1MB and upload 9MB instead.
    extensionHeaders: {
      "X-Goog-Content-Length-Range": `0,${validation.size}`,
    },
  });

  return {
    ok: true as const,
    uploadUrl,
    objectName: validation.objectName,
    fileUrl: buildPublicObjectUrl(bucketName, validation.objectName),
    fileName: validation.safeFileName,
    contentType: validation.normalizedContentType,
    size: validation.size,
    // Client must echo this back on the PUT request
    requiredUploadHeaders: {
      "Content-Type": validation.normalizedContentType,
      "X-Goog-Content-Length-Range": `0,${validation.size}`,
    },
  };
}

/**
 * Call this from the route that persists a message/attachment reference,
 * AFTER the client reports the upload finished. Confirms the object
 * actually exists in GCS and matches what was promised, before you trust
 * it in the DB.
 */
export async function verifyUploadedObject(input: {
  objectName: string;
  expectedContentType: string;
  expectedMaxSize: number;
}) {
  const bucketName = process.env.GCS_BUCKET_NAME;
  if (!bucketName) {
    return { ok: false as const, message: "Google Cloud Storage bucket is not configured" };
  }

  const file = storage.bucket(bucketName).file(input.objectName);

  const [exists] = await file.exists();
  if (!exists) {
    return { ok: false as const, message: "Uploaded file not found" };
  }

  const [metadata] = await file.getMetadata();
  const actualSize = Number(metadata.size ?? 0);
  const actualContentType = metadata.contentType ?? "";

  if (actualContentType !== input.expectedContentType) {
    return { ok: false as const, message: "Uploaded file content type mismatch" };
  }

  if (actualSize < 1 || actualSize > input.expectedMaxSize) {
    return { ok: false as const, message: "Uploaded file size mismatch" };
  }

  return {
    ok: true as const,
    size: actualSize,
    contentType: actualContentType,
  };
}