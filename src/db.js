'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

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

module.exports = {
  pool,
  initDB,
  getInventoryDB,
  saveInventoryDB,
  saveSessionDB,
  loadSessionDB,
  loadAllSessionsDB,
  deleteSessionDB,
};
