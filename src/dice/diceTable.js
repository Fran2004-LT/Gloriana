'use strict';

/**
 * diceTable.js
 * Dice table v3.3 + White/Gold logic
 * Gold zone threshold: ≤9 แต้ม
 */

const GOLD_THRESHOLD = 9;

// White dice table v3.3 [position][phase 1-4]
const WHITE = {
  Front: ['d30', '2d30', '3d30', '2d30'],
  Pace:  ['d30', '2d30', '2d30', '3d30'],
  Late:  ['d30', '2d30', '3d30', '2d30'],
  End:   ['d30', '2d30', '6d30', 'd30' ],
};

// Gold dice table v3.3 [position][phase 1-4]
const GOLD = {
  Front: ['3d30',     '3d30',     '3d30',     'd30'     ],
  Pace:  ['3d30kh2',  '6d30kh2',  '6d30kh2',  '6d30kh3' ],
  Late:  ['d30',      '6d30kh2',  '8d30kh3',  '3d30'    ],
  End:   ['d30',      'd30',      '6d30',     '3d30'    ],
};

/**
 * ดึง notation ที่ควรทอย
 * @param {string} position - Front/Pace/Late/End
 * @param {number} phase    - 1-4
 * @param {boolean} isGold  - ใช้ gold หรือ white
 * @returns {string} notation
 */
function getNotation(position, phase, isGold) {
  const table = isGold ? GOLD : WHITE;
  return table[position][phase - 1];
}

/**
 * เช็คว่า player อยู่ใน gold zone มั้ย
 * gold zone = ห่างจากม้าหน้า หรือ ม้าหลัง ≤ GOLD_THRESHOLD
 * @param {number} myScore
 * @param {number[]} allScores - คะแนนทุกคนในการแข่ง (sorted desc)
 * @returns {boolean}
 */
function isInGoldZone(myScore, allScores) {
  // ถ้ามีคนเดียว → ไม่มี gold zone
  if (allScores.length <= 1) return false;

  const sorted = [...allScores].sort((a, b) => b - a);
  const idx    = sorted.indexOf(myScore);

  // เช็คม้าหน้า
  if (idx > 0) {
    const diff = sorted[idx - 1] - myScore;
    if (diff <= GOLD_THRESHOLD) return true;
  }

  // เช็คม้าหลัง
  if (idx < sorted.length - 1) {
    const diff = myScore - sorted[idx + 1];
    if (diff <= GOLD_THRESHOLD) return true;
  }

  return false;
}

/**
 * ดึง notation ที่ถูกต้องสำหรับ player
 * รวม hill debuff ถ้ามี
 * @param {object} player   - { position, score }
 * @param {number} phase    - 1-4
 * @param {number[]} allScores
 * @param {object} options  - { hillDebuff: number, forceWhite: boolean }
 * @returns {{ notation: string, isGold: boolean }}
 */
function getPlayerNotation(player, phase, allScores, options = {}) {
  const { hillDebuff = 0, forceWhite = false, zoneEnabled = false } = options;

  // Zone (G1 only) = ทอย 2 ครั้งเอาดีกว่า → 2d30kh1
  if (zoneEnabled && !forceWhite) {
    return { notation: hillDebuff > 0 ? `2d30kh1-${hillDebuff}` : '2d30kh1', isGold: true };
  }

  const gold   = forceWhite ? false : isInGoldZone(player.score, allScores);
  let notation = getNotation(player.position, phase, gold);

  // ใส่ hill debuff ถ้ามี
  if (hillDebuff > 0) {
    notation = `${notation}-${hillDebuff}`;
  }

  return { notation, isGold: gold };
}

/**
 * Hill debuff ของ Nakayama (เฟส 3-4)
 */
const HILL_DEBUFF = {
  Front: 40,
  End:   30,
  Pace:  20,
  Late:  20,
};

function getHillDebuff(position, phase, track) {
  if (track !== 'Nakayama') return 0;
  if (phase < 3) return 0;
  return HILL_DEBUFF[position] || 0;
}

module.exports = {
  GOLD_THRESHOLD,
  WHITE, GOLD,
  getNotation,
  isInGoldZone,
  getPlayerNotation,
  getHillDebuff,
};
