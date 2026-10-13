'use strict';

/**
 * skillData.js — ข้อมูลสกิลทั้งหมด (Skills v1)
 *
 * ทุกตัวเลขที่ปรับสมดุลได้อยู่ในไฟล์นี้ที่เดียว ถ้าจะปรับ ให้ออกเป็นเวอร์ชันใหม่
 * (เช่น SKILLS_VERSION = 'v2') โดยไม่ต้องแตะ skillEngine.js
 *
 * ผูกกับตารางเต๋า v3.4 — ช่อง override ของ passive แบบ Fixed เขียนเป็นสูตรเต็ม
 * ถ้าตารางเปลี่ยน ต้องทบทวนช่องเหล่านี้ด้วย
 *
 * หลักร่วม:
 *  - ระยะห่างทุกตัวนับเป็น "แต้ม" จาก "คะแนนต้นเทิร์น"
 *  - การหารทุกครั้งปัดลง
 *  - เพิ่ม/ลดเต๋า 1 ลูก = จำนวนลูกที่เก็บ (kh) เปลี่ยนตามด้วย 1 (ยกเว้นที่ระบุ)
 *  - เต๋าเหลืออย่างน้อย 1 ลูกเสมอ
 */

const SKILLS_VERSION = 'v1';

// ---------------- Passive (เลือก 1 จาก 3 ตามคลาส) ----------------
// kind: 'trigger' = ทำงานเมื่อเข้าเงื่อนไข · 'fixed' = แก้ตารางถาวร
const PASSIVES = {
  // ===== Front =====
  catchMe: {
    name: 'Catch Me If You Can', emoji: '💨', cls: 'Front', kind: 'trigger',
    desc: 'นำอันดับ 1 และห่างอันดับ 2 เกิน 9 แต้ม → +5',
    bonus: 5, gapOver: 9,
  },
  measuredFury: {
    name: 'Measured Fury', emoji: '🔥', cls: 'Front', kind: 'fixed',
    desc: 'Gold เฟส 4: d30 → 2d30 · แต่ Gold เฟส 2–3: 5d30kh3 → 4d30kh3',
    override: { gold: { 2: '4d30kh3', 3: '4d30kh3', 4: '2d30' } },
  },
  riseAshes: {
    name: 'Rise From the Ashes', emoji: '🐦‍🔥', cls: 'Front', kind: 'trigger',
    desc: 'เฟส 2–4 อยู่นอก 3 อันดับแรก → +7',
    bonus: 7, minPhase: 2, rankOver: 3,
  },

  // ===== Pace =====
  slipstream: {
    name: 'Slipstream', emoji: '🌬️', cls: 'Pace', kind: 'trigger',
    desc: 'ม้าข้างหน้าห่างไม่เกิน 5 แต้ม → เพิ่มเต๋า 1 ลูก (ลูกที่เก็บเท่าเดิม)',
    gapMax: 5,
  },
  ironWithin: {
    name: 'Iron Within', emoji: '⚙️', cls: 'Pace', kind: 'fixed',
    desc: 'White เฟส 2–3: 2d30 → 3d30kh2 · แต่ Gold เฟส 4: 6d30kh3 → 5d30kh3',
    override: { white: { 2: '3d30kh2', 3: '3d30kh2' }, gold: { 4: '5d30kh3' } },
  },
  crowdReader: {
    name: 'Crowd Reader', emoji: '👥', cls: 'Pace', kind: 'trigger',
    desc: 'มีม้าอย่างน้อย 3 ตัวห่างไม่เกิน 9 แต้ม (หน้า+หลัง) → +5',
    bonus: 5, range: 9, minCount: 3,
  },

  // ===== Late =====
  gatheringStorm: {
    name: 'Gathering Storm', emoji: '⛈️', cls: 'Late', kind: 'trigger',
    desc: 'เฟส 1–2 อยู่ White สะสม +2/เทิร์น (สูงสุด +8) → ปล่อยทั้งหมดเทิร์นแรกที่อยู่ Gold ในเฟส 3–4',
    perTurn: 2, cap: 8,
  },
  bestYetToCome: {
    name: 'The Best Is Yet to Come', emoji: '🎷', cls: 'Late', kind: 'fixed',
    desc: 'Gold เฟส 4: 3d30 → 5d30kh3 · แต่ Gold เฟส 3: 8d30kh3 → 6d30kh3',
    override: { gold: { 3: '6d30kh3', 4: '5d30kh3' } },
  },
  wildHunt: {
    name: 'The Wild Hunt', emoji: '🏹', cls: 'Late', kind: 'trigger',
    desc: 'เฟส 3–4 ตามหลังอันดับ 1 อยู่ 10–30 แต้ม → +6',
    bonus: 6, minPhase: 3, gapMin: 10, gapMax: 30,
  },

  // ===== End =====
  supernova: {
    name: 'Supernova', emoji: '🌟', cls: 'End', kind: 'fixed',
    desc: 'เฟส 3 เพิ่มเต๋า 1 ลูกทั้งสองโซน · แต่เฟส 2 ลดเต๋า 1 ลูกทั้งสองโซน',
    override: { white: { 2: 'd30', 3: '6d30' }, gold: { 2: 'd30', 3: '7d30' } },
  },
  loneWolf: {
    name: 'Lone Wolf', emoji: '🐺', cls: 'End', kind: 'trigger',
    desc: 'เฟส 4 อยู่ White → เพิ่มเต๋า 1 ลูก (d30 → 2d30)',
    phase: 4,
  },
  vendetta: {
    name: 'Vendetta', emoji: '🗡️', cls: 'End', kind: 'trigger',
    desc: 'เทิร์นที่แล้วโดนสกิลแดงหรือไพ่ตายโจมตี → +8',
    bonus: 8,
  },
};

// ---------------- Active / ไพ่ตาย (เลือก 1 ใบ ใช้ได้ครั้งเดียว) ----------------
// timing: 'pre' = ใช้ก่อนทอย · 'post' = ใช้หลังทอย · 'any' = เมื่อไหร่ก็ได้ในเทิร์น
const ACTIVES = {
  overdrive: {
    name: 'Overdrive', emoji: '🚀', timing: 'pre', group: 'เติมแต้มตัวเอง',
    desc: 'เทิร์นนี้เพิ่มเต๋า 1 ลูก',
    dice: 1,
  },
  damageControl: {
    name: 'Damage Control', emoji: '🩹', timing: 'post', group: 'อุดรอยรั่ว',
    desc: 'ผลทอยต่ำกว่าค่าเฉลี่ยของสูตร → เติมครึ่งหนึ่งของส่วนที่ขาด',
  },
  allOrNothing: {
    name: 'All or Nothing', emoji: '🎰', timing: 'pre', group: 'เติมแต้มตัวเอง',
    desc: 'เทิร์นนี้ +2 ลูก เทิร์นหน้า −1 ลูก (ลดไม่ได้ → −15) · ใช้เทิร์นสุดท้าย → −15 ทันที',
    dice: 2, nextDice: -1, fallback: 15,
  },
  luckyBreak: {
    name: 'Lucky Break', emoji: '🍀', timing: 'pre', group: 'เติมแต้มตัวเอง',
    desc: 'ลูกที่เก็บแต่ละลูกที่ออก 25+ ได้ +10 · ไม่มีเลย −10',
    face: 25, perDie: 10, miss: 10,
  },
  reservePower: {
    name: 'Reserve Power', emoji: '🔋', timing: 'pre', group: 'อ่านเกม',
    desc: 'เทิร์นนี้ −1 ลูก เทิร์นหน้า +1 ลูก (ห้ามใช้เทิร์นสุดท้าย / ต้องมีเต๋า 2 ลูกขึ้นไป)',
  },
  pocketSand: {
    name: 'Pocket Sand', emoji: '🏜️', timing: 'any', group: 'โจมตี', attack: true, needsTarget: true,
    desc: 'ม้าที่ห่างไม่เกิน 9 แต้ม: เทิร์นหน้าลดเต๋า 2 ลูก (ลดไม่ได้ลูกละ −10)',
    range: 9, nextDice: -2, fallback: 10,
  },
  ironHalo: {
    name: 'Iron Halo', emoji: '🛡️', timing: 'any', group: 'ตั้งรับ', silent: true,
    desc: 'เปิดแบบเงียบ — กันสกิลแดง/ไพ่ตายโจมตีครั้งแรกที่โดน (ครั้งเดียว ไม่สะท้อน)',
  },
  ghostProtocol: {
    name: 'Ghost Protocol', emoji: '👻', timing: 'pre', group: 'อ่านเกม', needsZone: true,
    desc: 'เทิร์นนี้เลือกทอยสูตร White หรือ Gold เอง (ห้ามใช้เทิร์นแรก)',
  },
  hailMary: {
    name: 'Hail Mary', emoji: '🏈', timing: 'post', group: 'พลิกเกม',
    desc: 'เฟส 4 อยู่นอก 3 อันดับแรก: ทอยสูตรเดิมอีกชุด บวกครึ่งหนึ่ง',
    phase: 4, rankOver: 3,
  },
  doppelganger: {
    name: 'Doppelgänger', emoji: '🎭', timing: 'pre', group: 'อ่านเกม', needsTarget: true,
    desc: 'ม้าต่างคลาสที่ห่างไม่เกิน 9 แต้ม: ทอยสูตรตัวเอง + สูตรคลาสนั้น แล้วเอาค่าเฉลี่ย',
    range: 9,
  },
};

const RED_SKILL_BASE = 20;

function passivesOf(cls) {
  return Object.entries(PASSIVES).filter(([, p]) => p.cls === cls).map(([id]) => id);
}

module.exports = { SKILLS_VERSION, PASSIVES, ACTIVES, RED_SKILL_BASE, passivesOf };
