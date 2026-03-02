const data = [
  {
    title: 'Reliability, minus the plumbing',
    description:
      'Start with plain async code. No queues to wire, no schedulers to tune, no YAML. Best‑in‑class DX that compiles reliability into your app with zero config.',
  },
  {
    title: 'See every step, instantly',
    description:
      'Inspect every run end‑to‑end. Pause, replay, and time‑travel through steps with traces, logs, and metrics automatically captured — no extra services or setup.',
  },
  {
    title: 'A versatile paradigm',
    description:
      'Workflows can power a wide array of apps, from streaming realtime agents, to CI/CD pipelines, or multi day email subscriptions workflows.',
  },
];

export const Features = () => (
  <div className="px-4 py-8 sm:py-12 sm:px-12 grid md:grid-cols-3 gap-8">
    {data.map((item) => (
      <div key={item.title}>
        <h3 className="mb-2 font-semibold text-lg tracking-tight">
          {item.title}
        </h3>
        <p className="text-muted-foreground">{item.description}</p>
      </div>
    ))}
  </div>
);
