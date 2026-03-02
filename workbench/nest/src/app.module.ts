import { Module } from '@nestjs/common';
import { WorkflowModule } from 'workflow/nest';
import { AppController } from './app.controller.js';

@Module({
  imports: [WorkflowModule.forRoot()],
  controllers: [AppController],
})
export class AppModule {}
