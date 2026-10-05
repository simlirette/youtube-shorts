# Environment Variables Reference

All runtime configuration is managed via environment variables defined in `.env` (derived from `.env.example`).

| Variable | Type | Default | Description |
|---|---|---|---|
| `NODE_ENV` | `string` | `development` | Runtime environment (`development`, `production`, `test`) |
| `LOG_LEVEL` | `string` | `info` | Logging verbosity (`debug`, `info`, `warn`, `error`) |
| `PORT` | `number` | `3000` | HTTP port for API and review dashboard |
| `MOCK_LLM` | `boolean` | `true` | Use mock LLM generator instead of paid OpenAI/Gemini |
| `MOCK_SEARCH` | `boolean` | `true` | Use mock search provider instead of Tavily/Serper |
| `MOCK_TTS` | `boolean` | `true` | Use mock audio synthesizer instead of ElevenLabs/OpenAI |
| `MOCK_ASSETS` | `boolean` | `true` | Use synthetic image generator instead of Pexels/Replicate |
| `MOCK_YOUTUBE` | `boolean` | `true` | Use mock publisher instead of calling Google YouTube API |
| `DATABASE_URL` | `string` | `postgresql://...` | Connection URI for PostgreSQL database |
| `USE_SQLITE_FALLBACK` | `boolean` | `true` | When true, uses embedded SQLite without requiring PostgreSQL |
| `SQLITE_DB_PATH` | `string` | `./database/dev.sqlite` | Filepath for local SQLite database file |
| `OPENAI_API_KEY` | `string` | `""` | OpenAI API key for GPT-4o scripting / analysis |
| `GEMINI_API_KEY` | `string` | `""` | Google Gemini API key for multimodal analysis / research |
| `ELEVENLABS_API_KEY` | `string` | `""` | ElevenLabs API key for ultra-realistic documentary voiceover |
| `ELEVENLABS_VOICE_ID`| `string` | `""` | Specific ElevenLabs voice ID to use |
| `YOUTUBE_CLIENT_ID` | `string` | `""` | Google Cloud OAuth 2.0 Client ID |
| `YOUTUBE_CLIENT_SECRET` | `string` | `""` | Google Cloud OAuth 2.0 Client Secret |
| `YOUTUBE_REFRESH_TOKEN`| `string` | `""` | Google OAuth refresh token for automated uploads |
| `YOUTUBE_CHANNEL_ID` | `string` | `""` | Target YouTube channel identifier |
| `YOUTUBE_DEFAULT_PRIVACY`| `string` | `private` | Upload privacy status: `private`, `unlisted`, or `public` |
| `FFMPEG_PATH` | `string` | `ffmpeg` | Path or binary name for FFmpeg executable |
| `RENDER_OUTPUT_DIR` | `string` | `./output/renders` | Destination directory for rendered video files |
| `TEMP_DIR` | `string` | `./output/temp` | Temporary scratch directory for asset processing |
