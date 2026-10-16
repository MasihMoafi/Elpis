"use client";

import { Component, type ReactNode } from "react";

/** One settings page failing to render shows its error in place instead of blanking the app. */
export class PageBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : String(error) }; }
  render() {
    if (this.state.error) return <p role="alert" className="text-sm text-destructive">This page could not be shown: {this.state.error}</p>;
    return this.props.children;
  }
}
