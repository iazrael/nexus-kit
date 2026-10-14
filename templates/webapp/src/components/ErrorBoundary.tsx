/**
 * 根错误边界：界面渲染抛错时 React 会卸掉整棵树（白屏）。这里接住后交给 onCrash（模板里是白屏兜底，
 * 显示整页诊断面板），自身不再渲染任何东西。挂载成功时调 onMounted，之后的普通异常不再触发兜底。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** componentStack：React 给的组件栈，白屏排查时定位是哪个组件炸的 */
  onCrash: (error: unknown, componentStack?: string | null) => void;
  onMounted: () => void;
}

export class ErrorBoundary extends Component<Props, { crashed: boolean }> {
  override state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  override componentDidMount(): void {
    this.props.onMounted();
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onCrash(error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.crashed ? null : this.props.children;
  }
}
