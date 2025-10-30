export interface ModuleOptions {
  /**
   * Directories to scan for workflows and steps.
   *
   * By default, `workflows/` directory will be scanned from root and all layer source dirs.
   */
  dirs?: string[];
}

declare module 'nitro/types' {
  interface NitroOptions {
    workflow?: ModuleOptions;
  }
}

// @ts-expect-error (legacy)
declare module 'nitropack' {
  interface NitroOptions {
    workflow?: ModuleOptions;
  }
}
