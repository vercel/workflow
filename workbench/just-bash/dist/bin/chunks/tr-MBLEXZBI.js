#!/usr/bin/env node
import{a as C}from"./chunk-TA7RUHGQ.js";import{a as g,b as m}from"./chunk-GTNBSMZR.js";import"./chunk-KGOUQS5A.js";var x={name:"tr",summary:"translate or delete characters",usage:"tr [OPTION]... SET1 [SET2]",options:["-c, -C, --complement   use the complement of SET1","-d, --delete           delete characters in SET1","-s, --squeeze-repeats  squeeze repeated characters","    --help             display this help and exit"],description:`SET syntax:
  a-z         character range
  [:alnum:]   all letters and digits
  [:alpha:]   all letters
  [:digit:]   all digits
  [:lower:]   all lowercase letters
  [:upper:]   all uppercase letters
  [:space:]   all whitespace
  [:blank:]   horizontal whitespace
  [:punct:]   all punctuation
  [:print:]   all printable characters
  [:graph:]   all printable characters except space
  [:cntrl:]   all control characters
  [:xdigit:]  all hexadecimal digits
  \\n, \\t, \\r  escape sequences`},b={"[:alnum:]":"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789","[:alpha:]":"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz","[:blank:]":" 	","[:cntrl:]":Array.from({length:32},(r,n)=>String.fromCharCode(n)).join("").concat("\x7F"),"[:digit:]":"0123456789","[:graph:]":Array.from({length:94},(r,n)=>String.fromCharCode(33+n)).join(""),"[:lower:]":"abcdefghijklmnopqrstuvwxyz","[:print:]":Array.from({length:95},(r,n)=>String.fromCharCode(32+n)).join(""),"[:punct:]":"!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~","[:space:]":` 	
\r\f\v`,"[:upper:]":"ABCDEFGHIJKLMNOPQRSTUVWXYZ","[:xdigit:]":"0123456789ABCDEFabcdef"};function S(r){let n="",e=0;for(;e<r.length;){if(r[e]==="["&&r[e+1]===":"){let l=!1;for(let[i,a]of Object.entries(b))if(r.slice(e).startsWith(i)){n+=a,e+=i.length,l=!0;break}if(l)continue}if(r[e]==="\\"&&e+1<r.length){let l=r[e+1];l==="n"?n+=`
`:l==="t"?n+="	":l==="r"?n+="\r":n+=l,e+=2;continue}if(e+2<r.length&&r[e+1]==="-"){let l=r.charCodeAt(e),i=r.charCodeAt(e+2);for(let a=l;a<=i;a++)n+=String.fromCharCode(a);e+=3;continue}n+=r[e],e++}return n}var y={complement:{short:"c",long:"complement",type:"boolean"},complementUpper:{short:"C",type:"boolean"},delete:{short:"d",long:"delete",type:"boolean"},squeeze:{short:"s",long:"squeeze-repeats",type:"boolean"}},q={name:"tr",async execute(r,n){if(m(r))return g(x);let e=C("tr",r,y);if(!e.ok)return e.error;let l=e.result.flags.complement||e.result.flags.complementUpper,i=e.result.flags.delete,a=e.result.flags.squeeze,p=e.result.positional;if(p.length<1)return{stdout:"",stderr:`tr: missing operand
`,exitCode:1};if(!i&&!a&&p.length<2)return{stdout:"",stderr:`tr: missing operand after SET1
`,exitCode:1};let f=S(p[0]),s=p.length>1?S(p[1]):"",d=n.stdin,u=o=>{let t=f.includes(o);return l?!t:t},c="";if(i)for(let o of d)u(o)||(c+=o);else if(a&&p.length===1){let o="";for(let t of d)u(t)&&t===o||(c+=t,o=t)}else{if(l){let o=s.length>0?s[s.length-1]:"";for(let t of d)f.includes(t)?c+=t:c+=o}else{let o=new Map;for(let t=0;t<f.length;t++){let h=t<s.length?s[t]:s[s.length-1];o.set(f[t],h)}for(let t of d)c+=o.get(t)??t}if(a){let o="",t="";for(let h of c)s.includes(h)&&h===t||(o+=h,t=h);c=o}}return{stdout:c,stderr:"",exitCode:0}}};export{q as trCommand};
