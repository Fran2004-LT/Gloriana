'use strict';

const { EmbedBuilder } = require('discord.js');
const db = require('../db');
const { RELATION_TYPES, relationLabel } = require('../character/relations');

const STAFF_ROLES = ['1441679665893740614', '1506298098224332850'];
function isStaff(member) {
  return !!member && STAFF_ROLES.some(id => member.roles.cache.has(id));
}

function nameOf(interaction, user) {
  return interaction.guild?.members.cache.get(user.id)?.displayName || user.username;
}

// ============================
// /character set | info | remove
// ============================
async function handleCharacter(interaction) {
  const sub = interaction.options.getSubcommand();

  if ((sub === 'set' || sub === 'remove') && !isStaff(interaction.member)) {
    await interaction.reply({ content: '❌ เฉพาะสตาฟเท่านั้น', ephemeral: true });
    return;
  }

  try {
    if (sub === 'set') {
      const user    = interaction.options.getUser('user');
      const name    = interaction.options.getString('name').trim();
      const trainer = interaction.options.getUser('trainer');
      if (trainer && trainer.id === user.id) throw new Error('เทรนเนอร์ต้องเป็นคนละคนกับสาวม้า');

      await db.setCharacterDB(user.id, name, trainer ? trainer.id : null);
      await interaction.reply(
        `✅ บันทึกตัวละคร **${name}** (<@${user.id}>)` +
        (trainer ? `\n👤 เทรนเนอร์: <@${trainer.id}>` : '\n👤 ยังไม่มีเทรนเนอร์')
      );
    }

    if (sub === 'remove') {
      const user = interaction.options.getUser('user');
      await db.deleteCharacterDB(user.id);
      await interaction.reply(`🗑️ ลบข้อมูลตัวละครและความสัมพันธ์ทั้งหมดของ <@${user.id}> แล้ว`);
    }

    if (sub === 'info') {
      const user = interaction.options.getUser('user') || interaction.user;
      const ch   = await db.getCharacterDB(user.id);
      if (!ch) throw new Error(`<@${user.id}> ยังไม่มีข้อมูลตัวละคร`);

      const rels = await db.listRelationshipsDB(user.id);
      const team = ch.trainerId ? (await db.getTeamDB(ch.trainerId)).filter(m => m.userId !== user.id) : [];

      const relText = rels.length
        ? rels.map(r => `${relationLabel(r.type)} — <@${r.otherId}>`).join('\n')
        : 'ยังไม่มี';

      const embed = new EmbedBuilder()
        .setColor(0xF5C518)
        .setTitle(`🏇 ${ch.name}`)
        .setDescription(`<@${user.id}>`)
        .addFields(
          { name: '👤 เทรนเนอร์', value: ch.trainerId ? `<@${ch.trainerId}>` : 'ยังไม่มี', inline: true },
          { name: '🏠 เพื่อนร่วมทีม', value: team.length ? team.map(m => m.name).join(', ') : '—', inline: true },
          { name: '🔗 ความสัมพันธ์', value: relText, inline: false },
        )
        .setFooter({ text: 'ฝึกกับเทรนเนอร์ / เพื่อนร่วมทีม / คนที่มีความสัมพันธ์ → ⚡ One-use Reroll +1' });
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  } catch (err) {
    await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
  }
}

// ============================
// /relation add | remove   (สตาฟ — router กันไว้แล้ว)
// ============================
async function handleRelation(interaction) {
  const sub  = interaction.options.getSubcommand();
  const a    = interaction.options.getUser('user1');
  const b    = interaction.options.getUser('user2');
  const type = interaction.options.getString('type');

  try {
    if (a.id === b.id) throw new Error('ต้องเป็นตัวละครคนละตัว');
    if (!RELATION_TYPES[type]) throw new Error('ประเภทความสัมพันธ์ไม่ถูกต้อง');

    if (sub === 'add') {
      const [ca, cb] = await Promise.all([db.getCharacterDB(a.id), db.getCharacterDB(b.id)]);
      const missing = [!ca && a, !cb && b].filter(Boolean);
      if (missing.length) {
        throw new Error(`${missing.map(u => `<@${u.id}>`).join(', ')} ยังไม่มีข้อมูลตัวละคร — ใช้ \`/character set\` ก่อน`);
      }
      const added = await db.addRelationshipDB(a.id, b.id, type);
      await interaction.reply(added
        ? `✅ **${ca.name}** ↔ **${cb.name}** เป็น ${relationLabel(type)}`
        : `ℹ️ **${ca.name}** ↔ **${cb.name}** เป็น ${relationLabel(type)} อยู่แล้ว`);
    }

    if (sub === 'remove') {
      const removed = await db.removeRelationshipDB(a.id, b.id, type);
      await interaction.reply(removed
        ? `🗑️ ลบ ${relationLabel(type)} ระหว่าง **${nameOf(interaction, a)}** กับ **${nameOf(interaction, b)}** แล้ว`
        : { content: '❌ ไม่พบความสัมพันธ์นี้', ephemeral: true });
    }
  } catch (err) {
    await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
  }
}

module.exports = { handleCharacter, handleRelation };
