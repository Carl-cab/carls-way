import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser, auditLog } from '@/lib/auth';
import { getSql } from '@/lib/db';
import { createNotification } from '@/lib/notifications';

/**
 * Contacts.
 *
 * This is a view over the existing `friends` graph rather than a second table.
 * Manna already models a bidirectional social relationship with an approval
 * flow; introducing a parallel `contacts` table would have created two sources
 * of truth for "who can I pay", which is exactly the kind of split-brain that
 * causes payments to be sent to the wrong person.
 *
 * GET  /api/contacts?search=  — accepted contacts, optionally filtered
 * POST /api/contacts          — add by username, email, or phone
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const sql = getSql();
    const search = req.nextUrl.searchParams.get('search')?.trim() ?? '';
    const pattern = `%${search}%`;

    // The relationship is stored once; either side may be the initiator, so
    // both directions are unioned into a single contact list.
    const contacts = search
      ? await sql`
          SELECT u.id, u.username, u.name, u.avatar_color, u.country,
                 f.status, f.created_at
          FROM friends f
          JOIN users u ON u.id = CASE WHEN f.user_id = ${user.userId} THEN f.friend_id ELSE f.user_id END
          WHERE (f.user_id = ${user.userId} OR f.friend_id = ${user.userId})
            AND f.status = 'accepted'
            AND (u.username ILIKE ${pattern} OR u.name ILIKE ${pattern})
          ORDER BY u.name
          LIMIT 100
        `
      : await sql`
          SELECT u.id, u.username, u.name, u.avatar_color, u.country,
                 f.status, f.created_at
          FROM friends f
          JOIN users u ON u.id = CASE WHEN f.user_id = ${user.userId} THEN f.friend_id ELSE f.user_id END
          WHERE (f.user_id = ${user.userId} OR f.friend_id = ${user.userId})
            AND f.status = 'accepted'
          ORDER BY u.name
          LIMIT 100
        `;

    return NextResponse.json(contacts);
  } catch (err) {
    console.error('Contacts GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/contacts — add a contact by username, email, or phone.
 *
 * The lookup is exact-match on purpose. A fuzzy search here would let a caller
 * enumerate accounts by probing partial identifiers, and would risk adding the
 * wrong person to a list used to send money.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const identifier = String(body.identifier ?? '').trim().replace(/^@/, '');
    if (!identifier) {
      return NextResponse.json(
        { error: 'Provide a username, email, or phone number' },
        { status: 400 },
      );
    }

    const sql = getSql();
    const found = await sql`
      SELECT id, username, name, avatar_color FROM users
      WHERE username = ${identifier}
         OR email = ${identifier.toLowerCase()}
         OR phone = ${identifier}
      LIMIT 1
    `;

    if (!found[0]) {
      // Deliberately does not distinguish "no such user" from "not invitable",
      // so this endpoint cannot be used to test whether an email is registered.
      return NextResponse.json(
        { error: 'No Manna account matches that identifier', invitable: true },
        { status: 404 },
      );
    }

    const contactId = found[0].id as number;
    if (contactId === user.userId) {
      return NextResponse.json({ error: 'You cannot add yourself' }, { status: 400 });
    }

    const existing = await sql`
      SELECT id, status FROM friends
      WHERE (user_id = ${user.userId} AND friend_id = ${contactId})
         OR (user_id = ${contactId} AND friend_id = ${user.userId})
      LIMIT 1
    `;
    if (existing[0]) {
      return NextResponse.json(
        { success: true, alreadyExists: true, status: existing[0].status },
      );
    }

    const inserted = await sql`
      INSERT INTO friends (user_id, friend_id, status, requested_by)
      VALUES (${user.userId}, ${contactId}, 'pending', ${user.userId})
      ON CONFLICT (user_id, friend_id) DO NOTHING
      RETURNING id, status
    `;

    await auditLog(user.userId, 'contact_added', { contact_user_id: contactId });

    await createNotification({
      userId: contactId,
      type: 'contact_request',
      title: 'New contact request',
      message: `@${user.username} wants to connect with you on Manna.`,
      relatedEntityType: 'contact',
      relatedEntityId: user.userId,
    });

    return NextResponse.json(
      {
        success: true,
        contact: { id: contactId, username: found[0].username, name: found[0].name },
        status: inserted[0]?.status ?? 'pending',
      },
      { status: 201 },
    );
  } catch (err) {
    console.error('Contacts POST error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
