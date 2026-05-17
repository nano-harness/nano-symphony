import { createSignal, onMount } from "solid-js";
import { api } from "./api";
export function WorkflowEditor() {
  const [content, setContent] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  onMount(async () => { const { content: c } = await api.getWorkflow(); setContent(c); });
  const save = async () => { await api.saveWorkflow(content()); setSaved(true); setTimeout(() => setSaved(false), 2000); };
  return <div style="padding:24px"><h1>Workflow Editor</h1><button onClick={save}>Save</button>{saved() && <span> Saved!</span>}<br/><textarea value={content()} onInput={e => setContent(e.currentTarget.value)} style="width:100%;height:70vh;font-family:monospace" /></div>;
}
