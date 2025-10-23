import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { getConstructorName, getConstructorNames, isInstanceOf } from './types';

describe('getConstructorName', () => {
  it('should return the constructor name of an Error', () => {
    expect(getConstructorName(new Error('test'))).toBe('Error');
  });

  it('should return the constructor name of a custom error', () => {
    class CustomError extends Error {}
    expect(getConstructorName(new CustomError('test'))).toBe('CustomError');
  });

  it('should return null if the object has no constructor', () => {
    expect(getConstructorName(Object.create(null))).toBeNull();
  });

  it('should return null if the object is null or undefined', () => {
    expect(getConstructorName(null)).toBeNull();
    expect(getConstructorName(undefined)).toBeNull();
  });

  it('should return "String" if the object is a string', () => {
    expect(getConstructorName('test')).toBe('String');
  });

  it('should return "Number" if the object is a number', () => {
    expect(getConstructorName(123)).toBe('Number');
  });

  it('should return "Error" from an Error object from a different context', () => {
    const error = vm.runInNewContext('new Error("test")');
    expect(getConstructorName(error)).toBe('Error');
  });

  it('should return "TypeError" from an Error object from a different context', () => {
    const error = vm.runInNewContext('new TypeError("test")');
    expect(getConstructorName(error)).toBe('TypeError');
  });
});

describe('getConstructorNames', () => {
  it('should return the constructor names of an Error', () => {
    expect(getConstructorNames(new Error('test'))).toEqual(['Error']);
  });

  it('should return the constructor names of a custom error', () => {
    class CustomError extends Error {}
    expect(getConstructorNames(new CustomError('test'))).toEqual([
      'CustomError',
      'Error',
    ]);
  });

  it('should return the constructor names of a custom error from a different context', () => {
    const error = vm.runInNewContext(
      'class CustomError extends Error {} new CustomError("test")'
    );
    expect(getConstructorNames(error)).toEqual(['CustomError', 'Error']);
  });
});

describe('isInstanceOf', () => {
  it('should return true if the error is an instance of the given constructor', () => {
    expect(isInstanceOf(new Error('test'), Error)).toBe(true);
  });

  it('should return true if the error is a instance of a subclass of the given constructor', () => {
    expect(isInstanceOf(new TypeError('test'), Error)).toBe(true);
  });

  it('should return false if the error is not an instance of the given constructor', () => {
    expect(isInstanceOf(new Error('test'), TypeError)).toBe(false);
  });
});
