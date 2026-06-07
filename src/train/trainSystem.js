'use strict';

/**
 * trainSystem.js
 * ระบบส่งบทฝึก + approve/reject
 *
 * train-submit  → 1511602866631217173  (ผู้เล่นส่ง + รับผลกลับ)
 * train-review  → 1498223895227138158  (สตาฟ private)
 */

const { addItem } = require('../inventory/inventoryStore');

const CHANNELS = {
  submit: '1511602866631217173',
  review: '1498223895227138158',
};

// pending submissions: submitId → data
const pending = new Map();
let nextId = 1;

/**
 * ประเภทการฝึก → รางวัล
 */
const TRAIN_REWARDS = {
  solo: {                          // ฝึกคนเดียว/ไม่มีเทรนเนอร์
    uma:     [{ type: 'raceSafe',        amount: 1 }],
    trainer: [],
  },
  withTrainer: {                   // คุยกับเทรนเนอร์ 3 บรรทัด + 3 เทิร์น
    uma:     [{ type: 'reroll.trainer',  amount: 1 }],
    trainer: [{ type: 'reroll.trainer',  amount: 1 }],
  },
  group: {                         // ฝึกคู่/กลุ่ม (มีเทรนเนอร์)
    uma:     [{ type: 'reroll.trainer',  amount: 2 }],
    trainer: [{ type: 'reroll.trainer',  amount: 2 }],
  },
  hillClear: {                     // ล้าง hill debuff Nakayama
    uma:     [],
    trainer: [],
    special: 'hillClear',
  },
  zoneUnlock: {                    // unlock Zone G1
    uma:     [],
    trainer: [],
    special: 'zoneUnlock',
  },
};

/**
 * สร้าง submission ใหม่
 */
function createSubmission(data) {
  const id = `TRN-${String(nextId++).padStart(4, '0')}`;
  pending.set(id, {
    id,
    status:      'pending',
    trainerId:   data.trainerId,
    trainerName: data.trainerName,
    umaId:       data.umaId,
    umaName:     data.umaName,
    type:        data.type,       // solo/withTrainer/group/hillClear/zoneUnlock
    location:    data.location,
    link:        data.link,
    submittedBy: data.submittedBy,
    submittedAt: new Date().toISOString(),
    reviewMsgId: null,   // message ID ใน train-review
    submitMsgId: null,   // message ID ใน train-submit
  });
  return pending.get(id);
}

/**
 * approve submission
 * return { submission, umaRewards, trainerRewards, special }
 */
function approveSubmission(id) {
  const sub = pending.get(id);
  if (!sub) throw new Error(`ไม่พบ submission ${id}`);
  if (sub.status !== 'pending') throw new Error(`submission ${id} ถูกจัดการไปแล้ว`);

  sub.status = 'approved';

  const rewardSet     = TRAIN_REWARDS[sub.type] || TRAIN_REWARDS.solo;
  const umaRewards     = rewardSet.uma     || [];
  const trainerRewards = rewardSet.trainer || [];
  const special        = rewardSet.special || null;

  // ให้รางวัล
  for (const r of umaRewards)     addItem(sub.umaId,     r.type, r.amount);
  for (const r of trainerRewards) addItem(sub.trainerId, r.type, r.amount);

  return { submission: sub, umaRewards, trainerRewards, special };
}

/**
 * reject submission
 */
function rejectSubmission(id, reason = '') {
  const sub = pending.get(id);
  if (!sub) throw new Error(`ไม่พบ submission ${id}`);
  if (sub.status !== 'pending') throw new Error(`submission ${id} ถูกจัดการไปแล้ว`);
  sub.status = 'rejected';
  sub.rejectReason = reason;
  return sub;
}

function getSubmission(id) {
  return pending.get(id) || null;
}

function getPendingList() {
  return [...pending.values()].filter(s => s.status === 'pending');
}

/**
 * format รางวัลเป็น string
 */
function formatRewards(rewards) {
  if (!rewards.length) return 'ไม่มีรางวัล';
  const names = {
    'raceSafe':        '🛡️ Race Safe',
    'reroll.trainer':  '🎯 Trainer Reroll',
    'reroll.oneUse':   '⚡ One-use Reroll',
    'reroll.main':     '🔁 Main Reroll',
  };
  return rewards.map(r => `${names[r.type] || r.type} +${r.amount}`).join('\n');
}

module.exports = {
  CHANNELS, TRAIN_REWARDS,
  createSubmission, approveSubmission, rejectSubmission,
  getSubmission, getPendingList,
  formatRewards,
};
