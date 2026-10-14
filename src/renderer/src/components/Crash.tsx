import { Component, type ReactNode } from "react";
import { Rings } from "./Mark";

export class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="app no-repo">
        <div className="toolbar" />
        <div className="empty-state">
          <div className="empty-inner">
            <Rings />
            <div>
              <h2>moire hit a bug.</h2>
              <p>
                <code>{error.message}</code>
              </p>
              <button className="btn" onClick={() => this.setState({ error: null })}>
                Try again
              </button>
            </div>
          </div>
        </div>
        <div className="status" />
      </div>
    );
  }
}
