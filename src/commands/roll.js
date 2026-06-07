'use strict';

const { ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { roll }              = require('../dice/diceRoller');
const { getPlayerNotation, getNotation } = require('../dice/diceTable');
const { getHillDebuff }     = require('../config/tracks');
const { getInventory, useItem } = require('../inventory/inventoryStore');
const {
  submitScore, getSession, hasSession, getTurnSnapshot,
  trainerReroll, getLastRoll,
} = require('../race/raceSession');

// Staff/Assistant role IDs
const ALLOWED_ROLES = ['1441679665893740614', '1506298098224332850'];

// ============================
// Role check helper
// ============================
function hasAllowedRole(member) {
  if (!member) return false;
  return ALLOWED_ROLES.some(id => member.roles.cache.has(id));
}

// ============================
// Helpers
// ============================
function buildResultLines(emoji, label, result, scoreMsg = '') {
  const lines = [`${emoji} **${label}** ทอย \`${result.notation}\``, `> ${result.display}`];
  if (result.modifier !== 0) lines.push(`> Modifier: \`${result.modifier > 0 ? '+' : ''}${result.modifier}\``);
  lines.push(``, `**Total: ${result.total}**${scoreMsg}`);
  return lines.join('\n');
}

function buildActionRow(notation, label, canSafe, grade, userId) {
  const rows    = [];
  const options = [
    { label: '🔁 Main Reroll',    description: 'reroll หลัก', value: 'main'   },
    { label: '⚡ One-use Reroll', description: 'ใช้แล้วหมดไป', value: 'oneUse' },
  ];
  if (grade && grade !== 'Debut') {
    options.push({ label: '🛡️ Race Safe', description: 'ใช้แล้วหมดไป', value: 'raceSafe' });
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId(`rerollSelect:${notation}:${label}:${userId}`)
    .setPlaceholder('🔁 เลือกประเภท Reroll')
    .addOptions(options);
  rows.push(new ActionRowBuilder().addComponents(select));

  if (canSafe && grade === 'Debut') {
    const safeBtn = new ButtonBuilder()
      .setCustomId(`safe:${notation}:${label}:${userId}`)
      .setLabel('🛡️ Safe (ทอยใหม่)')
      .setStyle(ButtonStyle.Primary);
    rows.push(new ActionRowBuilder().addComponents(safeBtn));
  }
  return rows;
}

function checkNotation(guildId, userId, notation) {
  if (!hasSession(guildId)) return null;
  try {
    const session    = getSession(guildId);
    const player     = session.players.get(userId);
    if (!player) return null;
    const snapshot   = getTurnSnapshot(guildId);
    const allScores  = snapshot.map(([, s]) => s);
    const mySnapshot = { ...player, score: session.turnSnapshot.get(userId) ?? player.score };
    const hill       = player.hillCleared ? 0 : getHillDebuff(session.track, player.position, session.phase);
    const forceWhite = session.isFirstTurn === true;
    const { notation: expected, isGold } = getPlayerNotation(
      mySnapshot, session.phase, allScores,
      { hillDebuff: hill, forceWhite, zoneEnabled: false }
    );
    return { correct: notation === expected, expected, isGold };
  } catch { return null; }
}

async function doRoll(userId, displayName, guildId, notation, label) {
  const result = roll(notation);
  let scoreMsg = '';
  let canSafe  = false;
  let grade    = null;

  if (guildId && hasSession(guildId)) {
    const check = checkNotation(guildId, userId, notation);
    if (check && !check.correct) {
      return { error: `⚠️ ควรทอย \`${check.expected}\` (${check.isGold ? '🟡 Gold' : '⚪ White'})\nคุณทอย \`${notation}\` — ผลจะไม่ถูกบันทึก` };
    }
    try {
      const session2 = getSession(guildId);
      grade = session2.grade;
      const { player, canSafe: cs } = submitScore(guildId, userId, result, false, false);
      const tier = check ? (check.isGold ? '🟡' : '⚪') : '';
      scoreMsg = `\n📊 คะแนนสะสม: **${player.score}** ${tier}`;
      canSafe  = cs;
    } catch (e) {
      return { error: `❌ ${e.message}` };
    }
  }

  const lines = buildResultLines('🎲', label, result, scoreMsg);
  const rows  = (guildId && hasSession(guildId)) ? buildActionRow(notation, label, canSafe, grade, userId) : [];
  return { lines, rows };
}

// ============================
// /roll
// ============================
async function handleRoll(interaction) {
  const notation = interaction.options.getString('notation');
  const label    = interaction.options.getString('label') || interaction.member?.displayName || interaction.user.username;
  try {
    const res = await doRoll(interaction.user.id, interaction.member?.displayName, interaction.guildId, notation, label);
    if (res.error) { await interaction.reply({ content: res.error, ephemeral: true }); return; }
    await interaction.reply({ content: res.lines, components: res.rows });
  } catch (err) { await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true }); }
}

// ============================
// !r prefix
// ============================
async function handlePrefixRoll(message) {
  const parts    = message.content.slice(2).trim().split(/\s+/);
  const notation = parts[0];
  const label    = parts.slice(1).join(' ') || message.member?.displayName || message.author.username;
  if (!notation) { await message.reply('❌ ระบุ notation ด้วย เช่น `!r d30`'); return; }
  try {
    const res = await doRoll(message.author.id, message.member?.displayName, message.guildId, notation, label);
    if (res.error) { await message.reply(res.error); return; }
    await message.reply({ content: res.lines, components: res.rows });
  } catch (err) { await message.reply(`❌ ${err.message}`); }
}

// ============================
// Select Menu (reroll confirm)
// ============================
async function handleRerollSelect(interaction) {
  const parts = interaction.customId.split(':');
  const [, notation, label, ownerId] = parts;
  const type  = interaction.values[0];

  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: '❌ นี่ไม่ใช่ผลทอยของคุณ', ephemeral: true });
    return;
  }

  const names = { main: 'Main', oneUse: 'One-use', raceSafe: 'Race Safe' };
  const inv   = await getInventory(interaction.user.id);
  const count = type === 'main' ? inv.reroll.main : type === 'oneUse' ? inv.reroll.oneUse : inv.raceSafe;

  if (type !== 'main' && count <= 0) {
    await interaction.reply({ content: `❌ ไม่มี **${names[type]}** เหลือแล้ว`, ephemeral: true });
    return;
  }

  const yesBtn = new ButtonBuilder()
    .setCustomId(`doReroll:${notation}:${label}:${type}:${ownerId}`)
    .setLabel('✅ Yes').setStyle(ButtonStyle.Success);
  const noBtn = new ButtonBuilder()
    .setCustomId(`cancelReroll:${ownerId}`)
    .setLabel('❌ No').setStyle(ButtonStyle.Danger);

  await interaction.update({ content: interaction.message.content, components: [] });
  await interaction.followUp({
    content: `**${interaction.member?.displayName || interaction.user.username}** จะใช้ **${names[type]}** มั้ย?${type !== 'main' ? ` (เหลือ ${count})` : ''}`,
    components: [new ActionRowBuilder().addComponents(yesBtn, noBtn)],
  });
}

// ============================
// doReroll button
// ============================
async function handleDoReroll(interaction) {
  const [, notation, label, type, ownerId] = interaction.customId.split(':');
  const guildId = interaction.guildId;

  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: '❌ นี่ไม่ใช่ผลทอยของคุณ', ephemeral: true });
    return;
  }

  try {
    const itemMap = { main: 'reroll.main', oneUse: 'reroll.oneUse', raceSafe: 'raceSafe' };
    await useItem(interaction.user.id, itemMap[type] || type);

    const result = roll(notation);
    let scoreMsg = '';
    let canSafe  = false;
    let grade    = null;

    if (guildId && hasSession(guildId)) {
      try {
        const s = getSession(guildId);
        grade = s.grade;
        const { player, canSafe: cs } = submitScore(guildId, interaction.user.id, result, true, true);
        scoreMsg = `\n📊 คะแนนสะสม: **${player.score}**`;
        canSafe  = cs;
      } catch { }
    }

    const lines = buildResultLines('🔁', label, result, scoreMsg);
    await interaction.update({ content: '🔁 Rerolling...', components: [] });
    const rows = (guildId && hasSession(guildId)) ? buildActionRow(notation, label, canSafe, grade, ownerId) : [];
    await interaction.followUp({ content: lines, components: rows });

  } catch (err) { await interaction.update({ content: `❌ ${err.message}`, components: [] }); }
}

async function handleCancelReroll(interaction) {
  const ownerId = interaction.customId.split(':')[1];
  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: '❌ นี่ไม่ใช่ของคุณ', ephemeral: true });
    return;
  }
  await interaction.update({ content: '❌ ยกเลิก Reroll', components: [] });
}

// ============================
// Safe button
// ============================
async function handleSafe(interaction) {
  const [, notation, label, ownerId] = interaction.customId.split(':');
  const guildId = interaction.guildId;

  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: '❌ นี่ไม่ใช่ผลทอยของคุณ', ephemeral: true });
    return;
  }

  try {
    const result = roll(notation);
    let scoreMsg = '';
    let canSafe  = false;
    let grade    = null;

    if (guildId && hasSession(guildId)) {
      try {
        const s = getSession(guildId);
        grade = s.grade;
        const { player, canSafe: cs } = submitScore(guildId, interaction.user.id, result, true, true);
        scoreMsg = `\n📊 คะแนนสะสม: **${player.score}**`;
        canSafe  = cs;
      } catch { }
    }

    const lines = buildResultLines('🛡️', `${label} Safe`, result, scoreMsg);
    await interaction.update({ content: `🛡️ **${label}** ใช้ Safe...`, components: [] });
    const rows = (guildId && hasSession(guildId)) ? buildActionRow(notation, label, canSafe, grade, ownerId) : [];
    await interaction.followUp({ content: lines, components: rows });

  } catch (err) { await interaction.update({ content: `❌ ${err.message}`, components: [] }); }
}

// ============================
// Debuff skill (สกิลแดง)
// บอท reroll อัตโนมัติเลย ไม่ต้องให้เขาทอยเอง
// ============================
async function handleDebuff(interaction) {
  const guildId    = interaction.guildId;
  const target     = interaction.options.getUser('target');
  const targetName = interaction.guild?.members.cache.get(target.id)?.displayName || target.username;
  const userName   = interaction.member?.displayName || interaction.user.username;

  // เช็คยิงตัวเองไม่ได้
  if (target.id === interaction.user.id) {
    await interaction.reply({ content: '❌ ไม่สามารถใช้สกิลแดงกับตัวเองได้', ephemeral: true });
    return;
  }

  try {
    // เช็ค Main Reroll ก่อนใช้
    const inv = await getInventory(interaction.user.id);
    if (inv.reroll.main <= 1) throw new Error('ไม่มี Main Reroll เหลือแล้ว');

    if (!hasSession(guildId)) throw new Error('ไม่มี session การแข่งอยู่');
    const session = getSession(guildId);
    const player  = session.players.get(target.id);
    if (!player) throw new Error('ผู้เล่นเป้าหมายไม่ได้อยู่ใน session นี้');
    if (!player.rolled) throw new Error(`**${targetName}** ยังไม่ได้ทอยในเทิร์นนี้`);

    // ดึงผลล่าสุดของ target เพื่อรู้ notation
    const last = getLastRoll(guildId, target.id);
    if (!last) throw new Error('ไม่พบผลล่าสุดของ target');

    // ใช้ Main Reroll + set cooldown ถ้า main เหลือ 1
    await useItem(interaction.user.id, 'reroll.main');
    const updatedInv = await getInventory(interaction.user.id);
    const selfPlayerSession = getSession(guildId).players.get(interaction.user.id);
    if (selfPlayerSession && updatedInv.reroll.main <= 1) selfPlayerSession.mainRerollCooldown = true;

    // คะแนนก่อนทอยรอบนี้ = score - lastTotal
    const scoreBefore = Math.max(0, player.score - last.total);

    // บอท reroll ให้เลยอัตโนมัติ
    const newResult = roll(last.notation);

    // คำนวณคะแนนใหม่
    player.score = scoreBefore + newResult.total;

    // update lastRoll
    const { setLastRoll } = require('../race/raceSession');
    if (setLastRoll) setLastRoll(guildId, target.id, newResult);

    await interaction.reply(
      `🔴 **${userName}** ใช้สกิลแดงใส่ **${targetName}**!\n` +
      `> ผลเดิม: ${last.display} → **${last.total}**\n` +
      `> ผลใหม่: ${newResult.display} → **${newResult.total}**\n\n` +
      `📊 คะแนนสะสม **${targetName}**: **${player.score}**`
    );
  } catch (err) { await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true }); }
}

// ============================
// All Out
// reroll ใหม่ หักแต้ม -10n (n = ครั้งที่ใช้สะสมในแข่งนี้)
// ============================
async function handleAllOut(interaction) {
  const guildId = interaction.guildId;
  const userId  = interaction.user.id;
  const name    = interaction.member?.displayName || interaction.user.username;

  try {
    if (!hasSession(guildId)) throw new Error('ไม่มี session การแข่งอยู่');
    const session = getSession(guildId);
    const player  = session.players.get(userId);
    if (!player) throw new Error('คุณยังไม่ได้ลงทะเบียนแข่ง');
    if (!player.rolled) throw new Error('ต้องทอยก่อนถึงจะใช้ All Out ได้');

    const last = getLastRoll(guildId, userId);
    if (!last) throw new Error('ไม่พบผลล่าสุด');

    // เพิ่ม all out count
    player.allOutCount = (player.allOutCount || 0) + 1;
    const n       = player.allOutCount;
    const penalty = n * 10;

    // คะแนนก่อนทอยรอบนี้
    const scoreBefore = Math.max(0, player.score - last.total);

    // reroll ใหม่
    const newResult = roll(last.notation);
    const newTotal  = Math.max(0, newResult.total - penalty);

    player.score = scoreBefore + newTotal;

    await interaction.reply(
      `💥 **${name}** ใช้ **All Out** (ครั้งที่ ${n})\n` +
      `> ผลเดิม: ${last.display} → **${last.total}**\n` +
      `> ผลใหม่: ${newResult.display} → **${newResult.total}** (-${penalty}) = **${newTotal}**\n\n` +
      `📊 คะแนนสะสม: **${player.score}**\n` +
      `⚠️ หลังแข่งจบจะได้รับผลกระทบตามจำนวนครั้งที่ใช้`
    );
  } catch (err) { await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true }); }
}

// ============================
// /trainer reroll
// ============================
async function handleTrainerReroll(interaction) {
  const guildId     = interaction.guildId;
  const target      = interaction.options.getUser('target');
  const targetName  = interaction.guild?.members.cache.get(target.id)?.displayName || target.username;
  const trainerName = interaction.member?.displayName || interaction.user.username;

  try {
    await useItem(interaction.user.id, 'reroll.trainer');
    const { player, newResult, oldResult } = trainerReroll(guildId, target.id, roll);
    await interaction.reply(
      `🎯 **${trainerName}** ใช้ Trainer Reroll ให้ **${targetName}**\n` +
      `> ผลเดิม: ${oldResult.display} → **${oldResult.total}**\n` +
      `> ผลใหม่: ${newResult.display} → **${newResult.total}**\n\n` +
      `📊 คะแนนสะสม **${targetName}**: **${player.score}**`
    );
  } catch (err) { await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true }); }
}

module.exports = {
  handleRoll, handlePrefixRoll,
  handleRerollSelect, handleDoReroll, handleCancelReroll, handleSafe,
  handleDebuff, handleAllOut, handleTrainerReroll,
  hasAllowedRole,
};
