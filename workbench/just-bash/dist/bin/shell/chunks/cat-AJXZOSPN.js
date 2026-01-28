#!/usr/bin/env node
import{a as p}from"./chunk-5WFYIUU2.js";import"./chunk-OBH7XN5N.js";import{a as d}from"./chunk-TA7RUHGQ.js";import{a as c,b as m}from"./chunk-GTNBSMZR.js";import"./chunk-KGOUQS5A.js";var f={name:"cat",summary:"concatenate files and print on the standard output",usage:"cat [OPTION]... [FILE]...",options:["-n, --number           number all output lines","    --help             display this help and exit"]},b={number:{short:"n",long:"number",type:"boolean"}},w={name:"cat",async execute(t,r){if(m(t))return c(f);let e=d("cat",t,b);if(!e.ok)return e.error;let s=e.result.flags.number,o=e.result.positional,a=await p(r,o,{cmdName:"cat",allowStdinMarker:!0,stopOnError:!1}),n="",i=1;for(let{content:l}of a.files)if(s){let u=h(l,i);n+=u.content,i=u.nextLineNumber}else n+=l;return{stdout:n,stderr:a.stderr,exitCode:a.exitCode}}};function h(t,r){let e=t.split(`
`),s=t.endsWith(`
`),o=s?e.slice(0,-1):e;return{content:o.map((n,i)=>`${String(r+i).padStart(6," ")}	${n}`).join(`
`)+(s?`
`:""),nextLineNumber:r+o.length}}export{w as catCommand};
