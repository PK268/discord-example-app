# Discord Seat Monitor Bot

This project is a Discord bot that tracks registered course / CRN pairs, polls a seat API every few minutes, and posts alerts into a configured server channel when seats open.

## Commands

- `/register course:<course> crn:<crn>` — store a tracked course / CRN pair for the user
- `/unregister course:<course> crn:<crn>` — remove a tracked course / CRN pair for the user
- `/start` — set the current channel as the alert channel for the server and show all tracked pairs
- `/checknow` — immediately check all of the invoking user's tracked pairs
- `/listregistrations` — list all of the invoking user's currently tracked course / CRN pairs
- `/seeerrors enabled:<true|false>` — opt in or out of seat API error notifications for your tracked pairs
- `/specialautopost enabled:<true|false>` — opt in or out of the special CS3000 / 13895 auto-post request
- `/setautoparams xsynctoken:<token> cookieString:<cookie> uniqueSessionId:<id>` — store the special auto-post session values used for the CS3000 / 13895 flow

## Configuration

Create a `.env` file in the project root with values like:

```env
APP_ID=your_discord_app_id
DISCORD_TOKEN=your_bot_token
PUBLIC_KEY=your_public_key
GUILD_ID=optional_test_server_id
SEAT_API_BASE_URL=https://localhost:7167
```

## Run locally

Install dependencies:

```powershell
npm install
```

Register slash commands:

```powershell
npm run register
```

Start the bot:

```powershell
npm start
```

## Notes

- Registrations, guild channel settings, stored auto-post parameters, and per-user opt-in settings are persisted in `data/seat-monitor-state.json`.
- Polling uses a randomized delay between checks.
- If multiple users register the same course / CRN pair, the bot performs one shared background seat check for that pair and then notifies all matching users.
- The bot supports both `http` and `https` seat API base URLs.
- The special keepalive endpoint is polled every 4 minutes while auto-post parameters are stored.
- Error messages are off by default and are only sent for users who enable them with `/seeerrors enabled:true`.
- The CS3000 / 13895 special request only runs for users who both store params with `/setautoparams` and enable it with `/specialautopost enabled:true`.
