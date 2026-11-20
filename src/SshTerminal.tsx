import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RotateCcw } from "lucide-react";

interface Props {
  sessionId: string;
  isConnected: boolean;
  isVisible?: boolean;
  protocol?: string;
}

export default function SshTerminal({ sessionId, isConnected, isVisible = true, protocol = "SFTP" }: Props) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermInstance = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyStarted = useRef(false);
  const listenersReadyRef = useRef(false);
  const isConnectedRef = useRef(isConnected);
  const protocolRef = useRef(protocol);
  isConnectedRef.current = isConnected;
  protocolRef.current = protocol;
  const [ptyClosed, setPtyClosed] = useState(false);

  const launchPty = useCallback(() => {
    const term = xtermInstance.current;
    const fitAddon = fitAddonRef.current;
    const connected = isConnectedRef.current;
    const proto = protocolRef.current;
    if (!term || !fitAddon || !connected || proto === "FTP" || proto === "FTPS") return;
    ptyStarted.current = true;
    setPtyClosed(false);
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
      setPtyClosed(true);
    });
  }, [sessionId]);

  useEffect(() => {
    if (isVisible && fitAddonRef.current && terminalRef.current) {
      const el = terminalRef.current;
      const timer = setTimeout(() => {
        try {
          if (el.clientWidth > 0 && el.clientHeight > 0) {
            fitAddonRef.current?.fit();
          }
        } catch {}
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isVisible]);

  useEffect(() => {
    const el = terminalRef.current;
    if (!el) return;

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
    term.open(el);
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      fitAddon.fit();
    }

    xtermInstance.current = term;
    fitAddonRef.current = fitAddon;

    term.onData((data) => {
      invoke("write_ssh_pty", { sessionId, data }).catch(() => {});
    });

    term.onResize(({ cols, rows }) => {
      if (cols > 1 && rows > 1) {
        invoke("resize_ssh_pty", { sessionId, cols, rows }).catch(() => {});
      }
    });

    let disposed = false;
    listenersReadyRef.current = false;
    let unlistenOutput: (() => void) | undefined;
    let unlistenClosed: (() => void) | undefined;

    Promise.all([
      listen<string>(`ssh_pty_output_${sessionId}`, (event) => {
        if (!disposed) {
          term.write(event.payload);
        }
      }),
      listen<void>(`ssh_pty_closed_${sessionId}`, () => {
        if (!disposed) {
          ptyStarted.current = false;
          setPtyClosed(true);
          term.writeln("\r\n\x1b[33m[!] Canal shell SSH fermé par le serveur.\x1b[0m");
        }
      }),
    ])
      .then(([fnOut, fnClosed]) => {
        if (disposed) {
          fnOut();
          fnClosed();
          return;
        }
        unlistenOutput = fnOut;
        unlistenClosed = fnClosed;
        listenersReadyRef.current = true;
        if (
          isConnectedRef.current &&
          protocolRef.current !== "FTP" &&
          protocolRef.current !== "FTPS" &&
          !ptyStarted.current
        ) {
          launchPty();
        }
      })
      .catch(() => {});

    const resizeObserver = new ResizeObserver(() => {
      try {
        if (el.clientWidth > 0 && el.clientHeight > 0) {
          fitAddon.fit();
        }
      } catch {}
    });
    resizeObserver.observe(el);

    return () => {
      disposed = true;
      listenersReadyRef.current = false;
      resizeObserver.disconnect();
      unlistenOutput?.();
      unlistenClosed?.();
      term.dispose();
      xtermInstance.current = null;
      fitAddonRef.current = null;
      ptyStarted.current = false;
    };
  }, [sessionId, launchPty]);

  useEffect(() => {
    const term = xtermInstance.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;

    if (isConnected) {
      if (protocol === "FTP" || protocol === "FTPS") {
        ptyStarted.current = false;
        term.reset();
        term.writeln("\x1b[33m[!] Le protocole FTP / FTPS ne supporte pas l'accès terminal shell interactif.\x1b[0m\r\n\x1b[90mVeuillez vous connecter via SFTP/SSH pour piloter le serveur en ligne de commande.\x1b[0m");
        return;
      }

      if (listenersReadyRef.current && !ptyStarted.current) {
        launchPty();
      }
    } else {
      ptyStarted.current = false;
      setPtyClosed(false);
      term.reset();
      term.writeln("\x1b[33m[!] En attente de connexion SFTP/SSH pour ouvrir le shell distant...\x1b[0m");
    }
  }, [isConnected, sessionId, protocol, launchPty]);

  return (
    <div className="h-full w-full bg-neutral-950 p-2 overflow-hidden relative">
      {ptyClosed && isConnected && protocol === "SFTP" && (
        <button
          onClick={launchPty}
          className="absolute top-3 right-4 z-10 flex items-center gap-1.5 px-2.5 py-1 rounded bg-sky-600/90 hover:bg-sky-500 text-white text-[11px] font-semibold shadow cursor-pointer transition active:scale-95"
          title="Rouvrir un canal terminal SSH"
        >
          <RotateCcw className="h-3 w-3" />
          <span>Relancer le shell</span>
        </button>
      )}
      <div ref={terminalRef} className="h-full w-full" />
    </div>
  );
}