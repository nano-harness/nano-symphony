import { render } from "solid-js/web";
import { Router, Route } from "@solidjs/router";
import { createSignal, onMount, onCleanup } from "solid-js";
import { Dashboard } from "./Dashboard";
import { IssueDetail } from "./IssueDetail";
import { WorkflowEditor } from "./WorkflowEditor";
import { api, type SymphonyRun } from "./api";
function StatusBar() {
  const [runs, setRuns] = createSignal<SymphonyRun[]>([]);
  onMount(() => { const load = async () => { setRuns(await api.getRuns()); }; load(); const i = setInterval(load, 5000); onCleanup(() => clearInterval(i)); });
  return <div style="background:#1e293b;color:#94a3b8;padding:6px 16px;font-size:12px;display:flex;gap:16px"><span>nano-symphony</span><span>Active: {runs().filter(r=>r.last_state==="claimed").length}</span></div>;
}
function App() {
  return <Router root={(props) => (<><StatusBar />{props.children}</>)}><Route path="/" component={Dashboard} /><Route path="/issues/:id" component={IssueDetail} /><Route path="/workflow" component={WorkflowEditor} /></Router>;
}
render(() => <App />, document.getElementById("root")!);
