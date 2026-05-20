import { Router, Route, A } from "@solidjs/router";
import { createSignal, onMount, onCleanup } from "solid-js";
import { Dashboard } from "./Dashboard";
import { IssueDetail } from "./IssueDetail";
import { WorkflowEditor } from "./WorkflowEditor";
import { api, type SymphonyRun } from "./api";

export function StatusBar() {
  const [runs, setRuns] = createSignal<SymphonyRun[]>([]);
  onMount(() => {
    const load = async () => { setRuns(await api.getRuns()); };
    load();
    const i = setInterval(load, 5000);
    onCleanup(() => clearInterval(i));
  });
  const activeCount = () => runs().filter(r => r.last_state === "claimed").length;
  return (
    <div class="conductor-bar">
      <A href="/" class="brand" title="Back to dashboard">
        <span class="brand-name">nano·symphony</span>
        <span class="opus-label">OPUS 0.1 — LOCAL LOOP</span>
      </A>
      <div class="staff-lines">
        <div class="staff-line"></div>
        <div class="staff-line"></div>
        <div class="staff-line"></div>
        <div class="staff-line"></div>
        <div class="staff-line"></div>
      </div>
      <div class="tempo">
        <span class="tempo-dot" classList={{ active: activeCount() > 0 }}></span>
        <span class="tempo-text">{activeCount() > 0 ? `CONDUCTING ${String(activeCount()).padStart(2, "0")}` : "AT REST"}</span>
      </div>
    </div>
  );
}

export function App() {
  const Layout = (props: { children?: any }) => (
    <>
      <StatusBar />
      {props.children}
    </>
  );

  return (
    <Router root={Layout}>
      <Route path="/" component={Dashboard} />
      <Route path="/issues/:id" component={IssueDetail} />
      <Route path="/workflow" component={WorkflowEditor} />
    </Router>
  );
}
