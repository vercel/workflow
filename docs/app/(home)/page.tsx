import type { Metadata } from 'next';
import { CTA } from './components/cta';
import { Features } from './components/features';
import { Frameworks } from './components/frameworks';
import { Hero } from './components/hero';
import { Implementation } from './components/implementation';
import { Intro } from './components/intro/intro';
import { Observability } from './components/observability';
import { RunAnywhere } from './components/run-anywhere';
import { Templates } from './components/templates';
import { UseCases } from './components/use-cases-server';

const title = 'Make any TypeScript Function Durable';
const description =
  '"use workflow" brings durability, reliability, and observability to async JavaScript. Build apps and AI Agents that can suspend, resume, and maintain state with ease.';

export const metadata: Metadata = { title, description };

const Home = () => (
  <>
    <Hero title={title} description={description} />
    <div className="grid divide-y border-y sm:border-x">
      <Intro />
      <Implementation />
      <div className="grid lg:grid-cols-2 divide-y md:divide-y-0 md:divide-x">
        <Observability />
        <Frameworks />
      </div>
      <Features />
      <RunAnywhere />
      <UseCases />
      <Templates />
      <CTA />
    </div>
  </>
);

export default Home;
