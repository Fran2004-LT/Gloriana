'use strict';

/**
 * tracks.js
 * Config สนามแข่ง 5 สนาม
 * grade และ distance สตาฟกรอกตอน /race start
 */

const TRACKS = {
  Tokyo: {
    name:      'Tokyo',
    channelId: '1462831563690737919',
    hillDebuff: false,
  },
  Nakayama: {
    name:      'Nakayama',
    channelId: '1462831646523916380',
    hillDebuff: true,   // เฟส 4 อย่างเดียว
    hillPhase:  4,
    hill: { Front: 40, End: 30, Pace: 20, Late: 20 },
  },
  Kyoto: {
    name:      'Kyoto',
    channelId: '1462831714782150677',
    hillDebuff: false,
  },
  Hanshin: {
    name:      'Hanshin',
    channelId: '1462834889509310552',
    hillDebuff: false,
  },
  Chukyo: {
    name:      'Chukyo',
    channelId: '1462834989002526730',
    hillDebuff: false,
  },
};

// Grade options
const GRADES = ['G1', 'G2', 'G3', 'Debut'];

// Distance options (เทิร์น)
const DISTANCES = [9, 12, 14];

/**
 * ดึง track จากชื่อ
 */
function getTrack(name) {
  return TRACKS[name] || null;
}

/**
 * ดึง track จาก channel ID
 */
function getTrackByChannel(channelId) {
  return Object.values(TRACKS).find(t => t.channelId === channelId) || null;
}

/**
 * hill debuff ของสนาม
 */
function getHillDebuff(trackName, position, phase) {
  const track = TRACKS[trackName];
  if (!track || !track.hillDebuff) return 0;
  if (phase < track.hillPhase) return 0;
  return track.hill[position] || 0;
}

/**
 * เช็คว่า grade นี้มี Zone ได้มั้ย (G1 only)
 */
function hasZone(grade) {
  return grade === 'G1';
}

/**
 * เช็คว่า grade นี้มี Safe ติดตัวมั้ย (Debut only)
 */
function hasFreeSafe(grade) {
  return grade === 'Debut';
}

module.exports = {
  TRACKS, GRADES, DISTANCES,
  getTrack, getTrackByChannel,
  getHillDebuff, hasZone, hasFreeSafe,
};
