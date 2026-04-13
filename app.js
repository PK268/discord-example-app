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
const KEEPALIVE_INTERVAL_MS = 240000;
const SPECIAL_AUTOPOST_COURSE = 'CS3000';
const SPECIAL_AUTOPOST_CRN = '13895';

const registrations = new Map();
const guildChannels = new Map();
const scheduledChecks = new Map();
const autoPostParams = new Map();
const keepaliveTimers = new Map();

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

function getRegistrationsForUser(userId) {
  return [...registrations.entries()]
    .filter(([, registration]) => registration.userId === userId)
    .map(([key, registration]) => ({ key, registration }));
}

function getClientForUrl(url) {
  const parsedUrl = new URL(url);
  return {
    parsedUrl,
    client: parsedUrl.protocol === 'http:' ? http : https,
    requestOptions: parsedUrl.protocol === 'https:' ? { rejectUnauthorized: false } : undefined,
  };
}

function isSpecialAutoPostRegistration(registration) {
  return registration.course.toUpperCase() === SPECIAL_AUTOPOST_COURSE && registration.crn === SPECIAL_AUTOPOST_CRN;
}

function clearKeepalive(userId) {
  const timer = keepaliveTimers.get(userId);

  if (timer) {
    clearTimeout(timer);
    keepaliveTimers.delete(userId);
  }
}

function scheduleKeepalive(userId) {
  clearKeepalive(userId);

  if (!autoPostParams.has(userId)) {
    return;
  }

  const timer = setTimeout(() => {
    void runKeepalive(userId);
  }, KEEPALIVE_INTERVAL_MS);

  keepaliveTimers.set(userId, timer);
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
    const { parsedUrl, client, requestOptions } = getClientForUrl(url);

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

function requestStatus(url, method) {
  return new Promise((resolve, reject) => {
    const { parsedUrl, client, requestOptions } = getClientForUrl(url);
    const request = client.request(parsedUrl, { ...requestOptions, method }, (response) => {
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

        resolve({
          statusCode: response.statusCode ?? 0,
          body,
        });
      });
    });

    request.on('error', reject);
    request.end();
  });
}

async function requestKeepalive(userId) {
  const params = autoPostParams.get(userId);

  if (!params) {
    return { attempted: false };
  }

  const url = `${SEAT_API_BASE_URL}/api/KeepAlive/${encodeURIComponent(params.xsynctoken)}/${encodeURIComponent(params.cookieString)}/${encodeURIComponent(params.uniqueSessionId)}`;
  const response = await requestStatus(url, 'GET');

  const bodyText = String(response.body ?? '').trim();

  let alive = null;
  try {
    const parsed = JSON.parse(bodyText);
    if (typeof parsed === 'boolean') {
      alive = parsed;
    } else if (typeof parsed === 'number') {
      alive = parsed !== 0;
    } else if (typeof parsed === 'string') {
      alive = parsed.toLowerCase() === 'true';
    }
  } catch {
    // If JSON.parse fails, fall back to simple text checks.
    alive = bodyText.toLowerCase() === 'true' || bodyText === '1';
  }

  return {
    attempted: true,
    statusCode: response.statusCode,
    alive,
    rawBody: bodyText,
  };
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
    autoPostParams: Object.fromEntries(autoPostParams),
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

    for (const [userId, params] of Object.entries(payload.autoPostParams ?? {})) {
      autoPostParams.set(userId, params);
    }

    for (const userId of autoPostParams.keys()) {
      scheduleKeepalive(userId);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function runKeepalive(userId) {
  if (!autoPostParams.has(userId)) {
    clearKeepalive(userId);
    return;
  }

  const params = autoPostParams.get(userId);

  console.log(`Keepalive check for ${userId}: ${params.xsynctoken} / ${params.cookieString} / ${params.uniqueSessionId}`);

  try {
    const result = await requestKeepalive(userId);
    if (result.attempted) {
      console.log(`Keepalive performed for ${userId}: alive=${String(result.alive)} status=${result.statusCode}.`);

      if (result.alive === false) {
        const notifications = [];

        for (const channelId of guildChannels.values()) {
          const channel = await client.channels.fetch(channelId).catch(() => null);

          if (!channel || typeof channel.send !== 'function') {
            continue;
          }

          notifications.push(
            channel.send({
              content: 'sniper session no longer alive fix your dumb ahh code',
              allowedMentions: { parse: [] },
            })
          );
        }

        await Promise.allSettled(notifications);
      }
    }
  } catch (error) {
    console.error(`Keepalive failed for ${userId}:`, error);
  } finally {
    scheduleKeepalive(userId);
  }
}

async function triggerSpecialAutoPost(registration) {
  if (!isSpecialAutoPostRegistration(registration)) {
    return { attempted: false };
  }

  const params = autoPostParams.get(registration.userId);

  if (!params) {
    return {
      attempted: false,
      reason: 'Auto-post parameters have not been configured. Run /setautoparams first.',
    };
  }

  const url = `${SEAT_API_BASE_URL}/${encodeURIComponent(params.xsynctoken)}/${encodeURIComponent(params.cookieString)}/${encodeURIComponent(params.uniqueSessionId)}`;
  const response = await requestStatus(url, 'POST');

  return {
    attempted: true,
    statusCode: response.statusCode,
  };
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

async function notifyChannels(seatCount, registration, errorDetail) {
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
          content: `${userMention} seat API returned -1 for ${baseMessage}.`,
          allowedMentions: { users: [registration.userId] },
        })
      );
    } else if (seatCount === -2) {
      notifications.push(
        channel.send({
          content: `${userMention} seat API request failed for ${baseMessage}: ${errorDetail ?? 'unknown error'}`,
          allowedMentions: { parse: ['everyone'] },
        })
      );
    }
  }

  await Promise.allSettled(notifications);
}

async function processOpenSeat(registration, seatCount) {
  const autoPostResult = await triggerSpecialAutoPost(registration).catch((error) => ({
    attempted: true,
    failed: true,
    message: error instanceof Error ? error.message : String(error),
  }));

  if (autoPostResult?.failed) {
    console.error(`Special auto-post failed for ${registration.course} ${registration.crn}:`, autoPostResult.message);
    await notifyChannels(-2, registration, `special auto-post failed: ${autoPostResult.message}`);
  } else if (autoPostResult?.attempted) {
    console.log(`Special auto-post succeeded for ${registration.course} / ${registration.crn} with status ${autoPostResult.statusCode}.`);
  } else if (autoPostResult?.reason) {
    console.log(`Special auto-post skipped for ${registration.course} / ${registration.crn}: ${autoPostResult.reason}`);
  }

  await notifyChannels(seatCount, registration);
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

    if (seatCount === -1) {
      await notifyChannels(-1, registration);
      return;
    }

    await processOpenSeat(registration, seatCount);
  } catch (error) {
    await notifyChannels(-2, registration, error instanceof Error ? error.message : String(error));
    console.error(`Seat check request failed for ${registration.course} ${registration.crn}:`, error);
  } finally {
    scheduleNextCheck(registrationKey);
  }
}

async function runCheckNowForUser(userId) {
  const userRegistrations = getRegistrationsForUser(userId);

  if (userRegistrations.length === 0) {
    return {
      checked: 0,
      openSeats: 0,
      apiReturnedNegativeOne: 0,
      requestFailures: 0,
    };
  }

  const summary = {
    checked: 0,
    openSeats: 0,
    apiReturnedNegativeOne: 0,
    requestFailures: 0,
  };

  for (const { key, registration } of userRegistrations) {
    summary.checked += 1;

    try {
      const seatCount = await fetchSeatCount(registration.course, registration.crn);

      if (seatCount === 0) {
        console.log(`Manual check returned 0 for ${registration.course} / ${registration.crn}; no Discord message sent.`);
        continue;
      }

      if (seatCount === -1) {
        summary.apiReturnedNegativeOne += 1;
        await notifyChannels(-1, registration);
        continue;
      }

      summary.openSeats += 1;
      await processOpenSeat(registration, seatCount);
      scheduleNextCheck(key);
    } catch (error) {
      summary.requestFailures += 1;
      await notifyChannels(-2, registration, error instanceof Error ? error.message : String(error));
      console.error(`Manual seat check request failed for ${registration.course} ${registration.crn}:`, error);
    }
  }

  return summary;
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

  if (interaction.commandName === 'setautoparams') {
    const xsynctoken = interaction.options.getString('xsynctoken', true).trim();
    const cookieString = interaction.options.getString('cookiestring', true).trim();
    const uniqueSessionId = interaction.options.getString('uniquesessionid', true).trim();

    autoPostParams.set(interaction.user.id, {
      xsynctoken,
      cookieString,
      uniqueSessionId,
      updatedAt: Date.now(),
    });

    scheduleKeepalive(interaction.user.id);

    try {
      await saveState();
    } catch (error) {
      console.error('Failed to save auto-post parameters:', error);
    }

    await interaction.reply({
      content: 'Stored auto-post parameters for the special CS3000 / 13895 flow.',
      ephemeral: true,
      allowedMentions: { parse: [] },
    });

    return;
  }

  if (interaction.commandName === 'checknow') {
    const summary = await runCheckNowForUser(interaction.user.id);

    if (summary.checked === 0) {
      await interaction.reply({
        content: 'No tracked course / CRN combos found for your account. Use /register first.',
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: [
        `Checked ${summary.checked} tracked combo${summary.checked === 1 ? '' : 's'} right now.`,
        `${summary.openSeats} had open seats.`,
        `${summary.apiReturnedNegativeOne} returned -1 from the API.`,
        `${summary.requestFailures} had request/transport failures.`,
      ].join('\n'),
      ephemeral: true,
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

  for (const userId of autoPostParams.keys()) {
    scheduleKeepalive(userId);
  }

  console.log(`Logged in as ${client.user.tag}`);
  console.log(formatTrackedCourses());
});

client.login(process.env.DISCORD_TOKEN);
