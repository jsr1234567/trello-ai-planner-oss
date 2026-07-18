# Trello AI Planner

A self-hosted personal-planning service that combines Trello tasks with optional Google Calendar, Google Tasks, OpenAI, Telegram, and WhatsApp integrations. It runs locally by default and keeps its runtime data outside version control.

## What it does

- Reads Trello boards and cards, creates a daily briefing, and can prioritize tasks with an AI model.
- Optionally creates and reconciles calendar blocks, synchronizes Google Tasks, and sends Telegram or WhatsApp notifications.
- Binds to `localhost` by default. A bearer token is required before binding the API anywhere else.
- Stores generated planner state under `.planner-data/`, which is ignored by Git.

## Requirements

- Node.js 22 or newer
- A Trello API key and token for Trello functionality
- Credentials only for the optional integrations you choose to enable

## Run locally

Install dependencies:

```bash
npm ci
```

Set the two Trello variables in your shell or deployment secret manager. Do not add real values to Git-tracked files:

```bash
export TRELLO_API_KEY='your-trello-api-key'
export TRELLO_TOKEN='your-trello-token'
npm start
```

The service listens on `http://localhost:8787`. Confirm it is running:

```bash
curl http://localhost:8787/health
curl http://localhost:8787/api/trello/me
```

For live-reload development, use `npm run dev` instead of `npm start`.

## Configuration

`.env.example` lists every supported integration setting. Supply only the credentials required by the features you use, through your shell, container platform, or a secret manager. Never commit a `.env` file, real access token, phone number, webhook URL, or OAuth refresh token.

The application has no public webhook endpoint. Keep it on `localhost` unless you have deliberately configured `PLANNER_API_TOKEN` and a secure reverse proxy.

## Verification

```bash
npm run check
npm test
npm run check:public
```

`check:public` is a repository hygiene check that rejects known infrastructure branding, literal IPv4 addresses, and credential-like assignments in tracked source files. It complements—rather than replaces—reviewing changes before publication.

## Security and privacy

The app processes data returned by the integrations you configure. Treat `.planner-data/` and your runtime environment as sensitive. Before opening an issue, remove access tokens, personal calendar content, task names, phone numbers, and other private data from logs and screenshots.

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md), run the verification commands, and avoid including personal data or credentials in commits, issues, fixtures, or tests.

## License

[MIT](LICENSE)

