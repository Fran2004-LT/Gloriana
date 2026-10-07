'use strict';

/**
 * trainSystem.js
 * ระบบส่งบทฝึก + approve/reject (เก็บใน DB — รหัส TRN ไม่รีเซ็ตตอน restart)
 *
 * train-submit  → 1511602866631217173  (ผู้เล่นส่ง + รับผลกลับ)
 * train-review  → 1498223895227138158  (สตาฟ private)
 *
 * รางวัล:
 *  - สาวม้า: ⚡ One-use Reroll +1 ถ้าฝึกกับคนที่มีความสัมพันธ์ (สูงสุด +1 ต่อการฝึก)
 *  - เทรนเนอร์: 🎯 Trainer Reroll จากการฝึก
 *  - ฝึกคนเดียว: 🛡️ Race Safe +1
 */

const { addItem }           = require('../inventory/inventoryStore');
const { checkTrainingBond } = require('../character/relations');
const db                    = require('../db');

const CHANNELS = {
  submit: '1511602866631217173',
  review: '1498223895227138158',
};

const TYPE_NAMES = {
  solo:        'ฝึกคนเดียว',
  withTrainer: 'ฝึกกับเทรนเนอร์',
  group:       'ฝึกกับสาวม้าคนอื่น',
  hillClear:   'ล้าง Hill Debuff',
  zoneUnlock:  'Unlock Zone',
};

// รางวัลเทรนเนอร์ตามประเภท (ถ้ามีเทรนเนอร์ร่วมฝึก)
const TRAINER_REWARD = { withTrainer: 1, group: 2 };

/**
 * ตรวจข้อมูลก่อนสร้าง — คืนข้อความ error หรือ null
 */
function validateSubmission({ type, umaId, partnerId, trainerId }) {
  if (!TYPE_NAMES[type]) return 'ประเภทการฝึกไม่ถูกต้อง';
  if (type === 'withTrainer' && !trainerId) return 'ฝึกกับเทรนเนอร์ต้องระบุ `trainer`';
  if (type === 'group' && !partnerId)       return 'ฝึกกับสาวม้าคนอื่นต้องระบุ `partner`';
  if (partnerId && partnerId === umaId)     return 'partner ต้องเป็นคนอื่น ไม่ใช่ตัวเอง';
  if (trainerId && trainerId === umaId)     return 'trainer ต้องเป็นคนอื่น ไม่ใช่ตัวเอง';
  return null;
}

async function createSubmission(data) {
  const err = validateSubmission(data);
  if (err) throw new Error(err);
  return db.createSubmissionDB(data);
}

/**
 * คำนวณรางวัลของบทฝึก (ยังไม่แจกของ)
 * @returns {Promise<Array<{ userId, role, items: {type,amount}[], reasons?: string[], noCharacter?: boolean }>>}
 */
async function computeRewards(sub) {
  const out = [];

  if (sub.type === 'solo') {
    out.push({ userId: sub.umaId, role: 'uma', items: [{ type: 'raceSafe', amount: 1 }] });
    return out;
  }
  if (sub.type === 'hillClear') {
    out.push({ userId: sub.umaId, role: 'uma', items: [{ type: 'hillClearItem', amount: 1 }] });
    return out;
  }
  if (sub.type === 'zoneUnlock') {
    out.push({ userId: sub.umaId, role: 'uma', items: [{ type: 'zoneUnlock', amount: 1 }] });
    return out;
  }

  // withTrainer / group → สาวม้าทุกคนในบทฝึกเช็คความสัมพันธ์ของตัวเอง (สูงสุด +1 ต่อคน)
  const umas = [sub.umaId, sub.partnerId].filter(Boolean);
  for (const umaId of umas) {
    const partnerId = umaId === sub.umaId ? sub.partnerId : sub.umaId;
    const bond = await checkTrainingBond(umaId, { trainerId: sub.trainerId, partnerId });
    out.push({
      userId: umaId, role: 'uma',
      items: bond.qualifies ? [{ type: 'reroll.oneUse', amount: 1 }] : [],
      reasons: bond.reasons, noCharacter: bond.noCharacter,
    });
  }

  if (sub.trainerId && TRAINER_REWARD[sub.type]) {
    out.push({ userId: sub.trainerId, role: 'trainer', items: [{ type: 'reroll.trainer', amount: TRAINER_REWARD[sub.type] }] });
  }
  return out;
}

/**
 * approve → เปลี่ยนสถานะ (atomic) แล้วแจกรางวัล
 */
async function approveSubmission(id) {
  const sub     = await db.settleSubmissionDB(id, 'approved');
  const rewards = await computeRewards(sub);
  for (const r of rewards) {
    for (const it of r.items) await addItem(r.userId, it.type, it.amount);
  }
  return { submission: sub, rewards };
}

async function rejectSubmission(id, reason = '') {
  return db.settleSubmissionDB(id, 'rejected', reason || null);
}

async function getPendingList() {
  return db.listPendingSubmissionsDB();
}

/**
 * format รางวัลเป็น string
 */
const ITEM_NAMES = {
  'raceSafe':       '🛡️ Race Safe',
  'reroll.trainer': '🎯 Trainer Reroll',
  'reroll.oneUse':  '⚡ One-use Reroll',
  'hillClearItem':  '🏔️ Hill Clear',
  'zoneUnlock':     '🌀 Zone Unlock',
};

function formatItems(items) {
  if (!items.length) return 'ไม่มีรางวัล';
  return items.map(i =>
    (i.type === 'hillClearItem' || i.type === 'zoneUnlock')
      ? ITEM_NAMES[i.type]
      : `${ITEM_NAMES[i.type] || i.type} +${i.amount}`
  ).join(', ');
}

module.exports = {
  CHANNELS, TYPE_NAMES, TRAINER_REWARD,
  validateSubmission, createSubmission, computeRewards,
  approveSubmission, rejectSubmission, getPendingList,
  formatItems,
};
