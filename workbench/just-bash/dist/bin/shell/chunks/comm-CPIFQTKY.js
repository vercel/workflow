#!/usr/bin/env node
import{a as g,b as $,c as y}from"./chunk-GTNBSMZR.js";import"./chunk-KGOUQS5A.js";var x={name:"comm",summary:"compare two sorted files line by line",usage:"comm [OPTION]... FILE1 FILE2",options:["-1             suppress column 1 (lines unique to FILE1)","-2             suppress column 2 (lines unique to FILE2)","-3             suppress column 3 (lines that appear in both files)","    --help     display this help and exit"]},I={name:"comm",async execute(p,c){if($(p))return g(x);let o=!1,i=!1,f=!1,l=[];for(let e of p)if(e==="-1")o=!0;else if(e==="-2")i=!0;else if(e==="-3")f=!0;else if(e==="-12"||e==="-21")o=!0,i=!0;else if(e==="-13"||e==="-31")o=!0,f=!0;else if(e==="-23"||e==="-32")i=!0,f=!0;else if(e==="-123"||e==="-132"||e==="-213"||e==="-231"||e==="-312"||e==="-321")o=!0,i=!0,f=!0;else{if(e.startsWith("-")&&e!=="-")return y("comm",e);l.push(e)}if(l.length!==2)return{stdout:"",stderr:`comm: missing operand
Try 'comm --help' for more information.
`,exitCode:1};let m=async e=>{if(e==="-")return c.stdin;try{let F=c.fs.resolvePath(c.cwd,e);return await c.fs.readFile(F)}catch{return null}},a=await m(l[0]);if(a===null)return{stdout:"",stderr:`comm: ${l[0]}: No such file or directory
`,exitCode:1};let h=await m(l[1]);if(h===null)return{stdout:"",stderr:`comm: ${l[1]}: No such file or directory
`,exitCode:1};let t=a.split(`
`),s=h.split(`
`);t.length>0&&t[t.length-1]===""&&t.pop(),s.length>0&&s[s.length-1]===""&&s.pop();let n=0,r=0,u="",d=o?"":"	",w=(o?"":"	")+(i?"":"	");for(;n<t.length||r<s.length;)n>=t.length?(i||(u+=`${d}${s[r]}
`),r++):r>=s.length?(o||(u+=`${t[n]}
`),n++):t[n]<s[r]?(o||(u+=`${t[n]}
`),n++):t[n]>s[r]?(i||(u+=`${d}${s[r]}
`),r++):(f||(u+=`${w}${t[n]}
`),n++,r++);return{stdout:u,stderr:"",exitCode:0}}};export{I as commCommand};
