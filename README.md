# 🎵 Apple Music Discord RPC

> [!IMPORTANT]
> **Personal Use Only**
> This repository is a personal fork of [NextFire/apple-music-discord-rpc](https://github.com/NextFire/apple-music-discord-rpc) and is customized for personal use. It is **not** intended for public consumption, distribution, or external support.

Deno + JavaScript for Automation (JXA) Discord Rich Presence client for the macOS Apple Music app (Catalina and later) and legacy iTunes.

Works with local tracks and the Apple Music streaming service.

---

## ✨ Features

- **Zero Clutter**: Runs silently in the background at login with no menu bar or dock icons.
- **Smart Presence**: Presence updates automatically and is only active when music is actually playing.
- **Artwork Fallback**: Matches Apple Music streaming metadata and falls back to local artwork uploads via `litterbox.catbox.moe`.
- **Lightweight**: Written in TypeScript and executed via Deno, resulting in a minimal memory and CPU footprint.

<div align="center">
  <img width="230" height="47" alt="Discord Rich Presence Preview" src="https://github.com/user-attachments/assets/2e168586-4202-46a3-a2d5-0e4e499ecdc6" style="margin-right: 10px;" />
  <img width="296" height="128" alt="Presence Detail Preview" src="https://github.com/user-attachments/assets/d5c01904-d43e-4f10-990d-2c75ff3acc61" />
</div>

---

## 🛠️ Personal Setup & Installation

Since this is a personal configuration, install and run the service using the included local scripts:

### 1. Prerequisites

Ensure Deno (v2+) is installed on macOS:

```bash
deno --version
```

### 2. Install & Start Launch Agent

To set up the launch agent to automatically run at login, navigate to the project directory and run the installer script:

```bash
./scripts/install.sh
```

This script copies the plist file (`moe.yuru.music-rpc.plist`) to `~/Library/LaunchAgents/`, configures the current path, and loads the daemon.

### 3. Uninstall Launch Agent

To stop the background service and remove the launch agent, run:

```bash
./scripts/uninstall.sh
```

---

## 💻 Local Development & Debugging

To run the RPC client manually in the foreground (with full logging output):

```bash
deno run --allow-env --allow-run --allow-net --allow-read --allow-write --allow-ffi --allow-import --unstable-kv music-rpc.ts
```

Set `DEBUG=1` to also log per-track state, iTunes lookups, and connection attempts.

