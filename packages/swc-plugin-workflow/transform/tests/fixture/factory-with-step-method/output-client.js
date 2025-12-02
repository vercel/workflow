import fs from 'fs/promises';
const myFactory = ()=>({
        myStep: async ()=>{
            await fs.mkdir('test');
        }
    });
export default myFactory;
