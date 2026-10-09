// Keeps a crash in one part of the UI from unmounting the whole page and leaving it blank.
import { RotateCw, TriangleAlert } from "lucide-react";
import { Component, type ReactNode } from "react";
import { getState } from "../api.ts";
import { t } from "../i18n.ts";
import { Button, EmptyState } from "../kit/index.tsx";

interface Props {
  children: ReactNode;
  /** When it changes, for example on another selection, the children get another try. */
  resetKey?: unknown;
}

export class ErrorBoundary extends Component<Props, { error: Error | null; key: unknown }> {
  state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: { error: Error | null; key: unknown }) {
    return Object.is(props.resetKey, state.key) ? null : { error: null, key: props.resetKey };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // Read at the moment of the crash: a server behind the UI code is the usual cause.
    const stale = getState().serverStale;
    return (
      <EmptyState icon={TriangleAlert} title={t("crashTitle")} body={stale ? t("serverStale") : error.message}>
        <Button icon={RotateCw} onClick={() => location.reload()}>
          {t("reload")}
        </Button>
      </EmptyState>
    );
  }
}
