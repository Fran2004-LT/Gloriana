'use strict';

const { randomInt } = require('crypto');
const { parseNotation } = require('./diceParser');

/**
 * diceRoller.js
 * รับ notation string → ทอยด้วย crypto.randomInt → return result object
 *
 * @typedef {Object} RollResult
 * @property {string}   notation  - notation ที่ใช้
 * @property {number[]} rolls     - ผลทอยทั้งหมด (ก่อน keep)
 * @property {number[]} chosen    - ตัวที่เลือกใช้
 * @property {number[]} dropped   - ตัวที่ถูก drop
 * @property {number}   modifier  - modifier ที่ใช้
 * @property {number}   total     - ผลรวมสุดท้าย
 * @property {string}   display   - string แสดงผล เช่น "24, 18, ~~7~~"
 */

/**
 * สุ่มเลข 1 ถึง sides
 * @param {number} sides
 * @returns {number}
 */
function rollOne(sides) {
  return randomInt(1, sides + 1);
}

/**
 * จัดการ reroll ตาม type
 * ro = reroll once (ถ้าได้ <= threshold ทอยใหม่ 1 ครั้ง)
 * rr = reroll replace (ทอยใหม่จนกว่าจะได้มากกว่า threshold)
 * @param {number} sides
 * @param {{ type: string, threshold: number }} reroll
 * @returns {number}
 */
function rollWithReroll(sides, reroll) {
  let result = rollOne(sides);
  if (result <= reroll.threshold) {
    result = rollOne(sides); // ทอยใหม่ 1 ครั้ง (ทั้ง ro และ rr ทอยใหม่ครั้งเดียว)
  }
  return result;
}

/**
 * ทอย dice ตาม parsed notation
 * @param {import('./diceParser').ParsedDice} parsed
 * @returns {number[]} ผลทอยทั้งหมด
 */
function rollAll(parsed) {
  const results = [];
  for (let i = 0; i < parsed.count; i++) {
    let val = parsed.reroll
      ? rollWithReroll(parsed.sides, parsed.reroll)
      : rollOne(parsed.sides);

    // apply min/max per die
    if (parsed.minPerDie !== null) val = Math.max(val, parsed.minPerDie);
    if (parsed.maxPerDie !== null) val = Math.min(val, parsed.maxPerDie);

    results.push(val);
  }
  return results;
}

/**
 * แยก chosen กับ dropped จาก rolls ตาม keep rule
 * @param {number[]} rolls
 * @param {import('./diceParser').ParsedDice['keep']} keep
 * @returns {{ chosen: number[], dropped: number[] }}
 */
function applyKeep(rolls, keep) {
  if (!keep) {
    return { chosen: [...rolls], dropped: [] };
  }

  // จับคู่ index ไว้เพื่อ track ตัวไหน drop
  const indexed = rolls.map((val, idx) => ({ val, idx }));

  const sorted = [...indexed].sort((a, b) =>
    keep.type === 'h' ? b.val - a.val : a.val - b.val
  );

  const keptSet = new Set(
    sorted.slice(0, keep.count).map(x => x.idx)
  );

  const chosen  = [];
  const dropped = [];

  indexed.forEach(({ val, idx }) => {
    if (keptSet.has(idx)) chosen.push(val);
    else dropped.push(val);
  });

  return { chosen, dropped };
}

/**
 * สร้าง display string แบบ Avrae
 * dropped จะถูกแสดงด้วย ~~strikethrough~~
 * ลำดับ: chosen ก่อน แล้วตามด้วย dropped
 * @param {number[]} chosen
 * @param {number[]} dropped
 * @returns {string}
 */
function formatDisplay(chosen, dropped) {
  const chosenStr  = chosen.map(n => `${n}`);
  const droppedStr = dropped.map(n => `~~${n}~~`);
  const parts = [...chosenStr, ...droppedStr];
  return parts.length > 0 ? parts.join(', ') : '0';
}

/**
 * ทอย dice จาก notation string
 * @param {string} notation - เช่น "3d30kh2", "7d30kh4-40", "d30"
 * @returns {RollResult}
 */
function roll(notation) {
  const parsed = parseNotation(notation);
  const rolls  = rollAll(parsed);
  const { chosen, dropped } = applyKeep(rolls, parsed.keep);

  const sum     = chosen.reduce((a, b) => a + b, 0);
  const total   = sum + parsed.modifier;
  const display = formatDisplay(chosen, dropped);

  return {
    notation: parsed.raw,
    rolls,
    chosen,
    dropped,
    modifier: parsed.modifier,
    total,
    display,
  };
}

module.exports = { roll };
