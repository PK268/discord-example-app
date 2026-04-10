import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from 'discord.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
  ],
  partials: [Partials.Channel],
});

const DATA_FILE = path.resolve('data', 'seat-monitor-state.json');
const SEAT_API_BASE_URL = (process.env.SEAT_API_BASE_URL || 'https://localhost:7167').replace(/\/$/, '');
const POLL_MIN_MS = 120000;
const POLL_MAX_MS = 180000;

const registrations = new Map();
const guildChannels = new Map();
const scheduledChecks = new Map();

function formatTrackedCourses() {
  if (registrations.size === 0) {
    return 'No course/CRN combos are currently being traced.';
  }

  const lines = [...registrations.values()]
    .sort((a, b) => a.userId.localeCompare(b.userId) || a.course.localeCompare(b.course) || a.crn.localeCompare(b.crn))
    .map((entry) => `- <@${entry.userId}> ${entry.course} / ${entry.crn}`);
  return ['Currently traced course/CRN combos:', ...lines].join('\n');
}

function getRegistrationKey(entry) {
  return `${entry.userId}:${entry.course}:${entry.crn}`;
}

function upsertRegistration(entry) {
  const key = getRegistrationKey(entry);
  registrations.set(key, entry);
  return key;
}

function randomDelay() {
  return Math.floor(POLL_MIN_MS + Math.random() * (POLL_MAX_MS - POLL_MIN_MS));
}

function normalizeCourseInput(content) {
  const normalized = content.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return null;
  }

  const labeledMatch = normalized.match(/course\s*[:=]\s*([^\s,;]+).*crn\s*[:=]\s*([^\s,;]+)/i);
  if (labeledMatch) {
    return {
      course: labeledMatch[1],
      crn: labeledMatch[2],
    };
  }

  const tokens = normalized.split(/[\s,;]+/).filter(Boolean);
  if (tokens.length < 2) {
    return null;
  }

  return {
    course: tokens[0],
    crn: tokens[1],
  };
}

function parseSeatCount(rawBody) {
  const rawText = String(rawBody ?? '').trim();

  if (!rawText) {
    return -1;
  }

  try {
    const parsed = JSON.parse(rawText);

    if (typeof parsed === 'number') {
      return parsed;
    }

    if (parsed && typeof parsed === 'object') {
      for (const key of ['seats', 'seatCount', 'count', 'available', 'availableSeats']) {
        if (typeof parsed[key] === 'number') {
          return parsed[key];
        }
      }
    }
  } catch {
    // Fall through to numeric parsing.
  }

  const numericValue = Number(rawText);
  return Number.isFinite(numericValue) ? numericValue : -1;
}

function requestText(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'http:' ? http : https;
    const requestOptions = parsedUrl.protocol === 'https:' ? { rejectUnauthorized: false } : undefined;

    const request = client.get(parsedUrl, requestOptions, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if ((response.statusCode ?? 0) >= 400) {
          reject(new Error(`HTTP ${response.statusCode}: ${body}`));
          return;
        }

        resolve(body);
      });
    });

    request.on('error', reject);
  });
}

async function fetchSeatCount(course, crn) {
  const url = `${SEAT_API_BASE_URL}/api/Course/${encodeURIComponent(course)}/${encodeURIComponent(crn)}`;
  const body = await requestText(url);
  return parseSeatCount(body);
}

async function saveState() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });

  const payload = {
    registrations: Object.fromEntries(registrations),
    guildChannels: Object.fromEntries(guildChannels),
  };

  await fs.writeFile(DATA_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

async function loadState() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const payload = JSON.parse(raw);

    const loadedRegistrations = payload.registrations ?? {};

    for (const [key, registration] of Object.entries(loadedRegistrations)) {
      if (Array.isArray(registration)) {
        for (const entry of registration) {
          const normalizedEntry = {
            userId: entry.userId,
            course: entry.course,
            crn: entry.crn,
            updatedAt: entry.updatedAt ?? Date.now(),
          };

          registrations.set(getRegistrationKey(normalizedEntry), normalizedEntry);
        }

        continue;
      }

      const normalizedEntry = {
        userId: registration.userId ?? key.split(':')[0],
        course: registration.course,
        crn: registration.crn,
        updatedAt: registration.updatedAt ?? Date.now(),
      };

      registrations.set(getRegistrationKey(normalizedEntry), normalizedEntry);
    }

    for (const [guildId, channelId] of Object.entries(payload.guildChannels ?? {})) {
      guildChannels.set(guildId, channelId);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

function scheduleNextCheck(registrationKey) {
  const existingTimer = scheduledChecks.get(registrationKey);

  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  if (!registrations.has(registrationKey)) {
    scheduledChecks.delete(registrationKey);
    return;
  }

  const timer = setTimeout(() => {
    void runCheck(registrationKey);
  }, randomDelay());

  scheduledChecks.set(registrationKey, timer);
}

async function notifyChannels(seatCount, registration) {
  if (guildChannels.size === 0) {
    return;
  }

  const baseMessage = `${registration.course} (${registration.crn})`;
  const userMention = `<@${registration.userId}>`;
  const notifications = [];

  for (const channelId of guildChannels.values()) {
    const channel = await client.channels.fetch(channelId).catch(() => null);

    if (!channel || typeof channel.send !== 'function') {
      continue;
    }

    if (seatCount > 0) {
      notifications.push(
        channel.send({
          content: `${userMention} seats are available for ${baseMessage}: ${seatCount} open.`,
          allowedMentions: { users: [registration.userId] },
        })
      );
    } else if (seatCount === -1) {
      notifications.push(
        channel.send({
          content: `@here Error checking seats for ${baseMessage}.`,
          allowedMentions: { parse: ['everyone'] },
        })
      );
    }
  }

  await Promise.allSettled(notifications);
}

async function runCheck(registrationKey) {
  const registration = registrations.get(registrationKey);

  if (!registration) {
    scheduledChecks.delete(registrationKey);
    return;
  }

  try {
    const seatCount = await fetchSeatCount(registration.course, registration.crn);
    if (seatCount === 0) {
      console.log(`Seat check returned 0 for ${registration.course} / ${registration.crn}; no Discord message sent.`);
      return;
    }

    await notifyChannels(seatCount, registration);
  } catch (error) {
    await notifyChannels(-1, registration);
    console.error(`Seat check failed for ${registration.course} ${registration.crn}:`, error);
  } finally {
    scheduleNextCheck(registrationKey);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName === 'register') {
    const course = interaction.options.getString('course', true).trim();
    const crn = interaction.options.getString('crn', true).trim();
    const registration = {
      course,
      crn,
      userId: interaction.user.id,
      updatedAt: Date.now(),
    };
    const key = getRegistrationKey(registration);
    const alreadyTracking = registrations.has(key);

    upsertRegistration(registration);

    console.log(`Stored registration from ${interaction.user.tag}: ${course} / ${crn}`);

    scheduleNextCheck(key);

    try {
      await saveState();
    } catch (error) {
      console.error('Failed to save registration state:', error);
    }
    
    await interaction.reply({
      content: [
        alreadyTracking ? `Already tracking ${course} / ${crn}; refreshed its polling timer.` : `Stored ${course} / ${crn}.`,
        'Seat checks will run automatically every couple minutes.',
        'Use /start in a server channel to post seat alerts there.',
      ].join('\n'),
      ephemeral: true,
      allowedMentions: { parse: [] },
    });

    return;
  }

  if (interaction.commandName !== 'start') {
    return;
  }

  if (!interaction.inGuild()) {
    await interaction.reply({
      content: 'Use /start in a server channel.',
      ephemeral: true,
    });
    return;
  }

  guildChannels.set(interaction.guildId, interaction.channelId);
  console.log(`Registered alert channel ${interaction.channelId} for guild ${interaction.guildId}`);

  try {
    await saveState();
  } catch (error) {
    console.error('Failed to save channel state:', error);
  }

  await interaction.reply({
    content: `${formatTrackedCourses()}\n\nSeat alerts will be posted in this channel for any stored course and CRN combos.`,
    ephemeral: true,
  });
});

client.once(Events.ClientReady, async () => {
  try {
    await loadState();
  } catch (error) {
    console.error('Failed to load saved state:', error);
  }

  for (const registrationKey of registrations.keys()) {
    scheduleNextCheck(registrationKey);
  }

  console.log(`Logged in as ${client.user.tag}`);
  console.log(formatTrackedCourses());
});

client.login(process.env.DISCORD_TOKEN);
