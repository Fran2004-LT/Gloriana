'use strict';

/**
 * inventoryStore.js
 * เก็บ inventory ของผู้เล่นทุกคน (in-memory)
 * โครงสร้างพร้อม migrate ไป DB ได้ทีหลัง
 */

// userId → inventory object
const store = new Map();

const DEFAULT_INVENTORY = {
  // Currency
  gold: 0,
  rc:   0,

  // Reroll
  reroll: {
    main:    1,   // ทุกคนมี 1 เสมอ ไม่หมด
    oneUse:  0,
    trainer: 0,
  },

  // Safe
  raceSafe: 0,

  // Streak
  streak: {
    current: 0,
    lastClaim: null,   // ISO date string
  },

  // Role
  roles: [],   // ['uma', 'trainer'] หรือทั้งคู่

  // Items
  hillClearItem: false,  // ใช้แล้วหมดไป
  zoneUnlocked:  false,  // unlock แล้วอยู่ตลอด

  // Stats
  stats: {
    g1Wins:  0,
    g2Wins:  0,
    g3Wins:  0,
    races:   0,
  },
};

function getInventory(userId) {
  if (!store.has(userId)) {
    store.set(userId, JSON.parse(JSON.stringify(DEFAULT_INVENTORY)));
  }
  return store.get(userId);
}

function setInventory(userId, data) {
  store.set(userId, data);
}

/**
 * เพิ่ม/ลด item
 * type: 'gold' | 'rc' | 'reroll.main' | 'reroll.oneUse' | 'reroll.trainer' | 'raceSafe'
 */
function addItem(userId, type, amount) {
  const inv = getInventory(userId);

  if (type === 'gold')               inv.gold += amount;
  else if (type === 'rc')             inv.rc   += amount;
  else if (type === 'raceSafe')       inv.raceSafe += amount;
  else if (type === 'hillClearItem')  inv.hillClearItem = true;
  else if (type === 'zoneUnlock')     inv.zoneUnlocked  = true;
  else if (type === 'reroll.main')    inv.reroll.main    += amount;
  else if (type === 'reroll.oneUse')  inv.reroll.oneUse  += amount;
  else if (type === 'reroll.trainer') inv.reroll.trainer += amount;
  else throw new Error(`Unknown item type: ${type}`);

  // Main reroll ไม่ต่ำกว่า 1
  if (type === 'reroll.main' && inv.reroll.main < 1) inv.reroll.main = 1;

  return inv;
}

/**
 * ใช้ item (ลด count)
 * throw ถ้าไม่พอ
 */
function useItem(userId, type, amount = 1) {
  const inv = getInventory(userId);
  let current;

  if (type === 'reroll.main')         current = inv.reroll.main;
  else if (type === 'reroll.oneUse')  current = inv.reroll.oneUse;
  else if (type === 'reroll.trainer') current = inv.reroll.trainer;
  else if (type === 'raceSafe')       current = inv.raceSafe;
  else throw new Error(`Unknown item type: ${type}`);

  // Main reroll ขั้นต่ำ 1 ใช้ได้เสมอแต่ไม่ลดต่ำกว่า 1
  if (type === 'reroll.main') return inv; // main ไม่ลด count

  if (current < amount) {
    const names = {
      'reroll.oneUse':  'One-use Reroll',
      'reroll.trainer': 'Trainer Reroll',
      'raceSafe':       'Race Safe',
    };
    throw new Error(`ไม่มี ${names[type]} เหลือพอ`);
  }

  if (type === 'reroll.oneUse')       inv.reroll.oneUse  -= amount;
  else if (type === 'reroll.trainer') inv.reroll.trainer -= amount;
  else if (type === 'raceSafe')       inv.raceSafe       -= amount;

  return inv;
}

/**
 * set role ของผู้เล่น
 */
function setRole(userId, role) {
  const inv = getInventory(userId);
  if (!inv.roles.includes(role)) inv.roles.push(role);
  return inv;
}

/**
 * unlock zone
 */
function unlockZone(userId) {
  const inv = getInventory(userId);
  inv.zoneUnlocked = true;
  return inv;
}

/**
 * บันทึก win
 */
function recordWin(userId, grade) {
  const inv = getInventory(userId);
  if (grade === 'G1') {
    inv.stats.g1Wins++;
    addItem(userId, 'reroll.main', 1); // ชนะ G1 ได้ main reroll เพิ่ม
  }
  else if (grade === 'G2') inv.stats.g2Wins++;
  else if (grade === 'G3') inv.stats.g3Wins++;
  inv.stats.races++;
  return inv;
}

module.exports = {
  getInventory, setInventory,
  addItem, useItem,
  setRole, unlockZone, recordWin,
};
