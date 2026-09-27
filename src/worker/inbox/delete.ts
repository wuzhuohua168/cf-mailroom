export interface InboxDeletionEnv {
  DB: D1Database;
  RAW?: R2Bucket;
}

export interface DeletedInbox {
  id: number;
  address: string;
  domainId: number | null;
}

export class InboxDeletionError extends Error {
  readonly status: 400 | 404 | 409;

  constructor(
    message: string,
    status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "InboxDeletionError";
    this.status = status;
  }
}

export async function deleteInbox(
  env: InboxDeletionEnv,
  input: { id: number; confirmAddress: string },
): Promise<DeletedInbox> {
  const inbox = await env.DB.prepare(
    "SELECT id, address, domain_id FROM mailboxes WHERE id = ?",
  )
    .bind(input.id)
    .first<{ id: number; address: string; domain_id: number | null }>();

  if (!inbox) throw new InboxDeletionError("Inbox not found", 404);
  if (input.confirmAddress.trim().toLowerCase() !== inbox.address.toLowerCase()) {
    throw new InboxDeletionError("Type the inbox address to confirm deletion", 400);
  }

  const activeSend = await env.DB.prepare(
    `SELECT 1 AS active
     FROM reply_attempts ra
     JOIN threads t ON t.id = ra.thread_id
     WHERE t.mailbox_id = ? AND ra.status IN ('pending', 'sending')
     UNION ALL
     SELECT 1 AS active
     FROM outbound_attempts oa
     WHERE (oa.mailbox_id = ? OR oa.thread_id IN (
       SELECT id FROM threads WHERE mailbox_id = ?
     )) AND oa.status IN ('pending', 'sending')
     LIMIT 1`,
  )
    .bind(inbox.id, inbox.id, inbox.id)
    .first<{ active: number }>();

  if (activeSend) {
    throw new InboxDeletionError(
      "Wait for the current email to finish sending, then try again",
      409,
    );
  }

  const threadIds = "SELECT id FROM threads WHERE mailbox_id = ?";
  const results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM reply_attempts WHERE thread_id IN (${threadIds})`,
    ).bind(inbox.id),
    env.DB.prepare(
      `DELETE FROM outbound_attempts
       WHERE mailbox_id = ? OR thread_id IN (${threadIds})`,
    ).bind(inbox.id, inbox.id),
    env.DB.prepare(
      `DELETE FROM draft_runs WHERE thread_id IN (${threadIds})`,
    ).bind(inbox.id),
    env.DB.prepare(
      `DELETE FROM drafts WHERE thread_id IN (${threadIds})`,
    ).bind(inbox.id),
    env.DB.prepare(
      `DELETE FROM thread_labels WHERE thread_id IN (${threadIds})`,
    ).bind(inbox.id),
    env.DB.prepare(
      `DELETE FROM messages WHERE thread_id IN (${threadIds})`,
    ).bind(inbox.id),
    env.DB.prepare("DELETE FROM threads WHERE mailbox_id = ?").bind(inbox.id),
    env.DB.prepare("DELETE FROM playbooks WHERE mailbox_id = ?").bind(inbox.id),
    env.DB.prepare("DELETE FROM labels WHERE mailbox_id = ?").bind(inbox.id),
    env.DB.prepare("DELETE FROM mailboxes WHERE id = ?").bind(inbox.id),
  ]);

  if (results.at(-1)?.meta.changes !== 1) {
    throw new InboxDeletionError("Inbox changed while it was being deleted", 409);
  }

  return { id: inbox.id, address: inbox.address, domainId: inbox.domain_id };
}

export async function purgeInboxObjects(bucket: R2Bucket | undefined, inboxId: number): Promise<void> {
  if (!bucket) return;
  await Promise.all([
    purgePrefix(bucket, `raw/${inboxId}/`),
    purgePrefix(bucket, `attachments/${inboxId}/`),
  ]);
}

async function purgePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;

  do {
    const page = await bucket.list({ prefix, cursor, limit: 1_000 });
    const keys = page.objects.map((object) => object.key);
    if (keys.length > 0) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
