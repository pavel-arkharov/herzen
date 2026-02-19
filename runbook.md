# Herzen Runbook (Beginner Friendly)

This guide is written for a non-technical user on macOS (Apple Silicon), similar to the current development machine.
Linux notes are included as an untested reference only.

Goal: get Herzen running locally with the highest chance of success.

If you only follow one path, use:

- `fixed` recording mode
- `Enter` trigger mode
- local Ollama model enabled

That is the most reliable setup today.

Hardware assumption:

- Apple Silicon Mac (M-series), microphone available, stable internet for one-time installs/model downloads

---

## 1. What You Are Setting Up

Herzen is a local voice assistant monorepo with these packages:

- `@herzen/core`: runtime loop and orchestration
- `@herzen/audio`: recording/playback and adaptive capture plumbing
- `@herzen/stt`: speech-to-text
- `@herzen/tts`: text-to-speech
- `@herzen/vad`: voice activity detection for adaptive recording
- `@herzen/wakeword`: wakeword client (sidecar integration)
- `@herzen/response`: local LLM response service (Ollama provider)

---

## 2. One-Time Prerequisites (macOS, tested)

Open Terminal and install tools:

```bash
xcode-select --install
```

Install Homebrew (if needed):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Install required system packages:

```bash
brew install node pnpm sox whisper-cpp ollama ffmpeg
```

If Homebrew commands are not found after install, run:

```bash
eval "$(/opt/homebrew/bin/brew shellenv)"
```

What these are for:

- `sox`: microphone recording (`rec`) and playback (`play`)
- `whisper-cpp`: local speech-to-text binary (`whisper-cli`)
- `ollama`: local LLM responses
- `ffmpeg`: `.m4a` conversion for file transcription
- `pnpm`: workspace package manager

---

## Linux Setup Notes (Untested)

This path is not validated by the current maintainers. Use it as a starting point.

Example packages for Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y curl git build-essential ffmpeg sox espeak-ng
```

Install Node.js LTS and pnpm:

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
corepack enable
corepack prepare pnpm@9.0.0 --activate
```

Install Ollama:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Whisper requirement on Linux:

- Herzen needs `whisper-cli` available on `PATH` (or set `HERZEN_WHISPER_BIN`)
- If your distro has no `whisper-cpp` package, install `whisper.cpp` from its official repo/release and expose `whisper-cli`

Important Linux limitation right now:

- `@herzen/tts` currently calls macOS `say`
- On Linux, TTS is not officially supported yet in this repo
- STT/file transcription can still be validated first; full voice reply flow may require local adaptation

---

## 3. Install Project Dependencies

If the repository is not on your machine yet:

```bash
git clone https://github.com/pavel-arkharov/herzen.git /Users/parkharo/Programming/herzen
```

From the repo root:

```bash
cd /Users/parkharo/Programming/herzen
pnpm install
```

Quick check:

```bash
node -v
pnpm -v
whisper-cli -h | head -n 1
ollama --version
```

---

## 4. Download Models

Create model folder:

```bash
mkdir -p /Users/parkharo/Programming/herzen/data/models
```

Download Whisper model:

```bash
curl -L \
  -o /Users/parkharo/Programming/herzen/data/models/ggml-base.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
```

For adaptive mode (`@herzen/vad`), also place a Silero VAD model at:

- `/Users/parkharo/Programming/herzen/data/models/silero_vad.onnx`

If you do not have this yet, you can still run Herzen in `fixed` mode.

---

## 5. Configure Environment

Easiest path in this repo:

```bash
cp /Users/parkharo/Programming/herzen/.envrc.example /Users/parkharo/Programming/herzen/.envrc
```

Edit `/Users/parkharo/Programming/herzen/.envrc` and ensure at least:

- `HERZEN_WHISPER_BIN="/opt/homebrew/bin/whisper-cli"`
- `HERZEN_WHISPER_MODEL="/Users/parkharo/Programming/herzen/data/models/ggml-base.bin"`

Add response model config (recommended):

- `HERZEN_OLLAMA_MODEL="qwen2.5:3b"`

Optional adaptive VAD path (if different from default):

- `HERZEN_VAD_MODEL="/Users/parkharo/Programming/herzen/data/models/silero_vad.onnx"`

Load env variables for the current terminal:

```bash
source /Users/parkharo/Programming/herzen/.envrc
```

If you use `direnv`, run `direnv allow` instead.

---

## 6. Allow Microphone Access (macOS)

At first recording attempt, macOS may block microphone input for Terminal/iTerm.

If recording fails:

1. Open `System Settings` -> `Privacy & Security` -> `Microphone`
2. Enable microphone access for your terminal app (`Terminal`, `iTerm`, or your IDE terminal)
3. Restart the terminal

---

## 7. Start Local LLM (Recommended)

In Terminal A, ensure Ollama daemon is running:

```bash
ollama serve
```

If `ollama serve` prints `bind: address already in use`, Ollama is already running.

In Terminal B, pull the recommended model once:

```bash
ollama pull qwen2.5:3b
```

Quick check that model generation works:

```bash
ollama run qwen2.5:3b "Say hello"
```

Monitor loaded model/process status:

```bash
ollama ps
```

If `HERZEN_OLLAMA_MODEL` is missing or Ollama is unavailable, Herzen still runs, but voice replies may fall back.

---

## 8. First Run (Recommended Path)

From repo root:

```bash
pnpm dev
```

When prompted:

1. Choose recording mode: `2` (`Fixed`)
2. Choose trigger mode: `2` (`Enter`)

Then:

1. Press Enter to trigger recording
2. Speak
3. Wait for transcription and spoken reply

---

## 9. Optional Modes

Adaptive recording mode:

- Requires valid Silero VAD model path
- Choose recording mode `1` (`Adaptive`) at startup
- Set adaptive max length when prompted
- Current limitation: adaptive recording length behavior is not fully correct yet; prefer `fixed` mode for stable use

Wakeword trigger mode:

- Uses external sidecar repo `herzen-wake`
- Follow setup/start instructions in the `herzen-wake` repository
- This runbook intentionally does not duplicate sidecar startup steps
- After sidecar is running, choose trigger mode `1` (`Wakeword`)

---

## 10. File-by-File Transcription

From repo root:

```bash
pnpm transcribe:file -- "data/audio/sample.wav"
```

Examples:

```bash
pnpm transcribe:file -- "data/audio/sample.wav" --lang en --format md
pnpm transcribe:file -- --input "meeting.m4a" --out "data/transcribes/meeting.txt" --format txt
```

Default output folder:

- `/Users/parkharo/Programming/herzen/data/transcribes`

---

## 11. Sanity Checks

Run these from repo root:

```bash
pnpm test
pnpm test:core
pnpm test:audio
pnpm test:stt
pnpm test:tts
pnpm test:wakeword
pnpm test:response
pnpm --filter @herzen/vad test
```

---

## 12. Common Issues

`Could not find whisper.cpp CLI binary`

- Verify `/opt/homebrew/bin/whisper-cli` exists
- Ensure `HERZEN_WHISPER_BIN` is set correctly

`HERZEN_WHISPER_MODEL is required` or model not found

- Verify file exists at `data/models/ggml-base.bin`
- Ensure `HERZEN_WHISPER_MODEL` points to it

`Adaptive recording error` / VAD model missing

- Verify `data/models/silero_vad.onnx` exists
- Or use `fixed` mode

`LLM response disabled` / Ollama errors

- Start Ollama (`ollama serve`)
- Set `HERZEN_OLLAMA_MODEL`
- Pull the selected model (`ollama pull <model>`)

`Wakeword unavailable` socket error

- Sidecar is not running or socket path does not match
- Start `herzen-wake` and verify `HERZEN_WAKEWORD_SOCKET`

---

## 13. Practical Recommendation

For day-1 success, start here:

1. Fixed recording mode
2. Enter trigger mode
3. Ollama running with one small local model
4. Enable adaptive and wakeword only after baseline flow is stable
