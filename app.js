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
const errorNotificationUsers = new Set();
const specialAutoPostUsers = new Set();

function formatTrackedCourses() {
  if (registrations.size === 0) {
    return 'No course/CRN combos are currently being traced.';
  }

  const lines = [...registrations.values()]
    .sort((a, b) => a.userId.localeCompare(b.userId) || a.course.localeCompare(b.course) || a.crn.localeCompare(b.crn))
    .map((entry) => `- <@${entry.userId}> ${entry.course} / ${entry.crn}`);
  return ['Currently traced course/CRN combos:', ...lines].join('\n');
}

function formatUserRegistrations(userId) {
  const userRegistrations = getRegistrationsForUser(userId)
    .map(({ registration }) => registration)
    .sort((a, b) => a.course.localeCompare(b.course) || a.crn.localeCompare(b.crn));

  if (userRegistrations.length === 0) {
    return 'You are not tracking any course/CRN combos.';
  }

  const lines = userRegistrations.map((entry) => `- ${entry.course} / ${entry.crn}`);
  return ['Your tracked course/CRN combos:', ...lines].join('\n');
}

function getRegistrationKey(entry) {
  return `${entry.userId}:${entry.course}:${entry.crn}`;
}

function getCourseCrnKey(course, crn) {
  return `${course.trim().toUpperCase()}:${crn.trim()}`;
}

function getCourseCrnKeyFromRegistration(entry) {
  return getCourseCrnKey(entry.course, entry.crn);
}

function upsertRegistration(entry) {
  const key = getRegistrationKey(entry);
  registrations.set(key, entry);
  return key;
}

function removeRegistration(entry) {
  const key = getRegistrationKey(entry);
  const removed = registrations.delete(key);

  return {
    key,
    removed,
  };
}

function getRegistrationsForUser(userId) {
  return [...registrations.entries()]
    .filter(([, registration]) => registration.userId === userId)
    .map(([key, registration]) => ({ key, registration }));
}

function getRegistrationsForCourseCrn(course, crn) {
  const comboKey = getCourseCrnKey(course, crn);

  return [...registrations.entries()]
    .filter(([, registration]) => getCourseCrnKeyFromRegistration(registration) === comboKey)
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

function shouldReceiveErrorNotifications(userId) {
  return errorNotificationUsers.has(userId);
}

function shouldTriggerSpecialAutoPost(userId) {
  return specialAutoPostUsers.has(userId);
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

  if (!autoPostParams.has(userId) || !shouldTriggerSpecialAutoPost(userId)) {
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
    errorNotificationUsers: [...errorNotificationUsers],
    specialAutoPostUsers: [...specialAutoPostUsers],
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

    for (const userId of payload.errorNotificationUsers ?? []) {
      errorNotificationUsers.add(userId);
    }

    for (const userId of payload.specialAutoPostUsers ?? []) {
      specialAutoPostUsers.add(userId);
    }

    for (const userId of specialAutoPostUsers) {
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

  if (!shouldTriggerSpecialAutoPost(registration.userId)) {
    return {
      attempted: false,
      reason: 'Special auto-post is not enabled for this user. Run /specialautopost enabled:true first.',
    };
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

function scheduleNextCheck(comboKey) {
  const existingTimer = scheduledChecks.get(comboKey);

  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const comboRegistrations = [...registrations.values()].filter((registration) => getCourseCrnKeyFromRegistration(registration) === comboKey);

  if (comboRegistrations.length === 0) {
    scheduledChecks.delete(comboKey);
    return;
  }

  const timer = setTimeout(() => {
    void runCheck(comboKey);
  }, randomDelay());

  scheduledChecks.set(comboKey, timer);
}

async function notifyChannels(seatCount, comboRegistrations, errorDetail) {
  if (guildChannels.size === 0) {
    return;
  }

  if (comboRegistrations.length === 0) {
    return;
  }

  const [{ registration: firstRegistration }] = comboRegistrations;
  const baseMessage = `${firstRegistration.course} (${firstRegistration.crn})`;
  const recipientRegistrations = seatCount > 0
    ? comboRegistrations
    : comboRegistrations.filter(({ registration }) => shouldReceiveErrorNotifications(registration.userId));

  if (recipientRegistrations.length === 0) {
    return;
  }

  const userIds = [...new Set(recipientRegistrations.map(({ registration }) => registration.userId))];
  const userMentions = userIds.map((userId) => `<@${userId}>`).join(' ');
  const notifications = [];

  for (const channelId of guildChannels.values()) {
    const channel = await client.channels.fetch(channelId).catch(() => null);

    if (!channel || typeof channel.send !== 'function') {
      continue;
    }

    if (seatCount > 0) {
      notifications.push(
        channel.send({
          content: `${userMentions} seats are available for ${baseMessage}: ${seatCount} open.`,
          allowedMentions: { users: userIds },
        })
      );
    } else if (seatCount === -1) {
      notifications.push(
        channel.send({
          content: `${userMentions} seat API returned -1 for ${baseMessage}.`,
          allowedMentions: { users: userIds },
        })
      );
    } else if (seatCount === -2) {
      notifications.push(
        channel.send({
          content: `${userMentions} seat API request failed for ${baseMessage}: ${errorDetail ?? 'unknown error'}`,
          allowedMentions: { users: userIds },
        })
      );
    }
  }

  await Promise.allSettled(notifications);
}

async function processOpenSeat(comboRegistrations, seatCount) {
  for (const { registration } of comboRegistrations) {
    const autoPostResult = await triggerSpecialAutoPost(registration).catch((error) => ({
      attempted: true,
      failed: true,
      message: error instanceof Error ? error.message : String(error),
    }));

    if (autoPostResult?.failed) {
      console.error(`Special auto-post failed for ${registration.course} ${registration.crn}:`, autoPostResult.message);
      await notifyChannels(-2, [{ key: getRegistrationKey(registration), registration }], `special auto-post failed: ${autoPostResult.message}`);
    } else if (autoPostResult?.attempted) {
      console.log(`Special auto-post succeeded for ${registration.course} / ${registration.crn} with status ${autoPostResult.statusCode}.`);
    } else if (autoPostResult?.reason) {
      console.log(`Special auto-post skipped for ${registration.course} / ${registration.crn}: ${autoPostResult.reason}`);
    }
  }

  await notifyChannels(seatCount, comboRegistrations);
}

async function runCheck(comboKey) {
  const comboRegistrations = [...registrations.entries()]
    .filter(([, registration]) => getCourseCrnKeyFromRegistration(registration) === comboKey)
    .map(([key, registration]) => ({ key, registration }));

  if (comboRegistrations.length === 0) {
    scheduledChecks.delete(comboKey);
    return;
  }

  const [{ registration }] = comboRegistrations;

  try {
    const seatCount = await fetchSeatCount(registration.course, registration.crn);
    if (seatCount === 0) {
      console.log(`Seat check returned 0 for ${registration.course} / ${registration.crn}; no Discord message sent.`);
      return;
    }

    if (seatCount === -1) {
      await notifyChannels(-1, comboRegistrations);
      return;
    }

    await processOpenSeat(comboRegistrations, seatCount);
  } catch (error) {
    await notifyChannels(-2, comboRegistrations, error instanceof Error ? error.message : String(error));
    console.error(`Seat check request failed for ${registration.course} ${registration.crn}:`, error);
  } finally {
    scheduleNextCheck(comboKey);
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
        await notifyChannels(-1, [{ key, registration }]);
        continue;
      }

      summary.openSeats += 1;
      await processOpenSeat([{ key, registration }], seatCount);
      scheduleNextCheck(getCourseCrnKeyFromRegistration(registration));
    } catch (error) {
      summary.requestFailures += 1;
      await notifyChannels(-2, [{ key, registration }], error instanceof Error ? error.message : String(error));
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

    scheduleNextCheck(getCourseCrnKeyFromRegistration(registration));

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

  if (interaction.commandName === 'unregister') {
    const course = interaction.options.getString('course', true).trim();
    const crn = interaction.options.getString('crn', true).trim();
    const registration = {
      course,
      crn,
      userId: interaction.user.id,
    };
    const comboKey = getCourseCrnKeyFromRegistration(registration);
    const { removed } = removeRegistration(registration);

    if (!removed) {
      await interaction.reply({
        content: `You were not tracking ${course} / ${crn}.`,
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    console.log(`Removed registration from ${interaction.user.tag}: ${course} / ${crn}`);

    scheduleNextCheck(comboKey);

    try {
      await saveState();
    } catch (error) {
      console.error('Failed to save registration state:', error);
    }

    await interaction.reply({
      content: `Stopped tracking ${course} / ${crn} for your account.`,
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
      content: 'Stored auto-post parameters for the special CS3000 / 13895 flow. The special request and keepalive stay off until you enable them with /specialautopost enabled:true.',
      ephemeral: true,
      allowedMentions: { parse: [] },
    });

    return;
  }

  if (interaction.commandName === 'seeerrors') {
    const enabled = interaction.options.getBoolean('enabled', true);

    if (enabled) {
      errorNotificationUsers.add(interaction.user.id);
    } else {
      errorNotificationUsers.delete(interaction.user.id);
    }

    try {
      await saveState();
    } catch (error) {
      console.error('Failed to save error notification preferences:', error);
    }

    await interaction.reply({
      content: enabled
        ? 'Error notifications are enabled for your tracked course / CRN combos.'
        : 'Error notifications are disabled for your tracked course / CRN combos.',
      ephemeral: true,
      allowedMentions: { parse: [] },
    });

    return;
  }

  if (interaction.commandName === 'specialautopost') {
    const enabled = interaction.options.getBoolean('enabled', true);

    if (enabled) {
      specialAutoPostUsers.add(interaction.user.id);
      scheduleKeepalive(interaction.user.id);
    } else {
      specialAutoPostUsers.delete(interaction.user.id);
      clearKeepalive(interaction.user.id);
    }

    try {
      await saveState();
    } catch (error) {
      console.error('Failed to save special auto-post preferences:', error);
    }

    await interaction.reply({
      content: enabled
        ? 'Special CS3000 / 13895 auto-post requests are enabled for your account.'
        : 'Special CS3000 / 13895 auto-post requests are disabled for your account.',
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

  if (interaction.commandName === 'listregistrations') {
    await interaction.reply({
      content: formatUserRegistrations(interaction.user.id),
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
    const registration = registrations.get(registrationKey);

    if (registration) {
      scheduleNextCheck(getCourseCrnKeyFromRegistration(registration));
    }
  }

  for (const userId of autoPostParams.keys()) {
    scheduleKeepalive(userId);
  }

  console.log(`Logged in as ${client.user.tag}`);
  console.log(formatTrackedCourses());
});

client.login(process.env.DISCORD_TOKEN);
