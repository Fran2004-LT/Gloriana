'use strict';

/**
 * relations.js
 * ความสัมพันธ์ตามลอร์ม้าจริง → ใช้ตัดสินว่าการฝึกได้ One-use Reroll +1 หรือไม่
 *
 * ได้ +1 เมื่อเข้าเงื่อนไขอย่างใดอย่างหนึ่ง (สูงสุด +1 ต่อการฝึก แม้เข้าหลายข้อ):
 *  - TRAINER           ฝึกกับ Trainer ของตัวละคร
 *  - SAME_TRAINER_TEAM อยู่ทีม Trainer เดียวกัน
 *  - SIBLING / PARENT_CHILD / RIVAL / BREEDING_PARTNER / CLOSE_FRIEND (สตาฟบันทึกไว้)
 */

const db = require('../db');

// ความสัมพันธ์ที่สตาฟบันทึกได้ (TRAINER / SAME_TRAINER_TEAM คำนวณจาก trainer_id อัตโนมัติ)
const RELATION_TYPES = {
  SIBLING:          '👭 พี่น้อง',
  PARENT_CHILD:     '👪 พ่อแม่–ลูก',
  RIVAL:            '⚔️ คู่ปรับ',
  BREEDING_PARTNER: '💞 คู่ผสมพันธุ์',
  CLOSE_FRIEND:     '🤝 เพื่อนสนิท',
};

const AUTO_LABELS = {
  TRAINER:           '👤 Trainer ของตัวเอง',
  SAME_TRAINER_TEAM: '🏠 ทีม Trainer เดียวกัน',
};

function relationLabel(type) {
  return RELATION_TYPES[type] || AUTO_LABELS[type] || type;
}

/**
 * เช็คว่าสาวม้า umaId ฝึกครั้งนี้แล้วได้ Reroll +1 หรือไม่
 * @param {string} umaId
 * @param {{ trainerId?: string|null, partnerId?: string|null }} with
 * @returns {Promise<{ qualifies: boolean, reasons: string[], noCharacter: boolean }>}
 */
async function checkTrainingBond(umaId, { trainerId = null, partnerId = null } = {}) {
  const me = await db.getCharacterDB(umaId);
  if (!me) return { qualifies: false, reasons: [], noCharacter: true };

  const reasons = [];

  if (trainerId && me.trainerId && trainerId === me.trainerId) reasons.push('TRAINER');

  if (partnerId && partnerId !== umaId) {
    const partner = await db.getCharacterDB(partnerId);
    if (partner && me.trainerId && partner.trainerId === me.trainerId) reasons.push('SAME_TRAINER_TEAM');
    const lore = await db.getRelationshipsBetweenDB(umaId, partnerId);
    reasons.push(...lore);
  }

  // สูงสุด +1 — แค่มีข้อใดข้อหนึ่งก็พอ
  return { qualifies: reasons.length > 0, reasons, noCharacter: false };
}

module.exports = { RELATION_TYPES, AUTO_LABELS, relationLabel, checkTrainingBond };
