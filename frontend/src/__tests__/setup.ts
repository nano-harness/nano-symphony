import "@testing-library/jest-dom/vitest";

// Ensure browser environment is properly initialized for SolidJS Router
if (typeof window !== "undefined") {
  // Initialize window.history if not present
  if (!window.history) {
    Object.defineProperty(window, "history", {
      value: {
        pushState: () => {},
        replaceState: () => {},
        state: null,
      },
      writable: true,
    });
  }

  // Initialize window.location if not present
  if (!window.location) {
    Object.defineProperty(window, "location", {
      value: {
        href: "http://localhost:3000/",
        origin: "http://localhost:3000",
        pathname: "/",
        search: "",
        hash: "",
      },
      writable: true,
    });
  }
}
