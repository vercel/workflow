/**
 * Required for CSS modules to be supported by TypeScript.
 * https://github.com/mrmckeb/typescript-plugin-css-modules#custom-definitions
 */

declare module '*.module.css' {
  const classes: Record<string, string>;

  export default classes;
}

declare module '*.svg' {
  const content: { src: string };

  export default content;
}
