'use strict';

const { getInventoryDB, saveInventoryDB } = require('../db');

// cache in-memory — เก็บเฉพาะ session ปัจจุบัน
const cache = new Map();

async function getInventory(userId) {
  if (!cache.has(userId)) {
    const inv = await getInventoryDB(userId);
    cache.set(userId, inv);
  }
  return cache.get(userId);
}

async function saveInventory(userId) {
  const inv = cache.get(userId);
  if (inv) {
    await saveInventoryDB(userId, inv);
    // clear cache หลัง save เพื่อให้ครั้งถัดไปดึงจาก DB ใหม่เสมอ
    cache.delete(userId);
  }
}

/**
 * เพิ่ม item
 */
async function addItem(userId, type, amount) {
  const inv = await getInventory(userId);

  if (type === 'gold')              inv.gold += amount;
  else if (type === 'rc')           inv.rc   += amount;
  else if (type === 'raceSafe')     inv.raceSafe += amount;
  else if (type === 'hillClearItem') inv.hillClearItem = true;
  else if (type === 'zoneUnlock')   inv.zoneUnlocked  = true;
  else if (type === 'reroll.main')    inv.reroll.main    += amount;
  else if (type === 'reroll.oneUse')  inv.reroll.oneUse  += amount;
  else if (type === 'reroll.trainer') inv.reroll.trainer += amount;
  else throw new Error(`Unknown item type: ${type}`);

  if (type === 'reroll.main' && inv.reroll.main < 1) inv.reroll.main = 1;

  await saveInventory(userId);
  return inv;
}

/**
 * ใช้ item
 */
async function useItem(userId, type, amount = 1) {
  const inv = await getInventory(userId);
  let current;

  if (type === 'reroll.main')         current = inv.reroll.main;
  else if (type === 'reroll.oneUse')  current = inv.reroll.oneUse;
  else if (type === 'reroll.trainer') current = inv.reroll.trainer;
  else if (type === 'raceSafe')       current = inv.raceSafe;
  else throw new Error(`Unknown item type: ${type}`);

  if (type === 'reroll.main') {
    if (current <= 0) throw new Error('ไม่มี Main Reroll เหลือแล้ว');
    inv.reroll.main--;
    if (inv.reroll.main < 1) inv.reroll.main = 1; // ขั้นต่ำ 1 เสมอ
    await saveInventory(userId);
    return inv;
  }

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

  await saveInventory(userId);
  return inv;
}

async function setRole(userId, role) {
  const inv = await getInventory(userId);
  if (!inv.roles.includes(role)) inv.roles.push(role);
  await saveInventory(userId);
  return inv;
}

async function unlockZone(userId) {
  const inv = await getInventory(userId);
  inv.zoneUnlocked = true;
  await saveInventory(userId);
  return inv;
}

async function recordWin(userId, grade) {
  const inv = await getInventory(userId);
  if (grade === 'G1') { inv.stats.g1Wins++; await addItem(userId, 'reroll.main', 1); }
  else if (grade === 'G2') inv.stats.g2Wins++;
  else if (grade === 'G3') inv.stats.g3Wins++;
  inv.stats.races++;
  await saveInventory(userId);
  return inv;
}

module.exports = {
  getInventory, saveInventory,
  addItem, useItem,
  setRole, unlockZone, recordWin,
};
