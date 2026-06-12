'use strict';

/**
 * dailyStreak.js
 * Daily streak system — reset ตี 4 ไทย (UTC+7)
 */

const { addItem, getInventory, saveInventory } = require('../inventory/inventoryStore');

// รางวัลแต่ละวัน
const STREAK_REWARDS = {
  1: [{ type: 'gold',           amount: 200  }],
  2: [{ type: 'gold',           amount: 400  }],
  3: [{ type: 'gold',           amount: 600  }],
  4: [{ type: 'gold',           amount: 800  }],
  5: [{ type: 'gold',           amount: 1000 }, { type: 'raceSafe',        amount: 1 }],
  6: [{ type: 'gold',           amount: 1500 }, { type: 'reroll.oneUse',   amount: 1 }],
  7: [{ type: 'rc',             amount: 50   }],
};

/**
 * เช็คว่า claim ได้มั้ยวันนี้
 * reset ตี 4 ไทย = UTC+7 = offset 7*60 = 420 นาที
 */
function getTodayReset() {
  const now      = new Date();
  const utcMs    = now.getTime() + now.getTimezoneOffset() * 60000;
  const thaiMs   = utcMs + 7 * 3600000; // Thai time
  const thai     = new Date(thaiMs);

  // ถ้าก่อนตี 4 → reset วันก่อน
  const resetDate = new Date(thai);
  if (thai.getHours() < 4) {
    resetDate.setDate(resetDate.getDate() - 1);
  }
  resetDate.setHours(4, 0, 0, 0);

  return resetDate.toISOString().split('T')[0]; // YYYY-MM-DD
}

/**
 * Claim daily streak
 * return { success, day, rewards, streak }
 */
async function claimDaily(userId) {
  const inv     = getInventory(userId);
  const today   = getTodayReset();
  // guard — user เก่าอาจไม่มี streak object ใน DB
  if (!inv.streak) inv.streak = { current: 0, lastClaim: null };
  const lastDay = inv.streak.lastClaim;

  // เช็คว่า claim วันนี้แล้วหรือยัง
  if (lastDay === today) {
    throw new Error('คุณ claim แล้ววันนี้ รอ reset ตี 4 ครับ');
  }

  // เช็คว่า streak ขาดไหม (claim เมื่อวาน = ต่อ streak)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  if (lastDay !== yesterdayStr) {
    inv.streak.current = 0; // reset streak
  }

  // เพิ่ม streak
  inv.streak.current = (inv.streak.current % 7) + 1;
  inv.streak.lastClaim = today;

  const day     = inv.streak.current;
  const rewards = STREAK_REWARDS[day] || STREAK_REWARDS[1];

  // ให้รางวัล
  for (const r of rewards) {
    addItem(userId, r.type, r.amount);
  }

  // บันทึก streak ลง DB
  await saveInventory(userId);

  return { success: true, day, rewards, streak: inv.streak.current };
}

/**
 * format รางวัลเป็น string
 */
function formatRewards(rewards) {
  const names = {
    gold:            '💰 Gold',
    rc:              '🌈 RC',
    raceSafe:        '🛡️ Race Safe',
    'reroll.oneUse': '⚡ One-use Reroll',
    'reroll.main':   '🔁 Main Reroll',
  };
  return rewards.map(r => `${names[r.type] || r.type} +${r.amount}`).join('\n');
}

module.exports = { claimDaily, formatRewards, STREAK_REWARDS };
