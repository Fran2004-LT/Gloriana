'use strict';

const { ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
const { roll }              = require('../dice/diceRoller');
const { getPlayerNotation, getNotation } = require('../dice/diceTable');
const { getHillDebuff }     = require('../config/tracks');
const { getInventory, useItem } = require('../inventory/inventoryStore');
const {
  submitScore, getSession, hasSession, getTurnSnapshot,
  trainerReroll, getLastRoll, setLastRoll,
  setProxy, clearProxyByOwner, getProxyOwner,
} = require('../race/raceSession');

// Staff/Assistant role IDs
const ALLOWED_ROLES = ['1441679665893740614', '1506298098224332850'];
const TRAINER_ROLE  = '1441818898990366861';
// Staff / Assistant / Trainer ใช้ proxy ได้
const PROXY_ROLES = [...ALLOWED_ROLES, TRAINER_ROLE];

function canUseProxy(member) {
  if (!member) return false;
  return PROXY_ROLES.some(id => member.roles.cache.has(id));
}

function hasAllowedRole(member) {
  if (!member) return false;
  return ALLOWED_ROLES.some(id => member.roles.cache.has(id));
}

// ============================
// Helpers
// ============================
const ROLL_COLORS = {
  '🎲': 0x5865F2,  // ทอยปกติ — สีม่วง Discord
  '🔁': 0x57F287,  // reroll — สีเขียว
  '🛡️': 0x3498DB,  // safe — สีฟ้า
  '💥': 0xED4245,  // allout — สีแดง
  '🔴': 0xED4245,  // debuff — สีแดง
  '🎯': 0xF5C518,  // trainer reroll — สีทอง
};

function buildResultEmbed(emoji, label, result, scoreInfo = null) {
  const color   = ROLL_COLORS[emoji] || 0x5865F2;
  // guard — Discord ไม่ยอมรับ field value ที่ว่าง
  const display = result.display || String(result.total);
  const embed   = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${emoji} ${label}`)
    .addFields({ name: `🎲 \`${result.notation}\``, value: `> ${display}`, inline: false });

  if (result.modifier && result.modifier !== 0) {
    embed.addFields({ name: 'Modifier', value: `\`${result.modifier > 0 ? '+' : ''}${result.modifier}\``, inline: true });
  }

  embed.addFields({ name: 'Total', value: `**${result.total}**`, inline: true });

  if (scoreInfo && scoreInfo.trim()) {
    embed.addFields({ name: '📊 คะแนนสะสม', value: scoreInfo.trim(), inline: true });
  }

  return embed;
}

// keep buildResultLines for backward compat (ใช้ใน debuff/allout text parts)
function buildResultLines(emoji, label, result, scoreMsg = '') {
  const lines = [`${emoji} **${label}** ทอย \`${result.notation}\``, `> ${result.display}`];
  if (result.modifier !== 0) lines.push(`> Modifier: \`${result.modifier > 0 ? '+' : ''}${result.modifier}\``);
  lines.push(``, `**Total: ${result.total}**${scoreMsg}`);
  return lines.join('\n');
}

function buildActionRow(notation, label, canSafe, grade, userId, safeCount) {
  const rows    = [];
  const options = [
    { label: '🔁 Main Reroll',    description: 'reroll หลัก',  value: 'main'   },
    { label: '⚡ One-use Reroll', description: 'ใช้แล้วหมดไป', value: 'oneUse' },
  ];

  // G1/G2/G3 → Race Safe อยู่ใน dropdown
  if (grade && grade !== 'Debut') {
    options.push({ label: '🛡️ Race Safe', description: 'ใช้แล้วหมดไป', value: 'raceSafe' });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`rerollSelect:${notation}:${userId}`)
    .setPlaceholder('🔁 เลือกประเภท Reroll')
    .addOptions(options);
  rows.push(new ActionRowBuilder().addComponents(select));

  // Debut → Main Safe เป็นปุ่มแยก แสดงจำนวนที่เหลือด้วย
  if (canSafe && grade === 'Debut') {
    const remaining = safeCount !== undefined ? safeCount : '?';
    const safeBtn = new ButtonBuilder()
      .setCustomId(`safe:${notation}:${userId}`)
      .setLabel(`🛡️ Main Safe (${remaining}/3)`)
      .setStyle(ButtonStyle.Primary);
    rows.push(new ActionRowBuilder().addComponents(safeBtn));
  }
  return rows;
}

function checkNotation(channelId, userId, notation) {
  if (!hasSession(channelId)) return null;
  try {
    const session    = getSession(channelId);
    const player     = session.players.get(userId);
    if (!player) return null;
    const snapshot   = getTurnSnapshot(channelId);
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

async function doRoll(userId, displayName, channelId, notation, label) {
  // ถ้า userId กำลัง proxy แทนใครอยู่ → ทอยในนามของ owner
  let effectiveUserId = userId;
  if (channelId && hasSession(channelId)) {
    const owner = getProxyOwner(channelId, userId);
    if (owner) {
      effectiveUserId = owner;
      const s = getSession(channelId);
      const ownerName = s.players.get(owner)?.displayName;
      if (ownerName) label = ownerName;
    }
  }
  userId = effectiveUserId;
  const result = roll(notation);
  let scoreMsg = '';
  let canSafe  = false;
  let grade    = null;

  if (channelId && hasSession(channelId)) {
    const check = checkNotation(channelId, userId, notation);
    if (check && !check.correct) {
      return { error: `⚠️ ควรทอย \`${check.expected}\` (${check.isGold ? '🟡 Gold' : '⚪ White'})\nคุณทอย \`${notation}\` — ผลจะไม่ถูกบันทึก` };
    }
    try {
      const session2 = getSession(channelId);
      grade = session2.grade;
      const { player, canSafe: cs } = submitScore(channelId, userId, result, false, false);
      scoreMsg = `\n📊 คะแนนสะสม: **${player.score}**`;
      canSafe  = cs;
    } catch (e) {
      return { error: `❌ ${e.message}` };
    }
  }

  const scoreInfo = scoreMsg.replace(/\n📊 คะแนนสะสม: /, '').trim() || null;
  const embed = buildResultEmbed('🎲', label, result, scoreInfo || undefined);
  let safeCount;
  if (channelId && hasSession(channelId) && grade === 'Debut') {
    const s = getSession(channelId);
    safeCount = s.players.get(userId)?.debutSafeCount ?? 0;
  }
  return { embed };
}

// ============================
// /roll
// ============================
async function handleRoll(interaction) {
  const notation = interaction.options.getString('notation');
  const label    = interaction.options.getString('label') || interaction.member?.displayName || interaction.user.username;
  try {
    const res = await doRoll(interaction.user.id, interaction.member?.displayName, interaction.channelId, notation, label);
    if (res.error) { await interaction.reply({ content: res.error, ephemeral: true }); return; }
    await interaction.reply({ embeds: [res.embed] });
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
    const res = await doRoll(message.author.id, message.member?.displayName, message.channelId, notation, label);
    if (res.error) { await message.reply(res.error); return; }
    await message.reply({ embeds: [res.embed] });
  } catch (err) { await message.reply(`❌ ${err.message}`); }
}

// ============================
// Select Menu (reroll confirm)
// ============================
async function handleRerollSelect(interaction) {
  const parts = interaction.customId.split(':');
  const [, notation, ownerId] = parts;
  const type  = interaction.values[0];

  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: '❌ นี่ไม่ใช่ผลทอยของคุณ', ephemeral: true });
    return;
  }
  const label = interaction.member?.displayName || interaction.user.username;

  const names = { main: 'Main', oneUse: 'One-use', raceSafe: 'Race Safe' };
  const inv   = await getInventory(interaction.user.id);
  const count = type === 'main' ? inv.reroll.main : type === 'oneUse' ? inv.reroll.oneUse : inv.raceSafe;

  if (type !== 'main' && count <= 0) {
    await interaction.reply({ content: `❌ ไม่มี **${names[type]}** เหลือแล้ว`, ephemeral: true });
    return;
  }

  const yesBtn = new ButtonBuilder()
    .setCustomId(`doReroll:${notation}:${type}:${ownerId}`)
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
  const [, notation, type, ownerId] = interaction.customId.split(':');
  const channelId = interaction.channelId;
  const label = interaction.member?.displayName || interaction.user.username;

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

    if (channelId && hasSession(channelId)) {
      try {
        const s = getSession(channelId);
        grade = s.grade;
        // replace=true → ใช้ snapshot ต้นเทิร์นเป็น base (แก้ใน submitScore แล้ว)
        const { player, canSafe: cs } = submitScore(channelId, interaction.user.id, result, true, true);
        scoreMsg = `\n📊 คะแนนสะสม: **${player.score}**`;
        canSafe  = cs;
      } catch { }
    }

    const scoreInfo = scoreMsg.replace(/\n📊 คะแนนสะสม: /, '').trim() || null;
    const embed = buildResultEmbed('🔁', label, result, scoreInfo || undefined);
    await interaction.update({ content: '🔁 Rerolling...', components: [] });
    await interaction.followUp({ embeds: [embed] });

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
  const [, notation, ownerId] = interaction.customId.split(':');
  const channelId = interaction.channelId;

  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: '❌ นี่ไม่ใช่ผลทอยของคุณ', ephemeral: true });
    return;
  }
  const label = interaction.member?.displayName || interaction.user.username;

  try {
    let grade  = null;
    let player = null;

    if (channelId && hasSession(channelId)) {
      const s = getSession(channelId);
      grade  = s.grade;
      player = s.players.get(interaction.user.id);
    }

    // Debut → หัก debutSafeCount ใน session (ไม่แตะ inventory)
    // G1/G2/G3 → หัก raceSafe จาก inventory
    if (grade === 'Debut') {
      if (!player) throw new Error('คุณยังไม่ได้ลงทะเบียนแข่ง');
      if (player.debutSafeCount <= 0) throw new Error('ใช้ Main Safe หมดแล้ว (0/3)');
      player.debutSafeCount--;
    } else {
      await useItem(interaction.user.id, 'raceSafe');
    }

    const result = roll(notation);
    let scoreMsg = '';
    let canSafe  = false;
    let safeCount;

    if (channelId && hasSession(channelId)) {
      try {
        const { player: updated, canSafe: cs } = submitScore(channelId, interaction.user.id, result, true, true);
        if (grade === 'Debut') {
          safeCount = updated.debutSafeCount;
          scoreMsg  = `\n📊 คะแนนสะสม: **${updated.score}** | 🛡️ Main Safe เหลือ: ${safeCount}/3`;
          canSafe   = cs && safeCount > 0;
        } else {
          const inv = await getInventory(interaction.user.id);
          scoreMsg  = `\n📊 คะแนนสะสม: **${updated.score}** | 🛡️ Race Safe เหลือ: ${inv.raceSafe}`;
          canSafe   = cs && inv.raceSafe > 0;
        }
      } catch { }
    }

    const scoreInfo = scoreMsg.replace(/\n📊 คะแนนสะสม: /, '').trim() || null;
    const embed = buildResultEmbed('🛡️', `${label} Safe`, result, scoreInfo || undefined);
    await interaction.update({ content: `🛡️ **${label}** ใช้ Safe...`, components: [] });
    await interaction.followUp({ embeds: [embed] });

  } catch (err) { await interaction.update({ content: `❌ ${err.message}`, components: [] }); }
}

// ============================
// Debuff skill (สกิลแดง)
// ============================
async function handleDebuff(interaction) {
  const channelId  = interaction.channelId;
  const target     = interaction.options.getUser('target');
  const targetName = interaction.guild?.members.cache.get(target.id)?.displayName || target.username;
  const userName   = interaction.member?.displayName || interaction.user.username;

  if (target.id === interaction.user.id) {
    await interaction.reply({ content: '❌ ไม่สามารถใช้สกิลแดงกับตัวเองได้', ephemeral: true });
    return;
  }

  try {
    if (!hasSession(channelId)) throw new Error('ไม่มี session การแข่งอยู่');
    const session = getSession(channelId);

    const player = session.players.get(target.id);
    if (!player) throw new Error('ผู้เล่นเป้าหมายไม่ได้อยู่ใน session นี้');
    if (!player.rolled) throw new Error(`**${targetName}** ยังไม่ได้ทอยในเทิร์นนี้`);
    // กัน debuff คนที่ใช้ zone ในเทิร์นนี้ — ผล zone ห้ามถูก reroll ทับ
    if (player.zoneUsedTurn === session.totalTurn) {
      throw new Error(`**${targetName}** ใช้ Zone ในเทิร์นนี้แล้ว ไม่สามารถยิงสกิลแดงได้`);
    }

    const last = getLastRoll(channelId, target.id);
    if (!last) throw new Error('ไม่พบผลล่าสุดของ target');

    await useItem(interaction.user.id, 'reroll.main');

    // ใช้ turnSnapshot เป็น base แทนการคำนวณ score - last.total
    // เพราะ snapshot คือคะแนน ณ ต้นเทิร์น ก่อนที่จะทอยเทิร์นนี้
    const snapshot = session.turnSnapshot.get(target.id) ?? 0;

    const newResult = roll(last.notation);
    player.score    = snapshot + newResult.total;

    setLastRoll(channelId, target.id, newResult);

    const debuffEmbed = new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle(`🔴 ${userName} ใช้สกิลแดงใส่ ${targetName}!`)
      .addFields(
        { name: '❌ ผลเดิม', value: `~~${last.display}~~ → ~~${last.total}~~`, inline: true },
        { name: '✨ ผลใหม่', value: `${newResult.display} → **${newResult.total}**`, inline: true },
        { name: '📊 คะแนนสะสม', value: `**${player.score}**`, inline: false }
      );
    await interaction.reply({ embeds: [debuffEmbed] });
  } catch (err) { await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true }); }
}

// ============================
// All Out
// ============================
async function handleAllOut(interaction) {
  const channelId = interaction.channelId;
  const userId  = interaction.user.id;
  const name    = interaction.member?.displayName || interaction.user.username;

  try {
    if (!hasSession(channelId)) throw new Error('ไม่มี session การแข่งอยู่');
    const session = getSession(channelId);
    const player  = session.players.get(userId);
    if (!player) throw new Error('คุณยังไม่ได้ลงทะเบียนแข่ง');
    if (!player.rolled) throw new Error('ต้องทอยก่อนถึงจะใช้ All Out ได้');

    const last = getLastRoll(channelId, userId);
    if (!last) throw new Error('ไม่พบผลล่าสุด');

    player.allOutCount = (player.allOutCount || 0) + 1;
    const n       = player.allOutCount;
    const penalty = n * 10;

    // หัก penalty จากคะแนนสะสมก่อน แล้วบวกผลทอยใหม่เข้า
    const snapshot  = session.turnSnapshot.get(userId) ?? 0;
    const newResult = roll(last.notation);
    const scoreBeforeThisTurn = snapshot; // คะแนนก่อนเทิร์นนี้
    player.score = Math.max(0, scoreBeforeThisTurn - penalty) + newResult.total;
    const newTotal = player.score - scoreBeforeThisTurn;

    setLastRoll(channelId, userId, newResult);

    const alloutEmbed = new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle(`💥 ${name} ใช้ All Out (ครั้งที่ ${n})`)
      .addFields(
        { name: '❌ ผลเดิม', value: `~~${last.display} → ${last.total}~~`, inline: true },
        { name: '✨ ผลใหม่', value: `${newResult.display} → **${newResult.total}** (-${penalty}) = **${newTotal}**`, inline: true },
        { name: '📊 คะแนนสะสม', value: `**${player.score}**`, inline: false }
      )
      .setFooter({ text: '⚠️ หลังแข่งจบจะได้รับผลกระทบตามจำนวนครั้งที่ใช้' });
    await interaction.reply({ embeds: [alloutEmbed] });
  } catch (err) { await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true }); }
}

// ============================
// /trainer reroll
// ============================
async function handleTrainerReroll(interaction) {
  const channelId     = interaction.channelId;
  const target      = interaction.options.getUser('target');
  const targetName  = interaction.guild?.members.cache.get(target.id)?.displayName || target.username;
  const trainerName = interaction.member?.displayName || interaction.user.username;

  try {
    await useItem(interaction.user.id, 'reroll.trainer');
    const { player, newResult, oldResult } = trainerReroll(channelId, target.id, roll);
    const trainerEmbed = new EmbedBuilder()
      .setColor(0xF5C518)
      .setTitle(`🎯 ${trainerName} ใช้ Trainer Reroll ให้ ${targetName}`)
      .addFields(
        { name: '❌ ผลเดิม', value: `~~${oldResult.display} → ${oldResult.total}~~`, inline: true },
        { name: '✨ ผลใหม่', value: `${newResult.display} → **${newResult.total}**`, inline: true },
        { name: '📊 คะแนนสะสม', value: `**${player.score}**`, inline: false }
      );
    await interaction.reply({ embeds: [trainerEmbed] });
  } catch (err) { await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true }); }
}

async function handleRedo(interaction) {
  const channelId = interaction.channelId;
  const userId    = interaction.user.id;
  const name      = interaction.member?.displayName || interaction.user.username;

  try {
    if (!hasSession(channelId)) throw new Error('ไม่มี session การแข่งในช่องนี้');
    const session = getSession(channelId);
    const player  = session.players.get(userId);
    if (!player) throw new Error('คุณยังไม่ได้ลงทะเบียนแข่ง');

    const last = getLastRoll(channelId, userId);
    if (!last) throw new Error('ยังไม่มีผลทอยล่าสุดให้ redo');

    const grade = session.grade;
    // canSafe: ผลล่าสุดมีลูกที่อยู่ 1-10 (สำหรับ Main Safe ของ Debut)
    const canSafe = Array.isArray(last.chosen) && last.chosen.some(n => n >= 1 && n <= 10);
    let safeCount;
    if (grade === 'Debut') safeCount = player.debutSafeCount ?? 0;

    // สร้าง dropdown เดียวกับที่ติดมากับผลทอยปกติ
    const rows = buildActionRow(last.notation, name, canSafe, grade, userId, safeCount);

    await interaction.reply({
      content: `🔄 **${name}** เลือกประเภทเพื่อ redo\n` +
               `🎲 ผลล่าสุด \`${last.notation}\`: ${last.display} → **${last.total}**\n` +
               `📊 คะแนนสะสม: **${player.score}**`,
      components: rows,
    });
  } catch (err) { await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true }); }
}

async function handleProxy(interaction) {
  const channelId = interaction.channelId;
  const target    = interaction.options.getUser('target');
  const proxyName = interaction.member?.displayName || interaction.user.username;
  const targetName = interaction.guild?.members.cache.get(target.id)?.displayName || target.username;

  try {
    if (!canUseProxy(interaction.member)) throw new Error('เฉพาะ Staff / Assistant / Trainer เท่านั้นที่ใช้ proxy ได้');
    if (!hasSession(channelId)) throw new Error('ไม่มี session การแข่งในช่องนี้');
    if (target.id === interaction.user.id) throw new Error('สวมสิทธิ์ตัวเองไม่ได้');

    setProxy(channelId, interaction.user.id, target.id);

    const embed = new EmbedBuilder()
      .setColor(0x9B59B6)
      .setTitle('🎭 สวมสิทธิ์ทอยแทน')
      .setDescription(`**${proxyName}** จะทอยแทน **${targetName}** ชั่วคราว`)
      .setFooter({ text: 'ทอยได้ปกติ แต่ใช้ reroll/safe/zone/สกิลแดงไม่ได้ — เจ้าของกด /race unproxy เพื่อเอาสิทธิ์คืน' });
    await interaction.reply({ embeds: [embed] });
  } catch (err) { await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true }); }
}

async function handleUnproxy(interaction) {
  const channelId = interaction.channelId;
  const name = interaction.member?.displayName || interaction.user.username;
  try {
    if (!hasSession(channelId)) throw new Error('ไม่มี session การแข่งในช่องนี้');
    // เจ้าของม้าเท่านั้นที่เรียกสิทธิ์คืนได้
    const removed = clearProxyByOwner(channelId, interaction.user.id);
    if (!removed) throw new Error('ไม่มีใครกำลังสวมสิทธิ์คุณอยู่');
    await interaction.reply(`🔓 **${name}** เรียกสิทธิ์ควบคุมคืนแล้ว`);
  } catch (err) { await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true }); }
}

module.exports = {
  handleRoll, handlePrefixRoll,
  handleRerollSelect, handleDoReroll, handleCancelReroll, handleSafe,
  handleDebuff, handleAllOut, handleTrainerReroll,
  handleProxy, handleUnproxy, handleRedo,
  hasAllowedRole,
};
