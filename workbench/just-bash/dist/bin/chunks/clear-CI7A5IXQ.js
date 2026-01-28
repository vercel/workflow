#!/usr/bin/env node
import{a as e,b as r}from"./chunk-GTNBSMZR.js";import"./chunk-KGOUQS5A.js";var t={name:"clear",summary:"clear the terminal screen",usage:"clear [OPTIONS]",options:["    --help display this help and exit"]},s={name:"clear",async execute(a,c){return r(a)?e(t):{stdout:"\x1B[2J\x1B[H",stderr:"",exitCode:0}}};export{s as clearCommand};
