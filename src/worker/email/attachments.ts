import { attachmentBytes } from "./rules.ts";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_TOTAL_BYTES } from "../../shared/email-limits.ts";
export { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_TOTAL_BYTES } from "../../shared/email-limits.ts";

// The provider caps the whole MIME message at 5 MiB; base64 inflates payload
// by ~4/3, so 3 MiB of raw attachment bytes stays safely under the limit.
const MAX_FILENAME_CHARS = 200;
const MAX_CONTENT_TYPE_CHARS = 200;
const MAX_CONTENT_ID_CHARS = 200;

export interface OutboundAttachmentInput {
  filename?: string | null;
  contentType?: string | null;
  disposition?: "attachment" | "inline" | null;
  contentId?: string | null;
  content: ArrayBuffer | Uint8Array | string;
}

export interface NormalizedAttachment {
  filename: string | null;
  contentType: string;
  disposition: "attachment" | "inline";
  contentId: string | null;
  content: Uint8Array;
}

/** Attachment metadata persisted on the attempt row, including the R2 key. */
export interface StagedAttachment {
  filename: string | null;
  content_type: string;
  size: number;
  disposition: "attachment" | "inline";
  content_id: string | null;
  r2_key: string;
}

interface AttachmentMeta {
  filename: string | null;
  content_type: string;
  size: number;
  disposition: "attachment" | "inline";
  content_id: string | null;
}

export class AttachmentInputError extends Error {
  readonly status = 400;
}

export function normalizeAttachments(
  inputs: ReadonlyArray<OutboundAttachmentInput>,
): NormalizedAttachment[] {
  if (inputs.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new AttachmentInputError(
      `A message can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`,
    );
  }
  let total = 0;
  const normalized = inputs.map((input) => {
    const content = attachmentBytes(input.content);
    if (content.byteLength === 0) {
      throw new AttachmentInputError("Attachments cannot be empty");
    }
    total += content.byteLength;
    const disposition = input.disposition ?? "attachment";
    if (disposition !== "attachment" && disposition !== "inline") {
      throw new AttachmentInputError("Attachment disposition must be attachment or inline");
    }
    return {
      filename: sanitizeFilename(input.filename),
      contentType: sanitizeContentType(input.contentType),
      disposition,
      contentId: disposition === "inline" ? sanitizeContentId(input.contentId) : null,
      content,
    };
  });
  if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new AttachmentInputError(
      `Attachments are limited to ${Math.floor(MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024)} MB in total`,
    );
  }
  return normalized;
}

/**
 * Canonical JSON of the caller-visible metadata, used to verify that a retried
 * attempt carries the same attachments as the stored one.
 */
export function attachmentFingerprint(
  attachments: ReadonlyArray<NormalizedAttachment | StagedAttachment>,
): string {
  return JSON.stringify(attachments.map(metaOf));
}

export function parseStagedAttachments(raw: string | null | undefined): StagedAttachment[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StagedAttachment[]) : [];
  } catch {
    return [];
  }
}

export async function stageAttachments(
  bucket: R2Bucket | undefined,
  mailboxId: number,
  attemptId: string,
  attachments: ReadonlyArray<NormalizedAttachment>,
): Promise<StagedAttachment[]> {
  if (attachments.length === 0) return [];
  if (!bucket) {
    throw new Error("Staging attachments requires the RAW R2 binding");
  }
  const staged: StagedAttachment[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const r2Key = `attachments/${mailboxId}/outbound/${attemptId}/${index}-${crypto.randomUUID()}`;
    await bucket.put(r2Key, attachment.content, {
      httpMetadata: { contentType: attachment.contentType },
    });
    staged.push({
      filename: attachment.filename,
      content_type: attachment.contentType,
      size: attachment.content.byteLength,
      disposition: attachment.disposition,
      content_id: attachment.contentId,
      r2_key: r2Key,
    });
  }
  return staged;
}

/** One INSERT..SELECT per staged file, linking it to the just-stored message. */
export function recordAttachmentStatements(
  db: D1Database,
  staged: ReadonlyArray<StagedAttachment>,
  rfcMessageId: string,
): D1PreparedStatement[] {
  return staged.map((attachment) =>
    db.prepare(
      `INSERT INTO attachments
         (message_id, filename, content_type, size, disposition, content_id, r2_key)
       SELECT id, ?, ?, ?, ?, ?, ? FROM messages WHERE message_id = ?`,
    ).bind(
      attachment.filename,
      attachment.content_type,
      attachment.size,
      attachment.disposition,
      attachment.content_id,
      attachment.r2_key,
      rfcMessageId,
    ),
  );
}

export function sendableAttachments(attachments: ReadonlyArray<NormalizedAttachment>) {
  return attachments.map((attachment) => ({
    content: attachment.content,
    filename: attachment.filename ?? "attachment",
    type: attachment.contentType,
    disposition: attachment.disposition,
    ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
  }));
}

function metaOf(attachment: NormalizedAttachment | StagedAttachment): AttachmentMeta {
  if ("r2_key" in attachment) {
    return {
      filename: attachment.filename,
      content_type: attachment.content_type,
      size: attachment.size,
      disposition: attachment.disposition,
      content_id: attachment.content_id,
    };
  }
  return {
    filename: attachment.filename,
    content_type: attachment.contentType,
    size: attachment.content.byteLength,
    disposition: attachment.disposition,
    content_id: attachment.contentId,
  };
}

function sanitizeFilename(filename: string | null | undefined): string | null {
  const cleaned = (filename ?? "")
    .replace(/[\x00-\x1f"\\/;]/g, "_")
    .trim()
    .slice(0, MAX_FILENAME_CHARS);
  return cleaned || null;
}

function sanitizeContentType(contentType: string | null | undefined): string {
  const cleaned = (contentType ?? "")
    .replace(/[\x00-\x1f\x7f\s]/g, "")
    .slice(0, MAX_CONTENT_TYPE_CHARS)
    .toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(cleaned)
    ? cleaned
    : "application/octet-stream";
}

function sanitizeContentId(contentId: string | null | undefined): string | null {
  const cleaned = (contentId ?? "")
    .replace(/[\x00-\x1f<>\s]/g, "")
    .slice(0, MAX_CONTENT_ID_CHARS);
  return cleaned || null;
}
