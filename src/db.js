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
  console.log('✅ Database ready');
}

/**
 * ดึง inventory จาก DB (ถ้าไม่มีสร้างใหม่)
 */
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

/**
 * บันทึก inventory ลง DB
 */
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

module.exports = { pool, initDB, getInventoryDB, saveInventoryDB };
