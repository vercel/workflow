import { Module } from '@nestjs/common';
import { WorkflowModule } from 'workflow/nest';
import { AppController } from './app.controller.js';

@Module({
  imports: [
    // On Vercel the workflow bundles are pre-built by `workflow-nest build`,
    // so skip the in-process build there. No-op locally.
    WorkflowModule.forRoot({ skipBuild: Boolean(process.env.VERCEL) }),
  ],
  controllers: [AppController],
})
export class AppModule {}
