'use strict';

require('dotenv').config();
const { initDB } = require('./src/db');

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

const { handleRoll, handlePrefixRoll, handleRerollSelect, handleDoReroll, handleCancelReroll, handleSafe, handleDebuff, handleAllOut, handleTrainerReroll, hasAllowedRole } = require('./src/commands/roll');
const { handleRace }    = require('./src/commands/race');
const { handleTrain }   = require('./src/commands/train');
const { handleDaily, handleInventory, handleInspect, handleSetRole, handleGive, handleGift, handleTransfer } = require('./src/commands/economy');
const { restoreSessionsFromDB } = require('./src/race/raceSession');

// ============================
// Global Error Handlers — ป้องกัน process crash จาก unhandled error
// ต้องอยู่บนสุดก่อน client สร้าง
// ============================
process.on('uncaughtException', err => {
  console.error('💥 [uncaughtException]', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 [unhandledRejection]', reason, 'at:', promise);
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
});

// ============================
// Commands Definition
// ============================
const commands = [
  new SlashCommandBuilder()
    .setName('roll').setDescription('ทอยเต๋า เช่น 3d30kh2, d30')
    .addStringOption(o => o.setName('notation').setDescription('รูปแบบเต๋า').setRequired(true))
    .addStringOption(o => o.setName('label').setDescription('ชื่อที่แสดงผล').setRequired(false)),

  new SlashCommandBuilder()
    .setName('race').setDescription('ระบบการแข่งม้า')
    .addSubcommand(s =>
      s.setName('start').setDescription('เปิด session')
        .addStringOption(o => o.setName('track').setDescription('สนาม').setRequired(true)
          .addChoices(
            { name: 'Tokyo',    value: 'Tokyo'    },
            { name: 'Nakayama', value: 'Nakayama' },
            { name: 'Kyoto',    value: 'Kyoto'    },
            { name: 'Hanshin',  value: 'Hanshin'  },
            { name: 'Chukyo',   value: 'Chukyo'   },
          ))
        .addStringOption(o => o.setName('grade').setDescription('ระดับ').setRequired(true)
          .addChoices(
            { name: 'G1', value: 'G1' }, { name: 'G2', value: 'G2' },
            { name: 'G3', value: 'G3' }, { name: 'Debut', value: 'Debut' },
          ))
        .addIntegerOption(o => o.setName('distance').setDescription('ระยะ').setRequired(true)
          .addChoices(
            { name: 'Sprint (8 เทิร์น)',       value: 8  },
            { name: 'Mile/Medium (12 เทิร์น)', value: 12 },
            { name: 'Long (14 เทิร์น)',         value: 14 },
          ))
    )
    .addSubcommand(s =>
      s.setName('register').setDescription('ลงทะเบียน')
        .addStringOption(o => o.setName('position').setDescription('สาย').setRequired(true)
          .addChoices(
            { name: 'Front', value: 'Front' }, { name: 'Pace', value: 'Pace' },
            { name: 'Late',  value: 'Late'  }, { name: 'End',  value: 'End'  },
          ))
        .addBooleanOption(o => o.setName('hillclear').setDescription('ใช้ Hill Clear? (Nakayama เท่านั้น)').setRequired(false))
    )
    .addSubcommand(s =>
      s.setName('zone').setDescription('ใช้ Zone (G1 เท่านั้น ใช้ได้ 1 ครั้งต่อแข่ง)')
        .addStringOption(o => o.setName('type').setDescription('เลือก White หรือ Gold').setRequired(true)
          .addChoices(
            { name: '⚪ White', value: 'white' },
            { name: '🟡 Gold',  value: 'gold'  },
          ))
    )
    .addSubcommand(s => s.setName('next').setDescription('จบเทิร์น/เฟส/การแข่ง'))
    .addSubcommand(s => s.setName('status').setDescription('ดูสถานะ'))
    .addSubcommand(s => s.setName('finish').setDescription('ผลการแข่ง'))
    .addSubcommand(s => s.setName('close').setDescription('ปิด session'))
    .addSubcommand(s =>
      s.setName('slowdown').setDescription('ลดแต้มตัวเอง (1-10)')
        .addIntegerOption(o => o.setName('amount').setDescription('จำนวน').setRequired(true).setMinValue(1).setMaxValue(10))
    )
    .addSubcommand(s =>
      s.setName('proxy').setDescription('สวมสิทธิ์ทอยแทนม้า (Staff/Assistant/Trainer)')
        .addUserOption(o => o.setName('target').setDescription('ม้าที่จะทอยแทน').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('unproxy').setDescription('ดึงสิทธิ์ควบคุมม้าของคุณคืน')
    )
    .addSubcommand(s =>
      s.setName('redo').setDescription('เรียกผลทอยล่าสุดมา reroll/safe โดยไม่ต้องเลื่อนหา')
    ),


  new SlashCommandBuilder()
    .setName('trainer').setDescription('คำสั่งเทรนเนอร์')
    .addSubcommand(s =>
      s.setName('reroll').setDescription('Reroll ผลล่าสุดของสาวม้า')
        .addUserOption(o => o.setName('target').setDescription('สาวม้า').setRequired(true))
    ),

  new SlashCommandBuilder()
    .setName('train').setDescription('ระบบส่งบทฝึก')
    .addSubcommand(s =>
      s.setName('submit').setDescription('ส่งบทฝึก')
        .addStringOption(o => o.setName('type').setDescription('ประเภท').setRequired(true)
          .addChoices(
            { name: 'ฝึกคนเดียว',              value: 'solo'        },
            { name: 'คุยกับเทรนเนอร์',          value: 'withTrainer' },
            { name: 'ฝึกคู่/กลุ่ม',             value: 'group'       },
            { name: 'ล้าง Hill Debuff',          value: 'hillClear'   },
            { name: 'Unlock Zone (G1)',          value: 'zoneUnlock'  },
          ))
        .addStringOption(o => o.setName('link').setDescription('ลิงก์บทโรล').setRequired(true))
        .addUserOption(o => o.setName('trainer').setDescription('เทรนเนอร์ (ถ้ามี)').setRequired(false))
        .addUserOption(o => o.setName('uma').setDescription('สาวม้า (ถ้าเทรนเนอร์ submit แทน)').setRequired(false))
        .addStringOption(o => o.setName('location').setDescription('สถานที่ฝึก').setRequired(false))
    )
    .addSubcommand(s =>
      s.setName('approve').setDescription('อนุมัติบทฝึก (สตาฟ)')
        .addStringOption(o => o.setName('id').setDescription('รหัส เช่น TRN-0001').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('reject').setDescription('ปฏิเสธบทฝึก (สตาฟ)')
        .addStringOption(o => o.setName('id').setDescription('รหัส').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('เหตุผล').setRequired(false))
    )
    .addSubcommand(s => s.setName('list').setDescription('รายการรอ approve (สตาฟ)')),

  new SlashCommandBuilder()
    .setName('debuff').setDescription('ใช้สกิลแดง บังคับให้คนอื่นทอยใหม่')
    .addUserOption(o => o.setName('target').setDescription('เป้าหมาย').setRequired(true)),

  new SlashCommandBuilder().setName('allout').setDescription('All Out — reroll ใหม่ แต่หักแต้ม -10n'),

  new SlashCommandBuilder().setName('daily').setDescription('รับรางวัล daily streak'),
  new SlashCommandBuilder().setName('inventory').setDescription('ดู inventory (ทุกคนเห็น)'),
  new SlashCommandBuilder()
    .setName('inspect').setDescription('ดู inventory แบบ private')
    .addUserOption(o => o.setName('target').setDescription('ดู inventory ของคนอื่น').setRequired(false)),
  new SlashCommandBuilder()
    .setName('setrole').setDescription('ตั้ง role ของคุณ')
    .addStringOption(o => o.setName('role').setDescription('role').setRequired(true)
      .addChoices(
        { name: 'สาวม้า',              value: 'uma'     },
        { name: 'เทรนเนอร์',           value: 'trainer' },
        { name: 'สาวม้า + เทรนเนอร์', value: 'both'    },
      )),

  new SlashCommandBuilder()
    .setName('give').setDescription('ให้ Gold/RC แก่ผู้เล่น (สตาฟ)')
    .addStringOption(o => o.setName('type').setDescription('ประเภท').setRequired(true)
      .addChoices(
        { name: '💰 Gold', value: 'gold' },
        { name: '🌈 RC',   value: 'rc'   },
      ))
    .addIntegerOption(o => o.setName('amount').setDescription('จำนวน').setRequired(true).setMinValue(1))
    .addUserOption(o => o.setName('target').setDescription('ผู้รับ (คน)').setRequired(false))
    .addRoleOption(o => o.setName('role').setDescription('ผู้รับ (role ทั้งหมด)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('gift').setDescription('มอบ item แก่ผู้เล่น (สตาฟ)')
    .addStringOption(o => o.setName('type').setDescription('ประเภท item').setRequired(true)
      .addChoices(
        { name: '🔁 Main Reroll',    value: 'reroll.main'    },
        { name: '⚡ One-use Reroll', value: 'reroll.oneUse'  },
        { name: '🎯 Trainer Reroll', value: 'reroll.trainer' },
        { name: '🛡️ Race Safe',      value: 'raceSafe'       },
        { name: '🏔️ Hill Clear',     value: 'hillClearItem'  },
        { name: '🌀 Zone Unlock',    value: 'zoneUnlock'     },
      ))
    .addIntegerOption(o => o.setName('amount').setDescription('จำนวน (ไม่ใช้กับ Hill Clear/Zone)').setRequired(false).setMinValue(1))
    .addUserOption(o => o.setName('target').setDescription('ผู้รับ (คน)').setRequired(false))
    .addRoleOption(o => o.setName('role').setDescription('ผู้รับ (role ทั้งหมด)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('transfer').setDescription('โอน Gold ให้ผู้เล่นอื่น')
    .addUserOption(o => o.setName('target').setDescription('ผู้รับ').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('จำนวน Gold').setRequired(true).setMinValue(1)),

].map(cmd => cmd.toJSON());

// ============================
// Ready
// ============================
client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await initDB();
  await restoreSessionsFromDB(); // โหลด active sessions กลับมาหลัง restart
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash commands registered!');
  } catch (err) { console.error('❌ Register failed:', err); }
});

// ============================
// Message (prefix !r)
// ============================
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!message.content.startsWith('!r ') && message.content !== '!r') return;
  await handlePrefixRoll(message);
});

// ============================
// Interactions — Router
// ============================
client.on('interactionCreate', async interaction => {
  try {
    // Commands ที่ทุกคนใช้ได้ (ไม่ต้องมี Staff/Assistant role)
    const publicCmds = [
      'roll', 'daily', 'inventory', 'inspect', 'allout',
      'race', 'train', 'transfer', 'debuff', 'setrole', 'trainer',
    ];

    if (interaction.isChatInputCommand()) {
      if (!publicCmds.includes(interaction.commandName) && !hasAllowedRole(interaction.member)) {
        await interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้', ephemeral: true });
        return;
      }
    }

    // Select Menu
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('rerollSelect:')) await handleRerollSelect(interaction);
      return;
    }

    // Buttons
    if (interaction.isButton()) {
      const action = interaction.customId.split(':')[0];
      if (action === 'doReroll')     await handleDoReroll(interaction);
      if (action === 'cancelReroll') await handleCancelReroll(interaction);
      if (action === 'safe')         await handleSafe(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    if (commandName === 'roll')      await handleRoll(interaction);
    if (commandName === 'race')      await handleRace(interaction);
    if (commandName === 'trainer')   await handleTrainerReroll(interaction);
    if (commandName === 'debuff')    await handleDebuff(interaction);
    if (commandName === 'allout')    await handleAllOut(interaction);
    if (commandName === 'train')     await handleTrain(interaction, client);
    if (commandName === 'daily')     await handleDaily(interaction);
    if (commandName === 'inventory') await handleInventory(interaction);
    if (commandName === 'inspect')   await handleInspect(interaction);
    if (commandName === 'setrole')   await handleSetRole(interaction);
    if (commandName === 'give')      await handleGive(interaction);
    if (commandName === 'gift')      await handleGift(interaction);
    if (commandName === 'transfer')  await handleTransfer(interaction);

  } catch (err) {
    // Router-level catch — กัน crash กรณี handler โยน error ออกมา
    console.error('❌ [Router Error]', err);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: '❌ เกิดข้อผิดพลาด กรุณาลองใหม่', ephemeral: true });
      } else {
        await interaction.reply({ content: '❌ เกิดข้อผิดพลาด กรุณาลองใหม่', ephemeral: true });
      }
    } catch { /* interaction อาจ expire แล้ว */ }
  }
});

client.login(process.env.DISCORD_TOKEN);
