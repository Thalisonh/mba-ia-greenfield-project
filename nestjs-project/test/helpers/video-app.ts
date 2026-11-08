import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { Channel } from '../../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { useInternalHostForPresignedUrls } from '../../src/test/storage';
import { User } from '../../src/users/entities/user.entity';

/** Boots AppModule with the same global pipes/filters as `main.ts`. */
export async function createVideoTestApp(): Promise<INestApplication<App>> {
  useInternalHostForPresignedUrls();
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();
  return app;
}

export interface TestUser {
  user: User;
  channel: Channel;
  token: string;
}

/** Creates a user + channel directly and signs an access token for it. */
export async function createTestUser(
  app: INestApplication<App>,
): Promise<TestUser> {
  const dataSource = app.get(DataSource);
  const handle = `u${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const email = `${handle}@example.com`;
  const user = await dataSource
    .getRepository(User)
    .save({ email, password: 'hash', is_confirmed: true });
  const channel = await dataSource
    .getRepository(Channel)
    .save({ name: handle, nickname: handle, user_id: user.id });
  const token = await app
    .get(JwtService)
    .signAsync({ sub: user.id, email: user.email });
  return { user, channel, token };
}
