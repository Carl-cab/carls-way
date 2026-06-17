import { getSql } from '@/lib/db';

export async function createNotification({
  userId,
  type,
  title,
  message,
  relatedEntityType,
  relatedEntityId,
}: {
  userId: number;
  type: string;
  title: string;
  message: string;
  relatedEntityType?: string;
  relatedEntityId?: number;
}): Promise<void> {
  try {
    const sql = getSql();
    await sql`
      INSERT INTO notifications (user_id, type, title, message, related_entity_type, related_entity_id)
      VALUES (
        ${userId}, ${type}, ${title}, ${message},
        ${relatedEntityType ?? null}, ${relatedEntityId ?? null}
      )
    `;
  } catch {
    // Non-blocking — notification failure must never break the triggering action
  }
}
