require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const pool = require('./db');
const { evaluate } = require('./viability');

const app = express();
app.use(cors());
app.use(express.json());

// Optional protection for actions that change data. If ADMIN_TOKEN is set, the dashboard must send it.
const requireAdmin = (req, res, next) => {
  const token = process.env.ADMIN_TOKEN;
  if (token && req.get('x-admin-token') !== token) return res.status(401).json({ error: 'Admin token required' });
  next();
};

// One row per box: latest reading + totals since dispatch (or until delivery) + vaccine limits
const BOXES_SQL = `
SELECT b.id, b.name, b.destination, b.status, b.dispatched_at, b.delivered_at,
       p.name AS vaccine, p.min_temp_c, p.max_temp_c, p.critical_min_c, p.critical_max_c,
       p.max_excursion_s, p.max_humidity_pct, p.max_vib_g, p.max_shock_events, p.max_lid_open_s, p.max_tilt_deg,
       l.recorded_at AS last_seen, l.temp_c, l.hum_pct, l.vib_g, l.moving, l.lid_open,
       l.lat, l.lng, l.speed_kmph, l.heading_deg, l.distance_cm, l.tilt_deg,
       a.n, a.min_temp, a.max_temp, a.max_hum, a.excursion_s, a.shock_events, a.tilt_events, a.lid_open_s
FROM boxes b
JOIN vaccine_profiles p ON p.id = b.profile_id
LEFT JOIN LATERAL (
  SELECT * FROM readings r WHERE r.box_id = b.id ORDER BY r.recorded_at DESC LIMIT 1) l ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*)::int AS n, MIN(r.temp_c) AS min_temp, MAX(r.temp_c) AS max_temp, MAX(r.hum_pct) AS max_hum,
         COALESCE(SUM(r.interval_s) FILTER (WHERE r.temp_c < p.min_temp_c OR r.temp_c > p.max_temp_c), 0)::int AS excursion_s,
         (COUNT(*) FILTER (WHERE r.vib_g > p.max_vib_g))::int AS shock_events,
         (COUNT(*) FILTER (WHERE r.tilt_deg > p.max_tilt_deg))::int AS tilt_events,
         COALESCE(SUM(r.interval_s) FILTER (WHERE r.lid_open), 0)::int AS lid_open_s
  FROM readings r
  WHERE r.box_id = b.id AND r.recorded_at >= b.dispatched_at
    AND r.recorded_at <= COALESCE(b.delivered_at, now())) a ON true
ORDER BY b.id`;

app.get('/health', (_req, res) => res.send('ok'));

app.get('/api/boxes', async (_req, res) => {
  try {
    const { rows } = await pool.query(BOXES_SQL);
    res.json(rows.map((r) => ({ ...r, ...evaluate(r) })));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});

app.get('/api/boxes/:id/readings', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 60, 500);
  try {
    const { rows } = await pool.query(
      `SELECT recorded_at, temp_c FROM (
         SELECT recorded_at, temp_c FROM readings WHERE box_id = $1 ORDER BY recorded_at DESC LIMIT $2
       ) t ORDER BY recorded_at`, [req.params.id, limit]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});

app.post('/api/boxes/:id/deliver', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      "UPDATE boxes SET status='delivered', delivered_at=now() WHERE id=$1 AND status='in_transit'", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});

// ---------- History of one box ----------
const SUMMARY_SQL = `
WITH r AS (
  SELECT x.*, LAG(x.lid_open) OVER (ORDER BY x.recorded_at) AS prev_lid
  FROM readings x WHERE x.box_id = $1 AND x.recorded_at >= $2)
SELECT COUNT(r.recorded_at)::int AS n,
       MIN(r.temp_c) AS min_temp, MAX(r.temp_c) AS max_temp, AVG(r.temp_c) AS avg_temp,
       MIN(r.hum_pct) AS min_hum, MAX(r.hum_pct) AS max_hum,
       MAX(r.vib_g) AS max_vib, MAX(r.tilt_deg) AS max_tilt,
       COALESCE(SUM(r.interval_s) FILTER (WHERE r.temp_c < p.min_temp_c OR r.temp_c > p.max_temp_c), 0)::int AS out_of_range_s,
       COALESCE(SUM(r.interval_s) FILTER (WHERE r.lid_open), 0)::int AS lid_open_s,
       (COUNT(*) FILTER (WHERE r.lid_open AND NOT COALESCE(r.prev_lid, false)))::int AS lid_openings,
       (COUNT(*) FILTER (WHERE r.vib_g > p.max_vib_g))::int AS shocks,
       (COUNT(*) FILTER (WHERE r.tilt_deg > p.max_tilt_deg))::int AS tipped,
       MIN(r.recorded_at) AS first_at, MAX(r.recorded_at) AS last_at,
       b.id, b.name, b.status, b.dispatched_at, b.delivered_at,
       p.name AS vaccine, p.min_temp_c, p.max_temp_c, p.max_excursion_s, p.max_humidity_pct,
       p.max_vib_g, p.max_tilt_deg, p.max_lid_open_s
FROM boxes b
JOIN vaccine_profiles p ON p.id = b.profile_id
LEFT JOIN r ON true
WHERE b.id = $1
GROUP BY b.id, p.id`;

// At most $3 rows: long ranges are thinned evenly, and the newest reading is always kept
const READINGS_SQL = `
SELECT recorded_at, temp_c, hum_pct, vib_g, tilt_deg, moving, lid_open, speed_kmph, lat, lng
FROM (
  SELECT x.*, ROW_NUMBER() OVER (ORDER BY x.recorded_at) AS rn, COUNT(*) OVER () AS total
  FROM readings x WHERE x.box_id = $1 AND x.recorded_at >= $2
) t
WHERE t.rn % GREATEST(1, CEIL(t.total::numeric / $3::int)::int) = 0 OR t.rn = t.total
ORDER BY recorded_at`;

app.get('/api/boxes/:id/history', async (req, res) => {
  const hours = Math.max(0, Number(req.query.hours) || 0);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 400, 10), 5000);
  const since = hours > 0 ? new Date(Date.now() - hours * 3600e3) : new Date(0);
  try {
    const sum = await pool.query(SUMMARY_SQL, [req.params.id, since]);
    if (!sum.rows.length) return res.status(404).json({ error: 'Box not found' });
    const rows = await pool.query(READINGS_SQL, [req.params.id, since, limit]);
    res.json({ box: sum.rows[0], readings: rows.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});

// ---------- Delete data ----------
// Remove one box and every reading it has sent. (If the device keeps sending, the box comes back on its next message.)
app.delete('/api/boxes/:id', requireAdmin, async (req, res) => {
  try {
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM readings WHERE box_id = $1', [req.params.id]);
    const del = await pool.query('DELETE FROM boxes WHERE id = $1', [req.params.id]);
    res.json({ deletedBoxes: del.rowCount, deletedReadings: count.rows[0].n });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});

// Remove a box's readings but keep the box, and start its shipment again from now
app.delete('/api/boxes/:id/readings', requireAdmin, async (req, res) => {
  try {
    const del = await pool.query('DELETE FROM readings WHERE box_id = $1', [req.params.id]);
    await pool.query(
      "UPDATE boxes SET status='in_transit', dispatched_at=now(), delivered_at=NULL WHERE id=$1", [req.params.id]);
    res.json({ deletedReadings: del.rowCount });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});

// Start a new shipment with the same box: the usable check counts from now, old readings stay in the history
app.post('/api/boxes/:id/restart', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      "UPDATE boxes SET status='in_transit', dispatched_at=now(), delivered_at=NULL WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});

// Serve the built React dashboard if present (not needed when nginx serves the frontend)
const dist = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(process.env.PORT || 3000, () => console.log('API listening on', process.env.PORT || 3000));
