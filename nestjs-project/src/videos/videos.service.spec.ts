import { Test } from '@nestjs/testing';
import { QueryFailedError } from 'typeorm';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { VideosRepository } from './videos.repository';
import { VideosService } from './videos.service';

function uniqueViolation(detail: string): QueryFailedError {
  const error = new QueryFailedError('INSERT', [], new Error('duplicate'));
  Object.assign(error, { code: '23505', detail });
  return error;
}

const draftInput = {
  id: 'video-id',
  channel_id: 'channel-id',
  title: 'Aula',
  original_filename: 'aula.mp4',
  content_type: 'video/mp4',
  size_bytes: 10,
  storage_key: 'videos/video-id/original',
  upload_id: 'upload-id',
};

describe('VideosService', () => {
  let service: VideosService;
  const repository = {
    insert: jest.fn(),
    findById: jest.fn(),
    findByIdAndOwner: jest.fn(),
    findReadyBySlug: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: VideosRepository, useValue: repository },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  it('should retry with a new slug when the slug collides', async () => {
    repository.insert
      .mockRejectedValueOnce(uniqueViolation('Key (slug)=(x) already exists.'))
      .mockResolvedValueOnce(undefined);
    repository.findById.mockResolvedValue({ id: 'video-id' });

    await service.createDraft(draftInput);

    expect(repository.insert).toHaveBeenCalledTimes(2);
    const [first, second] = repository.insert.mock.calls.map(
      ([video]: [{ slug: string }]) => video.slug,
    );
    expect(first).not.toBe(second);
  });

  it('should give up after 5 slug collisions', async () => {
    const collision = uniqueViolation('Key (slug)=(x) already exists.');
    repository.insert.mockRejectedValue(collision);

    await expect(service.createDraft(draftInput)).rejects.toBe(collision);
    expect(repository.insert).toHaveBeenCalledTimes(5);
  });

  it('should not retry on a unique violation of another column', async () => {
    const violation = uniqueViolation('Key (id)=(x) already exists.');
    repository.insert.mockRejectedValue(violation);

    await expect(service.createDraft(draftInput)).rejects.toBe(violation);
    expect(repository.insert).toHaveBeenCalledTimes(1);
  });

  it('should translate missing rows into VideoNotFoundException', async () => {
    repository.findByIdAndOwner.mockResolvedValue(null);
    repository.findReadyBySlug.mockResolvedValue(null);

    await expect(service.findOwnedById('id', 'user')).rejects.toBeInstanceOf(
      VideoNotFoundException,
    );
    await expect(service.findReadyBySlug('slug')).rejects.toBeInstanceOf(
      VideoNotFoundException,
    );
  });
});
