import { describe, expect, it } from 'vitest';
import {
  isAltModifierKey,
  isTypingTarget,
  reduceAltHeld,
  shouldPreventAltDefault,
} from './use-alt-held';

describe('isAltModifierKey', () => {
  it('accepts Alt and AltGraph', () => {
    expect(isAltModifierKey('Alt')).toBe(true);
    expect(isAltModifierKey('AltGraph')).toBe(true);
  });

  it('rejects other keys', () => {
    expect(isAltModifierKey('a')).toBe(false);
    expect(isAltModifierKey('Control')).toBe(false);
    expect(isAltModifierKey('Meta')).toBe(false);
  });
});

describe('isTypingTarget', () => {
  it('treats input and textarea as typing targets', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'input' })).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
  });

  it('treats contenteditable as a typing target', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(
      true
    );
  });

  it('rejects non-editable targets', () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget({ isContentEditable: false, tagName: 'DIV' })).toBe(
      false
    );
  });
});

describe('shouldPreventAltDefault', () => {
  it('prevents Alt default outside text entry so Chrome cannot steal hover', () => {
    expect(shouldPreventAltDefault('Alt', { tagName: 'BODY' })).toBe(true);
    expect(shouldPreventAltDefault('AltGraph', { tagName: 'DIV' })).toBe(true);
    expect(shouldPreventAltDefault('Alt', null)).toBe(true);
  });

  it('leaves Alt default alone in an input, textarea, or contenteditable', () => {
    expect(shouldPreventAltDefault('Alt', { tagName: 'INPUT' })).toBe(false);
    expect(shouldPreventAltDefault('Alt', { tagName: 'TEXTAREA' })).toBe(false);
    expect(
      shouldPreventAltDefault('Alt', {
        tagName: 'DIV',
        isContentEditable: true,
      })
    ).toBe(false);
  });

  it('does not prevent default for unrelated keys', () => {
    expect(shouldPreventAltDefault('Escape', { tagName: 'BODY' })).toBe(false);
  });
});

describe('reduceAltHeld', () => {
  it('turns on for Alt down and off for Alt up', () => {
    expect(reduceAltHeld(false, { kind: 'keydown', key: 'Alt' })).toBe(true);
    expect(reduceAltHeld(false, { kind: 'keydown', key: 'AltGraph' })).toBe(
      true
    );
    expect(reduceAltHeld(true, { kind: 'keyup', key: 'Alt' })).toBe(false);
    expect(reduceAltHeld(true, { kind: 'keyup', key: 'AltGraph' })).toBe(false);
  });

  it('ignores unrelated keys', () => {
    expect(reduceAltHeld(false, { kind: 'keydown', key: 'a' })).toBe(false);
    expect(reduceAltHeld(true, { kind: 'keydown', key: 'Escape' })).toBe(true);
    expect(reduceAltHeld(true, { kind: 'keyup', key: 'a' })).toBe(true);
  });

  it('clears on blur so a stuck overlay cannot survive Alt+Tab', () => {
    expect(reduceAltHeld(true, { kind: 'blur' })).toBe(false);
    expect(reduceAltHeld(false, { kind: 'blur' })).toBe(false);
  });

  it('tracks pointer altKey when keydown was missed', () => {
    expect(reduceAltHeld(false, { kind: 'pointer', altKey: true })).toBe(true);
    expect(reduceAltHeld(true, { kind: 'pointer', altKey: false })).toBe(false);
  });
});
