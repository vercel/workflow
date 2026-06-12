import type { ComponentType } from 'react';
import {
  Ban,
  Bot,
  Box,
  CalendarClock,
  CircleStop,
  Gauge,
  GitFork,
  Layers,
  Network,
  RefreshCw,
  Repeat2,
  Split,
  ThumbsUp,
  Timer,
  Webhook,
  Zap,
} from 'lucide-react';
import type { RegistryLogoId } from '@/lib/patterns/types';
import { LogoAiSdk } from './logo-ai-sdk';
import { LogoChatSdk } from './logo-chat-sdk';
import { LogoResend } from './logo-resend';

export interface ProviderLogoProps {
  size?: number;
  className?: string;
}

/**
 * Pattern logos keyed by `RegistryLogoId`.
 * Conceptual patterns use lucide-react icons; brand marks use custom SVGs.
 */
export const providerLogos: Record<
  RegistryLogoId,
  ComponentType<ProviderLogoProps>
> = {
  resend: LogoResend,
  'ai-sdk': LogoAiSdk,
  'chat-sdk': LogoChatSdk,
  'agent-cancellation': CircleStop,
  batching: Layers,
  'child-workflows': GitFork,
  'kill-switch': Ban,
  'durable-agent': Bot,
  'human-in-the-loop': ThumbsUp,
  idempotency: RefreshCw,
  'handling-rate-limits': Gauge,
  saga: Repeat2,
  sandbox: Box,
  scheduling: CalendarClock,
  'sequential-and-parallel': Split,
  timeouts: Timer,
  'upgrading-workflows': Zap,
  webhooks: Webhook,
  'workflow-composition': Network,
};

export function getProviderLogo(
  id: RegistryLogoId | undefined
): ComponentType<ProviderLogoProps> | null {
  if (!id) return null;
  return providerLogos[id] ?? null;
}
