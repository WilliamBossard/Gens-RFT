# Gens-RFT 
> **Rust File Transfer** — A modern, blazing-fast, and highly secure FTP/SFTP client built for the next generation of sysadmins and developers.

![Tauri](https://img.shields.io/badge/Tauri-FFC131?style=for-the-badge&logo=Tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![TailwindCSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)

##  Overview

Gens-RFT is a desktop application designed from the ground up to be a modern, lightweight, and incredibly fast alternative to legacy file transfer clients like FileZilla. 

Powered by **Rust** on the backend and **React/TailwindCSS** on the frontend, it provides a seamless and secure experience for managing remote servers, homelab environments, containers, and storage pools. Whether you are administering Linux instances, transferring large ISOs, or deploying code, Gens-RFT handles your data securely via standard SSH/SFTP and FTP protocols.

##  Key Features

- **Blazing Fast Performance:** Leveraging Rust's memory safety and zero-cost abstractions to handle large file queues without system lag.
- **Enterprise-Grade Security:** Native support for SSH key authentication and secure SFTP tunneling. 
- **Modern UI/UX:** A beautiful, High-Contrast Dark Theme built with TailwindCSS, avoiding the cluttered "old-school" look.
- **Classic Split-Pane View:** Familiar local/remote dual-pane architecture with advanced Tree/List views.
- **Native Drag & Drop:** Seamless HTML5-powered drag-and-drop between your operating system and remote environments.
- **Real-Time Log Console:** Monitor every command, connection status, and handshake directly in the app.

##  Technology Stack

Gens-RFT uses the **Tauri** framework to bind a robust systems-programming backend with a flexible web frontend.

* **Backend:** Rust (handling `ssh2`, `russh`, TCP sockets, and file I/O).
* **Frontend:** TypeScript, React.js.
* **Styling:** TailwindCSS, Lucide Icons (clean, professional vector graphics).
* **State Management:** Context API / Zustand for concurrent transfer queues.

##  Getting Started

### Prerequisites
Make sure you have [Node.js](https://nodejs.org/) and [Rust](https://www.rust-lang.org/tools/install) installed on your machine. You will also need the Tauri CLI prerequisites depending on your OS (e.g., Build Tools for Windows).

### Installation

1. Clone the repository:
   ```bash
   git clone [https://github.com/yourusername/gens-rft.git](https://github.com/yourusername/gens-rft.git)
   cd gens-rft
Install frontend dependencies:

Bash
npm install
Run the application in development mode:

Bash
npm run tauri dev

🔒 License
This project is licensed under the MIT License - see the LICENSE file for details.
