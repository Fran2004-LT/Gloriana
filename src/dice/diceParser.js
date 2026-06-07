'use strict';

/**
 * diceParser.js
 * แปลง dice notation string → structured object
 * รองรับ: NdM, kh/kl, ro/rr, mi/ma, modifier (+/-)
 *
 * ตัวอย่าง:
 *   "3d30kh2"        → { count:3, sides:30, keep:{type:'h',count:2}, ... }
 *   "7d30kh4-40"     → { count:7, sides:30, keep:{type:'h',count:4}, modifier:-40 }
 *   "2d30kh1"        → { count:2, sides:30, keep:{type:'h',count:1}, ... }
 *   "4d6ro1"         → { count:4, sides:6, reroll:{type:'o',threshold:1}, ... }
 *   "10d6mi2"        → { count:10, sides:6, minPerDie:2, ... }
 */

/**
 * @typedef {Object} ParsedDice
 * @property {number}   count       - จำนวนลูกเต๋า
 * @property {number}   sides       - หน้าลูกเต๋า
 * @property {Object|null} keep     - { type: 'h'|'l', count: number } หรือ null
 * @property {Object|null} reroll   - { type: 'o'|'r', threshold: number } หรือ null
 * @property {number|null} minPerDie - minimum per die (mi)
 * @property {number|null} maxPerDie - maximum per die (ma)
 * @property {number}   modifier    - ตัวบวก/ลบท้าย (+5, -40 ฯลฯ)
 * @property {string}   raw         - notation ต้นฉบับ
 */

/**
 * parse dice notation string
 * @param {string} notation
 * @returns {ParsedDice}
 * @throws {Error} ถ้า notation ไม่ถูกต้อง
 */
function parseNotation(notation) {
  if (typeof notation !== 'string' || !notation.trim()) {
    throw new Error('Notation must be a non-empty string');
  }

  const raw = notation.trim().toLowerCase();

  // regex หลัก: จับ NdM + optional modifiers
  // กลุ่ม: (count)d(sides)(keep?)(reroll?)(minmax?)(modifier?)
  const pattern = /^(\d*)d(\d+)(kh\d+|kl\d+)?(ro\d+|rr\d+)?(mi\d+|ma\d+)?([+-]\d+)?$/;
  const match = raw.match(pattern);

  if (!match) {
    throw new Error(`Invalid dice notation: "${notation}"`);
  }

  const [, countStr, sidesStr, keepStr, rerollStr, minmaxStr, modStr] = match;

  const count    = countStr ? parseInt(countStr, 10) : 1;
  const sides    = parseInt(sidesStr, 10);
  const modifier = modStr ? parseInt(modStr, 10) : 0;

  if (count < 1)   throw new Error(`Dice count must be at least 1: "${notation}"`);
  if (sides < 2)   throw new Error(`Dice sides must be at least 2: "${notation}"`);
  if (count > 100) throw new Error(`Dice count too high (max 100): "${notation}"`);

  // keep highest / keep lowest
  let keep = null;
  if (keepStr) {
    const type     = keepStr[1]; // 'h' or 'l'
    const keepCount = parseInt(keepStr.slice(2), 10);
    if (keepCount < 1 || keepCount >= count) {
      throw new Error(`Keep count must be between 1 and ${count - 1}: "${notation}"`);
    }
    keep = { type, count: keepCount };
  }

  // reroll once (ro) / reroll replace (rr)
  let reroll = null;
  if (rerollStr) {
    const type      = rerollStr[1]; // 'o' or 'r'
    const threshold = parseInt(rerollStr.slice(2), 10);
    if (threshold < 1 || threshold >= sides) {
      throw new Error(`Reroll threshold must be between 1 and ${sides - 1}: "${notation}"`);
    }
    reroll = { type, threshold };
  }

  // min/max per die
  let minPerDie = null;
  let maxPerDie = null;
  if (minmaxStr) {
    const mmType = minmaxStr.slice(0, 2); // 'mi' or 'ma'
    const mmVal  = parseInt(minmaxStr.slice(2), 10);
    if (mmType === 'mi') minPerDie = mmVal;
    else                 maxPerDie = mmVal;
  }

  return { count, sides, keep, reroll, minPerDie, maxPerDie, modifier, raw };
}

module.exports = { parseNotation };
