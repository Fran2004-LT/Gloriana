'use strict';

const { saveSessionDB, loadAllSessionsDB, deleteSessionDB } = require('../db');

/**
 * Phase structure ตามระยะสนาม
 * Sprint    (8T)  → [2,2,2,2]
 * Mile/Med  (12T) → [3,3,3,3]
 * Long      (14T) → [2,4,4,4]
 */
function getPhaseStructure(distance) {
  if (distance === 8)  return [2, 2, 2, 2];
  if (distance === 14) return [2, 4, 4, 4];
  return [3, 3, 3, 3]; // default 12
}

/**
 * คำนวณว่า totalTurn อยู่ phase/turn ไหน
 */
function calcPhaseAndTurn(totalTurn, structure) {
  let remaining = totalTurn;
  for (let p = 0; p < structure.length; p++) {
    if (remaining <= structure[p]) {
      return { phase: p + 1, turn: remaining };
    }
    remaining -= structure[p];
  }
  const lastPhase = structure.length;
  return { phase: lastPhase, turn: structure[lastPhase - 1] };
}

// in-memory store (loaded from DB on startup)
const sessions  = new Map();
const lastRolls = new Map();

// =================== Persistence helpers ===================

/**
 * บันทึก session ลง DB — เรียกหลังทุก mutation
 */
async function persistSession(guildId) {
  const session = sessions.get(guildId);
  if (!session) return;
  try {
    await saveSessionDB(guildId, session);
  } catch (err) {
    console.error(`[raceSession] persistSession failed for ${guildId}:`, err);
  }
}

/**
 * โหลด sessions ทั้งหมดจาก DB กลับมาใส่ memory
 * เรียกครั้งเดียวตอน bot start (จาก initDB flow)
 */
async function restoreSessionsFromDB() {
  try {
    const all = await loadAllSessionsDB();
    let count = 0;
    for (const [guildId, session] of Object.entries(all)) {
      sessions.set(guildId, session);
      count++;
    }
    if (count > 0) console.log(`✅ [raceSession] Restored ${count} active session(s) from DB`);
  } catch (err) {
    console.error('[raceSession] restoreSessionsFromDB failed:', err);
  }
}

// =================== Session operations ===================

async function openSession(guildId, channelId, track = 'ไม่ระบุ', grade = 'G3', distance = 12) {
  if (sessions.has(guildId)) throw new Error('มี session การแข่งที่เปิดอยู่แล้ว');

  const structure = getPhaseStructure(distance);
  const { phase, turn } = calcPhaseAndTurn(1, structure);

  sessions.set(guildId, {
    guildId, channelId, track, grade, distance,
    structure,
    status:      'racing',
    phase, turn, totalTurn: 1,
    isFirstTurn: true,
    players:      new Map(),
    turnSnapshot: new Map(),
  });

  await persistSession(guildId);
  return sessions.get(guildId);
}

function registerPlayer(guildId, userId, displayName, position, options = {}) {
  const session = getSession(guildId);
  if (session.status === 'finished') throw new Error('การแข่งจบไปแล้ว');
  const VALID = ['Front', 'Pace', 'Late', 'End'];
  if (!VALID.includes(position)) throw new Error(`สายไม่ถูกต้อง ต้องเป็น: ${VALID.join(', ')}`);
  if (session.players.has(userId)) throw new Error('คุณลงทะเบียนไปแล้ว');

  session.players.set(userId, {
    userId, displayName, position,
    score: 0,
    reroll: { main: 1, oneUse: 0 },
    allOutCount: 0,
    rolled: false,
    hillCleared:  options.hillCleared  || false,
    zoneEnabled:  options.zoneEnabled  || false,
  });
  session.turnSnapshot.set(userId, 0);

  // persist async (ไม่ await เพื่อไม่ block — caller จัดการ await เองถ้าต้องการ)
  persistSession(guildId).catch(err => console.error('[registerPlayer] persist failed:', err));

  return session.players.get(userId);
}

function adjustScore(guildId, userId, amount) {
  const session = getSession(guildId);
  if (session.status !== 'racing') throw new Error('การแข่งยังไม่เริ่ม');
  const player = session.players.get(userId);
  if (!player) throw new Error('คุณไม่ได้อยู่ใน session นี้');
  if (amount < 1 || amount > 10) throw new Error('ลดได้ไม่เกิน 10 แต้มต่อครั้ง');
  if (player.score - amount < 0) throw new Error('คะแนนจะติดลบ ลดไม่ได้');
  player.score -= amount;
  session.turnSnapshot.set(userId, player.score);

  persistSession(guildId).catch(err => console.error('[adjustScore] persist failed:', err));
  return player;
}

/**
 * บันทึกคะแนน
 * replace = true  → แทนที่ (reroll/safe) โดยใช้ turnSnapshot เป็น base
 * replace = false → บวกเพิ่ม (ทอยปกติ)
 * isReroll = true → อนุญาตแม้ rolled แล้ว
 */
function submitScore(guildId, userId, rollResult, replace = false, isReroll = false) {
  const session = getSession(guildId);
  if (session.status !== 'racing') throw new Error('การแข่งยังไม่เริ่ม');
  const player = session.players.get(userId);
  if (!player) throw new Error('คุณไม่ได้อยู่ใน session นี้');

  if (player.rolled && !isReroll) {
    throw new Error('คุณทอยไปแล้วในเทิร์นนี้');
  }

  if (replace) {
    // ใช้ snapshot ต้นเทิร์นเป็น base เสมอ — กัน bug คะแนนหายจากการ replace ซ้อนกัน
    const base = session.turnSnapshot.get(userId) ?? 0;
    player.score = base + rollResult.total;
  } else {
    player.score += rollResult.total;
  }

  player.rolled = true;
  lastRolls.set(`${guildId}:${userId}`, { ...rollResult });

  const canSafe = rollResult.chosen.some(n => n >= 1 && n <= 10);

  persistSession(guildId).catch(err => console.error('[submitScore] persist failed:', err));
  return { player, canSafe };
}

function getTurnSnapshot(guildId) {
  const session = getSession(guildId);
  return [...session.turnSnapshot.entries()];
}

function getLastRoll(guildId, userId) {
  return lastRolls.get(`${guildId}:${userId}`) || null;
}

function setLastRoll(guildId, userId, result) {
  lastRolls.set(`${guildId}:${userId}`, { ...result });
}

function trainerReroll(guildId, targetUserId, rollFn) {
  const session = getSession(guildId);
  const player  = session.players.get(targetUserId);
  if (!player) throw new Error('ไม่พบผู้เล่นเป้าหมายใน session');
  const last = getLastRoll(guildId, targetUserId);
  if (!last) throw new Error('ยังไม่มีผลสุ่มของผู้เล่นคนนี้');

  const newResult = rollFn(last.notation);

  // ใช้ snapshot ต้นเทิร์นเป็น base เหมือน submitScore replace
  const base = session.turnSnapshot.get(targetUserId) ?? 0;
  player.score = base + newResult.total;

  lastRolls.set(`${guildId}:${targetUserId}`, { ...newResult });

  persistSession(guildId).catch(err => console.error('[trainerReroll] persist failed:', err));
  return { player, newResult, oldResult: last };
}

/**
 * /race next — จบเทิร์น
 */
async function next(guildId) {
  const session = getSession(guildId);
  if (session.status !== 'racing') throw new Error('การแข่งยังไม่เริ่ม');

  for (const p of session.players.values()) {
    p.rolled          = false;
    p.slowedThisTurn  = false;
    p.debuffed        = false;
  }
  session.isFirstTurn = false;

  if (session.totalTurn >= session.distance) {
    for (const p of session.players.values()) p.mainRerollCooldown = false;
    session.status = 'finished';
    await persistSession(guildId);
    return { type: 'finished', phase: session.phase, turn: session.turn, totalTurn: session.totalTurn };
  }

  const prevPhase = session.phase;
  session.totalTurn++;

  const { phase, turn } = calcPhaseAndTurn(session.totalTurn, session.structure);
  session.phase = phase;
  session.turn  = turn;

  for (const [uid, p] of session.players.entries()) {
    session.turnSnapshot.set(uid, p.score);
  }

  await persistSession(guildId);

  const type = session.phase !== prevPhase ? 'phase' : 'turn';
  return { type, phase: session.phase, turn: session.turn, totalTurn: session.totalTurn };
}

function getSession(guildId) {
  const s = sessions.get(guildId);
  if (!s) throw new Error('ไม่มี session การแข่งในเซิร์ฟเวอร์นี้');
  return s;
}

function hasSession(guildId) { return sessions.has(guildId); }

async function closeSession(guildId) {
  const session = sessions.get(guildId);
  if (session) {
    for (const userId of session.players.keys()) {
      lastRolls.delete(`${guildId}:${userId}`);
    }
  }
  sessions.delete(guildId);
  try {
    await deleteSessionDB(guildId);
  } catch (err) {
    console.error('[closeSession] deleteSessionDB failed:', err);
  }
}

function getLeaderboard(guildId) {
  const session = getSession(guildId);
  return [...session.players.values()]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, ...p }));
}

module.exports = {
  restoreSessionsFromDB,
  setLastRoll,
  openSession, registerPlayer,
  adjustScore,
  submitScore,
  getLastRoll, trainerReroll,
  getTurnSnapshot,
  next, getSession, hasSession, closeSession, getLeaderboard,
  getPhaseStructure, calcPhaseAndTurn,
};
