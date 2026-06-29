# Deep Dive

A personal research app that searches your notes, Google Sheets, and Pioneer School Book to surface insights by theme.

## Stack
- **Frontend**: Vanilla HTML/CSS/JS — no frameworks, no build step
- **Backend**: Netlify Functions (serverless)
- **Database**: Supabase (history and custom themes)
- **AI**: Anthropic Claude (claude-sonnet-4-6)
- **Data sources**: Google Sheets, Dropbox

## Project structure

```
deep-dive/
├── index.html                    # Main app (all screens)
├── netlify.toml                  # Netlify config and headers
└── netlify/
    └── functions/
        ├── chat.js               # Claude API — never exposes key to client
        ├── sheets.js             # Google Sheets reader
        └── dropbox.js            # Dropbox PDF access
```

## Environment variables

Set these in your Netlify dashboard under **Site settings → Environment variables**. Never put these in code.

| Variable | Description |
|---|---|
| `ANTHROPIC_KEY` | Your Anthropic API key |
| `SHEET_ID` | Google Sheets ID |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_KEY` | Your Supabase anon public key |
| `DROPBOX_TOKEN` | Your Dropbox access token |
| `DROPBOX_FILE_PATH` | Path to PDF in Dropbox e.g. `/Pioneer-School-Book.pdf` |

## Deploy

1. Push this repo to GitHub
2. Connect to Netlify (Import from GitHub)
3. Add environment variables in Netlify dashboard
4. Deploy — Netlify builds and publishes automatically

## Local development

```bash
npm install -g netlify-cli
netlify dev
```

Create a `.env` file (never commit this) with your environment variables for local testing.
