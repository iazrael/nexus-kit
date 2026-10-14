// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

afterEach(cleanup);

function Boom(): never {
  throw new Error("渲染炸了");
}

describe("ErrorBoundary", () => {
  it("正常渲染子树并报告已挂载", () => {
    const onMounted = vi.fn();
    const onCrash = vi.fn();
    render(
      <ErrorBoundary onCrash={onCrash} onMounted={onMounted}>
        <p>正常内容</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("正常内容")).toBeTruthy();
    expect(onMounted).toHaveBeenCalledTimes(1);
    expect(onCrash).not.toHaveBeenCalled();
  });

  it("子树渲染抛错：交给 onCrash，自身不再渲染", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined); // React 会把被接住的错误再打一遍
    const onCrash = vi.fn();
    const { container } = render(
      <ErrorBoundary onCrash={onCrash} onMounted={vi.fn()}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({ message: "渲染炸了" }), expect.stringContaining("Boom"));
    expect(container.textContent).toBe("");
  });
});
