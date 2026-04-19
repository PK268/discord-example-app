import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { InstallGlobalCommands, InstallGuildCommands } from './utils.js';

const DATA_FILE = path.resolve('data', 'seat-monitor-state.json');

const REGISTER_COMMAND = {
  name: 'register',
  description: 'Store a course and CRN for seat alerts',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      type: 3,
      name: 'course',
      description: 'Course code, such as CSCI101',
      required: true,
    },
    {
      type: 3,
      name: 'crn',
      description: 'Course reference number',
      required: true,
    },
  ],
};

const START_COMMAND = {
  name: 'start',
  description: 'Start posting seat alerts in this channel',
  type: 1,
  integration_types: [0, 1],
  contexts: [0],
};

const CHECKNOW_COMMAND = {
  name: 'checknow',
  description: 'Check all tracked course and CRN combos right now',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const SEEERRORS_COMMAND = {
  name: 'seeerrors',
  description: 'Opt in or out of seat API error messages for your tracked combos',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      type: 5,
      name: 'enabled',
      description: 'True to receive error messages, false to turn them off',
      required: true,
    },
  ],
};

const SPECIALAUTOPOST_COMMAND = {
  name: 'specialautopost',
  description: 'Opt in or out of the special CS3000 / 13895 auto-post request',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      type: 5,
      name: 'enabled',
      description: 'True to enable the special request, false to disable it',
      required: true,
    },
  ],
};

const SETAUTOPARAMS_COMMAND = {
  name: 'setautoparams',
  description: 'Store the auto-post parameters for the special CS3000 / 13895 flow',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      type: 3,
      name: 'xsynctoken',
      description: 'The xsynctoken path parameter',
      required: true,
    },
    {
      type: 3,
      name: 'cookiestring',
      description: 'The cookieString path parameter',
      required: true,
    },
    {
      type: 3,
      name: 'uniquesessionid',
      description: 'The uniqueSessionId path parameter',
      required: true,
    },
  ],
};

async function resolveGuildId() {
  if (process.env.GUILD_ID?.trim()) {
    return process.env.GUILD_ID.trim();
  }

  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const state = JSON.parse(raw);
    const savedGuildIds = Object.keys(state.guildChannels ?? {});
    return savedGuildIds[0];
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('Failed to read saved guild state:', error);
    }

    return undefined;
  }
}

const guildId = await resolveGuildId();

if (guildId) {
  await InstallGuildCommands(process.env.APP_ID, guildId, [REGISTER_COMMAND, START_COMMAND, CHECKNOW_COMMAND, SEEERRORS_COMMAND, SPECIALAUTOPOST_COMMAND, SETAUTOPARAMS_COMMAND]);
} else {
  await InstallGlobalCommands(process.env.APP_ID, [REGISTER_COMMAND, START_COMMAND, CHECKNOW_COMMAND, SEEERRORS_COMMAND, SPECIALAUTOPOST_COMMAND, SETAUTOPARAMS_COMMAND]);
}
