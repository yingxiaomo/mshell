import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props { children: ReactNode; }
interface State { error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3">
          <p className="text-sm font-medium text-red-400">组件崩溃</p>
          <pre className="mt-2 max-w-md overflow-auto text-xs text-red-300 whitespace-pre-wrap">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            className="mt-3 rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            onClick={() => this.setState({ error: null })}
          >重试</button>
        </div>
      </div>
    );
  }
}
