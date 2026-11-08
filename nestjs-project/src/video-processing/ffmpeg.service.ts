import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import type { VideoMetadata } from '../videos/entities/video.entity';

export interface ProbeResult {
  durationSeconds: number | null;
  metadata: VideoMetadata;
  hasVideoStream: boolean;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; format_name?: string; bit_rate?: string };
}

/**
 * Uploaded files are untrusted: playlist-style demuxers (HLS, concat) would make
 * FFmpeg fetch whatever the file points to (local files, internal hosts). Only
 * real video containers are probed, and only over HTTP(S) to the signed URL.
 */
const SAFE_INPUT_ARGS = [
  '-protocol_whitelist',
  'http,https,tcp,tls,crypto',
  '-format_whitelist',
  'mov,matroska,webm,avi,mpegts,flv,asf,mpeg,ogg',
];

const THUMBNAIL_MAX_WIDTH = 1280;

/** stderr patterns meaning the file itself is unusable — retrying cannot help. */
const INVALID_MEDIA_PATTERN =
  /Invalid data found|moov atom not found|not on whitelist|does not contain any stream/i;

/** The input is not a processable video; distinct from transient I/O failures. */
export class InvalidMediaError extends Error {}

function toNumber(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFrameRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [numerator, denominator] = rate.split('/').map(Number);
  if (!denominator) return null;
  return numerator / denominator;
}

/** Runs the FFmpeg binaries from the image (TD-06) against a presigned URL. */
@Injectable()
export class FfmpegService {
  async probe(url: string): Promise<ProbeResult> {
    const stdout = await this.run(
      'ffprobe',
      [
        '-v',
        'error',
        ...SAFE_INPUT_ARGS,
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        url,
      ],
      url,
    );
    const output = JSON.parse(stdout.toString('utf-8')) as FfprobeOutput;
    const streams = output.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');

    return {
      durationSeconds: toNumber(output.format?.duration),
      hasVideoStream: video !== undefined,
      metadata: {
        width: video?.width ?? null,
        height: video?.height ?? null,
        videoCodec: video?.codec_name ?? null,
        audioCodec: audio?.codec_name ?? null,
        formatName: output.format?.format_name ?? null,
        bitRate: toNumber(output.format?.bit_rate),
        frameRate: parseFrameRate(video?.avg_frame_rate),
      },
    };
  }

  /** Input seeking (`-ss` before `-i`) reads only the region around the frame. */
  async extractThumbnail(url: string, atSeconds: number): Promise<Buffer> {
    return this.run(
      'ffmpeg',
      [
        '-v',
        'error',
        ...SAFE_INPUT_ARGS,
        '-ss',
        atSeconds.toFixed(3),
        '-i',
        url,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${THUMBNAIL_MAX_WIDTH},iw)':-2`,
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      url,
    );
  }

  private run(
    command: string,
    args: string[],
    inputUrl: string,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(stdout));
          return;
        }
        // FFmpeg echoes its input in errors; the URL carries a live signature.
        const details = Buffer.concat(stderr)
          .toString('utf-8')
          .trim()
          .split(inputUrl)
          .join('<input>');
        const message = `${command} exited with code ${code}: ${details}`;
        reject(
          INVALID_MEDIA_PATTERN.test(details)
            ? new InvalidMediaError(message)
            : new Error(message),
        );
      });
    });
  }
}
