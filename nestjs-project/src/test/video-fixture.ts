import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Generates a short 320x240 MP4 at test time, so no binaries live in git. */
export async function generateTestVideo(durationSeconds = 2): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'video-fixture-'));
  const output = join(directory, 'fixture.mp4');
  try {
    await run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${durationSeconds}:size=320x240:rate=25`,
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-movflags',
      '+faststart',
      output,
    ]);
    return await readFile(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
