'use strict';

/**
 * skillSystem.js — สถานะสกิลของผู้เล่นใน session (เลือก, ใช้ไพ่ตาย, ปิดเทิร์น, เปิดเผยตอนจบ)
 * ไม่รู้จัก Discord และไม่ทอยเต๋าเอง (การทอยอยู่ใน raceSession ผ่าน skillEngine)
 */

const { PASSIVES, ACTIVES, SKILLS_VERSION } = require('./skillData');
const { buildPlan, standing } = require('./skillEngine');

function defaultSkills() {
  return {
    passive: null, active: null,
    activeUsed: false, usedTurn: null, activeUse: null,
    haloArmed: false, haloSpent: false,
    storm: 0,
    pending: [],
    log: [],
  };
}

function ensureSkills(player) {
  if (!player.skills) player.skills = defaultSkills();
  const s = player.skills;
  if (!Array.isArray(s.pending)) s.pending = [];
  if (!Array.isArray(s.log)) s.log = [];
  return s;
}

function skillsOn(session) { return !!(session && session.skillsEnabled); }

function requireOn(session) {
  if (!skillsOn(session)) throw new Error('การแข่งนี้ไม่ได้เปิดระบบสกิล');
}

// =================== เลือกสกิล ===================

function pickSkills(session, player, passiveId, activeId) {
  requireOn(session);
  if (session.totalTurn > 1 || player.rolled) {
    throw new Error('เลือก/เปลี่ยนสกิลได้เฉพาะก่อนทอยครั้งแรกของเทิร์นแรก');
  }
  const s = ensureSkills(player);
  if (passiveId) {
    const p = PASSIVES[passiveId];
    if (!p) throw new Error('ไม่พบ passive นี้');
    if (p.cls !== player.position) throw new Error(`${p.name} เป็น passive ของคลาส ${p.cls} แต่คุณลงคลาส ${player.position}`);
    s.passive = passiveId;
  }
  if (activeId) {
    if (!ACTIVES[activeId]) throw new Error('ไม่พบไพ่ตายนี้');
    s.active = activeId;
  }
  return s;
}

/** เปลี่ยนคลาสก่อนเริ่มแข่ง → passive เดิมใช้ไม่ได้ */
function onClassChanged(player) {
  const s = player.skills;
  if (s && s.passive && PASSIVES[s.passive].cls !== player.position) {
    s.passive = null;
    return true;
  }
  return false;
}

// =================== การโจมตี (สกิลแดง / Pocket Sand) ===================

/** ม้าตัวนี้โดนโจมตีไปแล้วในเทิร์นนี้ไหม (จำกัด 1 ครั้ง/เทิร์น รวมสกิลแดง) */
function attackedThisTurn(session, target) {
  return target.attackedTurn === session.totalTurn;
}

/**
 * บันทึกว่าเป้าหมายโดนโจมตี แล้วเช็ค Iron Halo
 * @returns {boolean} true = Iron Halo กันไว้ได้ (การโจมตีถูกยกเลิก)
 */
function receiveAttack(session, target) {
  target.attackedTurn = session.totalTurn;
  const s = target.skills;
  if (s && s.haloArmed && !s.haloSpent) {
    s.haloSpent = true;
    s.log.push({ turn: session.totalTurn, text: '🛡️ Iron Halo กันการโจมตี' });
    return true;
  }
  target.lastHitTurn = session.totalTurn;
  return false;
}

// =================== ใช้ไพ่ตาย ===================

/**
 * ตรวจและบันทึกการใช้ไพ่ตาย (ไม่ทอยเต๋า)
 * @param opts { targetId, zone }
 * @returns { card, def, kind: 'pre'|'post'|'attack'|'silent', target?, blocked? }
 */
function useActive(session, player, opts = {}) {
  requireOn(session);
  if (session.status !== 'racing') throw new Error('การแข่งไม่ได้อยู่ระหว่างแข่ง');
  const s = ensureSkills(player);
  if (!s.active) throw new Error('คุณยังไม่ได้เลือกไพ่ตาย (ใช้ /skill pick)');
  if (s.activeUsed) throw new Error('ใช้ไพ่ตายไปแล้วในการแข่งนี้');
  const card = s.active;
  const def  = ACTIVES[card];
  const turn = session.totalTurn;
  const isLast = turn >= session.distance;

  if (def.timing === 'pre'  && player.rolled)  throw new Error(`${def.name} ต้องใช้ก่อนทอย`);
  if (def.timing === 'post' && !player.rolled) throw new Error(`${def.name} ต้องใช้หลังทอย`);
  if (def.timing === 'post' && player.allOutTurn === turn) throw new Error(`ใช้ ${def.name} หลัง All Out ในเทิร์นเดียวกันไม่ได้`);

  const result = { card, def, kind: def.timing };
  const commit = (use) => {
    s.activeUsed = true;
    s.usedTurn   = turn;
    s.activeUse  = { card, turn, ...use };
    s.log.push({ turn, text: `${def.emoji} ใช้ ${def.name}` });
  };

  switch (card) {
    case 'overdrive':
    case 'luckyBreak':
      commit({});
      break;

    case 'allOrNothing':
      commit({});
      if (!isLast) {
        s.pending.push({ turn: turn + 1, delta: def.nextDice, fallback: def.fallback, label: '🎰 All or Nothing (ผลจากเทิร์นก่อน)' });
      }
      break;

    case 'reservePower': {
      if (isLast) throw new Error('Reserve Power ใช้ในเทิร์นสุดท้ายไม่ได้');
      // ลองสร้างแผนก่อน — ถ้าเหลือเต๋า 1 ลูก ลดไม่ได้ → ไม่รับไพ่
      const trial = buildPlan(session, { ...player, skills: { ...s, activeUse: { card, turn } } });
      if (trial.problems.length) throw new Error('Reserve Power ใช้ไม่ได้: เทิร์นนี้มีเต๋าแค่ 1 ลูก');
      commit({});
      s.pending.push({ turn: turn + 1, delta: 1, label: '🔋 Reserve Power (ผลจากเทิร์นก่อน)' });
      break;
    }

    case 'ghostProtocol':
      if (turn === 1 || session.isFirstTurn) throw new Error('Ghost Protocol ใช้ในเทิร์นแรกไม่ได้');
      if (!['white', 'gold'].includes(opts.zone)) throw new Error('Ghost Protocol ต้องเลือก zone: White หรือ Gold');
      commit({ zone: opts.zone });
      break;

    case 'doppelganger': {
      const target = validateTarget(session, player, opts.targetId, def.range);
      if (target.position === player.position) throw new Error('Doppelgänger ต้องเลือกม้าที่ต่างคลาสกับคุณ');
      commit({ targetId: target.userId });
      result.target = target;
      break;
    }

    case 'damageControl':
      commit({ post: { damageControl: true } });
      break;

    case 'hailMary': {
      if (session.phase !== def.phase) throw new Error('Hail Mary ใช้ได้เฉพาะเฟส 4');
      const st = standing(session, player.userId);
      if (st.rank <= def.rankOver) throw new Error(`Hail Mary ใช้ได้เมื่อต้นเทิร์นอยู่นอก 3 อันดับแรก (ตอนนี้อันดับ ${st.rank})`);
      commit({ post: { hailMary: true } });
      break;
    }

    case 'pocketSand': {
      if (isLast) throw new Error('เทิร์นสุดท้ายแล้ว Pocket Sand ไม่มีผล (ผลเกิดเทิร์นหน้า)');
      const target = validateTarget(session, player, opts.targetId, def.range);
      if (attackedThisTurn(session, target)) throw new Error(`${target.displayName} โดนโจมตีไปแล้วในเทิร์นนี้ (โดนได้ 1 ครั้งต่อเทิร์น)`);
      commit({ targetId: target.userId });
      result.kind = 'attack';
      result.target = target;
      result.blocked = receiveAttack(session, target);
      if (!result.blocked) {
        ensureSkills(target).pending.push({
          turn: turn + 1, delta: def.nextDice, fallback: def.fallback,
          label: `🏜️ Pocket Sand จาก ${player.displayName}`,
        });
      }
      break;
    }

    case 'ironHalo':
      commit({});
      s.haloArmed = true;
      result.kind = 'silent';
      break;

    default:
      throw new Error('ไพ่ตายนี้ยังไม่รองรับ');
  }
  return result;
}

function validateTarget(session, player, targetId, range) {
  if (!targetId) throw new Error('ไพ่ใบนี้ต้องเลือกเป้าหมาย (target)');
  if (targetId === player.userId) throw new Error('เลือกตัวเองเป็นเป้าหมายไม่ได้');
  const target = session.players.get(targetId);
  if (!target) throw new Error('เป้าหมายไม่ได้ลงแข่งในการแข่งนี้');
  const mine  = session.turnSnapshot.get(player.userId) ?? 0;
  const their = session.turnSnapshot.get(targetId) ?? 0;
  const gap   = Math.abs(mine - their);
  if (gap > range) throw new Error(`เป้าหมายห่าง ${gap} แต้ม (ต้องไม่เกิน ${range} จากคะแนนต้นเทิร์น)`);
  return target;
}

// =================== ปิดเทิร์น ===================

/**
 * เรียกตอน /race next ก่อนขึ้นเทิร์นใหม่: บันทึก Gathering Storm + ล้างผลค้างที่หมดอายุ
 */
function commitTurn(session) {
  if (!skillsOn(session)) return;
  const turn = session.totalTurn;
  for (const p of session.players.values()) {
    const s = ensureSkills(p);
    if (p.rolled && s.passive === 'gatheringStorm') {
      const plan = buildPlan(session, p);
      if (plan.storm.release) s.storm = 0;
      else if (plan.storm.gain > 0) s.storm = (s.storm || 0) + plan.storm.gain;
    }
    s.pending = s.pending.filter(e => e.turn > turn);
  }
}

// =================== แสดงผล ===================

function describePassive(id) {
  const p = PASSIVES[id];
  return p ? `${p.emoji} **${p.name}** — ${p.desc}` : '—';
}
function describeActive(id) {
  const a = ACTIVES[id];
  return a ? `${a.emoji} **${a.name}** — ${a.desc}` : '—';
}

/** สถานะสาธารณะ: 🔒 ยังไม่ใช้ / ✅ ใช้แล้ว */
function publicMarker(player) {
  const s = player.skills;
  if (!s || !s.active) return '';
  if (s.active === 'ironHalo' && s.activeUsed && !s.haloSpent) return ' 🔒'; // เปิดแบบเงียบ ยังไม่เปิดเผย
  return s.activeUsed ? ' ✅' : ' 🔒';
}

/** บันทึกสกิลของทุกคน — เปิดเผยตอนจบการแข่ง */
function revealSummary(session) {
  if (!skillsOn(session)) return null;
  const rows = [...session.players.values()].map(p => {
    const s = p.skills || {};
    const pas = s.passive ? `${PASSIVES[s.passive].emoji} ${PASSIVES[s.passive].name}` : '— ไม่ได้เลือก';
    const act = s.active ? `${ACTIVES[s.active].emoji} ${ACTIVES[s.active].name}` : '— ไม่ได้เลือก';
    const used = s.active ? (s.activeUsed ? `ใช้เทิร์น ${s.usedTurn}` : 'ไม่ได้ใช้') : '';
    return `**${p.displayName}** [${p.position}] · ${pas} · ${act}${used ? ` (${used})` : ''}`;
  });
  return `Skills ${session.skillsVersion || SKILLS_VERSION}\n` + rows.join('\n');
}

module.exports = {
  defaultSkills, ensureSkills, skillsOn,
  pickSkills, onClassChanged,
  attackedThisTurn, receiveAttack,
  useActive, commitTurn,
  describePassive, describeActive, publicMarker, revealSummary,
};
