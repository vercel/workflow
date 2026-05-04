import { render } from 'preact';
import { App } from './app';
import type { Catalog } from './catalog';
import './styles.css';

async function load() {
  const root = document.getElementById('app');
  if (!root) throw new Error('No #app root element');

  try {
    const res = await fetch('/catalog.json');
    if (!res.ok) throw new Error(`Failed to load catalog.json: ${res.status}`);
    const catalog = (await res.json()) as Catalog;
    render(<App catalog={catalog} />, root);
  } catch (err) {
    render(
      <div class="error">
        <h1>Failed to load catalog</h1>
        <pre>{String(err)}</pre>
      </div>,
      root
    );
  }
}

void load();
