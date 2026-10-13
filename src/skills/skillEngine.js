'use strict';

/**
 * skillEngine.js — คำนวณเทิร์นเมื่อเปิดระบบสกิล (ฟังก์ชันบริสุทธิ์ ไม่แตะ DB / Discord)
 *
 * ลำดับการคิดของ 1 เทิร์น (ใช้ลำดับเดียวกันทุกครั้ง ทั้งทอยปกติ, Reroll, Safe, All Out,
 * Trainer Reroll และสกิลแดง — สกิลแดง = "ทอยใหม่ทั้งเทิร์นด้วยเงื่อนไขเดิม แล้วหัก 20")
 *
 *   1. โซน: Gold/White จากคะแนนต้นเทิร์น (เทิร์นแรก = White) — Zone (G1) / Ghost Protocol เลือกแทนได้
 *   2. สูตรจากตาราง v3.4 ของคลาส
 *   3. passive แบบ Fixed แทนช่องตาราง
 *   4. เพิ่ม/ลดเต๋า: passive (Slipstream, Lone Wolf) → ผลค้างจากเทิร์นก่อน
 *      (All or Nothing, Reserve Power, Pocket Sand) → ไพ่ตายเทิร์นนี้ (Overdrive, All or Nothing, Reserve Power)
 *   5. Hill debuff (Nakayama) ต่อท้ายสูตร
 *   6. ทอย → Doppelgänger เฉลี่ยสองชุด → Damage Control → Lucky Break → Hail Mary
 *      → โบนัส/บทลงโทษแบบแต้ม (passive, ผลค้าง) → สกิลแดง −20 → ต่ำสุด 0
 *
 * passive ทุกตัวดูเงื่อนไขจาก "คะแนนต้นเทิร์น" และ "โซนตามจริง" (ไม่ใช่โซนที่เลือกด้วย Zone/Ghost)
 */

const { parseNotation } = require('../dice/diceParser');
const { WHITE, GOLD, isInGoldZone, GOLD_THRESHOLD } = require('../dice/diceTable');
const { getHillDebuff } = require('../config/tracks');
const { PASSIVES, ACTIVES, RED_SKILL_BASE } = require('./skillData');

// =================== Notation helpers ===================

function toNotation(p) {
  const count = p.count === 1 ? '' : String(p.count);
  const keep  = p.keep ? `k${p.keep.type}${p.keep.count}` : '';
  const mod   = p.modifier ? (p.modifier > 0 ? `+${p.modifier}` : `${p.modifier}`) : '';
  return `${count}d${p.sides}${keep}${mod}`;
}

/**
 * เพิ่ม/ลดเต๋า
 * - ปกติ: ลูกที่เก็บเปลี่ยนตาม (6d30kh2 +1 → 7d30kh3, 5d30kh3 −1 → 4d30kh2)
 * - keepSame (Slipstream): ลูกที่เก็บเท่าเดิม (6d30kh2 → 7d30kh2, 2d30 → 3d30kh2)
 * - เหลือขั้นต่ำ 1 ลูก — ลูกที่ลดไม่ได้นับเป็น missing (ให้ผู้เรียกแปลงเป็นแต้มลบ)
 */
function shiftDice(notation, delta, { keepSame = false } = {}) {
  const p = parseNotation(notation);
  let count = p.count;
  let keep  = p.keep ? { ...p.keep } : null;
  let missing = 0;
  for (let i = 0; i < Math.abs(delta); i++) {
    if (delta > 0) {
      if (keepSame) {
        if (!keep) keep = { type: 'h', count };
        count++;
      } else {
        count++;
        if (keep) keep.count++;
      }
    } else {
      if (count <= 1) { missing++; continue; }
      count--;
      if (keep) keep.count = Math.max(1, keep.count - 1);
    }
    if (keep && keep.count >= count) keep = null;
  }
  return { notation: toNotation({ ...p, count, keep }), missing };
}

function addModifier(notation, mod) {
  if (!mod) return notation;
  const p = parseNotation(notation);
  return toNotation({ ...p, modifier: p.modifier + mod });
}

/** ค่าเฉลี่ยจริงของสูตร (รองรับ NdS, NdSkhK, modifier) */
function expectedValue(notation) {
  const p = parseNotation(notation);
  const n = p.count, S = p.sides;
  const k = p.keep && p.keep.type === 'h' ? p.keep.count : n;
  const binom = (a, b) => { let r = 1; for (let i = 1; i <= b; i++) r = r * (a - b + i) / i; return r; };
  let e = 0;
  for (let x = 1; x <= S; x++) {
    const q = (S - x + 1) / S; // P(ลูกหนึ่ง ≥ x)
    // E[ผลรวม k ลูกสูงสุด] = Σx Σj≤k P(จำนวนลูกที่ ≥ x มีอย่างน้อย j ลูก)
    for (let j = 1; j <= k; j++) {
      let pAtLeast = 0;
      for (let m = j; m <= n; m++) pAtLeast += binom(n, m) * q ** m * (1 - q) ** (n - m);
      e += pAtLeast;
    }
  }
  return e + p.modifier;
}

// =================== Standing (จากคะแนนต้นเทิร์น) ===================

function standing(session, userId) {
  const mine   = session.turnSnapshot.get(userId) ?? 0;
  const others = [...session.turnSnapshot.entries()]
    .filter(([id]) => id !== userId && session.players.has(id))
    .map(([, s]) => s);
  const rank     = 1 + others.filter(s => s > mine).length;
  const aheadSet = others.filter(s => s >= mine);          // คะแนนเท่ากันนับเป็น "ข้างหน้า" ห่าง 0
  const aheadGap = aheadSet.length ? Math.min(...aheadSet) - mine : null;
  const maxOther = others.length ? Math.max(...others) : null;
  const leaderGap = maxOther === null ? null : maxOther - mine;           // > 0 = ตามหลังอันดับ 1
  const leadMargin = maxOther === null ? null : mine - maxOther;          // > 0 = นำอยู่
  const crowd    = others.filter(s => Math.abs(s - mine) <= GOLD_THRESHOLD).length;
  const firstTurn = session.isFirstTurn === true || session.totalTurn === 1;
  const naturalGold = firstTurn ? false : isInGoldZone(mine, [mine, ...others]);
  return { mine, others, rank, aheadGap, leaderGap, leadMargin, crowd, naturalGold, firstTurn };
}

// =================== Plan ===================

function tableCell(position, zone, phase) {
  return (zone === 'gold' ? GOLD : WHITE)[position][phase - 1];
}

/**
 * สร้างแผนของเทิร์นนี้จากสถานะปัจจุบัน (ทำซ้ำได้ทุกเมื่อ ได้ผลเหมือนเดิมถ้าสถานะไม่เปลี่ยน)
 * @returns plan { notation, copyNotation, zone, adds[], lines[], flags, storm, problems[] }
 */
function buildPlan(session, player) {
  const sk     = player.skills || {};
  const turn   = session.totalTurn;
  const phase  = session.phase;
  const isLast = turn >= session.distance;
  const st     = standing(session, player.userId);
  const passiveId = sk.passive || null;
  const passive   = passiveId ? PASSIVES[passiveId] : null;
  const use    = sk.activeUse && sk.activeUse.turn === turn ? sk.activeUse : null;
  const card   = use ? use.card : null;

  const lines = [];     // ข้อความอธิบาย (แสดงในผลทอย)
  const adds  = [];     // โบนัส/บทลงโทษแบบแต้ม { label, value }
  const problems = [];  // เงื่อนไขที่ทำให้ใช้ไพ่ไม่ได้ (ใช้ตรวจก่อนรับไพ่)
  const triggered = []; // passive ที่ทำงานเทิร์นนี้

  // ---- 1) โซน ----
  let zone = st.naturalGold ? 'gold' : 'white';
  if (player.zoneUsedTurn === turn && player.zoneType) {
    zone = player.zoneType; // Zone (G1) ที่ใช้ในเทิร์นนี้
  } else if (card === 'ghostProtocol' && use.zone) {
    zone = use.zone;
    lines.push(`👻 Ghost Protocol: เลือกทอยสูตร ${zone === 'gold' ? '🟡 Gold' : '⚪ White'}`);
  }

  // ---- 2–3) ตาราง + passive Fixed ----
  let notation = tableCell(player.position, zone, phase);
  if (passive && passive.kind === 'fixed') {
    const o = passive.override[zone] && passive.override[zone][phase];
    if (o && o !== notation) {
      lines.push(`${passive.emoji} ${passive.name}: \`${notation}\` → \`${o}\``);
      triggered.push(passiveId);
      notation = o;
    }
  }

  // ---- 4) เพิ่ม/ลดเต๋า ----
  const sharedShifts = []; // ใช้กับทั้งสูตรตัวเองและสูตรที่ Doppelgänger ลอก
  if (passiveId === 'slipstream' && st.aheadGap !== null && st.aheadGap <= passive.gapMax) {
    sharedShifts.push({ delta: 1, keepSame: true, label: `${passive.emoji} Slipstream (ม้าข้างหน้าห่าง ${st.aheadGap})` });
    triggered.push(passiveId);
  }
  if (passiveId === 'loneWolf' && phase === passive.phase && !st.naturalGold) {
    sharedShifts.push({ delta: 1, label: `${passive.emoji} Lone Wolf` });
    triggered.push(passiveId);
  }
  for (const e of (sk.pending || [])) {
    if (e.turn === turn) sharedShifts.push({ delta: e.delta, fallback: e.fallback, label: e.label });
  }
  const ownShifts = [];
  if (card === 'overdrive')    ownShifts.push({ delta: 1, label: '🚀 Overdrive' });
  if (card === 'allOrNothing') ownShifts.push({ delta: 2, label: '🎰 All or Nothing' });
  if (card === 'reservePower') ownShifts.push({ delta: -1, fallback: null, label: '🔋 Reserve Power' });

  const applyShifts = (start, shifts, describe) => {
    let n = start;
    for (const s of shifts) {
      const before = n;
      const r = shiftDice(n, s.delta, { keepSame: s.keepSame });
      n = r.notation;
      if (describe) {
        const sign = s.delta > 0 ? `+${s.delta}` : `${s.delta}`;
        lines.push(`${s.label}: เต๋า ${sign} ลูก \`${before}\` → \`${n}\``);
      }
      if (r.missing > 0) {
        if (s.fallback) {
          if (describe) adds.push({ label: `${s.label}: ลดเต๋าไม่ได้ ${r.missing} ลูก`, value: -s.fallback * r.missing });
        } else {
          problems.push(`${s.label}: ลดเต๋าไม่ได้ (เหลือ 1 ลูก)`);
        }
      }
    }
    return n;
  };
  notation = applyShifts(notation, [...sharedShifts, ...ownShifts], true);

  // ---- 5) Hill debuff ----
  const hill = player.hillCleared ? 0 : getHillDebuff(session.track, player.position, phase);
  notation = addModifier(notation, -hill);

  // ---- Doppelgänger: สูตรของคลาสเป้าหมาย (ไม่ลอก passive) ----
  let copyNotation = null;
  if (card === 'doppelganger' && use.targetId) {
    const target = session.players.get(use.targetId);
    if (target) {
      copyNotation = applyShifts(tableCell(target.position, zone, phase), sharedShifts, false);
      copyNotation = addModifier(copyNotation, -hill);
      lines.push(`🎭 Doppelgänger: ลอกสูตร ${target.position} → \`${copyNotation}\``);
    }
  }

  // ---- โบนัสแบบแต้มจาก passive ----
  if (passiveId === 'catchMe' && st.rank === 1 && st.leadMargin !== null && st.leadMargin > passive.gapOver) {
    adds.push({ label: `${passive.emoji} Catch Me If You Can (นำห่าง ${st.leadMargin})`, value: passive.bonus });
    triggered.push(passiveId);
  }
  if (passiveId === 'riseAshes' && phase >= passive.minPhase && st.rank > passive.rankOver) {
    adds.push({ label: `${passive.emoji} Rise From the Ashes (อันดับ ${st.rank})`, value: passive.bonus });
    triggered.push(passiveId);
  }
  if (passiveId === 'crowdReader' && st.crowd >= passive.minCount) {
    adds.push({ label: `${passive.emoji} Crowd Reader (ม้ารอบตัว ${st.crowd} ตัว)`, value: passive.bonus });
    triggered.push(passiveId);
  }
  if (passiveId === 'wildHunt' && phase >= passive.minPhase && st.leaderGap !== null &&
      st.leaderGap >= passive.gapMin && st.leaderGap <= passive.gapMax) {
    adds.push({ label: `${passive.emoji} The Wild Hunt (ตามอันดับ 1 อยู่ ${st.leaderGap})`, value: passive.bonus });
    triggered.push(passiveId);
  }
  if (passiveId === 'vendetta' && player.lastHitTurn === turn - 1) {
    adds.push({ label: `${passive.emoji} Vendetta`, value: passive.bonus });
    triggered.push(passiveId);
  }
  const storm = { gain: 0, release: false };
  if (passiveId === 'gatheringStorm') {
    const stored = sk.storm || 0;
    if (phase <= 2 && !st.naturalGold) {
      storm.gain = Math.min(passive.perTurn, passive.cap - stored);
      if (storm.gain > 0) {
        lines.push(`${passive.emoji} Gathering Storm: สะสม +${storm.gain} (รวม ${stored + storm.gain}/${passive.cap})`);
        triggered.push(passiveId);
      }
    } else if (phase >= 3 && st.naturalGold && stored > 0) {
      storm.release = true;
      adds.push({ label: `${passive.emoji} Gathering Storm ปล่อยพลังที่สะสม`, value: stored });
      triggered.push(passiveId);
    }
  }

  // ---- ไพ่ตายแบบแต้ม ----
  if (card === 'allOrNothing' && isLast) adds.push({ label: '🎰 All or Nothing (เทิร์นสุดท้าย)', value: -ACTIVES.allOrNothing.fallback });

  return {
    turn, phase, zone, naturalGold: st.naturalGold, standing: st,
    notation, copyNotation,
    adds, lines, problems, triggered: [...new Set(triggered)], storm,
    card,
    luckyBreak:    card === 'luckyBreak',
    damageControl: card === 'damageControl' && !!(use.post && use.post.damageControl),
    hailMary:      card === 'hailMary'      && !!(use.post && use.post.hailMary),
  };
}

// =================== Roll & Score ===================

function rollSets(plan, rollFn) {
  return {
    main:  rollFn(plan.notation),
    copy:  plan.copyNotation ? rollFn(plan.copyNotation) : null,
    extra: plan.hailMary ? rollFn(plan.notation) : null,
  };
}

/**
 * คิดแต้มเทิร์นจากผลทอย (ไม่ทอยใหม่) — ใช้ตอน Damage Control / Hail Mary ด้วย
 */
function scorePlan(plan, sets, { redSkill = false } = {}) {
  const lines = [...plan.lines];
  const main  = sets.main.total;
  let total = main;

  if (sets.copy) {
    total = Math.floor((main + sets.copy.total) / 2);
    lines.push(`🎭 ชุดที่ลอก \`${sets.copy.notation}\`: ${sets.copy.display} → ${sets.copy.total} · เฉลี่ย (${main} + ${sets.copy.total}) ÷ 2 = **${total}**`);
  }
  if (plan.damageControl) {
    const avg = Math.floor(expectedValue(plan.notation));
    if (main < avg) {
      const add = Math.floor((avg - main) / 2);
      total += add;
      lines.push(`🩹 Damage Control: ค่าเฉลี่ย ${avg} ขาด ${avg - main} → +${add}`);
    } else {
      lines.push(`🩹 Damage Control: ผลไม่ต่ำกว่าค่าเฉลี่ย (${avg}) ไม่ได้โบนัส`);
    }
  }
  if (plan.luckyBreak) {
    const lb   = ACTIVES.luckyBreak;
    const hits = (sets.main.chosen || []).filter(v => v >= lb.face).length;
    const add  = hits > 0 ? hits * lb.perDie : -lb.miss;
    total += add;
    lines.push(`🍀 Lucky Break: ออก ${lb.face}+ ${hits} ลูก → ${add > 0 ? '+' : ''}${add}`);
  }
  if (sets.extra) {
    const add = Math.floor(sets.extra.total / 2);
    total += add;
    lines.push(`🏈 Hail Mary: ชุดที่สอง ${sets.extra.display} → ${sets.extra.total} ÷ 2 = +${add}`);
  }
  for (const a of plan.adds) {
    total += a.value;
    lines.push(`${a.label}: ${a.value > 0 ? '+' : ''}${a.value}`);
  }
  if (redSkill) {
    total -= RED_SKILL_BASE;
    lines.push(`🔴 สกิลแดง: −${RED_SKILL_BASE}`);
  }
  if (total < 0) total = 0;
  return { total, lines };
}

/** ทอยทั้งเทิร์นตามแผน → ผลลัพธ์รูปแบบเดียวกับ diceRoller.roll() + ข้อมูลสกิล */
function resolve(plan, rollFn, flags = {}) {
  const sets = rollSets(plan, rollFn);
  return packResult(plan, sets, flags);
}

function packResult(plan, sets, flags = {}) {
  const { total, lines } = scorePlan(plan, sets, flags);
  return {
    ...sets.main,
    notation: plan.notation,
    total,
    diceTotal: sets.main.total,
    skillLines: lines,
    sets,
    redSkilled: !!flags.redSkill,
    skillTurn: plan.turn,
  };
}

module.exports = {
  toNotation, shiftDice, addModifier, expectedValue,
  standing, buildPlan, rollSets, scorePlan, resolve, packResult,
};
