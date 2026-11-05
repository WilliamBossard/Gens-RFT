import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface Props {
  sessionId: string;
  isConnected: boolean;
}

export default function SshTerminal({ sessionId, isConnected }: Props) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermInstance = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyStarted = useRef(false);

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "Consolas, 'Courier New', monospace",
      fontSize: 12,
      theme: {
        background: "#09090b",
        foreground: "#f4f4f5",
        cursor: "#38bdf8",
        selectionBackground: "rgba(56, 189, 248, 0.3)",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    xtermInstance.current = term;
    fitAddonRef.current = fitAddon;

    term.onData((data) => {
      invoke("write_ssh_pty", { sessionId, data }).catch(() => {});
    });

    term.onResize(({ cols, rows }) => {
      invoke("resize_ssh_pty", { sessionId, cols, rows }).catch(() => {});
    });

    const unlistenPromise = listen<string>(`ssh_pty_output_${sessionId}`, (event) => {
      term.write(event.payload);
    });

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {}
    });
    resizeObserver.observe(terminalRef.current);

    return () => {
      resizeObserver.disconnect();
      unlistenPromise.then((unlisten) => unlisten());
      term.dispose();
      xtermInstance.current = null;
      fitAddonRef.current = null;
      ptyStarted.current = false;
    };
  }, [sessionId]);

  useEffect(() => {
    const term = xtermInstance.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;

    if (isConnected && !ptyStarted.current) {
      ptyStarted.current = true;
      term.reset();
      fitAddon.fit();
      term.writeln("\x1b[32m[✓] Connexion au canal PTY interactif...\x1b[0m\r\n");

      invoke("start_ssh_pty", {
        sessionId,
        cols: term.cols || 80,
        rows: term.rows || 24,
      }).catch((err) => {
        term.writeln(`\r\n\x1b[31m[Erreur lancement PTY] : ${err}\x1b[0m`);
        ptyStarted.current = false;
      });
    } else if (!isConnected) {
      ptyStarted.current = false;
      term.reset();
      term.writeln("\x1b[33m[!] En attente de connexion SFTP/SSH pour ouvrir le shell distant...\x1b[0m");
    }
  }, [isConnected, sessionId]);

  return (
    <div className="h-full w-full bg-neutral-950 p-2 overflow-hidden">
      <div ref={terminalRef} className="h-full w-full" />
    </div>
  );
}