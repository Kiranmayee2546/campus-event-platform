const express = require('express');
const pool = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

// List events with optional search/filter
router.get('/', async (req, res) => {
  try {
    const { search, category } = req.query;
    const conditions = [];
    const values = [];

    if (search) {
      values.push(`%${String(search).trim()}%`);
      conditions.push(`title ILIKE $${values.length}`);
    }
    if (category) {
      values.push(String(category).trim().toLowerCase());
      conditions.push(`LOWER(TRIM(category)) = $${values.length}`);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(
      `SELECT * FROM events ${where} ORDER BY event_date ASC`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Single event
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Event not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create (organizers only)
router.post('/', auth, requireRole('organizer', 'admin'), async (req, res) => {
  try {
    const { title, description, category, venue, event_date, capacity, poster_url } = req.body;
    if (!title || !event_date || !capacity) {
      return res.status(400).json({ error: 'title, event_date, capacity required' });
    }
    const result = await pool.query(
      `INSERT INTO events
       (title, description, category, venue, event_date, capacity, poster_url, organizer_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [title, description, category, venue, event_date, capacity, poster_url, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update (only the event's own organizer)
router.put('/:id', auth, requireRole('organizer', 'admin'), async (req, res) => {
  try {
    const { title, description, category, venue, event_date, capacity, poster_url } = req.body;
    const eventId = Number(req.params.id);
    const organizerId = Number(req.user.id);

    if (!Number.isInteger(eventId) || !Number.isInteger(organizerId)) {
      return res.status(400).json({ error: 'Invalid event or organizer id' });
    }
    if (!title || !event_date || capacity === undefined || capacity === null || capacity === '') {
      return res.status(400).json({ error: 'title, event_date, capacity required' });
    }

    const numericCapacity = Number(capacity);
    const parsedDate = new Date(event_date);
    if (!Number.isInteger(numericCapacity) || numericCapacity < 1) {
      return res.status(400).json({ error: 'capacity must be a positive whole number' });
    }
    if (Number.isNaN(parsedDate.getTime())) {
      return res.status(400).json({ error: 'event_date must be a valid date' });
    }

    const result = await pool.query(
      `UPDATE events SET title=$1, description=$2, category=$3, venue=$4,
       event_date=$5, capacity=$6, poster_url=$7
       WHERE id=$8 AND (organizer_id=$9 OR $10 = 'admin') RETURNING *`,
      [title, description ?? null, category ?? null, venue ?? null, event_date,
       numericCapacity, poster_url ?? null, eventId, organizerId, req.user.role]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found or not yours' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating event:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete (only the event's own organizer)
router.delete('/:id', auth, requireRole('organizer', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM events WHERE id=$1 AND (organizer_id=$2 OR $3 = 'admin') RETURNING id`,
      [req.params.id, req.user.id, req.user.role]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found or not yours' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;