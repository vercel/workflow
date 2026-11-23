// biome-ignore-all format: these steps stay on one line, the shape under test
// Steps whose `"use step"` shares its line with other code, as formatter-free
// or minified code writes them. No directive in this file sits on a line of
// its own, so discovery has to find these to register them.
export async function oneLineDouble(i: number) { 'use step'; return i * 2; }

export const oneLineTriple=async(n:number)=>{"use step";return n*3};

export const oneLineSteps = { async square(n: number) { 'use step'; return n * n; } };