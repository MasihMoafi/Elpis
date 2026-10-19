"use client";

import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

type Props = {
  children: ReactNode;
  /** What failed, as the sentence's subject: "This page" (the default) or "The conversation". */
  label?: string;
  /** A change of this value (another page, another chat) clears the error. */
  resetKey?: unknown;
};
type State = { error: string | null; resetKey: unknown };

/** The safety net under every view: one that cannot draw what it was given (a reply from an older bridge, a proxy's
 * page) says so in its own place, with a way to try again, and the rest of the window carries on. Views read their
 * replies defensively too (lib/api.ts `unreadable`); this catches whatever they did not foresee. */
export class ViewBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : String(error) }; }
  static getDerivedStateFromProps(props: Props, state: State) { return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey }; }
  render() {
    if (this.state.error === null) return this.props.children;
    return <div role="alert" className="alert view-error">
      <p>{this.props.label ?? "This page"} could not be shown: {this.state.error}</p>
      <Button type="button" variant="outline" size="sm" onClick={() => this.setState({ error: null })}>Reload</Button>
    </div>;
  }
}
