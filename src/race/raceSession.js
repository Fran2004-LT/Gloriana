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
// proxy: key = `${channelId}:${proxyUserId}` → ownerUserId ที่ถูกสวมสิทธิ์
const proxies   = new Map();

// ตั้ง proxy: proxyUser สวมสิทธิ์แทน owner
function setProxy(channelId, proxyUserId, ownerUserId) {
  const session = getSession(channelId);
  if (!session.players.has(ownerUserId)) throw new Error('ม้าที่จะสวมสิทธิ์ยังไม่ได้ลงทะเบียนในการแข่งนี้');
  proxies.set(`${channelId}:${proxyUserId}`, ownerUserId);
}

// ยกเลิก proxy ทั้งหมดที่สวมสิทธิ์ owner คนนี้ (owner เป็นคนเรียกคืน)
function clearProxyByOwner(channelId, ownerUserId) {
  let removed = false;
  for (const [key, owner] of proxies.entries()) {
    if (key.startsWith(`${channelId}:`) && owner === ownerUserId) {
      proxies.delete(key);
      removed = true;
    }
  }
  return removed;
}

// เช็คว่า user คนนี้กำลัง proxy แทนใครอยู่ใน channel นี้ (คืน ownerId หรือ null)
function getProxyOwner(channelId, proxyUserId) {
  return proxies.get(`${channelId}:${proxyUserId}`) || null;
}
// =================== Persistence helpers ===================

/**
 * บันทึก session ลง DB — เรียกหลังทุก mutation
 */
async function persistSession(channelId) {
  const session = sessions.get(channelId);
  if (!session) return;
  try {
    await saveSessionDB(channelId, session);
  } catch (err) {
    console.error(`[raceSession] persistSession failed for ${channelId}:`, err);
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
    for (const [channelId, session] of Object.entries(all)) {
      sessions.set(channelId, session);
      count++;
    }
    if (count > 0) console.log(`✅ [raceSession] Restored ${count} active session(s) from DB`);
  } catch (err) {
    console.error('[raceSession] restoreSessionsFromDB failed:', err);
  }
}

// =================== Session operations ===================

async function openSession(channelId, track = 'ไม่ระบุ', grade = 'G3', distance = 12) {
  if (sessions.has(channelId)) throw new Error('มี session การแข่งที่เปิดอยู่แล้ว');

  const structure = getPhaseStructure(distance);
  const { phase, turn } = calcPhaseAndTurn(1, structure);

  sessions.set(channelId, {
    channelId, track, grade, distance,
    structure,
    status:      'racing',
    phase, turn, totalTurn: 1,
    isFirstTurn: true,
    players:      new Map(),
    turnSnapshot: new Map(),
  });

  await persistSession(channelId);
  return sessions.get(channelId);
}

function registerPlayer(channelId, userId, displayName, position, options = {}) {
  const session = getSession(channelId);
  if (session.status === 'finished') throw new Error('การแข่งจบไปแล้ว');
  const VALID = ['Front', 'Pace', 'Late', 'End'];
  if (!VALID.includes(position)) throw new Error(`สายไม่ถูกต้อง ต้องเป็น: ${VALID.join(', ')}`);
  // ถ้า register ซ้ำ — อนุญาตได้ก่อนเทิร์นแรก (เพื่อเปลี่ยนสาย)
  if (session.players.has(userId)) {
    if (session.totalTurn > 1) throw new Error('เริ่มแข่งไปแล้ว ไม่สามารถเปลี่ยนสายได้');
    // รีเซ็ตข้อมูลสำหรับสายใหม่ คงคะแนนและสถานะอื่นๆ ไว้
    const existing = session.players.get(userId);
    existing.position   = position;
    existing.hillCleared = options.hillCleared || false;
    persistSession(channelId).catch(err => console.error('[registerPlayer] persist failed:', err));
    return existing;
  }

  // ลงทะเบียนใหม่ได้เฉพาะเทิร์นแรก — คนที่เข้ากลางทางเริ่มที่ 0 แต้ม
  // จะไปทำให้ม้าท้ายสนามได้ Gold zone โดยไม่ควรได้
  if (session.totalTurn > 1) throw new Error('เริ่มแข่งไปแล้ว ลงทะเบียนเพิ่มไม่ได้ (ลงได้เฉพาะเทิร์นแรก)');

  const isDebut = session.grade === 'Debut';
  session.players.set(userId, {
    userId, displayName, position,
    score: 0,
    // Main / G1 Reroll นับใน session เท่านั้น — ไม่แตะ DB ระหว่างแข่ง
    // Main = 1 ทุกคนทุกการแข่ง, G1 = จำนวนครั้งที่ชนะ G1 (ได้ใหม่ทุกการแข่ง)
    mainRerollsLeft: 1,
    g1RerollsLeft:   options.g1Wins || 0,
    redSkillUsed:    false,
    allOutCount: 0,
    rolled: false,
    hillCleared:   options.hillCleared  || false,
    zoneEnabled:   options.zoneEnabled  || false,
    debutSafeCount: isDebut ? 3 : 0,  // Main Safe — เฉพาะ Debut 3 ครั้ง
  });
  session.turnSnapshot.set(userId, 0);

  // persist async (ไม่ await เพื่อไม่ block — caller จัดการ await เองถ้าต้องการ)
  persistSession(channelId).catch(err => console.error('[registerPlayer] persist failed:', err));

  return session.players.get(userId);
}

function adjustScore(channelId, userId, amount) {
  const session = getSession(channelId);
  if (session.status !== 'racing') throw new Error('การแข่งยังไม่เริ่ม');
  const player = session.players.get(userId);
  if (!player) throw new Error('คุณไม่ได้อยู่ใน session นี้');
  if (amount < 1 || amount > 10) throw new Error('ลดได้ไม่เกิน 10 แต้มต่อครั้ง');
  const base = session.turnSnapshot.get(userId) ?? player.score;
  if (player.score - amount < 0 || base - amount < 0) throw new Error('คะแนนจะติดลบ ลดไม่ได้');
  player.score -= amount;
  // ลดทั้งคะแนนจริงและคะแนนต้นเทิร์นเท่ากัน
  // (เดิมตั้ง snapshot = score ทำให้แต้มที่ทอยไปแล้วในเทิร์นนี้ปนเข้า "คะแนนต้นเทิร์น"
  //  → โซนของม้าคนอื่นคำนวณผิด และ reroll หลัง slowdown ได้แต้มเกินจริง)
  session.turnSnapshot.set(userId, base - amount);

  persistSession(channelId).catch(err => console.error('[adjustScore] persist failed:', err));
  return player;
}

/**
 * ใช้ Reroll ที่นับใน session (Main หรือ G1) — ไม่แตะ DB
 * kind = 'main' | 'g1'  → คืนจำนวนที่เหลือ
 */
const SESSION_REROLL_FIELD = { main: 'mainRerollsLeft', g1: 'g1RerollsLeft' };
const SESSION_REROLL_NAME  = { main: 'Main Reroll', g1: 'G1 Reroll' };

function getSessionRerolls(channelId, userId, kind) {
  if (!hasSession(channelId)) return null;
  const player = getSession(channelId).players.get(userId);
  if (!player) return null;
  // session เก่าที่ restore มาจาก DB อาจไม่มี field นี้
  if (kind === 'main') return player.mainRerollsLeft ?? 1;
  return player.g1RerollsLeft ?? 0;
}

function useSessionReroll(channelId, userId, kind) {
  const session = getSession(channelId);
  const player  = session.players.get(userId);
  if (!player) throw new Error('คุณไม่ได้อยู่ใน session นี้');
  const field = SESSION_REROLL_FIELD[kind];
  if (!field) throw new Error(`Unknown reroll: ${kind}`);
  const left = getSessionRerolls(channelId, userId, kind);
  if (left <= 0) throw new Error(`ไม่มี ${SESSION_REROLL_NAME[kind]} เหลือแล้ว`);
  player[field] = left - 1;
  persistSession(channelId).catch(err => console.error('[useSessionReroll] persist failed:', err));
  return player[field];
}

/**
 * 🔴 Red Skill — ใช้ได้ 1 ครั้งต่อการแข่ง
 * สุ่มเป้าหมายจากคู่แข่งที่ทอยแล้วในเทิร์นนี้ → ยกเลิกแต้มเทิร์นนั้นของเป้าหมาย
 * → ทอยใหม่ด้วยสูตรเดิมของเป้าหมาย → แต้มเทิร์น = max(ผลใหม่ - 20, 0)
 */
const RED_SKILL_BASE = 20;

function useRedSkill(channelId, userId, rollFn, randomFn = Math.random) {
  const session = getSession(channelId);
  if (session.status !== 'racing') throw new Error('การแข่งยังไม่เริ่ม');
  const user = session.players.get(userId);
  if (!user) throw new Error('คุณยังไม่ได้ลงทะเบียนแข่ง');
  if (user.redSkillUsed) throw new Error('ใช้สกิลแดงไปแล้วในการแข่งนี้ (Skill Already Used)');

  // เป้าหมายที่เป็นไปได้: คู่แข่งที่ทอยแล้วเทิร์นนี้ มีผลทอยล่าสุด และไม่ได้ใช้ Zone เทิร์นนี้
  const targets = [...session.players.values()].filter(p =>
    p.userId !== userId &&
    p.rolled &&
    getLastRoll(channelId, p.userId) &&
    p.zoneUsedTurn !== session.totalTurn
  );
  if (targets.length === 0) throw new Error('ยังไม่มีคู่แข่งที่ทอยในเทิร์นนี้ให้เป็นเป้าหมาย (No Valid Target)');

  const target   = targets[Math.floor(randomFn() * targets.length)];
  const last     = getLastRoll(channelId, target.userId);
  const newRoll  = rollFn(last.notation);
  const turnScore = Math.max(newRoll.total - RED_SKILL_BASE, 0);
  const base     = session.turnSnapshot.get(target.userId) ?? 0;

  target.score    = base + turnScore;
  target.debuffed = true;
  user.redSkillUsed = true;
  lastRolls.set(`${channelId}:${target.userId}`, {
    ...newRoll, total: turnScore, display: `${newRoll.display} − ${RED_SKILL_BASE}`, redSkilled: true,
  });

  persistSession(channelId).catch(err => console.error('[useRedSkill] persist failed:', err));
  return { target, oldRoll: last, newRoll, turnScore, base: RED_SKILL_BASE };
}

/**
 * บันทึกคะแนน
 * replace = true  → แทนที่ (reroll/safe) โดยใช้ turnSnapshot เป็น base
 * replace = false → บวกเพิ่ม (ทอยปกติ)
 * isReroll = true → อนุญาตแม้ rolled แล้ว
 */
function submitScore(channelId, userId, rollResult, replace = false, isReroll = false) {
  const session = getSession(channelId);
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
  lastRolls.set(`${channelId}:${userId}`, { ...rollResult });

  const canSafe = rollResult.chosen.some(n => n >= 1 && n <= 10);

  persistSession(channelId).catch(err => console.error('[submitScore] persist failed:', err));
  return { player, canSafe };
}

function getTurnSnapshot(channelId) {
  const session = getSession(channelId);
  return [...session.turnSnapshot.entries()];
}

function getLastRoll(channelId, userId) {
  return lastRolls.get(`${channelId}:${userId}`) || null;
}

function setLastRoll(channelId, userId, result) {
  lastRolls.set(`${channelId}:${userId}`, { ...result });
}

function trainerReroll(channelId, targetUserId, rollFn) {
  const session = getSession(channelId);
  const player  = session.players.get(targetUserId);
  if (!player) throw new Error('ไม่พบผู้เล่นเป้าหมายใน session');
  const last = getLastRoll(channelId, targetUserId);
  if (!last) throw new Error('ยังไม่มีผลสุ่มของผู้เล่นคนนี้');

  const newResult = rollFn(last.notation);

  // ใช้ snapshot ต้นเทิร์นเป็น base เหมือน submitScore replace
  const base = session.turnSnapshot.get(targetUserId) ?? 0;
  player.score = base + newResult.total;

  lastRolls.set(`${channelId}:${targetUserId}`, { ...newResult });

  persistSession(channelId).catch(err => console.error('[trainerReroll] persist failed:', err));
  return { player, newResult, oldResult: last };
}

/**
 * /race next — จบเทิร์น
 */
async function next(channelId) {
  const session = getSession(channelId);
  if (session.status !== 'racing') throw new Error('การแข่งยังไม่เริ่ม');

  for (const p of session.players.values()) {
    p.rolled          = false;
    p.slowedThisTurn  = false;
    p.debuffed        = false;
  }
  session.isFirstTurn = false;

  if (session.totalTurn >= session.distance) {
    session.status = 'finished';
    await persistSession(channelId);
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

  await persistSession(channelId);

  const type = session.phase !== prevPhase ? 'phase' : 'turn';
  return { type, phase: session.phase, turn: session.turn, totalTurn: session.totalTurn };
}

function getSession(channelId) {
  const s = sessions.get(channelId);
  if (!s) throw new Error('ไม่มี session การแข่งในเซิร์ฟเวอร์นี้');
  return s;
}

function hasSession(channelId) { return sessions.has(channelId); }

async function closeSession(channelId) {
  const session = sessions.get(channelId);
  if (session) {
    for (const userId of session.players.keys()) {
      lastRolls.delete(`${channelId}:${userId}`);
    }
  }
  sessions.delete(channelId);
  try {
    await deleteSessionDB(channelId);
  } catch (err) {
    console.error('[closeSession] deleteSessionDB failed:', err);
  }
}

function getLeaderboard(channelId) {
  const session = getSession(channelId);
  return [...session.players.values()]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, ...p }));
}

module.exports = {
  setProxy, clearProxyByOwner, getProxyOwner,
  restoreSessionsFromDB,
  setLastRoll,
  openSession, registerPlayer,
  adjustScore,
  getSessionRerolls, useSessionReroll,
  useRedSkill, RED_SKILL_BASE,
  submitScore,
  getLastRoll, trainerReroll,
  getTurnSnapshot,
  next, getSession, hasSession, closeSession, getLeaderboard,
  getPhaseStructure, calcPhaseAndTurn,
};
