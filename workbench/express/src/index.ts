import express from 'express';
import { fromNodeHandler, type NodeMiddleware } from 'nitro/h3';
import hookRouter from '../routes/hook.routes';
import triggerRouter from '../routes/trigger.routes';

const app = express();

app.use(express.json());
app.use(hookRouter);
app.use(triggerRouter);

export default fromNodeHandler(app as NodeMiddleware);
