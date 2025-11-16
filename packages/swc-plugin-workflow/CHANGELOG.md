# @workflow/swc-plugin

## 4.0.1-beta.6

### Patch Changes

- 5eb588a: Remove step function identifier transform out of swc-plugin and into `useStep()` runtime function
- 0b848cd: Fix compiler warnings
- 45b7b41: Support nested anonymous step functions
- f8e5d10: Support serializing step function references
- 8002e0f: Add support for step functions defined as object properties
- f07b2da: Transform step functions to single `useStep()` calls
- aecdcdf: Add support for step functions nested inside of workflow functions

## 4.0.1-beta.5

### Patch Changes

- 4f9ae4e: Remove step transformation in client mode

## 4.0.1-beta.4

### Patch Changes

- e0c6618: Specify import path of `start` function on error in SWC plugin

## 4.0.1-beta.3

### Patch Changes

- 4a821fc: Fix Windows path handling by normalizing backslashes to forward slashes in workflow IDs
- 4a821fc: Fix building SWC plugin on Windows

## 4.0.1-beta.2

### Patch Changes

- f973954: Update license to Apache 2.0

## 4.0.1-beta.1

### Patch Changes

- 1408293: Add "description" field to `package.json` file
- e46294f: Add "license" and "repository" fields to `package.json` file

## 4.0.1-beta.0

### Patch Changes

- fcf63d0: Initial publish
