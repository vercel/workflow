import { describe, expect, it } from 'vitest';
import { shouldNotifySocketForDiscoveredPattern } from './loader.js';

describe('workflow loader discovery notifications', () => {
  it('notifies for unchanged files that still contain workflow patterns', () => {
    expect(
      shouldNotifySocketForDiscoveredPattern(false, {
        hasWorkflow: true,
        hasStep: false,
        hasSerde: false,
      })
    ).toBe(true);
    expect(
      shouldNotifySocketForDiscoveredPattern(false, {
        hasWorkflow: false,
        hasStep: true,
        hasSerde: false,
      })
    ).toBe(true);
    expect(
      shouldNotifySocketForDiscoveredPattern(false, {
        hasWorkflow: false,
        hasStep: false,
        hasSerde: true,
      })
    ).toBe(true);
  });

  it('only notifies for plain files when pattern state changed', () => {
    const plainPatternState = {
      hasWorkflow: false,
      hasStep: false,
      hasSerde: false,
    };

    expect(
      shouldNotifySocketForDiscoveredPattern(false, plainPatternState)
    ).toBe(false);
    expect(
      shouldNotifySocketForDiscoveredPattern(true, plainPatternState)
    ).toBe(true);
  });
});
