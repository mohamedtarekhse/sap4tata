const router = require('express').Router();
const { query, withTransaction } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');

// ── GET /api/maintenance ─────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { search, status, type, asset_id, priority, rig_name } = req.query;
    const params = []; const conds = [];

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      const p = params.length;
      conds.push(`(LOWER(m.task) LIKE $${p} OR LOWER(m.asset_id) LIKE $${p} OR LOWER(a.name) LIKE $${p} OR LOWER(m.tech) LIKE $${p})`);
    }
    if (status)   { params.push(status);   conds.push(`m.status = $${params.length}`); }
    if (type)     { params.push(type);     conds.push(`m.type = $${params.length}`); }
    if (asset_id) { params.push(asset_id); conds.push(`m.asset_id = $${params.length}`); }
    if (priority) { params.push(priority); conds.push(`m.priority = $${params.length}`); }
    if (rig_name) { params.push(rig_name); conds.push(`a.rig_name = $${params.length}`); }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const { rows } = await query(
      `SELECT m.*, a.name AS asset_name, a.rig_name,
              (SELECT json_agg(ml ORDER BY ml.completion_date DESC)
               FROM maintenance_logs ml WHERE ml.maintenance_id = m.id) AS logs
       FROM maintenance_schedules m
       LEFT JOIN assets a ON a.asset_id = m.asset_id
       ${where}
       ORDER BY
         CASE
           WHEN m.next_due < NOW()::date THEN 0
           WHEN m.next_due <= NOW()::date + 14 THEN 1
           ELSE 2
         END,
         m.next_due ASC`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[GET /maintenance]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/maintenance/alerts ──────────────────────────────────
router.get('/alerts', authenticate, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT m.*, a.name AS asset_name, a.rig_name,
              (m.next_due - NOW()::date) AS days_until
       FROM maintenance_schedules m
       JOIN assets a ON a.asset_id = m.asset_id
       WHERE m.status NOT IN ('Completed','Cancelled')
         AND m.next_due <= NOW()::date + m.alert_days
       ORDER BY m.next_due ASC`,
      []
    );
    const overdue = rows.filter(r => parseInt(r.days_until) < 0);
    const dueSoon = rows.filter(r => parseInt(r.days_until) >= 0);
    res.json({ success: true, data: { overdue, dueSoon, total: rows.length } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/maintenance/:id ─────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT m.*, a.name AS asset_name, a.rig_name
       FROM maintenance_schedules m
       LEFT JOIN assets a ON a.asset_id = m.asset_id
       WHERE m.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Schedule not found' });

    const logs = await query(
      'SELECT * FROM maintenance_logs WHERE maintenance_id=$1 ORDER BY completion_date DESC',
      [req.params.id]
    );
    res.json({ success: true, data: { ...rows[0], logs: logs.rows } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/maintenance ────────────────────────────────────────
router.post('/', authenticate, requireRole('Admin', 'Asset Manager', 'Editor'), async (req, res) => {
  try {
    const {
      id, asset_id, task, type = 'Inspection', priority = 'Normal',
      freq = 30, last_done = null, next_due, tech, hours, cost,
      status = 'Scheduled', alert_days = 14, notes
    } = req.body;

    if (!id || !asset_id || !task || !next_due)
      return res.status(400).json({ success: false, message: 'id, asset_id, task, next_due required' });

    const { rows } = await query(
      `INSERT INTO maintenance_schedules
         (id, asset_id, task, type, priority, freq, last_done, next_due,
          tech, hours, cost, status, alert_days, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [id, asset_id, task, type, priority, freq, last_done, next_due,
       tech, hours || null, cost || null, status, alert_days, notes]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'Schedule ID exists' });
    console.error('[POST /maintenance]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/maintenance/:id ─────────────────────────────────────
router.put('/:id', authenticate, requireRole('Admin', 'Asset Manager', 'Editor'), async (req, res) => {
  try {
    const { asset_id, task, type, priority, freq, last_done, next_due, tech, hours, cost, status, alert_days, notes } = req.body;
    const { rows } = await query(
      `UPDATE maintenance_schedules SET
         asset_id=$1,task=$2,type=$3,priority=$4,freq=$5,last_done=$6,next_due=$7,
         tech=$8,hours=$9,cost=$10,status=$11,alert_days=$12,notes=$13,updated_at=NOW()
       WHERE id=$14 RETURNING *`,
      [asset_id, task, type, priority, freq, last_done || null, next_due, tech,
       hours || null, cost || null, status, alert_days, notes, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Schedule not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── DELETE /api/maintenance/:id ──────────────────────────────────
router.delete('/:id', authenticate, requireRole('Admin', 'Asset Manager', 'Editor'), async (req, res) => {
  try {
    // Check it exists first
    const check = await query('SELECT id FROM maintenance_schedules WHERE id=$1', [req.params.id]);
    if (!check.rows[0]) return res.status(404).json({ success: false, message: 'Schedule not found' });
    await query('DELETE FROM maintenance_logs WHERE maintenance_id=$1', [req.params.id]);
    await query('DELETE FROM maintenance_schedules WHERE id=$1', [req.params.id]);
    res.json({ success: true, message: 'Schedule deleted' });
  } catch (err) {
    console.error('[DELETE /maintenance/:id]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/maintenance/:id/complete – log a completion ────────
router.post('/:id/complete', authenticate, async (req, res) => {
  try {
    const { completion_date, completed_by, hours, cost, parts, notes, next_due } = req.body;
    if (!completion_date || !completed_by)
      return res.status(400).json({ success: false, message: 'completion_date and completed_by required' });

    const result = await withTransaction(async (client) => {
      const logRes = await client.query(
        `INSERT INTO maintenance_logs
           (maintenance_id, completion_date, completed_by, hours, cost, parts, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.params.id, completion_date, completed_by, hours || null, cost || null, parts, notes]
      );
      const schedRes = await client.query(
        `UPDATE maintenance_schedules SET
           last_done=$1, next_due=$2, status='Scheduled', updated_at=NOW()
         WHERE id=$3 RETURNING *`,
        [completion_date, next_due || null, req.params.id]
      );
      return { log: logRes.rows[0], schedule: schedRes.rows[0] };
    });

    res.status(201).json({ success: true, data: result });
  } catch (err) {
    console.error('[POST /maintenance/:id/complete]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/maintenance/:id/logs ───────────────────────────────
router.get('/:id/logs', authenticate, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM maintenance_logs WHERE maintenance_id=$1 ORDER BY completion_date DESC',
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
