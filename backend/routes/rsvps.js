const express = require('express');
const pool = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Create an RSVP while locking the event row so concurrent requests see a consistent count.
router.post('/:eventId', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const eventResult = await client.query(
      'SELECT id, capacity FROM events WHERE id = $1 FOR UPDATE',
      [req.params.eventId]
    );
    const event = eventResult.rows[0];
    if (!event) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }

    const existing = await client.query(
      'SELECT id, status, token FROM rsvps WHERE user_id = $1 AND event_id = $2',
      [req.user.id, event.id]
    );
    if (existing.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You already have an RSVP for this event' });
    }

    const countResult = await client.query(
      "SELECT COUNT(*)::int AS count FROM rsvps WHERE event_id = $1 AND status = 'confirmed'",
      [event.id]
    );
    const status = countResult.rows[0].count < event.capacity ? 'confirmed' : 'waitlisted';
    const result = await client.query(
      'INSERT INTO rsvps (user_id, event_id, status) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, event.id, status]
    );

    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Cancel an RSVP and promote the oldest waitlisted attendee when a confirmed spot opens.
router.delete('/:eventId', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cancelled = await client.query(
      "DELETE FROM rsvps WHERE user_id = $1 AND event_id = $2 AND status <> 'checked_in' RETURNING id, status",
      [req.user.id, req.params.eventId]
    );
    if (!cancelled.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'RSVP not found or already checked in' });
    }

    if (cancelled.rows[0].status === 'confirmed') {
      await client.query(
        `UPDATE rsvps SET status = 'confirmed'
         WHERE id = (
           SELECT id FROM rsvps
           WHERE event_id = $1 AND status = 'waitlisted'
           ORDER BY created_at ASC, id ASC
           LIMIT 1
         )`,
        [req.params.eventId]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'RSVP cancelled' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Return the signed-in student's RSVPs with the related event details.
router.get('/my', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.status, r.token, r.created_at, e.*
       FROM rsvps r JOIN events e ON e.id = r.event_id
       WHERE r.user_id = $1 ORDER BY e.event_date ASC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Organizers can inspect attendees only for events they own.
router.get('/event/:eventId', auth, requireRole('organizer', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.status, r.token, r.created_at, u.id AS user_id, u.name, u.email
       FROM rsvps r JOIN users u ON u.id = r.user_id
       JOIN events e ON e.id = r.event_id
       WHERE r.event_id = $1 AND (e.organizer_id = $2 OR $3 = 'admin')
       ORDER BY r.created_at ASC`,
      [req.params.eventId, req.user.id, req.user.role]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark a token as checked in after confirming the organizer owns its event.
router.put('/checkin/:token', auth, requireRole('organizer', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE rsvps r SET status = 'checked_in'
       FROM events e
       WHERE r.token = $1 AND r.event_id = e.id
         AND (e.organizer_id = $2 OR $3 = 'admin')
       RETURNING r.id, r.status, r.token`,
      [req.params.token, req.user.id, req.user.role]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'RSVP not found or not yours' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;