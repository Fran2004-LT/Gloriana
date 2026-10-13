'use strict';

/**
 * /skill pick | use | info — ระบบสกิล (ซ่อนข้อมูล: เลือก/ดูเป็นข้อความเห็นคนเดียว)
 */

const { EmbedBuilder } = require('discord.js');
const { roll } = require('../dice/diceRoller');
const { PASSIVES, ACTIVES, passivesOf } = require('../skills/skillData');
const { pickSkills, describePassive, describeActive, ensureSkills } = require('../skills/skillSystem');
const { getSession, hasSession, applyActive, getTurnPlan } = require('../race/raceSession');

function sessionAndPlayer(interaction) {
  const channelId = interaction.channelId;
  if (!hasSession(channelId)) throw new Error('ไม่มี session การแข่งในช่องนี้');
  const session = getSession(channelId);
  if (!session.skillsEnabled) throw new Error('การแข่งนี้ไม่ได้เปิดระบบสกิล');
  const player = session.players.get(interaction.user.id);
  if (!player) throw new Error('คุณยังไม่ได้ลงทะเบียนแข่ง');
  return { channelId, session, player };
}

async function handlePick(interaction) {
  const { session, player } = sessionAndPlayer(interaction);
  const passiveId = interaction.options.getString('passive');
  const activeId  = interaction.options.getString('active');
  if (!passiveId && !activeId) {
    const list = passivesOf(player.position).map(describePassive).join('\n');
    throw new Error(`เลือกอย่างน้อย 1 อย่าง\npassive ของคลาส ${player.position}:\n${list}`);
  }
  const s = pickSkills(session, player, passiveId, activeId);
  await interaction.reply({
    ephemeral: true,
    content:
      `🃏 **สกิลของคุณ** (ไม่มีใครเห็นนอกจากคุณ)\n` +
      `Passive: ${s.passive ? describePassive(s.passive) : '— ยังไม่เลือก'}\n` +
      `ไพ่ตาย: ${s.active ? describeActive(s.active) : '— ยังไม่เลือก'}\n` +
      `เปลี่ยนได้จนกว่าจะทอยครั้งแรก`,
  });
}

async function handleUse(interaction) {
  const { channelId, session, player } = sessionAndPlayer(interaction);
  const target = interaction.options.getUser('target');
  const zone   = interaction.options.getString('zone');
  const name   = player.displayName;
  const res = applyActive(channelId, interaction.user.id, { targetId: target?.id, zone }, roll);
  const { def } = res;

  // Iron Halo — เปิดแบบเงียบ
  if (res.kind === 'silent') {
    await interaction.reply({ ephemeral: true, content: `🛡️ เปิด **Iron Halo** แล้ว — ไม่มีใครรู้ จนกว่าจะกันการโจมตีครั้งแรกได้` });
    return;
  }

  const embed = new EmbedBuilder().setColor(0x9B59B6).setTitle(`${def.emoji} ${name} ใช้ไพ่ตาย ${def.name}!`);
  if (res.kind === 'attack') {
    if (res.blocked) {
      embed.setColor(0xF5C518).setDescription(`🎯 ปาใส่ **${res.target.displayName}**\n🛡️ **Iron Halo!** ถูกสกัดไว้ — ไม่มีผล`);
    } else {
      embed.setColor(0xED4245).setDescription(`🎯 ปาใส่ **${res.target.displayName}** → เทิร์นหน้าลดเต๋า 2 ลูก`);
    }
  } else if (res.rescored) {
    const r = res.rescored;
    embed.setDescription(
      `${r.newResult.skillLines.join('\n')}\n\n` +
      `แต้มเทิร์นนี้: ~~${r.oldTotal}~~ → **${r.newResult.total}**\n📊 คะแนนสะสม: **${r.score}**`
    );
  } else {
    const plan = getTurnPlan(channelId, interaction.user.id);
    const tgt  = res.target ? ` (ลอก **${res.target.displayName}** คลาส ${res.target.position})` : '';
    embed.setDescription(`${def.desc}${tgt}\n🎲 เทิร์นนี้ต้องทอย \`${plan.notation}\``);
  }
  await interaction.reply({ embeds: [embed] });
}

async function handleInfo(interaction) {
  const { channelId, session, player } = sessionAndPlayer(interaction);
  const s = ensureSkills(player);
  const plan = getTurnPlan(channelId, interaction.user.id);
  const lines = [
    `🃏 **สกิลของคุณ** (เห็นคนเดียว)`,
    `Passive: ${s.passive ? describePassive(s.passive) : '— ยังไม่เลือก'}`,
    `ไพ่ตาย: ${s.active ? describeActive(s.active) : '— ยังไม่เลือก'} ${s.activeUsed ? `(ใช้แล้ว เทิร์น ${s.usedTurn})` : s.active ? '(ยังไม่ใช้)' : ''}`,
  ];
  if (s.passive === 'gatheringStorm') lines.push(`⛈️ พลังที่สะสม: +${s.storm || 0}`);
  if (s.active === 'ironHalo' && s.activeUsed) lines.push(s.haloSpent ? '🛡️ Iron Halo: ใช้กันไปแล้ว' : '🛡️ Iron Halo: เปิดอยู่');
  lines.push('', `📍 เฟส ${session.phase} เทิร์น ${session.turn} — ${plan.zone === 'gold' ? '🟡 Gold' : '⚪ White'}`);
  lines.push(`🎲 เทิร์นนี้ต้องทอย \`${plan.notation}\``);
  if (plan.lines.length) lines.push(...plan.lines.map(l => `✨ ${l}`));
  if (plan.adds.length) lines.push(...plan.adds.map(a => `✨ ${a.label}: ${a.value > 0 ? '+' : ''}${a.value}`));
  await interaction.reply({ ephemeral: true, content: lines.join('\n') });
}

async function handleSkill(interaction) {
  const sub = interaction.options.getSubcommand();
  try {
    if (sub === 'pick') return await handlePick(interaction);
    if (sub === 'use')  return await handleUse(interaction);
    if (sub === 'info') return await handleInfo(interaction);
  } catch (err) {
    await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
  }
}

/** ตัวเลือกสำหรับ slash command */
const PASSIVE_CHOICES = Object.entries(PASSIVES).map(([value, p]) => ({ name: `${p.cls} · ${p.name}`, value }));
const ACTIVE_CHOICES  = Object.entries(ACTIVES).map(([value, a]) => ({ name: `${a.name} (${a.group})`, value }));

module.exports = { handleSkill, PASSIVE_CHOICES, ACTIVE_CHOICES };
