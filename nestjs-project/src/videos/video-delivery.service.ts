import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { parseRange } from './range.util';
import { VideosService } from './videos.service';

export interface DeliverableMedia {
  statusCode: 200 | 206;
  headers: Record<string, string>;
  stream: Readable;
}

const THUMBNAIL_CACHE_CONTROL = 'public, max-age=300';

function toAttachmentFilename(filename: string): string {
  // Keeps the header valid and injection-free: printable ASCII, no quotes.
  return filename.replace(/[^\x20-\x7E]|["\\]/g, '_');
}

/** Resolves ready videos into streams with the right HTTP semantics (TD-12). */
@Injectable()
export class VideoDeliveryService {
  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
  ) {}

  async openMedia(
    slug: string,
    rangeHeader: string | undefined,
    options: { attachment: boolean },
  ): Promise<DeliverableMedia> {
    const video = await this.videosService.findReadyBySlug(slug);
    const { contentLength: size } = await this.storageService.headObject(
      video.storage_key,
    );
    const range = parseRange(rangeHeader, size);
    const object = await this.storageService.getObjectStream(
      video.storage_key,
      range,
    );

    const headers: Record<string, string> = {
      'Content-Type': video.content_type,
      'Content-Length': String(range ? range.end - range.start + 1 : size),
      'Accept-Ranges': 'bytes',
    };
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    }
    if (options.attachment) {
      headers['Content-Disposition'] =
        `attachment; filename="${toAttachmentFilename(video.original_filename)}"`;
    }

    return { statusCode: range ? 206 : 200, headers, stream: object.body };
  }

  async openThumbnail(slug: string): Promise<DeliverableMedia> {
    const video = await this.videosService.findReadyBySlug(slug);
    if (!video.thumbnail_key) throw new VideoNotFoundException();
    const object = await this.storageService.getObjectStream(
      video.thumbnail_key,
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(object.contentLength),
        'Cache-Control': THUMBNAIL_CACHE_CONTROL,
      },
      stream: object.body,
    };
  }
}
