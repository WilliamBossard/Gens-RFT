# Gens-RFT

> **Rust File Transfer** — A modern, high-performance, and security-hardened **SFTP / FTPS / FTP** desktop client & integrated **SSH** terminal built with **Tauri v2**, **Rust**, and **React**.

[![CI](https://github.com/WilliamBossard/Gens-RFT/actions/workflows/ci.yml/badge.svg)](https://github.com/WilliamBossard/Gens-RFT/actions/workflows/ci.yml)
![Tauri v2](https://img.shields.io/badge/Tauri-v2-FFC131?style=for-the-badge&logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-2024-000000?style=for-the-badge&logo=rust&logoColor=white)
![React 19](https://img.shields.io/badge/React-19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)

---

## Overview

**Gens-RFT** is a cross-platform desktop file transfer client designed to be a fast, lightweight, and secure alternative to legacy FTP/SFTP tools. It combines an asynchronous Rust networking and I/O backend (`tokio`, `russh`, `russh-sftp`, `suppaftp`) with a responsive virtualized React 19 UI.

---

## Key Features

- **Multi-Protocol Support:**
  - **SFTP / SSH** (password and private key + passphrase authentication, connection keepalive, concurrent directory/file transfers).
  - **FTPS** (explicit FTP over TLS via `native-tls`, with strict certificate validation by default and opt-in override for self-signed servers).
  - **FTP** (binary mode `TYPE I`, pooled transfer connections, automatic browsing reconnection).
- **Integrated SSH Terminal:** Embedded interactive PTY terminal powered by `@xterm/xterm` and `russh` channels, lazily activated per SFTP/SSH tab with resize & reconnect support.
- **Security-First Design:**
  - **Encrypted Credential Vault:** Saved server profiles are encrypted at rest using native **Windows DPAPI** (`CryptProtectData` / `CryptUnprotectData` + `zeroize`) on Windows, or **AES-256-GCM** with `0600` key storage on Linux/macOS.
  - **Portable Encrypted Exports:** Export and import site profiles protected by user passwords using **PBKDF2-SHA256 (600,000 iterations) + AES-256-GCM**.
  - **SSH Host Key Verification:** Checks `~/.ssh/known_hosts` before authenticating, blocks changed host keys (`HOST_KEY_CHANGED` anti-MITM), and prompts explicitly before trusting unknown hosts.
  - **Transfer & Archive Hardening:** CRLF injection prevention on FTP commands, Zip-Slip / Tar-Slip & symlink-slip inspection before local/remote archive extraction, NTFS reserved-name & ADS sanitization, and executable launch confirmation.
  - **Strict CSP & Minimal Tauri Capabilities.**
- **Dual-Pane Explorer & Productivity:**
  - Split local/remote view with resizable panes, directory trees, bookmarks, path history, search filters, sorting, and virtualized lists (`@tanstack/react-virtual`).
  - **Multi-Tab Sessions & Server-to-Server Relay:** Open multiple server tabs simultaneously and drag-and-drop files between tabs (relayed safely through an isolated PID-scoped temporary directory).
  - **Concurrent Transfer Queue:** Configurable concurrency (1–10), real-time speed/ETA calculation, conflict resolution (overwrite / auto-rename / skip), per-item cancellation, and retry.
  - **Built-in Remote Text Editor & Archive Tools:** Edit remote text files up to 5 MB (with UTF-8 lossy detection, search, and atomic save) and compress/extract `.zip` and `.tar.gz` archives locally or over SSH.

---

## Technology Stack

- **Desktop Runtime:** [Tauri v2](https://v2.tauri.app/) (`tauri-plugin-dialog`, `tauri-plugin-opener`)
- **Backend (Rust 2024):**
  - `tokio` (async runtime)
  - `russh`, `russh-sftp`, `russh-keys` (SSH2 / SFTP / PTY)
  - `suppaftp` with `native-tls` (FTP / FTPS)
  - `aes-gcm`, `zeroize`, `walkdir`, `serde`
- **Frontend:**
  - React 19, TypeScript, Vite 8
  - Tailwind CSS v4, `lucide-react`
  - `zustand` (transfer queue & log stores)
  - `@tanstack/react-virtual` (virtualized file lists, queue & log viewer)
  - `@xterm/xterm` & `@xterm/addon-fit` (SSH terminal)

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v20+ / v22 recommended)
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain, Rust 1.85+ for Edition 2024)
- **Tauri v2 OS prerequisites:**
  - **Windows:** Microsoft C++ Build Tools & WebView2
  - **Linux (Debian/Ubuntu):**
    ```bash
    sudo apt-get update
    sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf pkg-config
    ```
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`)

### Development

1. Clone the repository:
   ```bash
   git clone https://github.com/WilliamBossard/Gens-RFT.git
   cd Gens-RFT
   ```

2. Install frontend dependencies:
   ```bash
   npm install
   ```

3. Run in development mode:
   ```bash
   npm run tauri dev
   ```

### Verification & Production Build

- **TypeScript & Frontend bundle:**
  ```bash
  npx tsc --noEmit
  npm run build
  ```
- **Rust lints & tests:**
  ```bash
  cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
  cargo test --manifest-path src-tauri/Cargo.toml
  ```
- **Full Tauri installer build:**
  ```bash
  npm run tauri build
  ```

---

## GitHub Actions & Releases

- **CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):** Runs TypeScript checks, Vite build, `cargo clippy`, and `cargo test` across Linux, Windows, and macOS on pushes and pull requests.
- **Draft Releases ([`.github/workflows/release.yml`](.github/workflows/release.yml)):** Triggered manually via **Actions → Build & Draft Release → Run workflow**. It automatically reads the crate version from `src-tauri/Cargo.toml`, builds installers for **Windows (`x64`)**, **Linux (`x64`)**, and **macOS (`universal`)**, and creates a **GitHub Draft Release** (`v<version>`) with all compiled artifacts attached.

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
