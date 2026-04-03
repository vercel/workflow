import { registerStepFunction } from "workflow/internal/private";
import fs from 'fs/promises';
/**__internal_workflows{"steps":{"input.js":{"myFactory/myStep":{"stepId":"step//./input//myFactory/myStep"}}}}*/;
var myFactory$myStep = async function() {
    await fs.mkdir('test');
};
const myFactory = ()=>({
        myStep: async ()=>{
            await fs.mkdir('test');
        }
    });
export default myFactory;
registerStepFunction("step//./input//myFactory/myStep", myFactory$myStep);
