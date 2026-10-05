import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SummariesModule } from './summaries/summaries.module.js';

@Module({
  // ConfigModule loads .env into process.env before SummariesModule validates it.
  imports: [ConfigModule.forRoot({ isGlobal: true }), SummariesModule],
})
export class AppModule {}
