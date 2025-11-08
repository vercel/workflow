/**
 * Tests for DurableAgent
 *
 * These tests verify that the DurableAgent constructor properly accepts
 * and stores configuration options from the AI SDK Agent class.
 */
import { describe, expect, it } from 'vitest';
import { DurableAgent } from './durable-agent.js';

describe('DurableAgent', () => {
  describe('constructor', () => {
    it('should accept basic required options', () => {
      const agent = new DurableAgent({
        model: 'anthropic/claude-opus',
        tools: {},
      });

      expect(agent).toBeDefined();
      expect(agent.model).toBe('anthropic/claude-opus');
      expect(agent.tools).toEqual({});
    });

    it('should accept system prompt', () => {
      const agent = new DurableAgent({
        model: 'anthropic/claude-opus',
        tools: {},
        system: 'You are a helpful assistant.',
      });

      expect(agent).toBeDefined();
      expect(agent.system).toBe('You are a helpful assistant.');
    });

    it('should accept temperature option', () => {
      const agent = new DurableAgent({
        model: 'anthropic/claude-opus',
        tools: {},
        temperature: 0.7,
      });

      expect(agent).toBeDefined();
      expect(agent.temperature).toBe(0.7);
    });

    it('should accept maxOutputTokens option', () => {
      const agent = new DurableAgent({
        model: 'anthropic/claude-opus',
        tools: {},
        maxOutputTokens: 1000,
      });

      expect(agent).toBeDefined();
      expect(agent.maxOutputTokens).toBe(1000);
    });

    it('should accept topP option', () => {
      const agent = new DurableAgent({
        model: 'anthropic/claude-opus',
        tools: {},
        topP: 0.9,
      });

      expect(agent).toBeDefined();
      expect(agent.topP).toBe(0.9);
    });

    it('should accept topK option', () => {
      const agent = new DurableAgent({
        model: 'anthropic/claude-opus',
        tools: {},
        topK: 40,
      });

      expect(agent).toBeDefined();
      expect(agent.topK).toBe(40);
    });

    it('should accept presencePenalty option', () => {
      const agent = new DurableAgent({
        model: 'anthropic/claude-opus',
        tools: {},
        presencePenalty: 0.5,
      });

      expect(agent).toBeDefined();
      expect(agent.presencePenalty).toBe(0.5);
    });

    it('should accept frequencyPenalty option', () => {
      const agent = new DurableAgent({
        model: 'anthropic/claude-opus',
        tools: {},
        frequencyPenalty: 0.5,
      });

      expect(agent).toBeDefined();
      expect(agent.frequencyPenalty).toBe(0.5);
    });

    it('should accept stopSequences option', () => {
      const agent = new DurableAgent({
        model: 'anthropic/claude-opus',
        tools: {},
        stopSequences: ['STOP', 'END'],
      });

      expect(agent).toBeDefined();
      expect(agent.stopSequences).toEqual(['STOP', 'END']);
    });

    it('should accept seed option', () => {
      const agent = new DurableAgent({
        model: 'anthropic/claude-opus',
        tools: {},
        seed: 12345,
      });

      expect(agent).toBeDefined();
      expect(agent.seed).toBe(12345);
    });

    it('should accept all options together', () => {
      const agent = new DurableAgent({
        model: 'anthropic/claude-opus',
        tools: {},
        system: 'You are a helpful assistant.',
        temperature: 0.7,
        maxOutputTokens: 1000,
        topP: 0.9,
        topK: 40,
        presencePenalty: 0.5,
        frequencyPenalty: 0.3,
        stopSequences: ['STOP', 'END'],
        seed: 12345,
      });

      expect(agent).toBeDefined();
      expect(agent.model).toBe('anthropic/claude-opus');
      expect(agent.system).toBe('You are a helpful assistant.');
      expect(agent.temperature).toBe(0.7);
      expect(agent.maxOutputTokens).toBe(1000);
      expect(agent.topP).toBe(0.9);
      expect(agent.topK).toBe(40);
      expect(agent.presencePenalty).toBe(0.5);
      expect(agent.frequencyPenalty).toBe(0.3);
      expect(agent.stopSequences).toEqual(['STOP', 'END']);
      expect(agent.seed).toBe(12345);
    });

    it('should accept tools with proper structure', () => {
      const tools = {
        testTool: {
          description: 'A test tool',
          inputSchema: {
            type: 'object',
            properties: {},
          },
          execute: async () => 'result',
        },
      };

      const agent = new DurableAgent({
        model: 'anthropic/claude-opus',
        tools,
      });

      expect(agent).toBeDefined();
      expect(agent.tools).toBe(tools);
    });
  });

  describe('methods', () => {
    it('should have generate method', () => {
      const agent = new DurableAgent({
        model: 'anthropic/claude-opus',
        tools: {},
      });

      expect(agent.generate).toBeDefined();
      expect(typeof agent.generate).toBe('function');
    });

    it('should have stream method', () => {
      const agent = new DurableAgent({
        model: 'anthropic/claude-opus',
        tools: {},
      });

      expect(agent.stream).toBeDefined();
      expect(typeof agent.stream).toBe('function');
    });
  });
});
