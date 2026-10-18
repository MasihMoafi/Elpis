import data from "@/lib/workflow-sources.json";
import { Button } from "@/components/ui/button";
import styles from "./experiment-lab.module.css";

type Paper = { title: string; authors: string; year: number; venue: string; url: string; read: string; finding: string };
const papers: Record<string, Paper> = data.sources;
const origins: Record<string, { title: string; url: string }> = data.origins;

export function WorkflowSources({ id, onBack }: { id: string; onBack: () => void }) {
  const pattern = data.patterns.find(pattern => pattern.id === id);
  if (!pattern) return null;
  return <aside id={`workflow-sources-${pattern.id}`} className={`canvas-side ${styles.sources}`} aria-label="Workflow sources">
    <Button variant="ghost" size="sm" onClick={onBack}>Back to patterns</Button>
    <h2>{pattern.name}</h2>
    <p className={styles.muted}>{pattern.status} · Elpis graph unproven</p>
    {pattern.sources.map(id => { const source = papers[id]; return <article key={id}>
      <h3><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></h3>
      <p className={styles.muted}>{source.year} · {source.venue}</p>
      <p>{source.finding}</p>
      <a href={source.read} target="_blank" rel="noreferrer">Read the results</a>
      <details><summary className={styles.muted}>Authors</summary><p className={styles.muted}>{source.authors}</p></details>
    </article>; })}
    <section><h3>What is proven</h3><p>{pattern.proven}</p></section>
    <section><h3>What is not</h3><p>{pattern.unproven}</p></section>
    {pattern.origins.length > 0 && <section><h3>Starter inspiration</h3>{pattern.origins.map(id => <p key={id}><a href={origins[id].url} target="_blank" rel="noreferrer">{origins[id].title}</a></p>)}<p className={styles.muted}>Implementation guidance, separate from the paper results above.</p></section>}
    <p className={styles.muted}>Reviewed {data.reviewed}. A published result applies to the paper&rsquo;s model, task and method.</p>
  </aside>;
}
