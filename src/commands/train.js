'use strict';

const { EmbedBuilder } = require('discord.js');
const { relationLabel } = require('../character/relations');
const {
  CHANNELS, TYPE_NAMES,
  createSubmission, approveSubmission, rejectSubmission, getPendingList, formatItems,
} = require('../train/trainSystem');

// Staff / Assistant เท่านั้นที่ approve/reject/list ได้
const STAFF_ROLES = ['1441679665893740614', '1506298098224332850'];
function isStaff(member) {
  return !!member && STAFF_ROLES.some(id => member.roles.cache.has(id));
}

function rewardLine(r) {
  const who = `<@${r.userId}>`;
  let line = `${r.role === 'trainer' ? '👤' : '🏇'} ${who}: ${formatItems(r.items)}`;
  if (r.role === 'uma' && r.reasons) {
    if (r.reasons.length)  line += `\n   ↳ ${[...new Set(r.reasons)].map(relationLabel).join(', ')}`;
    else if (r.noCharacter) line += `\n   ↳ ยังไม่มีข้อมูลตัวละคร (ให้สตาฟใช้ \`/character set\`)`;
    else                    line += `\n   ↳ ไม่มีความสัมพันธ์ที่เข้าเงื่อนไข`;
  }
  return line;
}

async function handleTrain(interaction, client) {
  const sub = interaction.options.getSubcommand();

  if (['approve', 'reject', 'list'].includes(sub) && !isStaff(interaction.member)) {
    await interaction.reply({ content: '❌ เฉพาะสตาฟเท่านั้น', ephemeral: true });
    return;
  }

  try {
    if (sub === 'submit') {
      const type     = interaction.options.getString('type');
      const link     = interaction.options.getString('link');
      const trainer  = interaction.options.getUser('trainer');
      const partner  = interaction.options.getUser('partner');
      const umaUser  = interaction.options.getUser('uma');
      const location = interaction.options.getString('location') || 'ไม่ระบุ';

      const s = await createSubmission({
        type, link, location,
        umaId:     umaUser ? umaUser.id : interaction.user.id,
        partnerId: partner ? partner.id : null,
        trainerId: trainer ? trainer.id : null,
        submittedBy: interaction.user.username,
      });

      const who =
        `🏇 สาวม้า: <@${s.umaId}>` +
        (s.partnerId ? `\n🏇 คู่ฝึก: <@${s.partnerId}>` : '') +
        (s.trainerId ? `\n👤 เทรนเนอร์: <@${s.trainerId}>` : '');

      try {
        const reviewCh = await client.channels.fetch(CHANNELS.review);
        await reviewCh.send(
          `📋 **บทฝึกใหม่รอพิจารณา** | \`${s.id}\`\n${who}\n` +
          `📝 ${TYPE_NAMES[type]}\n📍 ${location}\n🔗 ${link}\nส่งโดย ${s.submittedBy}\n\n` +
          `\`/train approve ${s.id}\` | \`/train reject ${s.id}\``
        );
      } catch (e) { console.error('[train submit] review channel', e); }

      await interaction.reply(`✅ ส่งบทฝึกแล้ว! รหัส: \`${s.id}\`\n📝 ${TYPE_NAMES[type]}\n${who}\nรอสตาฟพิจารณา`);
    }

    if (sub === 'approve') {
      const id = interaction.options.getString('id').toUpperCase();
      await interaction.deferReply({ ephemeral: true });
      const { submission, rewards } = await approveSubmission(id);

      const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle(`✅ อนุมัติบทฝึก ${submission.id}`)
        .setDescription(`📝 ${TYPE_NAMES[submission.type]}\n\n🎁 **รางวัล**\n${rewards.map(rewardLine).join('\n')}`);

      try {
        const submitCh = await client.channels.fetch(CHANNELS.submit);
        await submitCh.send({ embeds: [embed] });
      } catch (e) { console.error('[train approve] submit channel', e); }

      await interaction.editReply({ content: `✅ approve \`${submission.id}\` แล้ว`, embeds: [embed] });
    }

    if (sub === 'reject') {
      const id     = interaction.options.getString('id').toUpperCase();
      const reason = interaction.options.getString('reason') || '';
      const s      = await rejectSubmission(id, reason);
      try {
        const submitCh = await client.channels.fetch(CHANNELS.submit);
        await submitCh.send(
          `❌ **บทฝึกไม่ผ่าน** \`${s.id}\`\n🏇 <@${s.umaId}>` +
          (s.partnerId ? ` | 🏇 <@${s.partnerId}>` : '') +
          (s.trainerId ? ` | 👤 <@${s.trainerId}>` : '') +
          (reason ? `\n📝 ${reason}` : '')
        );
      } catch (e) { console.error('[train reject] submit channel', e); }
      await interaction.reply({ content: `❌ reject \`${s.id}\` แล้ว`, ephemeral: true });
    }

    if (sub === 'list') {
      const list = await getPendingList();
      if (!list.length) { await interaction.reply({ content: '📋 ไม่มีบทฝึกรอ', ephemeral: true }); return; }
      const text = list.map(s =>
        `\`${s.id}\` | <@${s.umaId}>${s.partnerId ? ` + <@${s.partnerId}>` : ''} | ${TYPE_NAMES[s.type]}`
      ).join('\n');
      await interaction.reply({ content: `📋 **รอ approve:**\n${text}`, ephemeral: true });
    }
  } catch (err) {
    const msg = { content: `❌ ${err.message}`, ephemeral: true };
    if (interaction.deferred) await interaction.editReply(msg);
    else if (!interaction.replied) await interaction.reply(msg);
  }
}

module.exports = { handleTrain };
