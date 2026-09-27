import { normalizeSubject } from "./rules.ts";
import type { ComposeAttemptResult } from "../../shared/types.ts";
export type { ComposeAttemptResult } from "../../shared/types.ts";
import {
  attachmentFingerprint,
  normalizeAttachments,
  parseStagedAttachments,
  recordAttachmentStatements,
  sendableAttachments,
  stageAttachments,
  type NormalizedAttachment,
  type OutboundAttachmentInput,
  type StagedAttachment,
} from "./attachments.ts";
import { sendEmail, type SendEmailEnv } from "./send.ts";
import { claimDailySendBudget } from "./send-budget.ts";

export interface ComposeEnv extends SendEmailEnv {
  DB: D1Database;
  RAW?: R2Bucket;
}

export interface ComposeIntent {
  attemptId: string;
  mailboxId: number;
  to: string[];
  subject: string;
  text: string;
  attachments?: OutboundAttachmentInput[];
  actorId?: string;
  oauthClientId?: string;
  dailySendLimit?: number;
  sentBy?: "human" | "agent";
}

export type ComposeAttemptStatus = "pending" | "sending" | "sent" | "failed";

interface StoredAttempt {
  id: string;
  mailbox_id: number;
  thread_id: number | null;
  status: ComposeAttemptStatus;
  to_addresses: string;
  subject: string;
  text_body: string;
  attachments: string;
  message_id: string | null;
  actor_id: string | null;
  oauth_client_id: string | null;
  error: string | null;
  sent_by: "human" | "agent";
}

export async function sendNewEmailAttempt(
  env: ComposeEnv,
  intent: ComposeIntent,
): Promise<ComposeAttemptResult> {
  const normalized = normalizeIntent(intent);
  const attachments = normalizeAttachments(intent.attachments ?? []);
  if (normalized.to.length !== 1 || !normalized.to[0]) {
    throw new ComposeIntentError("New email requires exactly one recipient", 400);
  }
  if (!normalized.subject) throw new ComposeIntentError("Subject is required", 400);
  if (!normalized.text && attachments.length === 0) {
    throw new ComposeIntentError("Message text is required", 400);
  }
  const existing = await getAttempt(env, normalized.attemptId);
  if (existing) {
    existingResult(existing, normalized, attachments);
    if (existing.status === "sent" || existing.status === "failed") {
      return existingResult(existing, normalized, attachments);
    }
    if (existing.status === "sending" && (!existing.message_id || !existing.thread_id)) {
      return existingResult(existing, normalized, attachments);
    }
  }

  const inbox = await env.DB.prepare(
    `SELECT m.id, m.address, d.status AS domain_status
     FROM mailboxes m LEFT JOIN domains d ON d.id = m.domain_id
     WHERE m.id = ?`,
  )
    .bind(normalized.mailboxId)
    .first<{ id: number; address: string; domain_status: "pending" | "active" | null }>();
  if (!inbox) throw new ComposeIntentError("Inbox not found", 404);
  if (inbox.domain_status !== "active") {
    throw new ComposeIntentError("Inbox domain is not ready for outbound sending", 409);
  }

  if (attachments.length > 0 && !env.RAW) {
    throw new ComposeIntentError(
      "Attachments require the RAW R2 binding, which is not configured on this instance",
      400,
    );
  }

  let staged: StagedAttachment[] = existing
    ? parseStagedAttachments(existing.attachments)
    : [];

  if (!existing) {
    try {
      staged = await stageAttachments(
        env.RAW,
        normalized.mailboxId,
        normalized.attemptId,
        attachments,
      );
      await env.DB.prepare(
        `INSERT INTO outbound_attempts
           (id, mailbox_id, status, to_addresses, subject, text_body, attachments,
            actor_id, oauth_client_id, sent_by)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          normalized.attemptId,
          normalized.mailboxId,
          JSON.stringify(normalized.to),
          normalized.subject,
          normalized.text,
          JSON.stringify(staged),
          normalized.actorId ?? null,
          normalized.oauthClientId ?? null,
          normalized.sentBy ?? "agent",
        )
        .run();
      if (
        normalized.actorId &&
        normalized.dailySendLimit !== undefined &&
        !(await claimDailySendBudget(env, normalized.actorId, normalized.dailySendLimit))
      ) {
        await markFailed(env, normalized.attemptId, "Daily MCP send limit reached");
        throw new ComposeIntentError("Daily MCP send limit reached", 429);
      }
    } catch (error) {
      if (error instanceof ComposeIntentError) throw error;
      const raced = await getAttempt(env, normalized.attemptId);
      if (raced) return existingResult(raced, normalized, attachments);
      throw error;
    }
  }

  if (!existing || existing.status === "pending") {
    const claimed = await env.DB.prepare(
      `UPDATE outbound_attempts
       SET status = 'sending', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'pending' RETURNING id`,
    )
      .bind(normalized.attemptId)
      .first<{ id: string }>();
    if (!claimed) {
      const raced = await getAttempt(env, normalized.attemptId);
      if (!raced) throw new ComposeIntentError("Send Attempt disappeared", 500);
      return existingResult(raced, normalized, attachments);
    }
  }

  const now = new Date().toISOString();
  let conversationId = existing?.thread_id ?? null;
  if (conversationId === null) {
    try {
      conversationId = randomThreadId();
      await env.DB.batch([
        env.DB.prepare(
        `INSERT INTO threads
           (id, mailbox_id, subject, normalized_subject, snippet, status, is_read,
            message_count, last_message_at)
         VALUES (?, ?, ?, ?, ?, 'open', 1, 0, ?)`,
        ).bind(
          conversationId,
          normalized.mailboxId,
          normalized.subject,
          normalizeSubject(normalized.subject),
          snippet(normalized.text),
          now,
        ),
        env.DB.prepare(
          `UPDATE outbound_attempts SET thread_id = ?, updated_at = ? WHERE id = ?`,
        ).bind(conversationId, now, normalized.attemptId),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create Conversation";
      await markFailed(env, normalized.attemptId, message);
      return failedResult(normalized.attemptId, null, message);
    }
  }

  let messageId = existing?.message_id ?? null;
  if (!messageId) {
    try {
      ({ messageId } = await sendEmail(env, {
        from: { address: inbox.address },
        to: normalized.to,
        subject: normalized.subject,
        text: normalized.text,
        attachments: sendableAttachments(attachments),
        autoSubmitted: normalized.sentBy === "human" ? undefined : "auto-generated",
        attemptId: normalized.attemptId,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Email provider rejected the message";
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE outbound_attempts
           SET status = 'failed', thread_id = NULL, error = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?`,
        ).bind(message.slice(0, 2000), normalized.attemptId),
        env.DB.prepare("DELETE FROM threads WHERE id = ? AND message_count = 0").bind(conversationId),
      ]);
      return failedResult(normalized.attemptId, null, message);
    }
    try {
      await env.DB.prepare(
        `UPDATE outbound_attempts
         SET message_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'sending'`,
      )
        .bind(messageId, normalized.attemptId)
        .run();
    } catch {
      console.error("Could not checkpoint provider result for Send Attempt", {
        attemptId: normalized.attemptId,
      });
    }
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages
         (thread_id, message_id, references_ids, direction, sent_by,
          from_address, from_name, to_addresses, reply_to_addresses,
          subject, text_body, created_at)
       VALUES (?, ?, '[]', 'outbound', ?, ?, NULL, ?, '[]', ?, ?, ?)`,
    ).bind(
      conversationId,
      messageId,
      normalized.sentBy ?? "agent",
      inbox.address,
      JSON.stringify(normalized.to),
      normalized.subject,
      normalized.text,
      now,
    ),
    ...recordAttachmentStatements(env.DB, staged, messageId),
    env.DB.prepare(
      `UPDATE threads
       SET message_count = 1, snippet = ?, last_message_at = ?, is_read = 1
       WHERE id = ?`,
    ).bind(
      snippet(normalized.text) ||
        staged.map((attachment) => attachment.filename ?? "attachment").join(", ").slice(0, 140),
      now,
      conversationId,
    ),
    env.DB.prepare(
      `UPDATE outbound_attempts
       SET status = 'sent', message_id = ?, error = NULL, updated_at = ?
       WHERE id = ?`,
    ).bind(messageId, now, normalized.attemptId),
  ]);

  return {
    ok: true,
    attempt_id: normalized.attemptId,
    status: "sent",
    conversation_id: conversationId,
    message_id: messageId,
  };
}

async function getAttempt(env: ComposeEnv, id: string): Promise<StoredAttempt | null> {
  return env.DB.prepare("SELECT * FROM outbound_attempts WHERE id = ?")
    .bind(id)
    .first<StoredAttempt>();
}

async function markFailed(env: ComposeEnv, id: string, error: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE outbound_attempts
     SET status = 'failed', error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
  )
    .bind(error.slice(0, 2000), id)
    .run();
}

function existingResult(
  existing: StoredAttempt,
  intent: NormalizedIntent,
  attachments: NormalizedAttachment[],
): ComposeAttemptResult {
  if (
    existing.mailbox_id !== intent.mailboxId ||
    existing.to_addresses !== JSON.stringify(intent.to) ||
    existing.subject !== intent.subject ||
    existing.text_body !== intent.text ||
    attachmentFingerprint(parseStagedAttachments(existing.attachments)) !==
      attachmentFingerprint(attachments) ||
    existing.actor_id !== (intent.actorId ?? null) ||
    existing.oauth_client_id !== (intent.oauthClientId ?? null) ||
    (existing.sent_by ?? "agent") !== (intent.sentBy ?? "agent")
  ) {
    throw new ComposeIntentError("Send Attempt id was already used for different content", 409);
  }
  return {
    ok: existing.status === "sent",
    attempt_id: existing.id,
    status: existing.status,
    conversation_id: existing.thread_id,
    message_id: existing.message_id,
    ...(existing.error ? { error: existing.error } : {}),
  };
}

function failedResult(id: string, conversationId: number | null, error: string): ComposeAttemptResult {
  return {
    ok: false,
    attempt_id: id,
    status: "failed",
    conversation_id: conversationId,
    message_id: null,
    error,
  };
}

interface NormalizedIntent extends Omit<ComposeIntent, "to" | "subject" | "text"> {
  to: string[];
  subject: string;
  text: string;
}

function normalizeIntent(intent: ComposeIntent): NormalizedIntent {
  return {
    ...intent,
    to: [...new Map(
      intent.to.map((address) => {
        const normalized = normalizeEmailAddress(address);
        return [normalized.toLowerCase(), normalized] as const;
      }),
    ).values()],
    subject: intent.subject.trim(),
    text: intent.text.trim(),
  };
}

function normalizeEmailAddress(address: string): string {
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed;
  return `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}`;
}

function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 140);
}

function randomThreadId(): number {
  const bytes = crypto.getRandomValues(new Uint32Array(2));
  return (bytes[0]! & 0x1fffff) * 0x1_0000_0000 + bytes[1]! + 1;
}

export class ComposeIntentError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
