#!/usr/bin/env node
import{c}from"./chunk-GTNBSMZR.js";function I(t,r){let i=10,s=null,o=!1,l=!1,n=!1,u=[];for(let f=0;f<t.length;f++){let e=t[f];if(e==="-n"&&f+1<t.length){let a=t[++f];r==="tail"&&a.startsWith("+")?(n=!0,i=parseInt(a.slice(1),10)):i=parseInt(a,10)}else if(r==="tail"&&e.startsWith("-n+"))n=!0,i=parseInt(e.slice(3),10);else if(e.startsWith("-n"))i=parseInt(e.slice(2),10);else if(e==="-c"&&f+1<t.length)s=parseInt(t[++f],10);else if(e.startsWith("-c"))s=parseInt(e.slice(2),10);else if(e.startsWith("--bytes="))s=parseInt(e.slice(8),10);else if(e.startsWith("--lines="))i=parseInt(e.slice(8),10);else if(e==="-q"||e==="--quiet"||e==="--silent")o=!0;else if(e==="-v"||e==="--verbose")l=!0;else if(e.match(/^-\d+$/))i=parseInt(e.slice(1),10);else{if(e.startsWith("--"))return{ok:!1,error:c(r,e)};if(e.startsWith("-")&&e!=="-")return{ok:!1,error:c(r,e)};u.push(e)}}return s!==null&&(Number.isNaN(s)||s<0)?{ok:!1,error:{stdout:"",stderr:`${r}: invalid number of bytes
`,exitCode:1}}:Number.isNaN(i)||i<0?{ok:!1,error:{stdout:"",stderr:`${r}: invalid number of lines
`,exitCode:1}}:{ok:!0,options:{lines:i,bytes:s,quiet:o,verbose:l,files:u,fromLine:n}}}async function W(t,r,i,s){let{quiet:o,verbose:l,files:n}=r;if(n.length===0)return{stdout:s(t.stdin),stderr:"",exitCode:0};let u="",f="",e=0,a=l||!o&&n.length>1,h=0;for(let d=0;d<n.length;d++){let p=n[d];try{let b=t.fs.resolvePath(t.cwd,p),x=await t.fs.readFile(b);a&&(h>0&&(u+=`
`),u+=`==> ${p} <==
`),u+=s(x),h++}catch{f+=`${i}: ${p}: No such file or directory
`,e=1}}return{stdout:u,stderr:f,exitCode:e}}function $(t,r,i){if(i!==null)return t.slice(0,i);if(r===0)return"";let s=0,o=0,l=t.length;for(;s<l&&o<r;){let n=t.indexOf(`
`,s);if(n===-1)return`${t}
`;o++,s=n+1}return s>0?t.slice(0,s):""}function g(t,r,i,s){if(i!==null)return t.slice(-i);let o=t.length;if(o===0)return"";if(s){let f=0,e=1;for(;f<o&&e<r;){let h=t.indexOf(`
`,f);if(h===-1)break;e++,f=h+1}let a=t.slice(f);return a.endsWith(`
`)?a:`${a}
`}if(r===0)return"";let l=o-1;t[l]===`
`&&l--;let n=0;for(;l>=0&&n<r;){if(t[l]===`
`&&(n++,n===r)){l++;break}l--}l<0&&(l=0);let u=t.slice(l);return t[o-1]===`
`?u:`${u}
`}export{I as a,W as b,$ as c,g as d};
