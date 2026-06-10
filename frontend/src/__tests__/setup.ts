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

// Node v25+ has a built-in localStorage global but methods are undefined.
// Provide a memory-backed polyfill so Vitest jsdom doesn't skip it.
if (typeof globalThis.localStorage === "undefined" || !globalThis.localStorage.getItem) {
  const store: Record<string, string> = {};
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { for (const key in store) delete store[key]; },
      key: (index: number) => Object.keys(store)[index] ?? null,
      get length() { return Object.keys(store).length; },
    },
    writable: true,
    configurable: true,
  });
}
