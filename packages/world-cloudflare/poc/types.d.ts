declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
declare module '*.so' {
  const module: WebAssembly.Module;
  export default module;
}
