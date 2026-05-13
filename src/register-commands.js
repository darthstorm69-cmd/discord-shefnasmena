// Run once with: node src/register-commands.js
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('report')
    .setDescription('Generate an activity report right now')
    .addStringOption(opt =>
      opt.setName('period')
        .setDescription('Time period to cover')
        .addChoices(
          { name: 'Last 7 days', value: '7' },
          { name: 'Last 30 days', value: '30' },
        )
    ),
  new SlashCommandBuilder()
    .setName('mystats')
    .setDescription('See your own activity this week'),
].map(c => c.toJSON());

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  console.log('Registering slash commands...');
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  console.log('Done.');
})();
