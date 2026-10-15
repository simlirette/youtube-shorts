# Music library

Background music is optional. The renderer only uses a track that a person has added here **and**
approved, with the licence terms and evidence recorded. Nothing is downloaded, scraped or approved
automatically.

Without an approved track every render records `music: null` with a `musicDisabledReason`, and media
QA reports the music criterion as **NOT MET** (a warning) when the job's variant asked for music. It
never reports music as present when it is not.

## Adding a track (YouTube Audio Library)

1. In YouTube Studio → Audio Library, pick an instrumental track whose licence is
   "You're free to use this song in any of your videos" (no attribution required). Tracks that
   require attribution are rejected by the loader until attribution in the description is supported.
2. Download it manually and save it in this folder (e.g. `assets/music/calm-pulse.mp3`).
3. Record the evidence: the Audio Library licence text, the date, and where you saw it (a
   screenshot path or a note). Do not fill these fields in without having checked them.
4. Copy `library.example.json` to `library.json` and add an entry:

```json
{
  "tracks": [
    {
      "id": "calm-pulse",
      "file": "calm-pulse.mp3",
      "title": "<title exactly as listed>",
      "artist": "<artist exactly as listed>",
      "source": "youtube_audio_library",
      "licence": "<licence text exactly as listed>",
      "licenceEvidence": "<where/when you verified it>",
      "attributionRequired": false,
      "attributionText": "",
      "approved": true,
      "approvedBy": "<your name>",
      "approvedAt": "<YYYY-MM-DD>"
    }
  ]
}
```

5. Check it loads: `pnpm cli doctor` (or run any job) — rejected tracks are listed with the reason
   (not approved, missing evidence, attribution required, file missing, undecodable, outside this
   folder).

## How it is mixed

- One track per job, chosen deterministically from the job id and recorded with the render
  (track id, title, source, licence, applied gain, measured track loudness).
- The bed is set `MUSIC_BED_LU` (default 20) LU below the narration, ducked further under speech
  (sidechain compression), faded in/out, and limited so the final mix stays near −14 LUFS and at or
  below −1 dBTP.
- Media QA measures the narration stem independently (start, gaps, pace) and checks that the voice
  stays dominant (`audio.voiceDominant`, bed ≥ 12 LU below the narration) and that the bed is
  actually audible after the last word (`audio.musicBed`).

Audio files and `library.json` in this folder are git-ignored; keep licence evidence with them.
