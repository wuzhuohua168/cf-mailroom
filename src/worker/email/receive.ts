import PostalMime, { type Attachment, type Email } from "postal-mime";
import { enqueueDraftRun } from "../agent/runs";
import { splitQuotedTail } from "../../shared/quote";
import { labelNewThread } from "./label";
import { notifyNewEmail } from "../notifications/push";
import {
  addressOf,
  addressesOf,
  attachmentBytes,
  hasReplyPrefix,
  isAutoSubmitted,
  normalizeSubject,
  rawFingerprint,
} from "./rules";

export async function receiveEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const mailbox = await findMailbox(env, message.to.trim().toLowerCase());
  if (!mailbox) {
    message.setReject("Inbox not configured");
    return;
  }

  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const fingerprint = await rawFingerprint(rawBuffer);
  const parsed = await PostalMime.parse(rawBuffer);
  const messageId = parsed.messageId ?? `<raw-${fingerprint}@mailroom.invalid>`;

  const duplicate = await env.DB.prepare(
    `SELECT msg.id, msg.thread_id, msg.is_auto_submitted
     FROM messages msg WHERE msg.message_id = ?`,
  )
    .bind(messageId)
    .first<{ id: number; thread_id: number; is_auto_submitted: number }>();
  if (duplicate) {
    if (mailbox.agent_mode !== "off" && !duplicate.is_auto_submitted) {
      await enqueueIfExternal(env, duplicate.thread_id, duplicate.id, parsed);
    }
    return;
  }

  // R2 is optional: instances without the RAW binding skip retaining the
  // original MIME (raw_key stays NULL; nothing reads it back).
  const rawKey = env.RAW ? `raw/${mailbox.id}/${fingerprint}.eml` : null;
  if (env.RAW && rawKey) {
    await env.RAW.put(rawKey, rawBuffer, {
      httpMetadata: { contentType: "message/rfc822" },
    });
  }

  const subject = parsed.subject ?? "";
  const textBody = parsed.text ?? htmlToText(parsed.html ?? "");
  const referencesIds = extractMessageIds(parsed);
  const sender = addressOf(parsed.from);
  const existingThreadId = await resolveThread(
    env,
    mailbox.id,
    subject,
    referencesIds,
    sender,
  );
  const now = new Date().toISOString();
  const snippet = splitQuotedTail(textBody).main.replace(/\s+/g, " ").trim().slice(0, 140);

  const stored = existingThreadId === null
    ? await storeNewConversation(env, {
        mailboxId: mailbox.id,
        messageId,
        parsed,
        subject,
        textBody,
        rawKey,
        snippet,
        now,
      })
    : await appendToConversation(env, {
        threadId: existingThreadId,
        messageId,
        parsed,
        subject,
        textBody,
        rawKey,
        snippet,
        now,
      });

  await storeAttachments(env, mailbox.id, stored.messageId, parsed.attachments);

  if (existingThreadId === null) {
    ctx.waitUntil(
      labelNewThread(env, stored.threadId, stored.messageId).catch((error) => {
        console.error("Auto-label task failed", {
          threadId: stored.threadId,
          messageId: stored.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  }

  ctx.waitUntil(
    notifyNewEmail(env, {
      threadId: stored.threadId,
      senderName: parsed.from && "name" in parsed.from ? parsed.from.name : null,
      senderAddress: sender || "unknown",
      subject,
    }).catch((error) => console.error("Browser notification task failed", error)),
  );

  if (mailbox.agent_mode !== "off" && !isAutoSubmitted(parsed)) {
    await enqueueIfExternal(env, stored.threadId, stored.messageId, parsed);
  }
}

async function enqueueIfExternal(
  env: Env,
  threadId: number,
  inboundMessageId: number,
  parsed: Email,
): Promise<void> {
  const sender = addressOf(parsed.from);
  if (!sender) return;
  const fromOurAddress = await env.DB.prepare("SELECT id FROM mailboxes WHERE address = ?")
    .bind(sender)
    .first();
  if (!fromOurAddress) await enqueueDraftRun(env, threadId, inboundMessageId);
}

async function findMailbox(
  env: Env,
  address: string,
): Promise<{ id: number; agent_mode: string } | null> {
  return env.DB.prepare("SELECT id, agent_mode FROM mailboxes WHERE address = ?")
    .bind(address)
    .first<{ id: number; agent_mode: string }>();
}

async function resolveThread(
  env: Env,
  mailboxId: number,
  subject: string,
  referencesIds: string[],
  sender: string,
): Promise<number | null> {
  if (referencesIds.length > 0) {
    const placeholders = referencesIds.map(() => "?").join(", ");
    const byHeader = await env.DB.prepare(
      `SELECT msg.thread_id AS id FROM messages msg
       JOIN threads t ON t.id = msg.thread_id
       WHERE t.mailbox_id = ? AND msg.message_id IN (${placeholders})
       ORDER BY msg.created_at DESC LIMIT 1`,
    )
      .bind(mailboxId, ...referencesIds)
      .first<{ id: number }>();
    if (byHeader) return byHeader.id;
  }

  const normalized = normalizeSubject(subject);
  if (!normalized || !sender || !hasReplyPrefix(subject)) return null;
  const bySubjectAndSender = await env.DB.prepare(
    `SELECT t.id FROM threads t
     WHERE t.mailbox_id = ? AND t.normalized_subject = ?
       AND t.last_message_at > datetime('now', '-2 days')
       AND EXISTS (
         SELECT 1 FROM messages msg
         WHERE msg.thread_id = t.id AND msg.direction = 'inbound'
           AND lower(msg.from_address) = ?
       )
     ORDER BY t.last_message_at DESC LIMIT 1`,
  )
    .bind(mailboxId, normalized, sender)
    .first<{ id: number }>();
  return bySubjectAndSender?.id ?? null;
}

async function appendToConversation(
  env: Env,
  args: StoredMessageInput & { threadId: number; snippet: string },
): Promise<{ threadId: number; messageId: number }> {
  const results = await env.DB.batch([
    insertMessage(env, args.threadId, args),
    env.DB.prepare(
      `UPDATE threads
       SET snippet = ?, status = 'open', is_read = 0,
           message_count = message_count + 1, last_message_at = ?
       WHERE id = ?`,
    ).bind(args.snippet, args.now, args.threadId),
  ]);
  const messageId = Number(results[0].meta.last_row_id);
  if (!messageId) throw new Error("Inbound message was not stored");
  return { threadId: args.threadId, messageId };
}

async function storeNewConversation(
  env: Env,
  args: StoredMessageInput & { mailboxId: number; snippet: string },
): Promise<{ threadId: number; messageId: number }> {
  const thread = await env.DB.prepare(
    `INSERT INTO threads (mailbox_id, subject, normalized_subject, snippet, message_count, last_message_at)
     VALUES (?, ?, ?, ?, 1, ?) RETURNING id`,
  )
    .bind(args.mailboxId, args.subject, normalizeSubject(args.subject), args.snippet, args.now)
    .first<{ id: number }>();
  if (!thread) throw new Error("Conversation was not created");

  try {
    const result = await insertMessage(env, thread.id, args).run();
    const messageId = Number(result.meta.last_row_id);
    if (!messageId) throw new Error("Inbound message was not stored");
    return { threadId: thread.id, messageId };
  } catch (error) {
    await env.DB.prepare("DELETE FROM threads WHERE id = ? AND message_count = 1")
      .bind(thread.id)
      .run();
    throw error;
  }
}

interface StoredMessageInput {
  messageId: string;
  parsed: Email;
  subject: string;
  textBody: string;
  rawKey: string | null;
  now: string;
}

function insertMessage(env: Env, threadId: number, args: StoredMessageInput) {
  const { parsed } = args;
  const fromName = parsed.from && "name" in parsed.from ? parsed.from.name : null;
  return env.DB.prepare(
    `INSERT INTO messages
       (thread_id, message_id, in_reply_to, references_ids, direction, sent_by,
        from_address, from_name, to_addresses, cc_addresses, reply_to_addresses,
        subject, text_body, html_body, raw_key, is_auto_submitted, created_at)
     VALUES (?, ?, ?, ?, 'inbound', 'external', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    threadId,
    args.messageId,
    parsed.inReplyTo ?? null,
    JSON.stringify(extractMessageIds(parsed)),
    addressOf(parsed.from) || "unknown",
    fromName,
    JSON.stringify(addressesOf(parsed.to)),
    JSON.stringify(addressesOf(parsed.cc)),
    JSON.stringify(addressesOf(parsed.replyTo)),
    args.subject,
    args.textBody,
    parsed.html ?? null,
    args.rawKey,
    isAutoSubmitted(parsed) ? 1 : 0,
    args.now,
  );
}

async function storeAttachments(
  env: Env,
  mailboxId: number,
  messageId: number,
  attachments: Attachment[],
): Promise<void> {
  if (attachments.length === 0) return;
  // Without the RAW R2 binding attachments are not retained at all (their
  // metadata rows are skipped too, since r2_key is NOT NULL).
  if (!env.RAW) return;
  const statements: D1PreparedStatement[] = [];

  for (const [index, attachment] of attachments.entries()) {
    const bytes = attachmentBytes(attachment.content);
    const r2Key = `attachments/${mailboxId}/${messageId}/${index}-${crypto.randomUUID()}`;
    await env.RAW.put(r2Key, bytes, {
      httpMetadata: { contentType: attachment.mimeType || "application/octet-stream" },
    });
    statements.push(
      env.DB.prepare(
        `INSERT INTO attachments
           (message_id, filename, content_type, size, disposition, content_id, r2_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        messageId,
        attachment.filename,
        attachment.mimeType || "application/octet-stream",
        bytes.byteLength,
        attachment.disposition,
        attachment.contentId ?? null,
        r2Key,
      ),
    );
  }

  await env.DB.batch(statements);
}

function extractMessageIds(parsed: Email): string[] {
  const raw = `${parsed.inReplyTo ?? ""} ${parsed.references ?? ""}`;
  return [...new Set(raw.match(/<[^<>\s]+>/g) ?? [])];
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export { normalizeSubject } from "./rules";
