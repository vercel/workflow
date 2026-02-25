import { O11yVisual } from './o11y-visual';

export const Observability = () => (
  <div className="grid gap-8 px-4 py-8 sm:py-12 sm:px-12">
    <h2 className="font-medium text-xl tracking-tight sm:text-2xl text-muted-foreground text-center text-balance">
      <span className="text-foreground">Observability</span>. Inspect every run
      end‑to‑end. Pause, replay, and time‑travel through steps with traces,
      logs, and metrics automatically.
    </h2>
    <O11yVisual />
  </div>
);
