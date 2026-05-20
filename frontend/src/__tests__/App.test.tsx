import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup, screen } from "@solidjs/testing-library";
import { Router, Route } from "@solidjs/router";
import { App, StatusBar } from "../App";

// Mock the API module
vi.mock("../api", () => ({
  api: {
    getRuns: vi.fn(async () => []),
    listIssues: vi.fn(async () => []),
    createIssue: vi.fn(async (data: any) => ({ id: "x", ...data })),
    updateIssue: vi.fn(async (_id: string, data: any) => ({ id: _id, ...data })),
    deleteIssue: vi.fn(async () => {}),
    streamEvents: vi.fn(() => ({
      addEventListener: vi.fn(),
      close: vi.fn(),
    })),
    getIssue: vi.fn(async () => null),
    getEvents: vi.fn(async () => []),
    cancelRun: vi.fn(async () => {}),
    pauseRun: vi.fn(async () => {}),
    resumeRun: vi.fn(async () => {}),
    getWorkflow: vi.fn(async () => ({ content: "" })),
    saveWorkflow: vi.fn(async () => {}),
  },
}));

// Mock EventSource for SSE
class MockEventSource {
  addEventListener = vi.fn();
  close = vi.fn();
}
(globalThis as any).EventSource = MockEventSource;

describe("App entry", () => {
  beforeEach(() => {
    cleanup();
    window.history.pushState({}, "", "/");
  });

  it("mounts without throwing and produces non-empty DOM (regression: blank page bug)", () => {
    const { container } = render(() => <App />);
    expect(container.children.length).toBeGreaterThan(0);
    expect(container.textContent).not.toBe("");
  });

  it("renders the StatusBar layout (root prop wiring)", async () => {
    render(() => <App />);
    // Look for the brand name in the conductor bar
    expect(await screen.findByText(/nano.*symphony/i)).toBeInTheDocument();
    // Look for the tempo indicator (AT REST or CONDUCTING)
    expect(await screen.findByText(/at rest|conducting/i)).toBeInTheDocument();
  });

  it("renders the Dashboard route at '/'", async () => {
    render(() => <App />);
    // Look for the page title "The Score"
    expect(await screen.findByText(/the score/i)).toBeInTheDocument();
    // Look for the filter input
    expect(await screen.findByPlaceholderText(/filter/i)).toBeInTheDocument();
  });

  it("exposes the CRUD entry point ('+ New issue')", async () => {
    render(() => <App />);
    // Look for the new issue button
    const buttons = await screen.findAllByRole("button", { name: /\+.*new issue/i });
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("regression: non-Route children must NOT be passed as direct <Router> children", async () => {
    // Old bug: putting <StatusBar /> as a sibling to <Route> in <Router> children.
    // @solidjs/router>=0.15's createBranches() would silently discard it, causing blank page.
    // This test ensures both layout text and route content appear simultaneously.
    // If someone reverts to the old buggy pattern, the page title lookup will fail or timeout.
    render(() => <App />);

    // StatusBar content should be present
    expect(await screen.findByText(/nano.*symphony/i)).toBeInTheDocument();

    // Dashboard content should also be present (proving both render)
    expect(await screen.findByText(/the score/i)).toBeInTheDocument();
  });
});

describe("StatusBar", () => {
  beforeEach(() => {
    cleanup();
    window.history.pushState({}, "", "/");
  });

  it("renders the brand label and an idle tempo by default", async () => {
    render(() => (
      <Router root={(props) => <>{props.children}</>}>
        <Route path="/" component={StatusBar} />
      </Router>
    ));
    // Brand name should be visible
    expect(await screen.findByText(/nano.*symphony/i)).toBeInTheDocument();
    // Default state should be "AT REST" (no active runs)
    expect(await screen.findByText(/at rest/i)).toBeInTheDocument();
  });

  it("brand links to dashboard so users can always return home", async () => {
    render(() => <App />);
    // Find the brand name text
    const brandText = await screen.findByText(/nano.*symphony/i);
    // Check that it's within a link element
    const linkElement = brandText.closest("a");
    expect(linkElement).not.toBeNull();
    expect(linkElement?.getAttribute("href")).toBe("/");
  });
});
