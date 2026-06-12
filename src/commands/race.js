'use strict';

const { getInventory, addItem, recordWin } = require('../inventory/inventoryStore');
const { getPlayerNotation }  = require('../dice/diceTable');
const { getHillDebuff }      = require('../config/tracks');
const { roll }               = require('../dice/diceRoller');
const {
  openSession, registerPlayer, adjustScore,
  submitScore,
  next, getSession, hasSession, closeSession, getLeaderboard,
  getTurnSnapshot,
} = require('../race/raceSession');

async function handleRace(interaction) {
  const sub     = interaction.options.getSubcommand();
  const channelId = interaction.channelId;

  try {
    // ============================
    if (sub === 'start') {
      const track    = interaction.options.getString('track');
      const grade    = interaction.options.getString('grade');
      const distance = interaction.options.getInteger('distance');
      const distNames = { 8: 'Sprint', 12: 'Mile/Medium', 14: 'Long' };
      await openSession(channelId, track, grade, distance);
      await interaction.reply(
        `🏇 **เปิด Session การแข่งแล้ว!**\n` +
        `🏟️ ${track} | ${grade} | ${distNames[distance]} (${distance} เทิร์น)\n\n` +
        `ใช้ \`/race register\` เพื่อลงทะเบียน — ลงทะเบียนแล้วทอยได้เลย!` +
        (grade === 'Debut' ? `\n🛡️ Debut: ทุกคนได้ Race Safe 3 อัน` : '')
      );
    }

    // ============================
    if (sub === 'register') {
      const position = interaction.options.getString('position');
      const useHill  = interaction.options.getBoolean('hillclear') || false;
      const session  = getSession(channelId);
      const inv      = await getInventory(interaction.user.id);
      const statusMsgs = [];

      let hillCleared = false;
      if (useHill) {
        if (session.track !== 'Nakayama') {
          statusMsgs.push('⚠️ Hill Clear ใช้ได้เฉพาะ Nakayama');
        } else if (!inv.hillClearItem) {
          statusMsgs.push('⚠️ ไม่มี Hill Clear item — ยังโดน debuff อยู่');
        } else {
          inv.hillClearItem = false;
          hillCleared = true;
          statusMsgs.push('✅ ล้าง Hill Debuff แล้ว');
        }
      }

      const player = registerPlayer(
        channelId, interaction.user.id,
        interaction.member?.displayName || interaction.user.username,
        position, { hillCleared }
      );

      // Debut ใช้ debutSafeCount ใน session แล้ว ไม่ต้องเพิ่ม raceSafe ใน inventory

      const extra = statusMsgs.length ? `\n${statusMsgs.join('\n')}` : '';
      await interaction.reply(
        `✅ **${player.displayName}** ลงทะเบียนสาย **${player.position}** แล้ว!\n` +
        `👥 ${session.players.size} คน | 🔁 Main: 1` +
        (session.grade === 'Debut' ? ` | 🛡️ Race Safe: 3` : '') +
        extra + `\nทอยด้วย \`!r\` หรือ \`/roll\` ได้เลย!`
      );
    }

    // ============================
    if (sub === 'zone') {
      const session = getSession(channelId);
      const player  = session.players.get(interaction.user.id);
      const inv     = await getInventory(interaction.user.id);
      const name    = interaction.member?.displayName || interaction.user.username;

      if (!player)                throw new Error('คุณยังไม่ได้ลงทะเบียนแข่ง');
      if (session.grade !== 'G1') throw new Error('Zone ใช้ได้เฉพาะ G1');
      if (!inv.zoneUnlocked)      throw new Error('ยังไม่ได้ unlock Zone — ต้องฝึกก่อน');
      if (player.zoneUsed)        throw new Error('ใช้ Zone ไปแล้วในการแข่งนี้');
      if (!player.rolled)         throw new Error('ต้องทอยก่อนถึงจะใช้ Zone ได้');

      const type   = interaction.options.getString('type');
      const isGold = type === 'gold';

      const { getNotation } = require('../dice/diceTable');
      let notation = getNotation(player.position, session.phase, isGold);

      const hill = player.hillCleared ? 0 : getHillDebuff(session.track, player.position, session.phase);
      if (hill > 0) notation = notation + '-' + hill;

      const r1   = roll(notation);
      const r2   = roll(notation);
      const best  = r1.total >= r2.total ? r1 : r2;
      const worst = r1.total <  r2.total ? r1 : r2;

      player.zoneUsed = true;

      const { player: updated } = submitScore(channelId, interaction.user.id, best, true, true);

      await interaction.reply(
        `🌀 **${name}** ใช้ **Zone** (${isGold ? '🟡 Gold' : '⚪ White'}) ด้วย \`${notation}\`\n` +
        `> ทอย 1: ${r1.display} → **${r1.total}**\n` +
        `> ทอย 2: ${r2.display} → **${r2.total}**\n` +
        `> เลือก: **${best.total}** ~~${worst.total}~~\n\n` +
        `📊 คะแนนสะสม: **${updated.score}**`
      );
    }

    // ============================
    if (sub === 'next') {
      // next() เป็น async แล้วหลังแก้ bug — ต้อง await
      const result = await next(channelId);
      if (result.type === 'finished') {
        const lb      = getLeaderboard(channelId);
        const session = getSession(channelId);
        const board   = lb.map(p => `${p.rank}. **${p.displayName}** [${p.position}] — ${p.score} แต้ม`).join('\n');
        if (lb.length > 0) await recordWin(lb[0].userId, session.grade);
        await interaction.reply(`🏁 **การแข่งจบแล้ว!**\n\n🏆 **ผลการแข่ง**\n\n${board}`);
      } else {
        const session = getSession(channelId);
        const prefix  = result.type === 'phase' ? `🔄 **จบเฟส ${result.phase - 1}!**\n\n` : `⏭️ **จบเทิร์น!**\n`;
        await interaction.reply(`${prefix}📍 เฟส ${result.phase} เทิร์น ${result.turn} (${result.totalTurn}/${session.distance})`);
      }
    }

    // ============================
    if (sub === 'status') {
      const session = getSession(channelId);
      const lb      = getLeaderboard(channelId);
      const board   = lb.map(p => {
        const zone = p.zoneUsed    ? ' 🌀' : '';
        const hill = p.hillCleared ? ' ✅' : '';
        const deb  = p.debuffed    ? ' 🔴' : '';
        return `${p.rank}. **${p.displayName}** [${p.position}${zone}${hill}${deb}] — ${p.score} แต้ม`;
      }).join('\n');
      await interaction.reply(
        `📊 **${session.track}** ${session.grade} | เฟส ${session.phase} เทิร์น ${session.turn} (${session.totalTurn}/${session.distance})\n\n` +
        `${board || 'ยังไม่มีผู้เล่น'}`
      );
    }

    if (sub === 'finish') {
      const lb    = getLeaderboard(channelId);
      const board = lb.map(p => `${p.rank}. **${p.displayName}** [${p.position}] — ${p.score} แต้ม`).join('\n');
      await interaction.reply(`🏆 **ผลการแข่ง**\n\n${board}`);
    }

    if (sub === 'close') {
      try {
        const s = getSession(channelId);
        for (const p of s.players.values()) p.mainRerollCooldown = false;
      } catch {}
      // closeSession() เป็น async แล้วหลังแก้ bug — ต้อง await
      await closeSession(channelId);
      await interaction.reply(`🔒 ปิด Session แล้ว`);
    }

    // ============================
    if (sub === 'slowdown') {
      const session = getSession(channelId);
      const player  = session.players.get(interaction.user.id);
      if (!player) throw new Error('คุณยังไม่ได้ลงทะเบียนแข่ง');
      if (player.slowedThisTurn) throw new Error('ลดแต้มได้แค่ 1 ครั้งต่อเทิร์น');

      const amount    = interaction.options.getInteger('amount');
      const updated   = adjustScore(channelId, interaction.user.id, amount);
      player.slowedThisTurn = true;

      const snapshot   = getTurnSnapshot(channelId);
      const allScores  = snapshot.map(([, s]) => s);
      const myScore    = session.turnSnapshot.get(interaction.user.id) ?? updated.score;
      const mySnapshot = { ...updated, score: myScore };
      const hill       = updated.hillCleared ? 0 : getHillDebuff(session.track, updated.position, session.phase);
      const { isGold } = getPlayerNotation(mySnapshot, session.phase, allScores, { hillDebuff: hill });

      await interaction.reply(
        `🐢 **${interaction.member?.displayName || interaction.user.username}** ลดแต้ม -${amount}\n` +
        `📊 **${updated.score}** | ${isGold ? '🟡 Gold zone' : '⚪ White zone'}`
      );
    }

  } catch (err) { await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true }); }
}

module.exports = { handleRace };
