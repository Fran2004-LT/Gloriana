'use strict';

const { EmbedBuilder } = require('discord.js');
const { getInventory, addItem, setRole } = require('../inventory/inventoryStore');
const { claimDaily, formatRewards }      = require('../economy/dailyStreak');

// ============================
// Inventory display
// ============================
function buildInventoryEmbed(name, inv, avatarUrl) {
  const roleLabel = { uma: '🏇 สาวม้า', trainer: '👤 เทรนเนอร์', both: '🏇👤 ทั้งคู่' };
  const roles     = (inv.roles.includes('uma') && inv.roles.includes('trainer')) ? 'both' : inv.roles[0] || 'uma';
  const streakBar = `${'⭐'.repeat(inv.streak?.current || 0)}${'☆'.repeat(7 - (inv.streak?.current || 0))} (${inv.streak?.current || 0}/7)`;

  return new EmbedBuilder()
    .setColor(0xF5C518)
    .setAuthor({ name: `${name} | ${roleLabel[roles]}`, iconURL: avatarUrl })
    .setTitle('📦 Inventory')
    .addFields(
      // Currency
      {
        name: '💰 Currency',
        value: `\`Gold\` **${inv.gold.toLocaleString()}** | \`RC\` **${inv.rc.toLocaleString()}**`,
        inline: false,
      },
      // Rerolls
      {
        name: '🎲 Rerolls',
        value: [
          `🔁 Main Reroll: **${inv.reroll.main}**`,
          `⚡ One-use Reroll: **${inv.reroll.oneUse}**`,
          `🎯 Trainer Reroll: **${inv.reroll.trainer}**`,
        ].join('\n'),
        inline: true,
      },
      // Items
      {
        name: '🎒 Items',
        value: [
          `🛡️ Race Safe: **${inv.raceSafe}**`,
          `🏔️ Hill Clear: **${inv.hillClearItem ? '✅ มี' : '❌ ไม่มี'}**`,
          `🌀 Zone: **${inv.zoneUnlocked ? '✅ Unlocked' : '🔒 Locked'}**`,
        ].join('\n'),
        inline: true,
      },
      // Daily Streak
      {
        name: '📅 Daily Streak',
        value: streakBar,
        inline: false,
      },
      // Stats
      {
        name: '📊 สถิติ',
        value: `G1: **${inv.stats.g1Wins}W** | G2: **${inv.stats.g2Wins}W** | G3: **${inv.stats.g3Wins}W** | แข่ง **${inv.stats.races}** ครั้ง`,
        inline: false,
      }
    );
}

// ============================
// Helper: ดึง members จาก user หรือ role
// return [{ id, displayName }]
// ============================
async function resolveTargets(interaction) {
  const user = interaction.options.getUser('target');
  const role = interaction.options.getRole('role');

  if (role) {
    // fetch ทุกคนใน guild ก่อนเพื่อให้ cache ครบ แล้วค่อย filter ด้วย role
    await interaction.guild?.members.fetch();
    const members = interaction.guild?.roles.cache.get(role.id)?.members;
    if (!members || members.size === 0) return [];
    return members.map(m => ({ id: m.id, displayName: m.displayName }));
  }

  if (user) {
    const displayName = interaction.guild?.members.cache.get(user.id)?.displayName || user.username;
    return [{ id: user.id, displayName }];
  }

  return [];
}

// ============================
// /daily
// ============================
async function handleDaily(interaction) {
  try {
    const { day, rewards, streak } = await claimDaily(interaction.user.id);
    const name      = interaction.member?.displayName || interaction.user.username;
    const avatarUrl = interaction.user.displayAvatarURL();
    const streakBar = `${'⭐'.repeat(streak)}${'☆'.repeat(7 - streak)}`;
    const rewardText = formatRewards(rewards);

    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setAuthor({ name, iconURL: avatarUrl })
      .setTitle('🌟 Daily Claim!')
      .addFields(
        { name: '📅 Streak', value: `Day **${day}**/7
${streakBar}`, inline: true },
        { name: '🎁 รางวัลวันนี้', value: rewardText, inline: true }
      );

    if (day === 7) embed.setFooter({ text: '🎉 ครบ 7 วัน! Streak จะรีเซ็ตในรอบหน้า' });

    await interaction.reply({ embeds: [embed] });
  } catch (err) { await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true }); }
}

// ============================
// /inventory
// ============================
async function handleInventory(interaction) {
  const name      = interaction.member?.displayName || interaction.user.username;
  const avatarUrl = interaction.user.displayAvatarURL();
  const inv       = await getInventory(interaction.user.id);
  await interaction.reply({ embeds: [buildInventoryEmbed(name, inv, avatarUrl)], ephemeral: false });
}

// ============================
// /inspect
// ============================
async function handleInspect(interaction) {
  const target    = interaction.options.getUser('target') || interaction.user;
  const name      = interaction.guild?.members.cache.get(target.id)?.displayName || target.username;
  const avatarUrl = target.displayAvatarURL();
  const inv       = await getInventory(target.id);
  await interaction.reply({ embeds: [buildInventoryEmbed(name, inv, avatarUrl)], ephemeral: true });
}

// ============================
// /setrole
// ============================
async function handleSetRole(interaction) {
  const role = interaction.options.getString('role');
  const name = interaction.member?.displayName || interaction.user.username;
  if (role === 'both') { await setRole(interaction.user.id, 'uma'); await setRole(interaction.user.id, 'trainer'); }
  else await setRole(interaction.user.id, role);
  const roleLabel = { uma: '🏇 สาวม้า', trainer: '👤 เทรนเนอร์', both: '🏇👤 ทั้งคู่' };
  await interaction.reply(`✅ **${name}** ตั้ง role เป็น ${roleLabel[role]} แล้ว`);
}

// ============================
// /give — สตาฟให้ Gold/RC (รองรับ user และ role)
// ============================
async function handleGive(interaction) {
  const type      = interaction.options.getString('type');
  const amount    = interaction.options.getInteger('amount');
  const staffName = interaction.member?.displayName || interaction.user.username;
  const names     = { gold: '💰 Gold', rc: '🌈 RC' };

  try {
    const targets = await resolveTargets(interaction);
    if (targets.length === 0) throw new Error('ไม่พบผู้รับ');

    for (const t of targets) await addItem(t.id, type, amount);

    if (targets.length === 1) {
      const inv = await getInventory(targets[0].id);
      await interaction.reply(
        `✅ **${staffName}** ให้ ${names[type]} +${amount.toLocaleString()} แก่ **${targets[0].displayName}**\n` +
        `💰 ${inv.gold.toLocaleString()} | 🌈 ${inv.rc.toLocaleString()}`
      );
    } else {
      await interaction.reply(
        `✅ **${staffName}** ให้ ${names[type]} +${amount.toLocaleString()} แก่ **${targets.length} คน** แล้ว`
      );
    }
  } catch (err) { await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true }); }
}

// ============================
// /gift — สตาฟให้ item (รองรับ user และ role)
// ============================
async function handleGift(interaction) {
  const type      = interaction.options.getString('type');
  const amount    = interaction.options.getInteger('amount') || 1;
  const staffName = interaction.member?.displayName || interaction.user.username;

  const itemNames = {
    'reroll.main':    '🔁 Main Reroll',
    'reroll.oneUse':  '⚡ One-use Reroll',
    'reroll.trainer': '🎯 Trainer Reroll',
    'raceSafe':       '🛡️ Race Safe',
    'hillClearItem':  '🏔️ Hill Clear',
    'zoneUnlock':     '🌀 Zone Unlock',
  };

  try {
    await interaction.deferReply();
    const targets = await resolveTargets(interaction);
    if (targets.length === 0) throw new Error('ไม่พบผู้รับ');

    for (const t of targets) await addItem(t.id, type, amount);

    const itemLabel = itemNames[type] || type;
    const amountStr = type !== 'hillClearItem' && type !== 'zoneUnlock' ? ` ×${amount}` : '';

    if (targets.length === 1) {
      const inv = await getInventory(targets[0].id);
      const summary = `🔁 ${inv.reroll.main} | ⚡ ${inv.reroll.oneUse} | 🎯 ${inv.reroll.trainer} | 🛡️ ${inv.raceSafe} | 🏔️ ${inv.hillClearItem ? 'มี' : 'ไม่มี'} | 🌀 ${inv.zoneUnlocked ? 'Unlocked' : 'Locked'}`;
      await interaction.editReply(
        `🎁 **${staffName}** มอบ **${itemLabel}${amountStr}** ให้ **${targets[0].displayName}**\n${summary}`
      );
    } else {
      await interaction.editReply(
        `🎁 **${staffName}** มอบ **${itemLabel}${amountStr}** ให้ **${targets.length} คน** แล้ว`
      );
    }
  } catch (err) {
    const msg = { content: `❌ ${err.message}`, ephemeral: true };
    if (interaction.deferred) await interaction.editReply(msg);
    else await interaction.reply(msg);
  }
}

// ============================
// /transfer — ผู้เล่นโอน Gold ให้กัน
// ============================
async function handleTransfer(interaction) {
  const target   = interaction.options.getUser('target');
  const amount   = interaction.options.getInteger('amount');
  const fromName = interaction.member?.displayName || interaction.user.username;
  const toName   = interaction.guild?.members.cache.get(target.id)?.displayName || target.username;

  if (target.id === interaction.user.id) {
    await interaction.reply({ content: '❌ ไม่สามารถโอนให้ตัวเองได้', ephemeral: true });
    return;
  }

  try {
    const fromInv = getInventory(interaction.user.id);
    if (fromInv.gold < amount) throw new Error(`Gold ไม่พอ (มี ${fromInv.gold.toLocaleString()})`);

    fromInv.gold -= amount;
    await addItem(target.id, 'gold', amount);
    const toInv = getInventory(target.id);

    await interaction.reply(
      `💸 **${fromName}** โอน 💰 **${amount.toLocaleString()} Gold** ให้ **${toName}**\n` +
      `${fromName}: ${fromInv.gold.toLocaleString()} | ${toName}: ${toInv.gold.toLocaleString()}`
    );
  } catch (err) { await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true }); }
}

module.exports = {
  handleDaily, handleInventory, handleInspect, handleSetRole,
  handleGive, handleGift, handleTransfer,
};
