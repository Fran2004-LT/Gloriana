'use strict';

const { unlockZone }    = require('../inventory/inventoryStore');
const { hasSession, getSession } = require('../race/raceSession');
const {
  CHANNELS, createSubmission, approveSubmission, rejectSubmission,
  getPendingList, formatRewards,
} = require('../train/trainSystem');

const TYPE_NAMES = {
  solo:        'ฝึกคนเดียว',
  withTrainer: 'คุยกับเทรนเนอร์',
  group:       'ฝึกคู่/กลุ่ม',
  hillClear:   'ล้าง Hill Debuff',
  zoneUnlock:  'Unlock Zone',
};

async function handleTrain(interaction, client) {
  const sub     = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  if (sub === 'submit') {
    const type     = interaction.options.getString('type');
    const link     = interaction.options.getString('link');
    const trainer  = interaction.options.getUser('trainer');
    const umaUser  = interaction.options.getUser('uma');
    const location = interaction.options.getString('location') || 'ไม่ระบุ';

    const umaId   = umaUser ? umaUser.id : interaction.user.id;
    const umaName = umaUser
      ? (interaction.guild?.members.cache.get(umaUser.id)?.displayName || umaUser.username)
      : (interaction.member?.displayName || interaction.user.username);
    const trainerId   = trainer ? trainer.id : interaction.user.id;
    const trainerName = trainer
      ? (interaction.guild?.members.cache.get(trainer.id)?.displayName || trainer.username)
      : (interaction.member?.displayName || interaction.user.username);

    const sub2 = createSubmission({ trainerId, trainerName, umaId, umaName, type, location, link, submittedBy: interaction.user.username });

    try {
      const reviewCh = await client.channels.fetch(CHANNELS.review);
      await reviewCh.send(
        `📋 **บทฝึกใหม่รอพิจารณา** | \`${sub2.id}\`\n` +
        `👤 เทรนเนอร์: <@${trainerId}>\n🏇 สาวม้า: <@${umaId}>\n` +
        `📝 ${TYPE_NAMES[type]}\n📍 ${location}\n🔗 ${link}\n` +
        `ส่งโดย ${sub2.submittedBy}\n\n` +
        `\`/train approve ${sub2.id}\` | \`/train reject ${sub2.id}\``
      );
    } catch { }

    await interaction.reply(`✅ ส่งบทฝึกแล้ว! รหัส: \`${sub2.id}\`\n📝 ${TYPE_NAMES[type]}\nรอสตาฟพิจารณา`);
  }

  if (sub === 'approve') {
    const id = interaction.options.getString('id').toUpperCase();
    try {
      const { submission, umaRewards, trainerRewards, special } = approveSubmission(id);

      if (special === 'hillClear' && hasSession(guildId)) {
        try {
          const session = getSession(guildId);
          const player  = session.players.get(submission.umaId);
          if (player) player.hillCleared = true;
        } catch { }
      }
      if (special === 'zoneUnlock') unlockZone(submission.umaId);

      const resultMsg =
        `✅ **อนุมัติบทฝึกแล้ว!**\n\n` +
        `🏇 สาวม้า: <@${submission.umaId}>\n🎁 รางวัล:\n${formatRewards(umaRewards)}\n\n` +
        `👤 เทรนเนอร์: <@${submission.trainerId}>\n🎁 รางวัล:\n${formatRewards(trainerRewards)}` +
        (special ? `\n\n✨ ${special}` : '');

      try {
        const submitCh = await client.channels.fetch(CHANNELS.submit);
        await submitCh.send(resultMsg);
      } catch { }

      await interaction.reply({ content: `✅ approve \`${id}\` แล้ว`, ephemeral: true });
    } catch (err) { await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true }); }
  }

  if (sub === 'reject') {
    const id     = interaction.options.getString('id').toUpperCase();
    const reason = interaction.options.getString('reason') || '';
    try {
      const submission = rejectSubmission(id, reason);
      const resultMsg =
        `❌ **บทฝึกไม่ผ่าน** \`${id}\`\n` +
        `🏇 <@${submission.umaId}> | 👤 <@${submission.trainerId}>\n` +
        (reason ? `📝 ${reason}` : '');

      try {
        const submitCh = await client.channels.fetch(CHANNELS.submit);
        await submitCh.send(resultMsg);
      } catch { }

      await interaction.reply({ content: `❌ reject \`${id}\` แล้ว`, ephemeral: true });
    } catch (err) { await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true }); }
  }

  if (sub === 'list') {
    const list = getPendingList();
    if (!list.length) { await interaction.reply({ content: '📋 ไม่มีบทฝึกรอ', ephemeral: true }); return; }
    const text = list.map(s => `\`${s.id}\` | <@${s.umaId}> | ${TYPE_NAMES[s.type]}`).join('\n');
    await interaction.reply({ content: `📋 **รอ approve:**\n${text}`, ephemeral: true });
  }
}

module.exports = { handleTrain };
