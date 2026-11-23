// biome-ignore-all format: these steps stay on one line, the shape under test
// Steps written the way a formatter-free or minified codebase writes them:
// the directive shares its line with other code, and no directive in this
// file sits on a line of its own.
export async function doubleIt(i: number) { 'use step'; return i * 2; }

export const tripleIt=async(n:number)=>{"use step";return n*3};

// biome-ignore lint/complexity/noStaticOnlyClass: a static step method is one of the shapes under test
export class Counter { static async addOne(n: number) { 'use step'; return n + 1; } }

export const steps = { async squareIt(n: number) { 'use step'; return n * n; } };