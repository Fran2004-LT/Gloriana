'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // ส่ง keep-alive กันการเชื่อมต่อที่เปิดค้างถูก proxy ตัดเงียบๆ
  keepAlive: true,
  // ปิดการเชื่อมต่อที่ว่างเกิน 30 วิ ก่อนที่ปลายทางจะตัดเอง
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// การเชื่อมต่อที่ว่างอยู่แล้วถูกตัด → แค่ log ไว้ (pool จะทิ้งตัวนั้นแล้วเปิดใหม่ให้เอง)
pool.on('error', err => console.error('⚠️ [pg pool] idle client error:', err.message));

// error ที่เกิดจากการเชื่อมต่อหลุดชั่วคราว — ลองใหม่ได้อย่างปลอดภัย
const TRANSIENT = /ECONNRESET|ETIMEDOUT|EPIPE|Connection terminated|terminating connection/i;

// แทน pool.query เดิม: ถ้าการเชื่อมต่อหลุด ลองใหม่อีกสูงสุด 2 ครั้งด้วยการเชื่อมต่อใหม่
const rawQuery = pool.query.bind(pool);
pool.query = async (...args) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rawQuery(...args);
    } catch (err) {
      if (attempt >= 3 || !TRANSIENT.test(`${err.code} ${err.message}`)) throw err;
      console.warn(`⚠️ [pg] ${err.code || err.message} — retry ${attempt}/2`);
      await new Promise(r => setTimeout(r, 200 * attempt));
    }
  }
};

/**
 * สร้าง tables ถ้ายังไม่มี
 */
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      user_id       TEXT PRIMARY KEY,
      gold          BIGINT    DEFAULT 0,
      rc            BIGINT    DEFAULT 0,
      reroll_main   INTEGER   DEFAULT 1,
      reroll_oneuse INTEGER   DEFAULT 0,
      reroll_trainer INTEGER  DEFAULT 0,
      race_safe     INTEGER   DEFAULT 0,
      hill_clear    BOOLEAN   DEFAULT FALSE,
      zone_unlocked BOOLEAN   DEFAULT FALSE,
      streak_current INTEGER  DEFAULT 0,
      streak_last   TEXT      DEFAULT NULL,
      roles         TEXT[]    DEFAULT '{}',
      g1_wins       INTEGER   DEFAULT 0,
      g2_wins       INTEGER   DEFAULT 0,
      g3_wins       INTEGER   DEFAULT 0,
      races         INTEGER   DEFAULT 0,
      updated_at    TIMESTAMP DEFAULT NOW()
    )
  `);

  // ตารางเก็บ race session เพื่อให้ข้อมูลไม่หายเมื่อ process restart
  await pool.query(`
    CREATE TABLE IF NOT EXISTS race_sessions (
      guild_id    TEXT PRIMARY KEY,
      channel_id  TEXT NOT NULL,
      track       TEXT NOT NULL,
      grade       TEXT NOT NULL,
      distance    INTEGER NOT NULL,
      data        JSONB NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_at  TIMESTAMP DEFAULT NOW()
    )
  `);

  // ข้อมูลตัวละคร: 1 Discord user = 1 สาวม้า, trainer_id = Discord user ของเทรนเนอร์
  await pool.query(`
    CREATE TABLE IF NOT EXISTS characters (
      user_id    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      trainer_id TEXT DEFAULT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ความสัมพันธ์ตามลอร์ (เก็บคู่แบบเรียง user_a < user_b เพื่อไม่ให้ซ้ำ)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS relationships (
      user_a TEXT NOT NULL,
      user_b TEXT NOT NULL,
      type   TEXT NOT NULL,
      PRIMARY KEY (user_a, user_b, type)
    )
  `);

  // บทฝึก — เก็บใน DB แล้ว รหัส TRN ไม่รีเซ็ตตอน restart
  await pool.query(`
    CREATE TABLE IF NOT EXISTS train_submissions (
      id            SERIAL PRIMARY KEY,
      status        TEXT NOT NULL DEFAULT 'pending',
      type          TEXT NOT NULL,
      uma_id        TEXT NOT NULL,
      partner_id    TEXT DEFAULT NULL,
      trainer_id    TEXT DEFAULT NULL,
      location      TEXT,
      link          TEXT,
      submitted_by  TEXT,
      reject_reason TEXT,
      submitted_at  TIMESTAMP DEFAULT NOW()
    )
  `);

  console.log('✅ Database ready');
}

// =================== Inventory ===================

async function getInventoryDB(userId) {
  const res = await pool.query(
    'SELECT * FROM inventory WHERE user_id = $1',
    [userId]
  );
  if (res.rows.length === 0) {
    await pool.query(
      'INSERT INTO inventory (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [userId]
    );
    return buildDefault(userId);
  }
  return rowToInventory(res.rows[0]);
}

async function saveInventoryDB(userId, inv) {
  await pool.query(`
    INSERT INTO inventory (
      user_id, gold, rc,
      reroll_main, reroll_oneuse, reroll_trainer,
      race_safe, hill_clear, zone_unlocked,
      streak_current, streak_last, roles,
      g1_wins, g2_wins, g3_wins, races,
      updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      gold           = $2,  rc             = $3,
      reroll_main    = $4,  reroll_oneuse  = $5,  reroll_trainer = $6,
      race_safe      = $7,  hill_clear     = $8,  zone_unlocked  = $9,
      streak_current = $10, streak_last    = $11, roles          = $12,
      g1_wins        = $13, g2_wins        = $14, g3_wins        = $15,
      races          = $16, updated_at     = NOW()
  `, [
    userId,
    inv.gold, inv.rc,
    inv.reroll.main, inv.reroll.oneUse, inv.reroll.trainer,
    inv.raceSafe, inv.hillClearItem, inv.zoneUnlocked,
    inv.streak.current, inv.streak.lastClaim,
    inv.roles,
    inv.stats.g1Wins, inv.stats.g2Wins, inv.stats.g3Wins, inv.stats.races,
  ]);
}

// =================== Race Session ===================

/**
 * บันทึก session ลง DB
 * data = object ทั้งหมด (players Map จะถูก serialize เป็น array)
 */
async function saveSessionDB(guildId, sessionData) {
  // Map serialize ไม่ได้ตรงๆ ต้องแปลงก่อน
  const serialized = serializeSession(sessionData);
  await pool.query(`
    INSERT INTO race_sessions (guild_id, channel_id, track, grade, distance, data, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (guild_id) DO UPDATE SET
      channel_id = $2,
      track      = $3,
      grade      = $4,
      distance   = $5,
      data       = $6,
      updated_at = NOW()
  `, [
    guildId,
    sessionData.channelId,
    sessionData.track,
    sessionData.grade,
    sessionData.distance,
    JSON.stringify(serialized),
  ]);
}

/**
 * โหลด session จาก DB (คืนค่า null ถ้าไม่มี)
 */
async function loadSessionDB(guildId) {
  const res = await pool.query(
    'SELECT data FROM race_sessions WHERE guild_id = $1',
    [guildId]
  );
  if (res.rows.length === 0) return null;
  return deserializeSession(res.rows[0].data);
}

/**
 * โหลด active sessions ทั้งหมด (ใช้ตอน bot start)
 */
async function loadAllSessionsDB() {
  const res = await pool.query('SELECT guild_id, data FROM race_sessions');
  const out = {};
  for (const row of res.rows) {
    out[row.guild_id] = deserializeSession(row.data);
  }
  return out;
}

/**
 * ลบ session จาก DB
 */
async function deleteSessionDB(guildId) {
  await pool.query('DELETE FROM race_sessions WHERE guild_id = $1', [guildId]);
}

// =================== Serialization helpers ===================

/**
 * แปลง session object (มี Map) → plain object สำหรับ JSON
 */
function serializeSession(session) {
  return {
    ...session,
    players: [...session.players.entries()].map(([id, p]) => ({ id, ...p })),
    turnSnapshot: [...session.turnSnapshot.entries()].map(([id, score]) => ({ id, score })),
  };
}

/**
 * แปลง plain object จาก DB → session object (คืน Map กลับมา)
 */
function deserializeSession(data) {
  const session = typeof data === 'string' ? JSON.parse(data) : data;
  const players = new Map();
  for (const p of (session.players || [])) {
    const { id, ...rest } = p;
    players.set(id, rest);
  }
  const turnSnapshot = new Map();
  for (const s of (session.turnSnapshot || [])) {
    turnSnapshot.set(s.id, s.score);
  }
  return { ...session, players, turnSnapshot };
}

// =================== Row mappers ===================

function rowToInventory(row) {
  return {
    gold: Number(row.gold),
    rc:   Number(row.rc),
    reroll: {
      main:    row.reroll_main,
      oneUse:  row.reroll_oneuse,
      trainer: row.reroll_trainer,
    },
    raceSafe:      row.race_safe,
    hillClearItem: row.hill_clear,
    zoneUnlocked:  row.zone_unlocked,
    streak: {
      current:   row.streak_current,
      lastClaim: row.streak_last,
    },
    roles: row.roles || [],
    stats: {
      g1Wins: row.g1_wins,
      g2Wins: row.g2_wins,
      g3Wins: row.g3_wins,
      races:  row.races,
    },
  };
}

function buildDefault(userId) {
  return {
    gold: 0, rc: 0,
    reroll: { main: 1, oneUse: 0, trainer: 0 },
    raceSafe: 0, hillClearItem: false, zoneUnlocked: false,
    streak: { current: 0, lastClaim: null },
    roles: [],
    stats: { g1Wins: 0, g2Wins: 0, g3Wins: 0, races: 0 },
  };
}

// =================== Characters & Relationships ===================

async function getCharacterDB(userId) {
  const res = await pool.query('SELECT * FROM characters WHERE user_id = $1', [userId]);
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return { userId: r.user_id, name: r.name, trainerId: r.trainer_id };
}

async function setCharacterDB(userId, name, trainerId) {
  await pool.query(`
    INSERT INTO characters (user_id, name, trainer_id, updated_at) VALUES ($1, $2, $3, NOW())
    ON CONFLICT (user_id) DO UPDATE SET name = $2, trainer_id = $3, updated_at = NOW()
  `, [userId, name, trainerId]);
}

async function deleteCharacterDB(userId) {
  await pool.query('DELETE FROM characters WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM relationships WHERE user_a = $1 OR user_b = $1', [userId]);
}

async function getTeamDB(trainerId) {
  const res = await pool.query('SELECT user_id, name FROM characters WHERE trainer_id = $1 ORDER BY name', [trainerId]);
  return res.rows.map(r => ({ userId: r.user_id, name: r.name }));
}

function orderPair(a, b) { return a < b ? [a, b] : [b, a]; }

async function addRelationshipDB(a, b, type) {
  const [x, y] = orderPair(a, b);
  const res = await pool.query(
    'INSERT INTO relationships (user_a, user_b, type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [x, y, type]
  );
  return res.rowCount > 0;
}

async function removeRelationshipDB(a, b, type) {
  const [x, y] = orderPair(a, b);
  const res = await pool.query(
    'DELETE FROM relationships WHERE user_a = $1 AND user_b = $2 AND type = $3', [x, y, type]
  );
  return res.rowCount > 0;
}

async function getRelationshipsBetweenDB(a, b) {
  const [x, y] = orderPair(a, b);
  const res = await pool.query('SELECT type FROM relationships WHERE user_a = $1 AND user_b = $2', [x, y]);
  return res.rows.map(r => r.type);
}

async function listRelationshipsDB(userId) {
  const res = await pool.query(
    'SELECT user_a, user_b, type FROM relationships WHERE user_a = $1 OR user_b = $1 ORDER BY type',
    [userId]
  );
  return res.rows.map(r => ({ otherId: r.user_a === userId ? r.user_b : r.user_a, type: r.type }));
}

// =================== Train submissions ===================

function rowToSubmission(r) {
  return {
    id: `TRN-${String(r.id).padStart(4, '0')}`,
    status: r.status, type: r.type,
    umaId: r.uma_id, partnerId: r.partner_id, trainerId: r.trainer_id,
    location: r.location, link: r.link, submittedBy: r.submitted_by,
    rejectReason: r.reject_reason, submittedAt: r.submitted_at,
  };
}

function parseSubmissionId(id) {
  const n = parseInt(String(id).replace(/^TRN-?/i, ''), 10);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`รหัสไม่ถูกต้อง: ${id}`);
  return n;
}

async function createSubmissionDB(d) {
  const res = await pool.query(`
    INSERT INTO train_submissions (type, uma_id, partner_id, trainer_id, location, link, submitted_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
  `, [d.type, d.umaId, d.partnerId || null, d.trainerId || null, d.location, d.link, d.submittedBy]);
  return rowToSubmission(res.rows[0]);
}

/** เปลี่ยนสถานะจาก pending เท่านั้น (atomic — กันกด approve ซ้ำ) */
async function settleSubmissionDB(id, status, reason = null) {
  const n   = parseSubmissionId(id);
  const res = await pool.query(`
    UPDATE train_submissions SET status = $2, reject_reason = $3
    WHERE id = $1 AND status = 'pending' RETURNING *
  `, [n, status, reason]);
  if (res.rows.length) return rowToSubmission(res.rows[0]);
  const exists = await pool.query('SELECT status FROM train_submissions WHERE id = $1', [n]);
  if (!exists.rows.length) throw new Error(`ไม่พบบทฝึก ${id}`);
  throw new Error(`บทฝึก ${id} ถูกจัดการไปแล้ว (${exists.rows[0].status})`);
}

async function listPendingSubmissionsDB() {
  const res = await pool.query("SELECT * FROM train_submissions WHERE status = 'pending' ORDER BY id");
  return res.rows.map(rowToSubmission);
}

module.exports = {
  pool,
  getCharacterDB, setCharacterDB, deleteCharacterDB, getTeamDB,
  addRelationshipDB, removeRelationshipDB, getRelationshipsBetweenDB, listRelationshipsDB,
  createSubmissionDB, settleSubmissionDB, listPendingSubmissionsDB,
  initDB,
  getInventoryDB,
  saveInventoryDB,
  saveSessionDB,
  loadSessionDB,
  loadAllSessionsDB,
  deleteSessionDB,
};
