import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "./App.css";

interface ErrorBoundaryState {
  hasError: boolean;
  errorMsg: string;
}

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMsg: "" };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMsg: error?.message || "Erreur inattendue de l'interface.",
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center bg-neutral-950 text-neutral-200 p-6 font-sans gap-4">
          <h1 className="text-lg font-semibold text-rose-400">
            Une erreur critique est survenue dans Gens-RFT
          </h1>
          <p className="text-xs text-neutral-400 max-w-lg text-center font-mono break-all">
            {this.state.errorMsg}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded bg-sky-600 hover:bg-sky-500 text-xs font-semibold text-white cursor-pointer"
          >
            Recharger l'application
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
